use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::{
    database::repository::{SqliteRepository, WorkspaceRecord, WorkspaceRepository},
    indexing::Indexer,
    security::WorkspacePathPolicy,
    watcher::WatcherState,
};

use super::{
    dto::{
        DirEntry, DirEntryKind, DirListRequest, EmptyResponse, Workspace, WorkspaceAddRequest,
        WorkspaceRemoveRequest,
    },
    error::{AppError, IpcError},
};

#[derive(Clone)]
pub struct WorkspaceService {
    pub(crate) repository: Arc<SqliteRepository>,
}

impl WorkspaceService {
    pub fn new(repository: Arc<SqliteRepository>) -> Self {
        Self { repository }
    }

    pub async fn add(&self, request: WorkspaceAddRequest) -> Result<Workspace, IpcError> {
        self.add_inner(request).await.map_err(Into::into)
    }

    async fn add_inner(&self, request: WorkspaceAddRequest) -> Result<Workspace, AppError> {
        let requested = PathBuf::from(request.root_path);
        let canonical = requested.canonicalize().map_err(|source| AppError::Io {
            path: Some(requested.clone()),
            source,
        })?;
        if !canonical.is_dir() {
            return Err(AppError::PathAccessDenied(canonical));
        }

        let current = self.repository.workspace_list().await?;
        let mut roots = current
            .iter()
            .map(|workspace| Path::new(&workspace.root_path).to_path_buf())
            .collect::<Vec<_>>();
        roots.push(canonical.clone());
        WorkspacePathPolicy::new(roots).map_err(|error| match error {
            crate::security::PathSecurityError::WorkspaceOverlap { first, second } => {
                AppError::WorkspaceOverlap(format!("{} and {}", first.display(), second.display()))
            }
            other => AppError::from(other),
        })?;

        let name = request
            .name
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                canonical
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("Workspace")
                    .to_owned()
            });
        let record = WorkspaceRecord {
            id: Uuid::new_v4().to_string(),
            name,
            root_path: canonical.display().to_string(),
            created_at: unix_timestamp()?,
        };
        self.repository.workspace_upsert(record.clone()).await?;
        Ok(record.into())
    }

    pub async fn remove(&self, request: WorkspaceRemoveRequest) -> Result<EmptyResponse, IpcError> {
        let workspace = self
            .repository
            .workspace_get(request.workspace_id.clone())
            .await
            .map_err(AppError::from)?
            .ok_or(AppError::WorkspaceNotFound(request.workspace_id))?;
        self.repository
            .workspace_delete(workspace.id)
            .await
            .map_err(AppError::from)?;
        Ok(EmptyResponse {})
    }

    pub async fn list(&self) -> Result<Vec<Workspace>, IpcError> {
        self.repository
            .workspace_list()
            .await
            .map(|items| items.into_iter().map(Into::into).collect())
            .map_err(|error| IpcError::from(AppError::from(error)))
    }

    pub async fn dir_list(&self, request: DirListRequest) -> Result<Vec<DirEntry>, IpcError> {
        self.dir_list_inner(request).await.map_err(Into::into)
    }

    async fn dir_list_inner(&self, request: DirListRequest) -> Result<Vec<DirEntry>, AppError> {
        let workspace = self
            .repository
            .workspace_get(request.workspace_id.clone())
            .await?
            .ok_or(AppError::WorkspaceNotFound(request.workspace_id))?;
        let root = PathBuf::from(&workspace.root_path);
        let policy = policy_for_repository(&self.repository).await?;
        let relative = safe_relative_path(&request.relative_path)?;
        let requested = root.join(relative);
        let directory = policy.authorize_existing(&requested)?;
        let metadata = fs::metadata(&directory).map_err(|source| AppError::Io {
            path: Some(directory.clone()),
            source,
        })?;
        if !metadata.is_dir() {
            return Err(AppError::PathAccessDenied(directory));
        }

        let mut entries = Vec::new();
        for entry in fs::read_dir(&directory).map_err(|source| AppError::Io {
            path: Some(directory.clone()),
            source,
        })? {
            let entry = entry.map_err(|source| AppError::Io {
                path: Some(directory.clone()),
                source,
            })?;
            let path = entry.path();
            let file_type = entry.file_type().map_err(|source| AppError::Io {
                path: Some(path.clone()),
                source,
            })?;
            if file_type.is_symlink() {
                continue;
            }
            let metadata = entry.metadata().map_err(|source| AppError::Io {
                path: Some(path.clone()),
                source,
            })?;
            let relative_path = path
                .strip_prefix(&root)
                .map_err(|_| AppError::PathAccessDenied(path.clone()))?;
            let relative_path = relative_path
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            let kind = if file_type.is_dir() {
                DirEntryKind::Dir
            } else if file_type.is_file() && is_supported_document(&path) {
                DirEntryKind::File
            } else {
                continue;
            };
            entries.push(DirEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                relative_path,
                kind,
                mtime: modified_timestamp(&metadata, &path)?,
                file_size: if kind == DirEntryKind::File {
                    metadata.len() as i64
                } else {
                    0
                },
            });
        }
        entries.sort_by(|left, right| {
            (
                left.kind != DirEntryKind::Dir,
                left.name.to_ascii_lowercase(),
            )
                .cmp(&(
                    right.kind != DirEntryKind::Dir,
                    right.name.to_ascii_lowercase(),
                ))
        });
        Ok(entries)
    }

    pub async fn start_index(&self, workspace: WorkspaceRecord, app: Option<AppHandle>) {
        Indexer::new(Arc::clone(&self.repository)).spawn(workspace, app);
    }
}

