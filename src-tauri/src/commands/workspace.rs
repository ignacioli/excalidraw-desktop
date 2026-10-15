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
    window::{
        peer_close::{PeerCloseRequest, PeerCloseRequests},
        registry::{ClaimDecision, RegistryError, WindowRegistry, WorkspaceCandidate},
    },
};

use super::{
    dto::{
        ClaimWorkspaceOutcome, EmptyResponse, PeerClaimOutcome, PeerCloseCancelled,
        WindowClaimResultEvent, WindowCloseOtherResponse, WindowCloseRequestedByPeerEvent,
        Workspace, WorkspaceAddRequest, WorkspaceRemoveRequest, WorkspaceRevealEntryEvent,
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
    crate::window::placement::place_for_workspace(app, label, &workspace.id).await;
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

/// Resolve a claim or probe target given as either a folder or a retained
/// Workspace id to its canonical root and record.
pub(crate) async fn resolve_target(
    service: &WorkspaceService,
    root_path: Option<String>,
    workspace_id: Option<String>,
) -> Result<(PathBuf, Option<WorkspaceRecord>), AppError> {
    match (root_path, workspace_id) {
        (Some(root_path), None) => service.resolve_root(&root_path).await,
        (None, Some(workspace_id)) => {
            let record = service
                .repository
                .workspace_get(workspace_id.clone())
                .await?
                .ok_or(AppError::WorkspaceNotFound(workspace_id))?;
            let root = canonical_directory(Path::new(&record.root_path))?;
            Ok((root, Some(record)))
        }
        _ => Err(AppError::Internal(
            "exactly one of rootPath or workspaceId is required".to_owned(),
        )),
    }
}

/// The outcome for a Workspace another window holds, or one nested with it.
/// `None` for a claimable decision.
pub(crate) fn declined_outcome<W>(decision: ClaimDecision) -> Option<ClaimWorkspaceOutcome<W>> {
    match decision {
        ClaimDecision::Claimable { .. } => None,
        ClaimDecision::OwnedBy {
            label,
            workspace_id,
        } => Some(ClaimWorkspaceOutcome::OwnedBy {
            label,
            workspace_id,
        }),
        ClaimDecision::InsideOpen {
            label,
            workspace_id,
            relative_path,
        } => Some(ClaimWorkspaceOutcome::InsideOpen {
            label,
            workspace_id,
            relative_path,
        }),
        ClaimDecision::ContainsOpen {
            label,
            workspace_id,
        } => Some(ClaimWorkspaceOutcome::ContainsOpen {
            label,
            workspace_id,
        }),
    }
}

/// Decide, without changing anything, what opening the target in `label`
/// would do.
pub(crate) fn probe_outcome(
    registry: &WindowRegistry,
    label: &str,
    root: PathBuf,
    record: Option<WorkspaceRecord>,
) -> Result<ClaimWorkspaceOutcome<Option<Workspace>>, AppError> {
    let candidate = WorkspaceCandidate {
        id: record.as_ref().map(|record| record.id.clone()),
        root: root.clone(),
    };
    let decision = registry.probe(label, &candidate).map_err(registry_error)?;
    Ok(match decision {
        ClaimDecision::Claimable { replaced } => ClaimWorkspaceOutcome::Claimed {
            workspace: record.map(|record| with_root(record, &root).into()),
            replaced,
            shell: None,
        },
        declined => declined_outcome(declined)
            .ok_or_else(|| AppError::Internal("unreachable claim decision".to_owned()))?,
    })
}

/// Report the canonical root, which is what ownership and nesting compare.
fn with_root(record: WorkspaceRecord, root: &Path) -> WorkspaceRecord {
    WorkspaceRecord {
        root_path: root.display().to_string(),
        ..record
    }
}

/// Read-only: what `window_claim_workspace` would decide for the calling
/// window. Used before closing tabs to replace a Workspace.
#[tauri::command]
pub async fn window_probe_workspace(
    root_path: Option<String>,
    workspace_id: Option<String>,
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    registry: State<'_, WindowRegistry>,
) -> Result<ClaimWorkspaceOutcome<Option<Workspace>>, IpcError> {
    let (root, record) = resolve_target(&state.service, root_path, workspace_id).await?;
    Ok(probe_outcome(&registry, window.label(), root, record)?)
}

/// Open `root` in window `label` and report the outcome. When another window
/// holds it or a Workspace that contains it, that window is brought to the
/// front instead and `label` is unchanged; a folder inside another window's
/// Workspace is also shown in that window's sidebar.
pub(crate) async fn claim_outcome_for_window(
    app: &AppHandle,
    service: &WorkspaceService,
    label: &str,
    root: PathBuf,
    record: Option<WorkspaceRecord>,
) -> Result<ClaimWorkspaceOutcome<Workspace>, AppError> {
    match claim_for_window(app, label, root.clone(), record, None).await? {
        WindowClaim::Claimed {
            workspace,
            replaced,
        } => {
            crate::window::persist_session(app).await;
            crate::window::broadcast_open_workspaces(app).await;
            let shell = crate::commands::session::workspace_shell_state_for(
                &service.repository,
                &workspace.id,
            )
            .await?;
            Ok(ClaimWorkspaceOutcome::Claimed {
                workspace: with_root(workspace, &root).into(),
                replaced,
                shell,
            })
        }
        WindowClaim::Declined(decision) => {
            let outcome = declined_outcome(decision)
                .ok_or_else(|| AppError::Internal("unreachable claim decision".to_owned()))?;
            match &outcome {
                ClaimWorkspaceOutcome::OwnedBy { label, .. } => {
                    crate::window::activate_label(app, label);
                }
                ClaimWorkspaceOutcome::InsideOpen {
                    label,
                    relative_path,
                    ..
                } => {
                    crate::window::activate_label(app, label);
                    let name = root
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    if let Err(error) = app.emit_to(
                        label.as_str(),
                        "workspace-reveal-entry",
                        WorkspaceRevealEntryEvent {
                            relative_path: relative_path.clone(),
                            name,
                        },
                    ) {
                        eprintln!("failed to show the folder in {label}: {error}");
                    }
                }
                _ => {}
            }
            Ok(outcome)
        }
    }
}

/// Open a Workspace in the calling window, replacing its current one (see
/// [`claim_outcome_for_window`]).
#[tauri::command]
pub async fn window_claim_workspace(
    root_path: Option<String>,
    workspace_id: Option<String>,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
) -> Result<ClaimWorkspaceOutcome<Workspace>, IpcError> {
    let (root, record) = resolve_target(&state.service, root_path, workspace_id).await?;
    Ok(claim_outcome_for_window(&app, &state.service, window.label(), root, record).await?)
}

/// "Close it and open here" is still valid only while `root` contains the
/// Workspace of `target_label`; otherwise ownership changed after the dialog
/// opened.
pub(crate) fn ensure_still_contained(
    registry: &WindowRegistry,
    label: &str,
    root: PathBuf,
    record: Option<WorkspaceRecord>,
    target_label: &str,
) -> Result<(), AppError> {
    match probe_outcome(registry, label, root.clone(), record)? {
        ClaimWorkspaceOutcome::ContainsOpen { label, .. } if label == target_label => Ok(()),
        _ => Err(AppError::WindowOwnershipChanged(root.display().to_string())),
    }
}

/// "Close it and open here": ask `target_label`, whose Workspace lies inside
/// `root_path`, to close the normal way. The folder opens in the calling
/// window once that window is gone; the result arrives as
/// `window-claim-result`. The calling window closes its own tabs first.
#[tauri::command]
pub async fn window_close_other_and_claim(
    target_label: String,
    root_path: String,
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
) -> Result<WindowCloseOtherResponse, IpcError> {
    let (root, record) = resolve_target(&state.service, Some(root_path), None).await?;
    ensure_still_contained(
        &app.state::<WindowRegistry>(),
        window.label(),
        root.clone(),
        record,
        &target_label,
    )?;
    let request_id = Uuid::new_v4().to_string();
    let requests = app.state::<PeerCloseRequests>();
    requests.begin(PeerCloseRequest {
        request_id: request_id.clone(),
        initiator: window.label().to_owned(),
        target: target_label.clone(),
        root_path: root.display().to_string(),
    });
    if let Err(error) = app.emit_to(
        target_label.as_str(),
        "window-close-requested-by-peer",
        WindowCloseRequestedByPeerEvent {
            request_id: request_id.clone(),
        },
    ) {
        requests.take(&request_id, &target_label);
        return Err(
            AppError::Internal(format!("failed to ask {target_label} to close: {error}")).into(),
        );
    }
    Ok(WindowCloseOtherResponse::Closing { request_id })
}

/// The calling window was asked to close by a peer and its close was
/// cancelled or failed: tell the window that asked; nothing is opened.
#[tauri::command]
pub async fn window_peer_close_failed(
    request_id: String,
    app: AppHandle,
    window: WebviewWindow,
) -> Result<EmptyResponse, IpcError> {
    if let Some(request) = app
        .state::<PeerCloseRequests>()
        .take(&request_id, window.label())
    {
        send_claim_result(
            &app,
            &request,
            PeerClaimOutcome::Cancelled(PeerCloseCancelled::Cancelled),
        );
    }
    Ok(EmptyResponse {})
}

/// After window `label` is destroyed: open the folders that waited for it to
/// close, and forget the requests it made.
pub(crate) async fn finish_peer_closes(app: &AppHandle, label: &str) {
    let requests = app.state::<PeerCloseRequests>();
    requests.drop_initiator(label);
    let service = app.state::<WorkspaceState>().service.clone();
    for request in requests.take_for_target(label) {
        let outcome = match resolve_target(&service, Some(request.root_path.clone()), None).await {
            Ok((root, record)) => {
                claim_outcome_for_window(app, &service, &request.initiator, root, record).await
            }
            Err(error) => Err(error),
        };
        let outcome = match outcome {
            Ok(outcome) => PeerClaimOutcome::Claim(outcome),
            Err(error) => {
                eprintln!(
                    "failed to open {} after its window closed: {error}",
                    request.root_path
                );
                PeerClaimOutcome::Cancelled(PeerCloseCancelled::Cancelled)
            }
        };
        send_claim_result(app, &request, outcome);
    }
}

fn send_claim_result(app: &AppHandle, request: &PeerCloseRequest, outcome: PeerClaimOutcome) {
    if let Err(error) = app.emit_to(
        request.initiator.as_str(),
        "window-claim-result",
        WindowClaimResultEvent {
            request_id: request.request_id.clone(),
            outcome,
        },
    ) {
        eprintln!(
            "failed to report the open to {}: {error}",
            request.initiator
        );
    }
}

/// Close the calling window's Workspace. The frontend closes its tabs first.
#[tauri::command]
pub async fn window_release_workspace(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<EmptyResponse, IpcError> {
    release_for_window(&app, window.label()).await?;
    crate::window::persist_session(&app).await;
    crate::window::broadcast_open_workspaces(&app).await;
    Ok(EmptyResponse {})
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

/// The calling window's Workspace, as a list of at most one. Other windows'
/// Workspaces never appear in this window's sidebar.
#[tauri::command]
pub async fn workspace_list(
    window: WebviewWindow,
    state: State<'_, WorkspaceState>,
    registry: State<'_, WindowRegistry>,
) -> Result<Vec<Workspace>, IpcError> {
    Ok(window_workspaces(&state.service, &registry, window.label()).await?)
}

pub(crate) async fn window_workspaces(
    service: &WorkspaceService,
    registry: &WindowRegistry,
    label: &str,
) -> Result<Vec<Workspace>, AppError> {
    let Some(owned) = registry.window(label).and_then(|window| window.workspace) else {
        return Ok(Vec::new());
    };
    let record = service
        .repository
        .workspace_get(owned.id.clone())
        .await?
        .ok_or(AppError::WorkspaceNotFound(owned.id))?;
    Ok(vec![with_root(record, &owned.root).into()])
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
    crate::window::events::emit_to_workspace_owner(
        app,
        workspace_id,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window::registry::WindowRole;

    struct Fixture {
        service: WorkspaceService,
        database: PathBuf,
        folders: PathBuf,
    }

    impl Fixture {
        async fn new() -> Self {
            let id = Uuid::new_v4();
            let database =
                std::env::temp_dir().join(format!("excalidraw-window-claim-{id}.sqlite3"));
            let folders = std::env::temp_dir().join(format!("excalidraw-window-claim-{id}"));
            fs::create_dir_all(folders.join("notes/sub"))
                .unwrap_or_else(|error| panic!("create folders: {error}"));
            fs::create_dir_all(folders.join("other"))
                .unwrap_or_else(|error| panic!("create folders: {error}"));
            let repository = SqliteRepository::open(&database)
                .await
                .unwrap_or_else(|error| panic!("open repository: {error}"));
            Self {
                service: WorkspaceService::new(Arc::new(repository)),
                database,
                folders,
            }
        }

        fn folder(&self, relative: &str) -> String {
            self.folders.join(relative).display().to_string()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.folders);
            for suffix in ["sqlite3-wal", "sqlite3-shm", "sqlite3"] {
                let _ = fs::remove_file(self.database.with_extension(suffix));
            }
        }
    }

    fn registry_with(labels: &[&str]) -> WindowRegistry {
        let registry = WindowRegistry::new();
        for label in labels {
            registry
                .register(label, WindowRole::Normal)
                .unwrap_or_else(|error| panic!("register {label}: {error}"));
        }
        registry
    }

    async fn claim(fixture: &Fixture, registry: &WindowRegistry, label: &str, folder: &str) {
        let (root, _) = fixture
            .service
            .resolve_root(&fixture.folder(folder))
            .await
            .unwrap_or_else(|error| panic!("resolve: {error}"));
        let record = fixture
            .service
            .ensure_record(&root, None)
            .await
            .unwrap_or_else(|error| panic!("record: {error}"));
        let (decision, _) = registry
            .claim(
                label,
                &WorkspaceCandidate {
                    id: Some(record.id),
                    root,
                },
            )
            .unwrap_or_else(|error| panic!("claim: {error}"));
        assert!(matches!(decision, ClaimDecision::Claimable { .. }));
    }

    async fn probe(
        fixture: &Fixture,
        registry: &WindowRegistry,
        label: &str,
        folder: &str,
    ) -> ClaimWorkspaceOutcome<Option<Workspace>> {
        let (root, record) = resolve_target(&fixture.service, Some(fixture.folder(folder)), None)
            .await
            .unwrap_or_else(|error| panic!("resolve: {error}"));
        probe_outcome(registry, label, root, record)
            .unwrap_or_else(|error| panic!("probe: {error}"))
    }

    #[tokio::test]
    async fn close_and_open_requires_the_contained_workspace_to_be_unchanged() {
        let fixture = Fixture::new().await;
        let registry = registry_with(&["window-1", "window-2", "window-3"]);
        claim(&fixture, &registry, "window-2", "notes/sub").await;
        let (root, record) = resolve_target(&fixture.service, Some(fixture.folder("notes")), None)
            .await
            .unwrap_or_else(|error| panic!("resolve: {error}"));

        assert!(ensure_still_contained(
            &registry,
            "window-1",
            root.clone(),
            record.clone(),
            "window-2"
        )
        .is_ok());
        let wrong_target = ensure_still_contained(
            &registry,
            "window-1",
            root.clone(),
            record.clone(),
            "window-3",
        )
        .expect_err("another window does not hold the contained Workspace");
        assert!(matches!(wrong_target, AppError::WindowOwnershipChanged(_)));

        registry
            .release_workspace("window-2")
            .unwrap_or_else(|error| panic!("release: {error}"));
        let released = ensure_still_contained(&registry, "window-1", root, record, "window-2")
            .expect_err("the contained Workspace was closed meanwhile");
        assert!(matches!(released, AppError::WindowOwnershipChanged(_)));
        assert_eq!(
            IpcError::from(released).code,
            crate::commands::error::ErrorCode::WindowOwnershipChanged
        );
    }

    #[tokio::test]
    async fn probing_a_new_folder_is_claimable_and_creates_nothing() {
        let fixture = Fixture::new().await;
        let registry = registry_with(&["window-1"]);
        let outcome = probe(&fixture, &registry, "window-1", "notes").await;
        assert_eq!(
            outcome,
            ClaimWorkspaceOutcome::Claimed {
                workspace: None,
                replaced: None,
                shell: None
            }
        );
        let recent = fixture
            .service
            .recent_list()
            .await
            .unwrap_or_else(|error| panic!("recent: {error:?}"));
        assert!(recent.is_empty(), "a probe must not create a record");
        assert!(registry.owned_workspace_ids().is_empty());
    }

    #[tokio::test]
    async fn probing_reports_each_declined_decision() {
        let fixture = Fixture::new().await;
        let registry = registry_with(&["window-1", "window-2"]);
        claim(&fixture, &registry, "window-1", "notes").await;
        let notes = registry
            .window("window-1")
            .and_then(|window| window.workspace)
            .map(|workspace| workspace.id)
            .unwrap_or_else(|| panic!("window-1 owns notes"));

        assert_eq!(
            probe(&fixture, &registry, "window-2", "notes").await,
            ClaimWorkspaceOutcome::OwnedBy {
                label: "window-1".to_owned(),
                workspace_id: notes.clone(),
            }
        );
        assert_eq!(
            probe(&fixture, &registry, "window-2", "notes/sub").await,
            ClaimWorkspaceOutcome::InsideOpen {
                label: "window-1".to_owned(),
                workspace_id: notes.clone(),
                relative_path: "sub".to_owned(),
            }
        );
        assert_eq!(
            probe(&fixture, &registry, "window-2", "").await,
            ClaimWorkspaceOutcome::ContainsOpen {
                label: "window-1".to_owned(),
                workspace_id: notes.clone(),
            }
        );
        // The owner itself may reopen or replace its own Workspace.
        match probe(&fixture, &registry, "window-1", "other").await {
            ClaimWorkspaceOutcome::Claimed { replaced, .. } => {
                assert_eq!(replaced, Some(notes));
            }
            other => panic!("expected claimable, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn resolves_a_retained_workspace_by_id_and_rejects_ambiguous_targets() {
        let fixture = Fixture::new().await;
        let (root, _) = fixture
            .service
            .resolve_root(&fixture.folder("notes"))
            .await
            .unwrap_or_else(|error| panic!("resolve: {error}"));
        let record = fixture
            .service
            .ensure_record(&root, Some("Notes".to_owned()))
            .await
            .unwrap_or_else(|error| panic!("record: {error}"));

        let (resolved, found) = resolve_target(&fixture.service, None, Some(record.id.clone()))
            .await
            .unwrap_or_else(|error| panic!("resolve by id: {error}"));
        assert_eq!(resolved, root);
        assert_eq!(found.map(|found| found.id), Some(record.id.clone()));

        let registry = registry_with(&["window-1"]);
        match probe(&fixture, &registry, "window-1", "notes").await {
            ClaimWorkspaceOutcome::Claimed {
                workspace: Some(workspace),
                ..
            } => {
                assert_eq!(workspace.id, record.id);
                assert_eq!(workspace.root_path, root.display().to_string());
            }
            other => panic!("expected the retained Workspace, got {other:?}"),
        }

        for (root_path, workspace_id) in [
            (None, None),
            (Some(fixture.folder("notes")), Some(record.id.clone())),
        ] {
            assert!(matches!(
                resolve_target(&fixture.service, root_path, workspace_id).await,
                Err(AppError::Internal(_))
            ));
        }
        assert!(matches!(
            resolve_target(&fixture.service, None, Some("missing".to_owned())).await,
            Err(AppError::WorkspaceNotFound(_))
        ));
    }

    #[tokio::test]
    async fn lists_only_the_calling_windows_workspace() {
        let fixture = Fixture::new().await;
        let registry = registry_with(&["window-1", "window-2", "window-3"]);
        claim(&fixture, &registry, "window-1", "notes").await;
        claim(&fixture, &registry, "window-2", "other").await;

        let list = |label: &'static str| {
            let service = fixture.service.clone();
            let registry = &registry;
            async move {
                window_workspaces(&service, registry, label)
                    .await
                    .unwrap_or_else(|error| panic!("list {label}: {error}"))
                    .into_iter()
                    .map(|workspace| workspace.name)
                    .collect::<Vec<_>>()
            }
        };
        assert_eq!(list("window-1").await, ["notes"]);
        assert_eq!(list("window-2").await, ["other"]);
        assert!(list("window-3").await.is_empty());
    }

    #[test]
    fn serializes_the_claim_outcome_contract() {
        let owned: ClaimWorkspaceOutcome<Workspace> = ClaimWorkspaceOutcome::InsideOpen {
            label: "window-2".to_owned(),
            workspace_id: "w".to_owned(),
            relative_path: "docs/2026".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(owned).unwrap_or_else(|error| panic!("serialize: {error}")),
            serde_json::json!({
                "kind": "insideOpen",
                "label": "window-2",
                "workspaceId": "w",
                "relativePath": "docs/2026"
            })
        );
        let probe: ClaimWorkspaceOutcome<Option<Workspace>> = ClaimWorkspaceOutcome::Claimed {
            workspace: None,
            replaced: Some("old".to_owned()),
            shell: None,
        };
        assert_eq!(
            serde_json::to_value(probe).unwrap_or_else(|error| panic!("serialize: {error}")),
            serde_json::json!({
                "kind": "claimed",
                "workspace": null,
                "replaced": "old",
                "shell": null
            })
        );
    }
}
