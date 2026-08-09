//! Workspace indexing domain.

use std::{path::PathBuf, sync::Arc};

use tauri::{AppHandle, Emitter};

use crate::{
    commands::{
        dto::IndexProgressEvent,
        error::AppError,
        workspace::{is_supported_document, modified_timestamp},
    },
    database::repository::{
        FileIndexRecord, FileIndexRepository, SqliteRepository, WorkspaceRecord,
    },
};

#[derive(Clone)]
pub struct Indexer {
    repository: Arc<SqliteRepository>,
}

impl Indexer {
    pub fn new(repository: Arc<SqliteRepository>) -> Self {
        Self { repository }
    }

    pub fn spawn(&self, workspace: WorkspaceRecord, app: Option<AppHandle>) {
        let indexer = self.clone();
        tokio::spawn(async move {
            let _ = indexer.index_workspace(workspace, app).await;
        });
    }

    pub async fn index_workspace(
        &self,
        workspace: WorkspaceRecord,
        app: Option<AppHandle>,
    ) -> Result<u64, AppError> {
        let repository = Arc::clone(&self.repository);
        tokio::task::spawn_blocking(move || index_workspace_blocking(repository, workspace, app))
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?
    }
}

fn index_workspace_blocking(
    repository: Arc<SqliteRepository>,
    workspace: WorkspaceRecord,
    app: Option<AppHandle>,
) -> Result<u64, AppError> {
    let root = PathBuf::from(&workspace.root_path);
    let mut stack = vec![root.clone()];
    let mut scanned = 0_u64;
    while let Some(directory) = stack.pop() {
        let entries = std::fs::read_dir(&directory).map_err(|source| AppError::Io {
            path: Some(directory.clone()),
            source,
        })?;
        for entry in entries {
            let entry = entry.map_err(|source| AppError::Io {
                path: Some(directory.clone()),
                source,
            })?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(|source| AppError::Io {
                path: Some(path.clone()),
                source,
            })?;
            let file_type = metadata.file_type();
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if !file_type.is_file() || !is_supported_document(&path) {
                continue;
            }
            let relative_path = path
                .strip_prefix(&root)
                .map_err(|_| AppError::PathAccessDenied(path.clone()))?
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            let mtime = modified_timestamp(&metadata, &path)?;
            tauri::async_runtime::block_on(
                repository.file_index_upsert(FileIndexRecord {
                    canonical_path: path
                        .canonicalize()
                        .map_err(|source| AppError::Io {
                            path: Some(path.clone()),
                            source,
                        })?
                        .display()
                        .to_string(),
                    workspace_id: workspace.id.clone(),
                    display_name: entry.file_name().to_string_lossy().into_owned(),
                    relative_path,
                    mtime,
                    file_size: metadata.len() as i64,
                    content_hash: None,
                }),
            )
            .map_err(AppError::from)?;
            scanned += 1;
            emit_progress(app.as_ref(), &workspace.id, scanned, false);
        }
    }
    emit_progress(app.as_ref(), &workspace.id, scanned, true);
    Ok(scanned)
}

fn emit_progress(app: Option<&AppHandle>, workspace_id: &str, scanned: u64, done: bool) {
    if let Some(app) = app {
        let _ = app.emit(
            "index-progress",
            IndexProgressEvent {
                workspace_id: workspace_id.to_owned(),
                scanned,
                total: None,
                done,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::database::repository::WorkspaceRepository;

    #[tokio::test]
    async fn indexes_only_supported_documents_and_skips_symlink_entries() {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-index-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("drawing.excalidraw"), b"{}").unwrap();
        fs::write(root.join("nested/second.excalidraw.json"), b"{}").unwrap();
        fs::write(root.join("notes.txt"), b"ignored").unwrap();
        let repository = Arc::new(
            SqliteRepository::open(&root.join("state.sqlite3"))
                .await
                .unwrap(),
        );
        let workspace = WorkspaceRecord {
            id: "workspace".into(),
            name: "Workspace".into(),
            root_path: root.display().to_string(),
            created_at: 1,
        };
        repository
            .workspace_upsert(workspace.clone())
            .await
            .unwrap();
        let count = Indexer::new(Arc::clone(&repository))
            .index_workspace(workspace, None)
            .await
            .unwrap();
        assert_eq!(count, 2);
        assert_eq!(
            repository
                .file_index_list("workspace".into())
                .await
                .unwrap()
                .len(),
            2
        );
        drop(repository);
        let _ = fs::remove_dir_all(root);
    }
}
