use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::UNIX_EPOCH,
};

use sha2::{Digest, Sha256};
use tauri::State;

use crate::{
    database::repository::{DraftRepository, SqliteRepository, WorkspaceRepository},
    documents::{
        assets::{asset_root_for, reembed_files},
        atomic_write::atomic_write,
        recovery::{RecoverySnapshot, RecoveryStore},
        validation::{validate_scene, SceneValidationError},
    },
    security::{PathSecurityError, WorkspacePathPolicy},
};

use super::{
    dto::{RecoveryAction, RecoveryApplyRequest, RecoveryApplyResponse, RecoveryCandidate},
    error::{AppError, IpcError},
};

pub const DEFAULT_SCENE_LIMIT_BYTES: usize = 256 * 1024 * 1024;

pub trait RecoveryPathGrant: Send + Sync {
    fn is_allowed(&self, path: &Path) -> bool;
}

struct DenyRecoveryPathGrant;

impl RecoveryPathGrant for DenyRecoveryPathGrant {
    fn is_allowed(&self, _path: &Path) -> bool {
        false
    }
}

/// Adapter for Tauri's fs scope.  The application owner can pass this to
/// [`RecoveryService::with_path_grant`] so direct files selected in a native
/// dialog receive the same narrow authorization as document commands.
pub struct TauriRecoveryPathGrant(pub tauri::fs::Scope);

impl RecoveryPathGrant for TauriRecoveryPathGrant {
    fn is_allowed(&self, path: &Path) -> bool {
        self.0.is_allowed(path)
    }
}

#[derive(Clone)]
pub struct RecoveryService {
    repository: Arc<SqliteRepository>,
    store: Arc<RecoveryStore>,
    path_grant: Arc<dyn RecoveryPathGrant>,
    scene_limit_bytes: usize,
}

impl RecoveryService {
    pub fn new(repository: Arc<SqliteRepository>, store: Arc<RecoveryStore>) -> Self {
        Self::with_path_grant_and_scene_limit(
            repository,
            store,
            Arc::new(DenyRecoveryPathGrant),
            DEFAULT_SCENE_LIMIT_BYTES,
        )
    }

    pub fn with_path_grant(
        repository: Arc<SqliteRepository>,
        store: Arc<RecoveryStore>,
        path_grant: Arc<dyn RecoveryPathGrant>,
    ) -> Self {
        Self::with_path_grant_and_scene_limit(
            repository,
            store,
            path_grant,
            DEFAULT_SCENE_LIMIT_BYTES,
        )
    }

    pub fn with_path_grant_and_scene_limit(
        repository: Arc<SqliteRepository>,
        store: Arc<RecoveryStore>,
        path_grant: Arc<dyn RecoveryPathGrant>,
        scene_limit_bytes: usize,
    ) -> Self {
        Self {
            repository,
            store,
            path_grant,
            scene_limit_bytes,
        }
    }

