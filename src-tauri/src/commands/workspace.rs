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
    documents::assets::{asset_garbage_error, collect_garbage, scan_referenced_hashes},
    indexing::Indexer,
    security::WorkspacePathPolicy,
    watcher::WatcherState,
};

use super::{
    dto::{EmptyResponse, Workspace, WorkspaceAddRequest, WorkspaceRemoveRequest},
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
        let root = PathBuf::from(&workspace.root_path);
        let scan_root = root.clone();
        let referenced = tokio::task::spawn_blocking(move || scan_referenced_hashes(&scan_root))
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;
        let garbage_root = root;
        tokio::task::spawn_blocking(move || {
            collect_garbage(&garbage_root, &referenced).map_err(asset_garbage_error)
        })
        .await
        .map_err(|error| AppError::Internal(error.to_string()))??;
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
