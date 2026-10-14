use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use uuid::Uuid;

use crate::{
    database::repository::{SqliteRepository, WorkspaceRecord, WorkspaceRepository},
    indexing::Indexer,
    security::WorkspacePathPolicy,
    watcher::WatcherState,
    window::registry::{ClaimDecision, RegistryError, WindowRegistry, WorkspaceCandidate},
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
        let retained = self.repository.workspace_recent_list().await?;
        if let Some(existing) = retained
            .into_iter()
            .find(|workspace| Path::new(&workspace.root_path) == canonical)
        {
            if existing.mounted {
                return Err(AppError::WorkspaceOverlap(existing.root_path));
            }
            validate_mount(&current, &canonical)?;
            self.repository
                .workspace_set_mounted(existing.id.clone(), true)
                .await?;
            return Ok(WorkspaceRecord {
                mounted: true,
                ..existing
            }
            .into());
        }
        validate_mount(&current, &canonical)?;

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
            mounted: true,
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
            .workspace_set_mounted(workspace.id, false)
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

    pub async fn recent_list(&self) -> Result<Vec<Workspace>, IpcError> {
        self.repository
            .workspace_recent_list()
            .await
            .map(|items| items.into_iter().map(Into::into).collect())
            .map_err(|error| IpcError::from(AppError::from(error)))
    }

    pub async fn remount(&self, workspace_id: String) -> Result<Workspace, IpcError> {
        let workspace = self
            .repository
            .workspace_get(workspace_id.clone())
            .await
            .map_err(AppError::from)?
            .ok_or(AppError::WorkspaceNotFound(workspace_id))?;
        if workspace.mounted {
            return Ok(workspace.into());
        }
        let requested = PathBuf::from(&workspace.root_path);
        let canonical = requested.canonicalize().map_err(|source| AppError::Io {
            path: Some(requested.clone()),
            source,
        })?;
        if !canonical.is_dir() {
            return Err(AppError::PathAccessDenied(canonical).into());
        }
        let current = self
            .repository
            .workspace_list()
            .await
            .map_err(AppError::from)?;
        validate_mount(&current, &canonical)?;
        self.repository
            .workspace_set_mounted(workspace.id.clone(), true)
            .await
            .map_err(AppError::from)?;
        Ok(WorkspaceRecord {
            root_path: canonical.display().to_string(),
            mounted: true,
            ..workspace
        }
        .into())
    }

    pub async fn recent_remove(&self, workspace_id: String) -> Result<EmptyResponse, IpcError> {
        let workspace = self
            .repository
            .workspace_get(workspace_id.clone())
            .await
            .map_err(AppError::from)?
            .ok_or(AppError::WorkspaceNotFound(workspace_id))?;
        if workspace.mounted {
            return Err(AppError::WorkspaceMounted(workspace.id).into());
        }
        self.repository
            .workspace_delete(workspace.id)
            .await
            .map_err(AppError::from)?;
        Ok(EmptyResponse {})
    }

    /// Canonicalize a chosen folder and find its retained record, if any.
    /// Nothing is created or mounted.
    pub(crate) async fn resolve_root(
        &self,
        root_path: &str,
    ) -> Result<(PathBuf, Option<WorkspaceRecord>), AppError> {
        let canonical = canonical_directory(Path::new(root_path))?;
        let existing = self
            .repository
            .workspace_recent_list()
            .await?
            .into_iter()
            .find(|workspace| Path::new(&workspace.root_path) == canonical);
        Ok((canonical, existing))
    }

    /// Return the retained record for `canonical`, creating an unmounted one
    /// when the folder has never been opened.
    pub(crate) async fn ensure_record(
        &self,
        canonical: &Path,
        name: Option<String>,
    ) -> Result<WorkspaceRecord, AppError> {
        if let (_, Some(existing)) = self.resolve_root(&canonical.display().to_string()).await? {
            return Ok(existing);
        }
        let name = name
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
            mounted: false,
        };
        self.repository.workspace_upsert(record.clone()).await?;
        Ok(record)
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

/// Result of asking for a Workspace in a window.
#[allow(
    dead_code,
    reason = "the window claim commands report the replaced Workspace and the declined decision"
)]
pub(crate) enum WindowClaim {
    Claimed {
        workspace: WorkspaceRecord,
        replaced: Option<String>,
    },
    Declined(ClaimDecision),
}