    pub async fn list(&self) -> Result<Vec<RecoveryCandidate>, AppError> {
        let store = Arc::clone(&self.store);
        let snapshots =
            run_blocking(move || store.list_snapshots().map_err(AppError::from)).await?;
        let workspaces = self.repository.workspace_list().await?;
        let policy = WorkspacePathPolicy::new(
            workspaces
                .iter()
                .map(|workspace| Path::new(&workspace.root_path)),
        )?;

        let mut latest_by_document: HashMap<String, (PathBuf, RecoverySnapshot)> = HashMap::new();
        for (path, snapshot) in snapshots {
            latest_by_document
                .entry(snapshot.document_id.clone())
                .and_modify(|current| {
                    let current_modified = snapshot_modified_time(&current.0);
                    let incoming_modified = snapshot_modified_time(&path);
                    if (snapshot.saved_at, incoming_modified, &path)
                        > (current.1.saved_at, current_modified, &current.0)
                    {
                        *current = (path.clone(), snapshot.clone());
                    }
                })
                .or_insert((path, snapshot));
        }

        let mut candidates = Vec::new();
        for (_, (_, snapshot)) in latest_by_document {
            let stored_path = snapshot.original_path.clone().map(PathBuf::from);
            let original_path = stored_path.filter(|path| {
                is_authorized_recovery_path(path, &policy, self.path_grant.as_ref())
            });
            let (cold_file_mtime, cold_hash, cold_scene) = original_path
                .as_deref()
                .map(cold_file_state)
                .unwrap_or((None, None, None));
            let snapshot_newer = match (cold_file_mtime, cold_hash.as_deref()) {
                (Some(mtime), Some(hash)) => {
                    let scene_changed = match cold_scene.as_ref() {
                        Some(cold_scene) => cold_scene != &snapshot.scene,
                        None => true,
                    };
                    // A normal unsaved draft has the same base hash as the
                    // cold file, so compare the persisted scene as well.  The
                    // base hash still detects an external replacement even
                    // when its JSON happens to equal the draft scene.
                    snapshot.saved_at > mtime && (snapshot.base_file_hash != hash || scene_changed)
                }
                // A missing cold file or an unreadable file must not silently
                // discard the user's last recoverable scene.
                _ => true,
            };
            if !snapshot_newer {
                continue;
            }
            let display_name = original_path
                .as_deref()
                .and_then(|path| path.file_name())
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .unwrap_or("Untitled drawing")
                .to_owned();
            candidates.push(RecoveryCandidate {
                document_id: snapshot.document_id,
                original_path: original_path.map(|path| path.display().to_string()),
                display_name,
                snapshot_saved_at: snapshot.saved_at,
                cold_file_mtime,
                snapshot_newer,
            });
        }
        candidates.sort_by(|left, right| {
            right
                .snapshot_saved_at
                .cmp(&left.snapshot_saved_at)
                .then_with(|| left.document_id.cmp(&right.document_id))
        });
        Ok(candidates)
    }

    pub async fn apply(
        &self,
        request: RecoveryApplyRequest,
    ) -> Result<RecoveryApplyResponse, AppError> {
        let document_id = request.document_id.clone();
        let store = Arc::clone(&self.store);
        let snapshot = run_blocking(move || {
            store
                .latest_valid_snapshot(&document_id)
                .map_err(AppError::from)
                .and_then(|snapshot| {
                    snapshot.ok_or_else(|| AppError::FileNotFound(PathBuf::from(document_id)))
                })
        })
        .await?;

        let original_path = snapshot.original_path.as_deref().map(PathBuf::from);
        let scene_json = serde_json::to_vec(&snapshot.scene)
            .map_err(|error| AppError::InvalidScene(error.to_string()))?;
        validate_snapshot_scene(&scene_json, self.scene_limit_bytes)?;

        let response = match request.action {
            RecoveryAction::Restore => RecoveryApplyResponse {
                scene: Some(snapshot.scene),
                new_path: None,
            },
            RecoveryAction::KeepDisk | RecoveryAction::Discard => RecoveryApplyResponse {
                scene: None,
                new_path: None,
            },
            RecoveryAction::SaveAsNew => {
                let save_as_path = request
                    .save_as_path
                    .as_deref()
                    .ok_or_else(|| AppError::PathAccessDenied(PathBuf::from("<missing path>")))?;
                let target = self.authorize_save_as_path(save_as_path).await?;
                if original_path.as_deref() == Some(target.as_path()) {
                    return Err(AppError::PathAccessDenied(target));
                }
                let target_for_write = target.clone();
                let write_bytes = match original_path.as_deref() {
                    Some(original) => {
                        let workspaces = self.repository.workspace_list().await?;
                        let workspace_root = workspaces
                            .iter()
                            .find(|workspace| {
                                Path::new(original).starts_with(Path::new(&workspace.root_path))
                            })
                            .map(|workspace| PathBuf::from(&workspace.root_path));
                        let asset_root =
                            asset_root_for(Path::new(original), workspace_root.as_deref());
                        let snapshot_bytes = scene_json.clone();
                        run_blocking(move || {
                            let text = std::str::from_utf8(&snapshot_bytes)
                                .map_err(|error| AppError::InvalidScene(error.to_string()))?;
                            reembed_files(text, &asset_root)
                                .map(String::into_bytes)
                                .map_err(AppError::from)
                        })
                        .await?
                    }
                    None => scene_json.clone(),
                };
                run_blocking(move || {
                    atomic_write(&target_for_write, &write_bytes).map_err(AppError::from)
                })
                .await?;
                RecoveryApplyResponse {
                    scene: None,
                    new_path: Some(target.display().to_string()),
                }
            }
        };

        let document_id = request.document_id;
        let store = Arc::clone(&self.store);
        run_blocking(move || store.remove_document(&document_id).map_err(AppError::from)).await?;
        if let Some(path) = original_path {
            self.repository
                .draft_delete(path.display().to_string())
                .await?;
        }
        Ok(response)
    }

