use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, OwnedMutexGuard};
use uuid::Uuid;

use crate::{
    commands::{
        dto::{
            EmptyResponse, EntryMutationResult, ExpectedOpenDocument, PathMigration,
            WorkspaceEntry, WorkspaceEntryCreateRequest, WorkspaceEntryDeletePreflightResult,
            WorkspaceEntryDeleteRequest, WorkspaceEntryDeleteResult, WorkspaceEntryKind,
            WorkspaceEntryListRequest, WorkspaceEntryPathRequest, WorkspaceEntryRenameRequest,
            WorkspaceEntryRenameResult,
        },
        error::{AppError, IpcError},
        workspace::{
            is_supported_document, modified_timestamp, policy_for_repository, safe_relative_path,
            workspace_by_id,
        },
    },
    database::repository::{
        migrate_path, DraftRepository, FileIndexRecord, FileIndexRepository, SqliteRepository,
        WorkspaceRecord,
    },
    documents::recovery::RecoveryStore,
};

pub(crate) mod mutation_journal;
#[cfg(test)]
mod mutation_test;

pub use mutation_journal::reconcile_pending_mutations;

use mutation_journal::{
    apply_committed_record_with_skip, delete_journal, save_journal, MutationJournalRecord,
};

const MANAGED_DIRECTORY_NAMES: &[&str] = &[".excalidraw_assets"];
const EMPTY_SCENE: &[u8] = br#"{"type":"excalidraw","version":2,"source":"excalidraw-desktop","elements":[],"appState":{},"files":{}}"#;

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

/// Small seam around the operating-system Trash provider. Tests can inject a
/// deterministic failure without depending on a desktop Trash service.
pub trait TrashOperator: Send + Sync {
    fn delete(&self, path: &Path) -> Result<(), io::Error>;
}

#[derive(Debug, Default)]
pub struct SystemTrashOperator;

