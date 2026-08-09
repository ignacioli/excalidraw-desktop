use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use tauri::State;

use crate::{
    commands::{
        dto::{EmptyResponse, FileCreateRequest, FileEntry, FileRenameRequest, PathRequest},
        error::{AppError, IpcError},
        workspace::{
            is_supported_document, modified_timestamp, policy_for_repository, safe_relative_path,
            workspace_by_id,
        },
    },
    database::repository::{
        FileIndexRecord, FileIndexRepository, FileMetaRepository, SqliteRepository,
        WorkspaceRepository,
    },
    documents::atomic_write::atomic_write,
};

const EMPTY_SCENE: &[u8] = br#"{"type":"excalidraw","version":2,"source":"excalidraw-desktop","elements":[],"appState":{},"files":{}}"#;

#[derive(Clone)]
pub struct FileService {
    repository: Arc<SqliteRepository>,
}

impl FileService {
    pub fn new(repository: Arc<SqliteRepository>) -> Self {
        Self { repository }
    }

    pub async fn create(&self, request: FileCreateRequest) -> Result<FileEntry, IpcError> {
        self.create_inner(request).await.map_err(Into::into)
    }

    async fn create_inner(&self, request: FileCreateRequest) -> Result<FileEntry, AppError> {
        let workspace = workspace_by_id(&self.repository, &request.workspace_id).await?;
        let relative = safe_relative_path(&request.relative_path)?;
        let root = PathBuf::from(&workspace.root_path);
        let requested = root.join(relative);
        if !is_supported_document(&requested) {
            return Err(AppError::PathAccessDenied(requested));
        }
        let policy = policy_for_repository(&self.repository).await?;
        let target = policy.authorize_for_creation(&requested)?;
        if target.exists() {
            return Err(AppError::Io {
                path: Some(target),
                source: std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "file already exists",
                ),
            });
        }
        let write_target = target.clone();
        tokio::task::spawn_blocking(move || {
            atomic_write(&write_target, EMPTY_SCENE).map_err(AppError::from)
        })
        .await
        .map_err(|error| AppError::Internal(error.to_string()))??;
        self.entry_for_path(&workspace.id, &root, &target).await
    }

    pub async fn rename(&self, request: FileRenameRequest) -> Result<FileEntry, IpcError> {
        self.rename_inner(request).await.map_err(Into::into)
    }

    async fn rename_inner(&self, request: FileRenameRequest) -> Result<FileEntry, AppError> {
        let policy = policy_for_repository(&self.repository).await?;
        let source = policy.authorize_existing(Path::new(&request.path))?;
        let metadata = fs::metadata(&source).map_err(|error| AppError::Io {
            path: Some(source.clone()),
            source: error,
        })?;
        if !metadata.is_file() || !is_supported_document(&source) {
            return Err(AppError::PathAccessDenied(source));
        }
        if request.new_name.is_empty()
            || Path::new(&request.new_name)
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
            || !is_supported_document(Path::new(&request.new_name))
        {
            return Err(AppError::PathAccessDenied(PathBuf::from(request.new_name)));
        }
        let parent = source
            .parent()
            .ok_or_else(|| AppError::PathAccessDenied(source.clone()))?;
        let target = policy.authorize_for_creation(&parent.join(&request.new_name))?;
        if target.exists() {
            return Err(AppError::Io {
                path: Some(target),
                source: std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    "file already exists",
                ),
            });
        }
        let old_path = source.clone();
        let new_path = target.clone();
        tokio::task::spawn_blocking(move || {
            fs::rename(&old_path, &new_path).map_err(|source| AppError::Io {
                path: Some(new_path.clone()),
                source,
            })
        })
        .await
        .map_err(|error| AppError::Internal(error.to_string()))??;

        let old_canonical = source.display().to_string();
        self.repository.file_index_delete(old_canonical).await?;
        let workspace = owning_workspace(&self.repository, &target).await?;
        self.entry_for_path(&workspace.id, Path::new(&workspace.root_path), &target)
            .await
    }

    pub async fn delete(&self, request: PathRequest) -> Result<EmptyResponse, IpcError> {
        self.delete_inner(request).await.map_err(Into::into)
    }

    async fn delete_inner(&self, request: PathRequest) -> Result<EmptyResponse, AppError> {
        let policy = policy_for_repository(&self.repository).await?;
        let target = policy.authorize_existing(Path::new(&request.path))?;
        let metadata = fs::metadata(&target).map_err(|source| AppError::Io {
            path: Some(target.clone()),
            source,
        })?;
        if !metadata.is_file() || !is_supported_document(&target) {
            return Err(AppError::PathAccessDenied(target));
        }
        let trash_target = target.clone();
        tokio::task::spawn_blocking(move || {
            trash::delete(&trash_target).map_err(|error| AppError::Io {
                path: Some(trash_target.clone()),
                source: std::io::Error::other(error.to_string()),
            })
        })
        .await
        .map_err(|error| AppError::Internal(error.to_string()))??;
        let canonical = target.display().to_string();
        self.repository.file_index_delete(canonical.clone()).await?;
        self.repository.file_meta_delete(canonical).await?;
        Ok(EmptyResponse {})
    }

    async fn entry_for_path(
        &self,
        workspace_id: &str,
        root: &Path,
        path: &Path,
    ) -> Result<FileEntry, AppError> {
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
        let display_name = canonical
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| AppError::PathAccessDenied(canonical.clone()))?
            .to_owned();
        let relative_path = canonical
            .strip_prefix(root)
            .map_err(|_| AppError::PathAccessDenied(canonical.clone()))?
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let mtime = modified_timestamp(&metadata, &canonical)?;
        self.repository
            .file_index_upsert(FileIndexRecord {
                canonical_path: canonical.display().to_string(),
                workspace_id: workspace_id.to_owned(),
                display_name: display_name.clone(),
                relative_path: relative_path.clone(),
                mtime,
                file_size: metadata.len() as i64,
                content_hash: None,
            })
            .await?;
        Ok(FileEntry {
            canonical_path: canonical.display().to_string(),
            workspace_id: workspace_id.to_owned(),
            display_name,
            relative_path,
            mtime,
            file_size: metadata.len() as i64,
        })
    }
}

#[derive(Clone)]
pub struct FileState {
    pub service: FileService,
}

impl FileState {
    pub fn new(repository: Arc<SqliteRepository>) -> Self {
        Self {
            service: FileService::new(repository),
        }
    }
}

#[tauri::command]
pub async fn file_create(
    workspace_id: String,
    relative_path: String,
    state: State<'_, FileState>,
) -> Result<FileEntry, IpcError> {
    state
        .service
        .create(FileCreateRequest {
            workspace_id,
            relative_path,
        })
        .await
}

#[tauri::command]
pub async fn file_rename(
    path: String,
    new_name: String,
    state: State<'_, FileState>,
) -> Result<FileEntry, IpcError> {
    state
        .service
        .rename(FileRenameRequest { path, new_name })
        .await
}

#[tauri::command]
pub async fn file_delete(
    path: String,
    state: State<'_, FileState>,
) -> Result<EmptyResponse, IpcError> {
    state.service.delete(PathRequest { path }).await
}

async fn owning_workspace(
    repository: &SqliteRepository,
    path: &Path,
) -> Result<crate::database::repository::WorkspaceRecord, AppError> {
    let workspaces = repository.workspace_list().await?;
    workspaces
        .into_iter()
        .find(|workspace| path.starts_with(Path::new(&workspace.root_path)))
        .ok_or_else(|| AppError::PathAccessDenied(path.to_path_buf()))
}