    async fn authorize_save_as_path(&self, requested: &str) -> Result<PathBuf, AppError> {
        let path = Path::new(requested);
        if !is_supported_document_path(path) {
            return Err(AppError::PathAccessDenied(path.to_path_buf()));
        }
        let workspaces = self.repository.workspace_list().await?;
        let policy = WorkspacePathPolicy::new(
            workspaces
                .iter()
                .map(|workspace| Path::new(&workspace.root_path)),
        )?;
        let authorization = if path.exists() {
            policy.authorize_existing(path)
        } else {
            policy.authorize_for_creation(path)
        };
        match authorization {
            Ok(path) => Ok(path),
            Err(PathSecurityError::AccessDenied(_)) if self.path_grant.is_allowed(path) => {
                normalize_granted_path(path)
            }
            Err(error) => Err(error.into()),
        }
    }
}

#[derive(Clone)]
pub struct RecoveryState {
    service: RecoveryService,
}

impl RecoveryState {
    pub fn new(service: RecoveryService) -> Self {
        Self { service }
    }

    pub fn service(&self) -> &RecoveryService {
        &self.service
    }
}

#[tauri::command]
pub async fn recovery_list(
    state: State<'_, RecoveryState>,
) -> Result<Vec<RecoveryCandidate>, IpcError> {
    state.service.list().await.map_err(Into::into)
}

#[tauri::command]
pub async fn recovery_apply(
    document_id: String,
    action: RecoveryAction,
    save_as_path: Option<String>,
    state: State<'_, RecoveryState>,
) -> Result<RecoveryApplyResponse, IpcError> {
    state
        .service
        .apply(RecoveryApplyRequest {
            document_id,
            action,
            save_as_path,
        })
        .await
        .map_err(Into::into)
}

fn validate_snapshot_scene(bytes: &[u8], maximum_bytes: usize) -> Result<(), AppError> {
    validate_scene(bytes, maximum_bytes)
        .map(|_| ())
        .map_err(|error| match error {
            SceneValidationError::TooLarge {
                actual_bytes,
                maximum_bytes,
            } => AppError::FileTooLarge {
                actual_bytes,
                maximum_bytes,
            },
            other => AppError::InvalidScene(other.to_string()),
        })
}

fn is_authorized_recovery_path(
    path: &Path,
    policy: &WorkspacePathPolicy,
    direct_grant: &dyn RecoveryPathGrant,
) -> bool {
    let workspace_authorized = if path.exists() {
        policy.authorize_existing(path).is_ok()
    } else {
        policy.authorize_for_creation(path).is_ok()
    };
    workspace_authorized || direct_grant.is_allowed(path)
}

fn cold_file_state(path: &Path) -> (Option<i64>, Option<String>, Option<serde_json::Value>) {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return (None, None, None),
    };
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_secs()).ok());
    let bytes = fs::read(path).ok();
    let hash = bytes
        .as_deref()
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)));
    let scene = bytes
        .as_deref()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok());
    (mtime, hash, scene)
}

fn snapshot_modified_time(path: &Path) -> std::time::SystemTime {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .unwrap_or(UNIX_EPOCH)
}

fn is_supported_document_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|name| name.ends_with(".excalidraw") || name.ends_with(".excalidraw.json"))
}

fn normalize_granted_path(path: &Path) -> Result<PathBuf, AppError> {
    if path.exists() {
        return path.canonicalize().map_err(|source| AppError::Io {
            path: Some(path.to_path_buf()),
            source,
        });
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let canonical_parent = parent.canonicalize().map_err(|source| AppError::Io {
        path: Some(parent.to_path_buf()),
        source,
    })?;
    let file_name = path
        .file_name()
        .ok_or_else(|| AppError::PathAccessDenied(path.to_path_buf()))?;
    Ok(canonical_parent.join(file_name))
}

async fn run_blocking<T, F>(operation: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| AppError::Internal(format!("blocking recovery task failed: {error}")))?
}