impl TrashOperator for SystemTrashOperator {
    fn delete(&self, path: &Path) -> Result<(), io::Error> {
        trash::delete(path).map_err(|error| io::Error::other(error.to_string()))
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DerivedStateFault {
    Sqlite,
    Recovery,
}

#[derive(Clone)]
pub struct WorkspaceEntryService {
    repository: Arc<SqliteRepository>,
    mutation_gate: WorkspaceMutationGate,
    trash: Arc<dyn TrashOperator>,
    recovery: Arc<RecoveryStore>,
    watcher: Option<crate::watcher::WatcherService>,
    #[cfg(test)]
    derived_fault: Arc<std::sync::Mutex<Option<DerivedStateFault>>>,
}

impl WorkspaceEntryService {
    pub fn new(repository: Arc<SqliteRepository>, mutation_gate: WorkspaceMutationGate) -> Self {
        Self::with_recovery(repository, mutation_gate, isolated_recovery_store())
    }

    pub fn with_recovery(
        repository: Arc<SqliteRepository>,
        mutation_gate: WorkspaceMutationGate,
        recovery: Arc<RecoveryStore>,
    ) -> Self {
        Self::with_trash_and_recovery(
            repository,
            mutation_gate,
            Arc::new(SystemTrashOperator),
            recovery,
        )
    }

    pub fn with_trash(
        repository: Arc<SqliteRepository>,
        mutation_gate: WorkspaceMutationGate,
        trash: Arc<dyn TrashOperator>,
    ) -> Self {
        Self::with_trash_and_recovery(repository, mutation_gate, trash, isolated_recovery_store())
    }

    pub fn with_trash_and_recovery(
        repository: Arc<SqliteRepository>,
        mutation_gate: WorkspaceMutationGate,
        trash: Arc<dyn TrashOperator>,
        recovery: Arc<RecoveryStore>,
    ) -> Self {
        Self {
            repository,
            mutation_gate,
            trash,
            recovery,
            watcher: None,
            #[cfg(test)]
            derived_fault: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    pub fn with_watcher(mut self, watcher: crate::watcher::WatcherService) -> Self {
        self.watcher = Some(watcher);
        self
    }

    async fn note_pending_operation(
        &self,
        operation_id: &str,
        workspace_id: &str,
        echoes: Vec<(String, crate::watcher::WatcherEchoKind)>,
    ) {
        if let Some(watcher) = &self.watcher {
            watcher
                .note_entry_operation(operation_id.to_owned(), workspace_id.to_owned(), echoes)
                .await;
        }
    }

    async fn forget_pending_operation(&self, operation_id: &str) {
        if let Some(watcher) = &self.watcher {
            watcher.forget_entry_operation(operation_id).await;
        }
    }

    pub fn mutation_gate(&self) -> &WorkspaceMutationGate {
        &self.mutation_gate
    }

    #[cfg(test)]
    pub(crate) fn set_derived_fault(&self, fault: Option<DerivedStateFault>) {
        *self
            .derived_fault
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = fault;
    }

    fn skip_sqlite(&self) -> bool {
        #[cfg(test)]
        {
            *self
                .derived_fault
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                == Some(DerivedStateFault::Sqlite)
        }
        #[cfg(not(test))]
        {
            false
        }
    }

    fn skip_recovery(&self) -> bool {
        #[cfg(test)]
        {
            *self
                .derived_fault
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                == Some(DerivedStateFault::Recovery)
        }
        #[cfg(not(test))]
        {
            false
        }
    }

    pub async fn create(
        &self,
        request: WorkspaceEntryCreateRequest,
    ) -> Result<EntryMutationResult, IpcError> {
        self.create_inner(request).await.map_err(Into::into)
    }

    pub async fn rename(
        &self,
        request: WorkspaceEntryRenameRequest,
    ) -> Result<WorkspaceEntryRenameResult, IpcError> {
        self.rename_inner(request).await.map_err(Into::into)
    }

    pub async fn delete_preflight(
        &self,
        request: WorkspaceEntryPathRequest,
    ) -> Result<WorkspaceEntryDeletePreflightResult, IpcError> {
        self.delete_preflight_inner(request)
            .await
            .map_err(Into::into)
    }

    pub async fn delete(
        &self,
        request: WorkspaceEntryDeleteRequest,
    ) -> Result<WorkspaceEntryDeleteResult, IpcError> {
        self.delete_inner(request).await.map_err(Into::into)
    }

    pub async fn reveal(
        &self,
        request: WorkspaceEntryPathRequest,
    ) -> Result<EmptyResponse, IpcError> {
        self.reveal_inner(request).await.map_err(Into::into)
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

    async fn create_inner(
        &self,
        request: WorkspaceEntryCreateRequest,
    ) -> Result<EntryMutationResult, AppError> {
        let _workspace_guard = self.mutation_gate.acquire(&request.workspace_id).await;
        reconcile_pending_mutations(&self.repository, &self.recovery).await?;
        let workspace = workspace_by_id(&self.repository, &request.workspace_id).await?;
        let root = PathBuf::from(&workspace.root_path);
        let base_name = validate_entry_base_name(&request.base_name)?;
        let parent = self
            .authorize_parent(&workspace, &request.parent_relative_path)
            .await?;
        let target_name = match request.kind {
            WorkspaceEntryKind::Drawing => format!("{base_name}.excalidraw"),
            WorkspaceEntryKind::Directory => base_name,
        };
        let target = authorize_creation(&self.repository, &parent, &target_name).await?;
        reject_symlink_components(&root, &target)?;
        ensure_target_absent(&target)?;

        let operation_id = Uuid::new_v4().to_string();
        let relative_path = normalized_relative(&root, &target)?;
        self.note_pending_operation(
            &operation_id,
            &request.workspace_id,
            vec![(
                relative_path.clone(),
                crate::watcher::WatcherEchoKind::Created,
            )],
        )
        .await;

        let create_result = match request.kind {
            WorkspaceEntryKind::Drawing => atomic_create_drawing(&target),
            WorkspaceEntryKind::Directory => fs::create_dir(&target).map_err(|source| {
                if source.kind() == io::ErrorKind::AlreadyExists {
                    AppError::NameConflict(target.clone())
                } else {
                    AppError::Io {
                        path: Some(target.clone()),
                        source,
                    }
                }
            }),
        };
        if let Err(error) = create_result {
            self.forget_pending_operation(&operation_id).await;
            return Err(error);
        }

        let parent_relative_path = normalized_relative(&root, &parent)?;
        let entry = entry_from_path(
            &workspace.id,
            &root,
            &parent_relative_path,
            &target,
            request.kind,
        )?;
        if request.kind == WorkspaceEntryKind::Drawing {
            self.index_entry(&workspace, &entry).await?;
        }
        Ok(EntryMutationResult {
            operation_id,
            entry,
        })
    }

    async fn rename_inner(
        &self,
        request: WorkspaceEntryRenameRequest,
    ) -> Result<WorkspaceEntryRenameResult, AppError> {
        let _workspace_guard = self.mutation_gate.acquire(&request.workspace_id).await;
        reconcile_pending_mutations(&self.repository, &self.recovery).await?;
        let workspace = workspace_by_id(&self.repository, &request.workspace_id).await?;
        let root = PathBuf::from(&workspace.root_path);
        let source = self
            .resolve_entry(&workspace, &request.relative_path)
            .await?;
        let base_name = validate_entry_base_name(&request.base_name)?;
        let suffix = match source.kind {
            WorkspaceEntryKind::Drawing => drawing_suffix(&source.name)
                .ok_or_else(|| AppError::PathAccessDenied(source.path.clone()))?,
            WorkspaceEntryKind::Directory => String::new(),
        };
        let target_name = format!("{base_name}{suffix}");
        let parent = source
            .path
            .parent()
            .ok_or_else(|| AppError::PathAccessDenied(source.path.clone()))?;
        let target = authorize_creation(&self.repository, parent, &target_name).await?;
        reject_symlink_components(&root, &target)?;
        ensure_target_absent(&target)?;

        let path_migrations =
            expected_path_migrations(&source, &target, &request.expected_open_documents)?;
        let old_canonical_path = source.path.display().to_string();
        let old_relative_path = source.relative_path.clone();
        let new_relative_path = normalized_relative(&root, &target)?;
        let new_display_name = target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_owned();
        let operation_id = Uuid::new_v4().to_string();

        let mut record = MutationJournalRecord::rename(
            operation_id.clone(),
            request.workspace_id.clone(),
            old_canonical_path.clone(),
            target.display().to_string(),
            old_relative_path.clone(),
            new_relative_path.clone(),
            new_display_name,
        );
        save_journal(&self.recovery, &record)?;
        self.note_pending_operation(
            &operation_id,
            &request.workspace_id,
            watcher_echoes_for_rename(&source.path, &old_relative_path, &new_relative_path),
        )
        .await;

        let old_path = source.path.clone();
        let new_path = target.clone();
        let rename_result = run_blocking(move || {
            fs::rename(&old_path, &new_path).map_err(|source| {
                if source.kind() == io::ErrorKind::AlreadyExists {
                    AppError::NameConflict(new_path.clone())
                } else {
                    AppError::Io {
                        path: Some(new_path.clone()),
                        source,
                    }
                }
            })
        })
        .await;
        if let Err(error) = rename_result {
            delete_journal(&self.recovery, &operation_id)?;
            self.forget_pending_operation(&operation_id).await;
            return Err(error);
        }

        let _ = apply_committed_record_with_skip(
            &self.repository,
            &self.recovery,
            &mut record,
            self.skip_sqlite(),
            self.skip_recovery(),
        )
        .await;

        let parent_relative_path = target
            .parent()
            .map(|parent| normalized_relative(&root, parent))
            .transpose()?
            .unwrap_or_default();
        let entry = entry_from_path(
            &workspace.id,
            &root,
            &parent_relative_path,
            &target,
            source.kind,
        )?;
        Ok(WorkspaceEntryRenameResult {
            operation_id,
            entry,
            old_relative_path,
            new_relative_path,
            path_migrations,
        })
    }

    async fn delete_preflight_inner(
        &self,
        request: WorkspaceEntryPathRequest,
    ) -> Result<WorkspaceEntryDeletePreflightResult, AppError> {
        let _workspace_guard = self.mutation_gate.acquire(&request.workspace_id).await;
        reconcile_pending_mutations(&self.repository, &self.recovery).await?;
        let workspace = workspace_by_id(&self.repository, &request.workspace_id).await?;
        let source = self
            .resolve_entry(&workspace, &request.relative_path)
            .await?;
        let non_empty =
            source.kind == WorkspaceEntryKind::Directory && directory_has_children(&source.path)?;
        let entry = source.into_entry()?;
        if non_empty {
            return Ok(WorkspaceEntryDeletePreflightResult::DirectoryNotEmpty { entry });
        }
        Ok(WorkspaceEntryDeletePreflightResult::Confirmable { entry })
    }

    async fn delete_inner(
        &self,
        request: WorkspaceEntryDeleteRequest,
    ) -> Result<WorkspaceEntryDeleteResult, AppError> {
        let _workspace_guard = self.mutation_gate.acquire(&request.workspace_id).await;
        reconcile_pending_mutations(&self.repository, &self.recovery).await?;
        let workspace = workspace_by_id(&self.repository, &request.workspace_id).await?;
        let source = self
            .resolve_entry(&workspace, &request.relative_path)
            .await?;
        if source.kind == WorkspaceEntryKind::Directory && directory_has_children(&source.path)? {
            return Err(AppError::DirectoryNotEmpty(source.path));
        }

        let canonical_path = source.path.display().to_string();
        let draft = self.repository.draft_get(canonical_path.clone()).await?;
        if draft.as_ref().is_some_and(|draft| draft.is_dirty) {
            return Err(AppError::ConflictPending(source.path));
        }
        if let Some(expected) = request.expected_open_document {
            if expected.relative_path != source.relative_path
                || source.kind != WorkspaceEntryKind::Drawing
                || hash_file(&source.path)? != expected.base_hash
            {
                return Err(AppError::EntryChanged(source.path));
            }
        }

        let trash = Arc::clone(&self.trash);
        let target = source.path.clone();
        let operation_id = Uuid::new_v4().to_string();
        let mut record = MutationJournalRecord::delete(
            operation_id.clone(),
            request.workspace_id.clone(),
            canonical_path.clone(),
            source.relative_path.clone(),
        );
        save_journal(&self.recovery, &record)?;
        self.note_pending_operation(
            &operation_id,
            &request.workspace_id,
            vec![(
                source.relative_path.clone(),
                crate::watcher::WatcherEchoKind::Removed,
            )],
        )
        .await;
        let trash_result = run_blocking(move || {
            trash.delete(&target).map_err(|source| AppError::Io {
                path: Some(target),
                source,
            })
        })
        .await;
        if let Err(error) = trash_result {
            delete_journal(&self.recovery, &operation_id)?;
            self.forget_pending_operation(&operation_id).await;
            return Err(error);
        }
        let _ = apply_committed_record_with_skip(
            &self.repository,
            &self.recovery,
            &mut record,
            self.skip_sqlite(),
            self.skip_recovery(),
        )
        .await;
        Ok(WorkspaceEntryDeleteResult {
            operation_id,
            kind: source.kind,
            old_relative_path: source.relative_path,
        })
    }

    async fn reveal_inner(
        &self,
        request: WorkspaceEntryPathRequest,
    ) -> Result<EmptyResponse, AppError> {
        let _workspace_guard = self.mutation_gate.acquire(&request.workspace_id).await;
        reconcile_pending_mutations(&self.repository, &self.recovery).await?;
        let workspace = workspace_by_id(&self.repository, &request.workspace_id).await?;
        let source = self
            .resolve_entry(&workspace, &request.relative_path)
            .await?;
        let path = source.path;
        run_blocking(move || reveal_in_finder(&path)).await?;
        Ok(EmptyResponse {})
    }

    async fn authorize_parent(
        &self,
        workspace: &WorkspaceRecord,
        relative_path: &str,
    ) -> Result<PathBuf, AppError> {
        let root = PathBuf::from(&workspace.root_path);
        let relative = safe_relative_path(relative_path)?;
        let parent = root.join(relative);
        reject_protected_parent(&root, &parent)?;
        reject_symlink_components(&root, &parent)?;
        let policy = policy_for_repository(&self.repository).await?;
        let authorized = policy.authorize_existing(&parent)?;
        let metadata = fs::metadata(&authorized).map_err(|source| AppError::Io {
            path: Some(authorized.clone()),
            source,
        })?;
        if metadata.is_dir() {
            Ok(authorized)
        } else {
            Err(AppError::PathAccessDenied(authorized))
        }
    }

    async fn resolve_entry(
        &self,
        workspace: &WorkspaceRecord,
        relative_path: &str,
    ) -> Result<EntryLocation, AppError> {
        let root = PathBuf::from(&workspace.root_path);
        let relative = safe_relative_path(relative_path)?;
        if relative.as_os_str().is_empty() {
            return Err(AppError::EntryProtected(root));
        }
        let requested = root.join(relative);
        reject_protected_parent(&root, &requested)?;
        reject_symlink_components(&root, &requested)?;
        let policy = policy_for_repository(&self.repository).await?;
        let path = policy.authorize_existing(&requested)?;
        let metadata = fs::symlink_metadata(&path).map_err(|source| {
            if source.kind() == io::ErrorKind::NotFound {
                AppError::FileNotFound(path.clone())
            } else {
                AppError::Io {
                    path: Some(path.clone()),
                    source,
                }
            }
        })?;
        if metadata.file_type().is_symlink() {
            return Err(AppError::EntryProtected(path));
        }
        let kind = if metadata.is_dir() {
            WorkspaceEntryKind::Directory
        } else if metadata.is_file() && is_supported_document(&path) {
            WorkspaceEntryKind::Drawing
        } else {
            return Err(AppError::PathAccessDenied(path));
        };
        let relative_path = normalized_relative(&root, &path)?;
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| AppError::PathAccessDenied(path.clone()))?
            .to_owned();
        Ok(EntryLocation {
            workspace_id: workspace.id.clone(),
            root,
            path,
            relative_path,
            name,
            kind,
        })
    }

    async fn index_entry(
        &self,
        workspace: &WorkspaceRecord,
        entry: &WorkspaceEntry,
    ) -> Result<(), AppError> {
        self.repository
            .file_index_upsert(FileIndexRecord {
                canonical_path: entry.canonical_path.clone(),
                workspace_id: workspace.id.clone(),
                display_name: entry.name.clone(),
                relative_path: entry.relative_path.clone(),
                mtime: entry.mtime,
                file_size: entry.file_size,
                content_hash: None,
            })
            .await
            .map_err(Into::into)
    }
}

struct EntryLocation {
    workspace_id: String,
    root: PathBuf,
    path: PathBuf,
    relative_path: String,
    name: String,
    kind: WorkspaceEntryKind,
}

impl EntryLocation {
    fn into_entry(self) -> Result<WorkspaceEntry, AppError> {
        let parent_relative_path = self
            .path
            .parent()
            .map(|parent| normalized_relative(&self.root, parent))
            .transpose()?
            .unwrap_or_default();
        entry_from_path(
            &self.workspace_id,
            &self.root,
            &parent_relative_path,
            &self.path,
            self.kind,
        )
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

fn reject_protected_parent(root: &Path, path: &Path) -> Result<(), AppError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| AppError::PathAccessDenied(path.to_path_buf()))?;
    for component in relative.components() {
        let name = component.as_os_str().to_string_lossy();
        if is_protected_entry_name(&name) {
            return Err(AppError::EntryProtected(path.to_path_buf()));
        }
    }
    Ok(())
}

fn reject_symlink_components(root: &Path, path: &Path) -> Result<(), AppError> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| AppError::PathAccessDenied(path.to_path_buf()))?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(AppError::EntryProtected(current));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(source) => {
                return Err(AppError::Io {
                    path: Some(current),
                    source,
                });
            }
        }
    }
    Ok(())
}