/// Open `root` in window `label`: decide ownership, create the retained
/// record if needed, commit the claim, mirror it to `mounted` in one
/// transaction (rolling the claim back on failure), then move the watcher
/// and start indexing.
pub(crate) async fn claim_for_window(
    app: &AppHandle,
    label: &str,
    root: PathBuf,
    record: Option<WorkspaceRecord>,
    name: Option<String>,
) -> Result<WindowClaim, AppError> {
    let registry = app.state::<WindowRegistry>();
    let service = app.state::<WorkspaceState>().service.clone();
    let candidate = WorkspaceCandidate {
        id: record.as_ref().map(|record| record.id.clone()),
        root: root.clone(),
    };
    let decision = registry.probe(label, &candidate).map_err(registry_error)?;
    if !matches!(decision, ClaimDecision::Claimable { .. }) {
        return Ok(WindowClaim::Declined(decision));
    }
    let record = match record {
        Some(record) => record,
        None => service.ensure_record(&root, name).await?,
    };
    let already_held = registry
        .window(label)
        .and_then(|window| window.workspace)
        .is_some_and(|workspace| workspace.id == record.id);
    let candidate = WorkspaceCandidate {
        id: Some(record.id.clone()),
        root,
    };
    let (decision, rollback) = registry.claim(label, &candidate).map_err(registry_error)?;
    let ClaimDecision::Claimable { replaced } = decision else {
        return Ok(WindowClaim::Declined(decision));
    };
    let workspace = WorkspaceRecord {
        mounted: true,
        ..record
    };
    if already_held {
        return Ok(WindowClaim::Claimed {
            workspace,
            replaced: None,
        });
    }
    if let Err(error) = service
        .repository
        .workspace_mount_transition(Some(workspace.id.clone()), replaced.clone())
        .await
    {
        if let Some(rollback) = rollback {
            registry.rollback_claim(rollback);
        }
        return Err(error.into());
    }
    let watcher = app.state::<WatcherState>();
    if let Some(replaced) = replaced.as_ref() {
        watcher.service.stop_for_workspace(replaced).await;
    }
    service
        .start_index(workspace.clone(), Some(app.clone()))
        .await;
    watcher
        .service
        .spawn_for_workspace(workspace.clone(), app.clone())
        .await?;
    Ok(WindowClaim::Claimed {
        workspace,
        replaced,
    })
}

/// Close the Workspace of window `label`, returning its id. The `mounted`
/// write failing puts the claim back so ownership and `mounted` agree.
pub(crate) async fn release_for_window(
    app: &AppHandle,
    label: &str,
) -> Result<Option<String>, AppError> {
    let registry = app.state::<WindowRegistry>();
    let previous = registry.window(label).and_then(|window| window.workspace);
    let Some(released) = registry.release_workspace(label).map_err(registry_error)? else {
        return Ok(None);
    };
    let service = app.state::<WorkspaceState>().service.clone();
    if let Err(error) = service
        .repository
        .workspace_mount_transition(None, Some(released.clone()))
        .await
    {
        if let Some(previous) = previous {
            let _ = registry.claim(
                label,
                &WorkspaceCandidate {
                    id: Some(previous.id),
                    root: previous.root,
                },
            );
        }
        return Err(error.into());
    }
    app.state::<WatcherState>()
        .service
        .stop_for_workspace(&released)
        .await;
    Ok(Some(released))
}

fn registry_error(error: RegistryError) -> AppError {
    AppError::Internal(error.to_string())
}

/// The error the pre-ownership commands report when another window holds
/// the Workspace or one nested with it.
fn declined_error(root: &Path) -> AppError {
    AppError::WorkspaceOverlap(root.display().to_string())
}

/// Deprecated: superseded by `window_claim_workspace`; opens the folder in
/// the calling window, replacing its Workspace.
#[tauri::command]
pub async fn workspace_add(
    root_path: String,
    name: Option<String>,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
) -> Result<Workspace, IpcError> {
    let (root, record) = state.service.resolve_root(&root_path).await?;
    match claim_for_window(&app, window.label(), root.clone(), record, name).await? {
        WindowClaim::Claimed { workspace, .. } => Ok(workspace.into()),
        WindowClaim::Declined(_) => Err(declined_error(&root).into()),
    }
}

