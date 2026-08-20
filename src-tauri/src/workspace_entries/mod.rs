use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::{
    commands::{
        dto::{WorkspaceEntry, WorkspaceEntryKind, WorkspaceEntryListRequest},
        error::{AppError, IpcError},
        workspace::{
            is_supported_document, modified_timestamp, policy_for_repository, safe_relative_path,
            workspace_by_id,
        },
    },
    database::repository::SqliteRepository,
};

const MANAGED_DIRECTORY_NAMES: &[&str] = &[".excalidraw_assets"];

#[derive(Clone, Default)]
pub struct WorkspaceMutationGate {
    locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl WorkspaceMutationGate {
    pub async fn acquire(&self, workspace_id: &str) -> OwnedMutexGuard<()> {
        let workspace_lock = {
            let mut locks = self.locks.lock().await;
            Arc::clone(
                locks
                    .entry(workspace_id.to_owned())
                    .or_insert_with(|| Arc::new(Mutex::new(()))),
            )
        };
        workspace_lock.lock_owned().await
    }
}

#[derive(Clone)]
pub struct WorkspaceEntryService {
    repository: Arc<SqliteRepository>,
    mutation_gate: WorkspaceMutationGate,
}

impl WorkspaceEntryService {
    pub fn new(repository: Arc<SqliteRepository>, mutation_gate: WorkspaceMutationGate) -> Self {
        Self {
            repository,
            mutation_gate,
        }
    }

    pub fn mutation_gate(&self) -> &WorkspaceMutationGate {
        &self.mutation_gate
    }

    pub async fn list(
        &self,
        request: WorkspaceEntryListRequest,
    ) -> Result<Vec<WorkspaceEntry>, IpcError> {
        self.list_inner(request).await.map_err(Into::into)
    }