fn ensure_target_absent(target: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(target) {
        Ok(_) => Err(AppError::NameConflict(target.to_path_buf())),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(AppError::Io {
            path: Some(target.to_path_buf()),
            source,
        }),
    }
}

async fn authorize_creation(
    repository: &SqliteRepository,
    parent: &Path,
    name: &str,
) -> Result<PathBuf, AppError> {
    let policy = policy_for_repository(repository).await?;
    policy
        .authorize_for_creation(&parent.join(name))
        .map_err(Into::into)
}

fn atomic_create_drawing(target: &Path) -> Result<(), AppError> {
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = target
        .file_name()
        .ok_or_else(|| AppError::PathAccessDenied(target.to_path_buf()))?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        file_name.to_string_lossy(),
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|source| AppError::Io {
                path: Some(temporary.clone()),
                source,
            })?;
        file.write_all(EMPTY_SCENE).map_err(|source| AppError::Io {
            path: Some(temporary.clone()),
            source,
        })?;
        file.sync_all().map_err(|source| AppError::Io {
            path: Some(temporary.clone()),
            source,
        })?;
        serde_json::from_slice::<serde_json::Value>(EMPTY_SCENE)
            .map_err(|source| AppError::InvalidScene(source.to_string()))?;
        // Hard-link publish is atomic and cannot overwrite a target created
        // by a concurrent external process, unlike a plain rename.
        fs::hard_link(&temporary, target).map_err(|source| {
            if source.kind() == io::ErrorKind::AlreadyExists {
                AppError::NameConflict(target.to_path_buf())
            } else {
                AppError::Io {
                    path: Some(target.to_path_buf()),
                    source,
                }
            }
        })?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|source| AppError::Io {
                path: Some(parent.to_path_buf()),
                source,
            })?;
        Ok(())
    })();
    let cleanup = fs::remove_file(&temporary);
    match (result, cleanup) {
        (Err(error), Err(cleanup_error)) if cleanup_error.kind() != io::ErrorKind::NotFound => {
            let _ = cleanup_error;
            Err(error)
        }
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(AppError::Io {
            path: Some(temporary),
            source: error,
        }),
        (Ok(()), Ok(())) => Ok(()),
    }
}