/// Deprecated: superseded by `window_release_workspace`.
#[tauri::command]
pub async fn workspace_remove(
    workspace_id: String,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    registry: State<'_, WindowRegistry>,
) -> Result<EmptyResponse, IpcError> {
    match registry.workspace_owner(&workspace_id) {
        Some(owner) if owner == window.label() => {
            release_for_window(&app, window.label()).await?;
            Ok(EmptyResponse {})
        }
        Some(_) => Err(AppError::WorkspaceMounted(workspace_id).into()),
        // A row left mounted by an abnormal exit, owned by no window.
        None => {
            state
                .service
                .remove(WorkspaceRemoveRequest {
                    workspace_id: workspace_id.clone(),
                })
                .await
        }
    }
}

#[tauri::command]
pub async fn workspace_list(state: State<'_, WorkspaceState>) -> Result<Vec<Workspace>, IpcError> {
    state.service.list().await
}

#[tauri::command]
pub async fn workspace_recent_list(
    state: State<'_, WorkspaceState>,
) -> Result<Vec<Workspace>, IpcError> {
    state.service.recent_list().await
}

/// Deprecated: superseded by `window_claim_workspace`.
#[tauri::command]
pub async fn workspace_remount(
    workspace_id: String,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
) -> Result<Workspace, IpcError> {
    let record = state
        .service
        .repository
        .workspace_get(workspace_id.clone())
        .await
        .map_err(AppError::from)?
        .ok_or(AppError::WorkspaceNotFound(workspace_id))?;
    let root = canonical_directory(Path::new(&record.root_path))?;
    match claim_for_window(&app, window.label(), root.clone(), Some(record), None).await? {
        WindowClaim::Claimed { workspace, .. } => Ok(WorkspaceRecord {
            root_path: root.display().to_string(),
            ..workspace
        }
        .into()),
        WindowClaim::Declined(_) => Err(declined_error(&root).into()),
    }
}

#[tauri::command]
pub async fn workspace_recent_remove(
    workspace_id: String,
    state: State<'_, WorkspaceState>,
    registry: State<'_, WindowRegistry>,
) -> Result<EmptyResponse, IpcError> {
    if registry.workspace_owner(&workspace_id).is_some() {
        return Err(AppError::WorkspaceMounted(workspace_id).into());
    }
    state.service.recent_remove(workspace_id).await
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
    let workspace = repository
        .workspace_get(id.to_owned())
        .await?
        .ok_or_else(|| AppError::WorkspaceNotFound(id.to_owned()))?;
    if !workspace.mounted {
        return Err(AppError::WorkspaceNotFound(id.to_owned()));
    }
    Ok(workspace)
}

/// Canonicalize a Workspace root so symbolic links, letter-case variants on
/// case-insensitive volumes, and `..` segments resolve to one path before
/// ownership and nesting are decided. A missing folder is an I/O error and a
/// non-folder is access denied.
pub(crate) fn canonical_directory(requested: &Path) -> Result<PathBuf, AppError> {
    let canonical = requested.canonicalize().map_err(|source| AppError::Io {
        path: Some(requested.to_path_buf()),
        source,
    })?;
    if !canonical.is_dir() {
        return Err(AppError::PathAccessDenied(canonical));
    }
    Ok(canonical)
}

fn validate_mount(current: &[WorkspaceRecord], canonical: &Path) -> Result<(), AppError> {
    let mut roots = current
        .iter()
        .map(|workspace| Path::new(&workspace.root_path).to_path_buf())
        .collect::<Vec<_>>();
    roots.push(canonical.to_path_buf());
    WorkspacePathPolicy::new(roots).map_err(|error| match error {
        crate::security::PathSecurityError::WorkspaceOverlap { first, second } => {
            AppError::WorkspaceOverlap(format!("{} and {}", first.display(), second.display()))
        }
        other => AppError::from(other),
    })?;
    Ok(())
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