    async fn list_inner(
        &self,
        request: WorkspaceEntryListRequest,
    ) -> Result<Vec<WorkspaceEntry>, AppError> {
        let workspace = workspace_by_id(&self.repository, &request.workspace_id).await?;
        let root = PathBuf::from(&workspace.root_path);
        let relative = safe_relative_path(&request.parent_relative_path)?;
        let requested = root.join(relative);
        reject_symlink(&requested)?;
        let policy = policy_for_repository(&self.repository).await?;
        let directory = policy.authorize_existing(&requested)?;
        let directory_metadata = fs::metadata(&directory).map_err(|source| AppError::Io {
            path: Some(directory.clone()),
            source,
        })?;
        if !directory_metadata.is_dir() {
            return Err(AppError::PathAccessDenied(directory));
        }

        let parent_relative_path = normalized_relative(&root, &directory)?;
        let mut entries = Vec::new();
        for candidate in fs::read_dir(&directory).map_err(|source| AppError::Io {
            path: Some(directory.clone()),
            source,
        })? {
            let candidate = candidate.map_err(|source| AppError::Io {
                path: Some(directory.clone()),
                source,
            })?;
            let path = candidate.path();
            let file_type = candidate.file_type().map_err(|source| AppError::Io {
                path: Some(path.clone()),
                source,
            })?;
            if file_type.is_symlink() || is_hidden_or_managed(&candidate.file_name()) {
                continue;
            }
            let kind = if file_type.is_dir() {
                WorkspaceEntryKind::Directory
            } else if file_type.is_file() && is_supported_document(&path) {
                WorkspaceEntryKind::Drawing
            } else {
                continue;
            };
            entries.push(entry_from_path(
                &workspace.id,
                &root,
                &parent_relative_path,
                &path,
                kind,
            )?);
        }
        apply_drawing_display_name_collisions(&mut entries);
        entries.sort_by(|left, right| {
            (
                left.kind != WorkspaceEntryKind::Directory,
                left.display_name.to_ascii_lowercase(),
                left.name.to_ascii_lowercase(),
            )
                .cmp(&(
                    right.kind != WorkspaceEntryKind::Directory,
                    right.display_name.to_ascii_lowercase(),
                    right.name.to_ascii_lowercase(),
                ))
        });
        Ok(entries)
    }
}

pub fn validate_entry_base_name(value: &str) -> Result<String, AppError> {
    let trimmed = value.trim();
    let path = Path::new(trimmed);
    let uppercase_stem = trimmed
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(uppercase_stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || uppercase_stem
            .strip_prefix("COM")
            .or_else(|| uppercase_stem.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            });
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('\0')
        || trimmed.len() > 255
        || trimmed
            .chars()
            .any(|character| character.is_control() || r#"<>:"/\|?*"#.contains(character))
        || trimmed.ends_with([' ', '.'])
        || path.is_absolute()
        || path.components().count() != 1
        || trimmed.starts_with('.')
        || reserved
    {
        return Err(AppError::InvalidName(value.to_owned()));
    }
    Ok(trimmed.to_owned())
}

pub fn is_protected_entry_name(name: &str) -> bool {
    name.starts_with('.') || MANAGED_DIRECTORY_NAMES.contains(&name)
}

fn reject_symlink(path: &Path) -> Result<(), AppError> {
    let metadata = fs::symlink_metadata(path).map_err(|source| AppError::Io {
        path: Some(path.to_path_buf()),
        source,
    })?;
    if metadata.file_type().is_symlink() {
        return Err(AppError::EntryProtected(path.to_path_buf()));
    }
    Ok(())
}

fn is_hidden_or_managed(name: &std::ffi::OsStr) -> bool {
    name.to_str().is_none_or(is_protected_entry_name)
}

fn entry_from_path(
    workspace_id: &str,
    root: &Path,
    parent_relative_path: &str,
    path: &Path,
    kind: WorkspaceEntryKind,
) -> Result<WorkspaceEntry, AppError> {
    reject_symlink(path)?;
    let canonical = path.canonicalize().map_err(|source| AppError::Io {
        path: Some(path.to_path_buf()),
        source,
    })?;
    if !canonical.starts_with(root) {
        return Err(AppError::PathAccessDenied(canonical));
    }
    let metadata = fs::metadata(&canonical).map_err(|source| AppError::Io {
        path: Some(canonical.clone()),
        source,
    })?;
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AppError::PathAccessDenied(canonical.clone()))?
        .to_owned();
    let display_name = match kind {
        WorkspaceEntryKind::Drawing => drawing_display_name(&name),
        WorkspaceEntryKind::Directory => name.clone(),
    };
    Ok(WorkspaceEntry {
        workspace_id: workspace_id.to_owned(),
        kind,
        canonical_path: canonical.display().to_string(),
        relative_path: normalized_relative(root, &canonical)?,
        parent_relative_path: parent_relative_path.to_owned(),
        name,
        display_name,
        mtime: modified_timestamp(&metadata, &canonical)?,
        file_size: if kind == WorkspaceEntryKind::Drawing {
            i64::try_from(metadata.len()).unwrap_or(i64::MAX)
        } else {
            0
        },
    })
}

fn normalized_relative(root: &Path, path: &Path) -> Result<String, AppError> {
    path.strip_prefix(root)
        .map(|relative| {
            relative
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/")
        })
        .map_err(|_| AppError::PathAccessDenied(path.to_path_buf()))
}

fn drawing_display_name(name: &str) -> String {
    name.strip_suffix(".excalidraw.json")
        .or_else(|| name.strip_suffix(".excalidraw"))
        .unwrap_or(name)
        .to_owned()
}

fn apply_drawing_display_name_collisions(entries: &mut [WorkspaceEntry]) {
    let mut counts = HashMap::<String, usize>::new();
    for entry in entries
        .iter()
        .filter(|entry| entry.kind == WorkspaceEntryKind::Drawing)
    {
        *counts
            .entry(entry.display_name.to_ascii_lowercase())
            .or_default() += 1;
    }
    for entry in entries
        .iter_mut()
        .filter(|entry| entry.kind == WorkspaceEntryKind::Drawing)
    {
        if counts
            .get(&entry.display_name.to_ascii_lowercase())
            .copied()
            .unwrap_or_default()
            > 1
        {
            entry.display_name.clone_from(&entry.name);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_portable_entry_base_names() {
        assert_eq!(
            validate_entry_base_name("  Drawing  ")
                .unwrap_or_else(|error| panic!("valid name rejected: {error}")),
            "Drawing"
        );
        let too_long = "a".repeat(256);
        for invalid in [
            "",
            ".",
            "..",
            ".hidden",
            "nested/name",
            r"nested\name",
            "CON",
            "com1.txt",
            "trailing.",
            "bad:name",
            "line\nbreak",
            too_long.as_str(),
        ] {
            assert!(
                matches!(
                    validate_entry_base_name(invalid),
                    Err(AppError::InvalidName(_))
                ),
                "invalid name accepted: {invalid:?}"
            );
        }
    }

    #[test]
    fn protects_hidden_and_managed_entries() {
        assert!(is_protected_entry_name(".hidden"));
        assert!(is_protected_entry_name(".excalidraw_assets"));
        assert!(!is_protected_entry_name("ordinary"));
    }

    #[test]
    fn disambiguates_sibling_drawing_display_name_collisions() {
        let mut entries = [
            drawing_entry("drawing.excalidraw"),
            drawing_entry("drawing.excalidraw.json"),
            drawing_entry("unique.excalidraw"),
        ];
        apply_drawing_display_name_collisions(&mut entries);
        assert_eq!(entries[0].display_name, "drawing.excalidraw");
        assert_eq!(entries[1].display_name, "drawing.excalidraw.json");
        assert_eq!(entries[2].display_name, "unique");
    }

    fn drawing_entry(name: &str) -> WorkspaceEntry {
        WorkspaceEntry {
            workspace_id: "workspace".to_owned(),
            kind: WorkspaceEntryKind::Drawing,
            canonical_path: format!("/workspace/{name}"),
            relative_path: name.to_owned(),
            parent_relative_path: String::new(),
            name: name.to_owned(),
            display_name: drawing_display_name(name),
            mtime: 1,
            file_size: 1,
        }
    }
}