fn directory_has_children(path: &Path) -> Result<bool, AppError> {
    let mut entries = fs::read_dir(path).map_err(|source| AppError::Io {
        path: Some(path.to_path_buf()),
        source,
    })?;
    Ok(entries
        .next()
        .transpose()
        .map_err(|source| AppError::Io {
            path: Some(path.to_path_buf()),
            source,
        })?
        .is_some())
}

fn expected_path_migrations(
    source: &EntryLocation,
    target: &Path,
    expected_documents: &[ExpectedOpenDocument],
) -> Result<Vec<PathMigration>, AppError> {
    let mut seen = HashSet::new();
    let mut migrations = Vec::with_capacity(expected_documents.len());
    for expected in expected_documents {
        let relative = safe_relative_path(&expected.relative_path)?
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let valid_source = match source.kind {
            WorkspaceEntryKind::Drawing => relative == source.relative_path,
            WorkspaceEntryKind::Directory => {
                relative == source.relative_path
                    || relative
                        .strip_prefix(&source.relative_path)
                        .is_some_and(|suffix| suffix.starts_with('/'))
            }
        };
        if !valid_source || !seen.insert(relative.clone()) {
            return Err(AppError::EntryChanged(source.path.clone()));
        }

        let old_path = source.root.join(Path::new(&relative));
        reject_symlink_components(&source.root, &old_path)?;
        let old_path = old_path
            .canonicalize()
            .map_err(|source_error| AppError::Io {
                path: Some(old_path.clone()),
                source: source_error,
            })?;
        let metadata = fs::metadata(&old_path).map_err(|source_error| AppError::Io {
            path: Some(old_path.clone()),
            source: source_error,
        })?;
        if !metadata.is_file() || !is_supported_document(&old_path) {
            return Err(AppError::EntryChanged(old_path));
        }
        if hash_file(&old_path)? != expected.base_hash {
            return Err(AppError::EntryChanged(old_path));
        }

        let suffix = relative
            .strip_prefix(&source.relative_path)
            .unwrap_or_default()
            .trim_start_matches('/');
        let new_root = normalized_relative(&source.root, target)?;
        let new_relative = if source.kind == WorkspaceEntryKind::Drawing || suffix.is_empty() {
            new_root.clone()
        } else {
            format!("{new_root}/{suffix}")
        };
        let new_canonical = if source.kind == WorkspaceEntryKind::Drawing || suffix.is_empty() {
            target.display().to_string()
        } else {
            target.join(suffix).display().to_string()
        };
        migrations.push(PathMigration {
            old_relative_path: relative,
            new_relative_path: new_relative,
            old_canonical_path: old_path.display().to_string(),
            new_canonical_path: new_canonical,
        });
    }
    Ok(migrations)
}