#[derive(Clone)]
pub struct WorkspaceState {
    pub service: WorkspaceService,
}

impl WorkspaceState {
    pub fn new(repository: Arc<SqliteRepository>) -> Self {
        Self {
            service: WorkspaceService::new(repository),
        }
    }
}

#[tauri::command]
pub async fn workspace_add(
    root_path: String,
    name: Option<String>,
    app: AppHandle,
    state: State<'_, WorkspaceState>,
    watcher: State<'_, WatcherState>,
) -> Result<Workspace, IpcError> {
    let workspace = state
        .service
        .add(WorkspaceAddRequest { root_path, name })
        .await?;
    let record = WorkspaceRecord {
        id: workspace.id.clone(),
        name: workspace.name.clone(),
        root_path: workspace.root_path.clone(),
        created_at: workspace.created_at,
    };
    state
        .service
        .start_index(record.clone(), Some(app.clone()))
        .await;
    watcher
        .service
        .spawn_for_workspace(record, app)
        .await
        .map_err(IpcError::from)?;
    Ok(workspace)
}

#[tauri::command]
pub async fn workspace_remove(
    workspace_id: String,
    state: State<'_, WorkspaceState>,
    watcher: State<'_, WatcherState>,
) -> Result<EmptyResponse, IpcError> {
    let response = state
        .service
        .remove(WorkspaceRemoveRequest {
            workspace_id: workspace_id.clone(),
        })
        .await?;
    watcher.service.stop_for_workspace(&workspace_id).await;
    Ok(response)
}

#[tauri::command]
pub async fn workspace_list(state: State<'_, WorkspaceState>) -> Result<Vec<Workspace>, IpcError> {
    state.service.list().await
}

#[tauri::command]
pub async fn dir_list(
    workspace_id: String,
    relative_path: String,
    state: State<'_, WorkspaceState>,
) -> Result<Vec<DirEntry>, IpcError> {
    state
        .service
        .dir_list(DirListRequest {
            workspace_id,
            relative_path,
        })
        .await
}

pub(crate) async fn policy_for_repository(
    repository: &SqliteRepository,
) -> Result<WorkspacePathPolicy, AppError> {
    let workspaces = repository.workspace_list().await?;
    WorkspacePathPolicy::new(
        workspaces
            .iter()
            .map(|workspace| Path::new(&workspace.root_path)),
    )
    .map_err(Into::into)
}

pub(crate) async fn workspace_by_id(
    repository: &SqliteRepository,
    id: &str,
) -> Result<WorkspaceRecord, AppError> {
    repository
        .workspace_get(id.to_owned())
        .await?
        .ok_or_else(|| AppError::WorkspaceNotFound(id.to_owned()))
}

pub(crate) fn safe_relative_path(value: &str) -> Result<PathBuf, AppError> {
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(AppError::PathAccessDenied(path.to_path_buf()));
    }
    Ok(path.to_path_buf())
}

pub(crate) fn is_supported_document(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|name| name.ends_with(".excalidraw") || name.ends_with(".excalidraw.json"))
}

pub(crate) fn modified_timestamp(metadata: &fs::Metadata, path: &Path) -> Result<i64, AppError> {
    metadata
        .modified()
        .map_err(|source| AppError::Io {
            path: Some(path.to_path_buf()),
            source,
        })
        .and_then(|time| {
            time.duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs() as i64)
                .map_err(|_| {
                    AppError::Internal("filesystem timestamp predates Unix epoch".to_owned())
                })
        })
}

fn unix_timestamp() -> Result<i64, AppError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .map_err(|_| AppError::Internal("system clock is before Unix epoch".to_owned()))
}

impl From<WorkspaceRecord> for Workspace {
    fn from(record: WorkspaceRecord) -> Self {
        Self {
            id: record.id,
            name: record.name,
            root_path: record.root_path,
            created_at: record.created_at,
        }
    }
}

#[allow(dead_code)]
fn emit_index_progress(
    app: &AppHandle,
    workspace_id: &str,
    scanned: u64,
    done: bool,
) -> Result<(), AppError> {
    app.emit(
        "index-progress",
        crate::commands::dto::IndexProgressEvent {
            workspace_id: workspace_id.to_owned(),
            scanned,
            total: None,
            done,
        },
    )
    .map_err(|error| AppError::Internal(error.to_string()))
}