fn watcher_echoes_for_rename(
    source: &Path,
    old_relative: &str,
    new_relative: &str,
) -> Vec<(String, crate::watcher::WatcherEchoKind)> {
    use crate::watcher::WatcherEchoKind;
    let mut relatives = vec![old_relative.to_owned()];
    if source.is_dir() {
        collect_descendant_relatives(source, old_relative, &mut relatives);
    }
    let mut echoes = Vec::with_capacity(relatives.len() * 2);
    for old in relatives {
        let new = migrate_path(&old, old_relative, new_relative);
        echoes.push((old, WatcherEchoKind::Removed));
        echoes.push((new, WatcherEchoKind::Created));
    }
    echoes
}

fn collect_descendant_relatives(directory: &Path, relative: &str, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let child_relative = format!("{relative}/{name}");
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            out.push(child_relative);
            continue;
        }
        if metadata.is_dir() {
            collect_descendant_relatives(&path, &child_relative, out);
        }
        out.push(child_relative);
    }
}

fn hash_file(path: &Path) -> Result<String, AppError> {
    let bytes = fs::read(path).map_err(|source| AppError::Io {
        path: Some(path.to_path_buf()),
        source,
    })?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn reveal_in_finder(path: &Path) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        let path_string = path.display().to_string();
        let status = Command::new("open")
            .args(["-R", path_string.as_str()])
            .status()
            .map_err(|source| AppError::Io {
                path: Some(path.to_path_buf()),
                source,
            })?;
        if !status.success() {
            return Err(AppError::Internal(format!(
                "Finder failed to reveal {}",
                path.display()
            )));
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Finder is a macOS-only surface. Keep this command deterministic on
        // community-validation platforms instead of spawning an arbitrary
        // desktop opener from an IPC request.
        let _ = path;
    }
    Ok(())
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

async fn run_blocking<T, F>(operation: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| AppError::Internal(format!("blocking entry task failed: {error}")))?
}

fn isolated_recovery_store() -> Arc<RecoveryStore> {
    Arc::new(RecoveryStore::new(
        std::env::temp_dir().join(format!("excalidraw-entry-recovery-{}", Uuid::new_v4())),
    ))
}

fn drawing_display_name(name: &str) -> String {
    name.strip_suffix(".excalidraw.json")
        .or_else(|| name.strip_suffix(".excalidraw"))
        .unwrap_or(name)
        .to_owned()
}

fn drawing_suffix(name: &str) -> Option<String> {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".excalidraw.json") {
        Some(name[name.len() - ".excalidraw.json".len()..].to_owned())
    } else if lower.ends_with(".excalidraw") {
        Some(name[name.len() - ".excalidraw".len()..].to_owned())
    } else {
        None
    }
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
