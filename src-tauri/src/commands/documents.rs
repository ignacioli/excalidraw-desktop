use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

use crate::{
    database::repository::{
        DocumentRepository, DraftRecord, DraftRepository, FileIndexRecord, SqliteRepository,
        WorkspaceRecord, WorkspaceRepository,
    },
    documents::{
        atomic_write::atomic_write,
        recovery::{document_id_for_path, RecoveryStore},
        validation::{validate_scene, SceneValidationError},
    },
    security::{PathSecurityError, WorkspacePathPolicy},
    watcher::WatcherService,
};

use super::{
    dto::{
        CheckpointReason, CheckpointRequest, CheckpointResponse, CloseDocumentRequest,
        ConflictResolution, DraftSavedEvent, EmptyResponse, PathRequest, ResolveConflictRequest,
        ResolveConflictResponse, SaveDraftRequest, SaveDraftResponse, SceneOpenResponse,
    },
    error::{AppError, IpcError},
};

pub trait DirectFileGrant: Send + Sync {
    fn is_allowed(&self, path: &Path) -> bool;
}

struct DenyDirectFiles;

impl DirectFileGrant for DenyDirectFiles {
    fn is_allowed(&self, _path: &Path) -> bool {
        false
    }
}

/// Tracks paths where an external change hit a dirty document. It is the
/// backend authority for data-model invariant 2: `Conflicted` documents must
/// not accept automatic draft or checkpoint writes until the user resolves.
#[derive(Clone, Default)]
pub struct ConflictRegistry {
    conflicted: Arc<tokio::sync::Mutex<HashSet<PathBuf>>>,
}

impl ConflictRegistry {
    pub async fn mark_conflicted(&self, path: PathBuf) {
        self.conflicted.lock().await.insert(path);
    }

    pub async fn clear_conflicted(&self, path: &Path) {
        self.conflicted.lock().await.remove(path);
    }

    pub async fn is_conflicted(&self, path: &Path) -> bool {
        self.conflicted.lock().await.contains(path)
    }
}

#[derive(Clone)]
pub struct DocumentService {
    repository: Arc<SqliteRepository>,
    direct_file_grant: Arc<dyn DirectFileGrant>,
    scene_limit_bytes: usize,
    document_locks: Arc<tokio::sync::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>>,
    recovery: Option<Arc<RecoveryStore>>,
    conflicts: ConflictRegistry,
    watcher: Option<Arc<WatcherService>>,
}

impl DocumentService {
    pub const DEFAULT_SCENE_LIMIT_BYTES: usize = 256 * 1024 * 1024;

    pub fn new(repository: Arc<SqliteRepository>) -> Self {
        Self::with_grant_and_scene_limit(
            repository,
            Arc::new(DenyDirectFiles),
            Self::DEFAULT_SCENE_LIMIT_BYTES,
        )
    }

    pub fn with_scene_limit(repository: Arc<SqliteRepository>, scene_limit_bytes: usize) -> Self {
        Self::with_grant_and_scene_limit(repository, Arc::new(DenyDirectFiles), scene_limit_bytes)
    }

    pub fn with_grant_and_scene_limit(
        repository: Arc<SqliteRepository>,
        direct_file_grant: Arc<dyn DirectFileGrant>,
        scene_limit_bytes: usize,
    ) -> Self {
        Self {
            repository,
            direct_file_grant,
            scene_limit_bytes,
            document_locks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            recovery: None,
            conflicts: ConflictRegistry::default(),
            watcher: None,
        }
    }

    pub fn with_recovery(repository: Arc<SqliteRepository>, recovery: Arc<RecoveryStore>) -> Self {
        Self::with_grant_and_scene_limit_and_recovery(
            repository,
            Arc::new(DenyDirectFiles),
            Self::DEFAULT_SCENE_LIMIT_BYTES,
            recovery,
        )
    }

    pub fn with_grant_and_scene_limit_and_recovery(
        repository: Arc<SqliteRepository>,
        direct_file_grant: Arc<dyn DirectFileGrant>,
        scene_limit_bytes: usize,
        recovery: Arc<RecoveryStore>,
    ) -> Self {
        Self {
            repository,
            direct_file_grant,
            scene_limit_bytes,
            document_locks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            recovery: Some(recovery),
            conflicts: ConflictRegistry::default(),
            watcher: None,
        }
    }

    /// Wires the external-change pipeline after construction: the shared
    /// conflict registry and the watcher sink for own-write echo suppression.
    pub fn attach_external_change_handlers(
        &mut self,
        conflicts: ConflictRegistry,
        watcher: Option<Arc<WatcherService>>,
    ) {
        self.conflicts = conflicts;
        self.watcher = watcher;
    }

    /// Exposes the conflict registry for integration tests and wiring.
    pub fn conflicts(&self) -> &ConflictRegistry {
        &self.conflicts
    }

    pub async fn doc_open(&self, request: PathRequest) -> Result<SceneOpenResponse, IpcError> {
        self.open(request).await.map_err(Into::into)
    }

    pub async fn doc_save_draft(
        &self,
        request: SaveDraftRequest,
    ) -> Result<SaveDraftResponse, IpcError> {
        self.save_draft(request).await.map_err(Into::into)
    }

    pub async fn doc_checkpoint(
        &self,
        request: CheckpointRequest,
    ) -> Result<CheckpointResponse, IpcError> {
        self.checkpoint(request).await.map_err(Into::into)
    }

    pub async fn doc_close(
        &self,
        request: CloseDocumentRequest,
    ) -> Result<EmptyResponse, IpcError> {
        self.close(request).await.map_err(Into::into)
    }

    pub async fn doc_resolve_conflict(
        &self,
        request: ResolveConflictRequest,
    ) -> Result<ResolveConflictResponse, IpcError> {
        self.resolve_conflict(request).await.map_err(Into::into)
    }

    async fn open(&self, request: PathRequest) -> Result<SceneOpenResponse, AppError> {
        let authorized = self
            .authorize_path(Path::new(&request.path), PathMode::Existing)
            .await?;
        let _document_guard = self.lock_document(&authorized.path).await;
        let limit = self.scene_limit_bytes;
        let path = authorized.path.clone();
        let bytes = run_blocking(move || read_bounded(&path, limit)).await?;
        let scene = validate_persisted_scene(&bytes, limit)?;
        let base_hash = content_hash(&bytes);
        let draft = self
            .repository
            .draft_get(path_string(&authorized.path))
            .await?;
        let has_newer_draft =
            draft.is_some_and(|record| record.is_dirty && record.content_hash != base_hash);

        Ok(SceneOpenResponse {
            scene,
            base_hash,
            has_newer_draft,
        })
    }

    async fn save_draft(&self, request: SaveDraftRequest) -> Result<SaveDraftResponse, AppError> {
        let authorized = self
            .authorize_path(Path::new(&request.path), PathMode::Existing)
            .await?;
        if self.conflicts.is_conflicted(&authorized.path).await {
            return Err(AppError::ConflictPending(authorized.path));
        }
        let _document_guard = self.lock_document(&authorized.path).await;
        let limit = self.scene_limit_bytes;
        let scene_json = request.scene_json;
        let (scene_json, hash) = run_blocking(move || {
            validate_active_scene(scene_json.as_bytes(), limit)?;
            let hash = content_hash(scene_json.as_bytes());
            Ok((scene_json, hash))
        })
        .await?;

        let canonical_path = path_string(&authorized.path);
        let snapshot_scene_json = scene_json.clone();
        let existing = self.repository.draft_get(canonical_path.clone()).await?;
        let base_hash = match existing.and_then(|draft| draft.base_hash) {
            Some(hash) => Some(hash),
            None => {
                let path = authorized.path.clone();
                let bytes = run_blocking(move || read_bounded(&path, limit)).await?;
                Some(content_hash(&bytes))
            }
        };
        let saved_at = unix_timestamp()?;
        self.repository
            .draft_upsert(DraftRecord {
                file_path: canonical_path,
                scene_json,
                content_hash: hash.clone(),
                base_hash: base_hash.clone(),
                updated_at: saved_at,
                is_dirty: true,
            })
            .await?;
        if let Some(recovery) = self.recovery.clone() {
            let document_id = document_id_for_path(&authorized.path);
            let original_path = authorized.path.clone();
            let base_file_hash = base_hash.unwrap_or_default();
            run_blocking(move || {
                recovery
                    .write_snapshot(
                        &document_id,
                        Some(&original_path),
                        &base_file_hash,
                        saved_at,
                        &snapshot_scene_json,
                    )
                    .map(|_| ())
                    .map_err(AppError::from)
            })
            .await?;
        }
        Ok(SaveDraftResponse {
            content_hash: hash,
            saved_at,
        })
    }

    async fn checkpoint(&self, request: CheckpointRequest) -> Result<CheckpointResponse, AppError> {
        let authorized = self
            .authorize_path(Path::new(&request.path), PathMode::CreateOrReplace)
            .await?;
        if self.conflicts.is_conflicted(&authorized.path).await {
            return Err(AppError::ConflictPending(authorized.path));
        }
        let _document_guard = self.lock_document(&authorized.path).await;
        let limit = self.scene_limit_bytes;
        let scene_json = request.scene_json;
        let (scene_json, hash) = run_blocking(move || {
            validate_active_scene(scene_json.as_bytes(), limit)?;
            let hash = content_hash(scene_json.as_bytes());
            Ok((scene_json, hash))
        })
        .await?;

        let write_path = authorized.path.clone();
        let write_contents = scene_json.clone();
        run_blocking(move || {
            atomic_write(&write_path, write_contents.as_bytes()).map_err(AppError::from)
        })
        .await?;

        let metadata_path = authorized.path.clone();
        let (mtime, file_size) = run_blocking(move || file_metadata(&metadata_path)).await?;
        let canonical_path = path_string(&authorized.path);
        let indexed_file = authorized
            .workspace
            .map(|workspace| {
                file_index_record(&workspace, &authorized.path, mtime, file_size, &hash)
            })
            .transpose()?;
        self.repository
            .document_checkpoint_commit(
                DraftRecord {
                    file_path: canonical_path,
                    scene_json,
                    content_hash: hash.clone(),
                    base_hash: Some(hash.clone()),
                    updated_at: mtime,
                    is_dirty: false,
                },
                indexed_file,
            )
            .await?;
        if let Some(watcher) = self.watcher.clone() {
            watcher
                .note_own_write(authorized.path, mtime, file_size, hash.clone())
                .await;
        }
        let _reason: CheckpointReason = request.reason;
        Ok(CheckpointResponse {
            new_base_hash: hash,
            mtime,
        })
    }

    async fn resolve_conflict(
        &self,
        request: ResolveConflictRequest,
    ) -> Result<ResolveConflictResponse, AppError> {
        let authorized = self
            .authorize_path(Path::new(&request.path), PathMode::Existing)
            .await?;
        let _document_guard = self.lock_document(&authorized.path).await;
        let limit = self.scene_limit_bytes;
        let canonical_path = path_string(&authorized.path);
        let draft = self
            .repository
            .draft_get(canonical_path.clone())
            .await?
            .ok_or_else(|| {
                AppError::Internal(
                    "no recovery draft exists for the conflicted document".to_owned(),
                )
            })?;

        let external_path = authorized.path.clone();
        let external_bytes = run_blocking(move || read_bounded(&external_path, limit)).await?;
        let external_hash = content_hash(&external_bytes);
        let external_scene = validate_persisted_scene(&external_bytes, limit)?;
        let external_json = String::from_utf8(external_bytes)
            .map_err(|error| AppError::InvalidScene(error.to_string()))?;

        let response = match request.resolution {
            ConflictResolution::TakeExternal => {
                self.repository
                    .draft_upsert(DraftRecord {
                        file_path: canonical_path,
                        scene_json: external_json,
                        content_hash: external_hash.clone(),
                        base_hash: Some(external_hash.clone()),
                        updated_at: unix_timestamp()?,
                        is_dirty: false,
                    })
                    .await?;
                ResolveConflictResponse {
                    scene: Some(external_scene),
                    new_base_hash: external_hash,
                }
            }
            ConflictResolution::KeepLocal => {
                self.repository
                    .draft_upsert(DraftRecord {
                        base_hash: Some(external_hash.clone()),
                        ..draft
                    })
                    .await?;
                ResolveConflictResponse {
                    scene: None,
                    new_base_hash: external_hash,
                }
            }
            ConflictResolution::SaveAsNew => {
                let save_as_path = request.save_as_path.as_deref().ok_or_else(|| {
                    AppError::PathAccessDenied(PathBuf::from("<missing save-as path>"))
                })?;
                let target = self.authorize_save_as_path(save_as_path).await?;
                if target == authorized.path {
                    return Err(AppError::PathAccessDenied(target));
                }
                let write_path = target.clone();
                let scene_json = draft.scene_json.clone();
                let local_hash = content_hash(scene_json.as_bytes());
                let write_scene = scene_json.clone();
                run_blocking(move || {
                    atomic_write(&write_path, write_scene.as_bytes()).map_err(AppError::from)
                })
                .await?;
                let metadata_path = target.clone();
                let (mtime, file_size) =
                    run_blocking(move || file_metadata(&metadata_path)).await?;
                let workspaces = self.repository.workspace_list().await?;
                let indexed_file = owning_workspace(&workspaces, &target)
                    .map(|workspace| {
                        file_index_record(&workspace, &target, mtime, file_size, &local_hash)
                    })
                    .transpose()?;
                self.repository
                    .document_checkpoint_commit(
                        DraftRecord {
                            file_path: path_string(&target),
                            scene_json,
                            content_hash: local_hash.clone(),
                            base_hash: Some(local_hash.clone()),
                            updated_at: mtime,
                            is_dirty: false,
                        },
                        indexed_file,
                    )
                    .await?;
                self.repository.draft_delete(canonical_path).await?;
                if let Some(watcher) = self.watcher.clone() {
                    watcher
                        .note_own_write(target, mtime, file_size, local_hash.clone())
                        .await;
                }
                ResolveConflictResponse {
                    scene: None,
                    new_base_hash: local_hash,
                }
            }
        };

        self.conflicts.clear_conflicted(&authorized.path).await;
        Ok(response)
    }

    async fn close(&self, request: CloseDocumentRequest) -> Result<EmptyResponse, AppError> {
        let authorized = self
            .authorize_path(Path::new(&request.path), PathMode::Existing)
            .await?;
        let _document_guard = self.lock_document(&authorized.path).await;
        let canonical_path = path_string(&authorized.path);
        if request.discard_draft {
            self.repository.draft_delete(canonical_path).await?;
            return Ok(EmptyResponse {});
        }
        if self
            .repository
            .draft_get(canonical_path)
            .await?
            .is_some_and(|draft| draft.is_dirty)
        {
            return Err(AppError::ConflictPending(authorized.path));
        }
        Ok(EmptyResponse {})
    }

    async fn authorize_path(
        &self,
        requested: &Path,
        mode: PathMode,
    ) -> Result<AuthorizedPath, AppError> {
        if !is_supported_document_path(requested) {
            return Err(AppError::PathAccessDenied(requested.to_path_buf()));
        }
        let workspaces = self.repository.workspace_list().await?;
        let policy = WorkspacePathPolicy::new(
            workspaces
                .iter()
                .map(|workspace| Path::new(&workspace.root_path)),
        )?;

        let authorization = match mode {
            PathMode::Existing => policy.authorize_existing(requested),
            PathMode::CreateOrReplace if requested.exists() => policy.authorize_existing(requested),
            PathMode::CreateOrReplace => policy.authorize_for_creation(requested),
        };
        match authorization {
            Ok(path) => Ok(AuthorizedPath {
                workspace: owning_workspace(&workspaces, &path),
                path,
            }),
            Err(PathSecurityError::AccessDenied(_))
                if self.is_direct_file_allowed(requested, mode) =>
            {
                let path = normalize_granted_path(requested, mode)?;
                Ok(AuthorizedPath {
                    workspace: owning_workspace(&workspaces, &path),
                    path,
                })
            }
            Err(PathSecurityError::AccessDenied(_)) => {
                Err(AppError::PathAccessDenied(requested.to_path_buf()))
            }
            Err(error) => Err(error.into()),
        }
    }

    fn is_direct_file_allowed(&self, requested: &Path, mode: PathMode) -> bool {
        if self.direct_file_grant.is_allowed(requested) {
            return true;
        }

        // The save dialog scopes the exact path selected by the user. The
        // frontend adds the standard extension when the platform dialog does
        // not, so accept only that single, deterministic sibling path.
        matches!(mode, PathMode::CreateOrReplace)
            && !requested.exists()
            && requested
                .extension()
                .is_some_and(|value| value == "excalidraw")
            && self
                .direct_file_grant
                .is_allowed(&requested.with_extension(""))
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
            Err(PathSecurityError::AccessDenied(_)) if self.direct_file_grant.is_allowed(path) => {
                normalize_granted_path(path, PathMode::CreateOrReplace)
            }
            Err(error) => Err(error.into()),
        }
    }

    async fn lock_document(&self, path: &Path) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.document_locks.lock().await;
            Arc::clone(
                locks
                    .entry(path.to_path_buf())
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
            )
        };
        lock.lock_owned().await
    }
}

fn is_supported_document_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|name| name.ends_with(".excalidraw") || name.ends_with(".excalidraw.json"))
}

#[derive(Clone)]
pub struct DocumentState {
    service: DocumentService,
}

impl DocumentState {
    pub fn new(service: DocumentService) -> Self {
        Self { service }
    }
}

#[tauri::command]
pub async fn doc_open(
    path: String,
    state: State<'_, DocumentState>,
) -> Result<SceneOpenResponse, IpcError> {
    state.service.doc_open(PathRequest { path }).await
}

#[tauri::command]
pub async fn doc_save_draft(
    path: String,
    scene_json: String,
    app: AppHandle,
    state: State<'_, DocumentState>,
) -> Result<SaveDraftResponse, IpcError> {
    let response = state
        .service
        .doc_save_draft(SaveDraftRequest {
            path: path.clone(),
            scene_json,
        })
        .await?;
    app.emit(
        "draft-saved",
        DraftSavedEvent {
            path,
            saved_at: response.saved_at,
        },
    )
    .map_err(|error| IpcError::from(AppError::Internal(error.to_string())))?;
    Ok(response)
}

#[tauri::command]
pub async fn doc_checkpoint(
    path: String,
    scene_json: String,
    reason: CheckpointReason,
    state: State<'_, DocumentState>,
) -> Result<CheckpointResponse, IpcError> {
    state
        .service
        .doc_checkpoint(CheckpointRequest {
            path,
            scene_json,
            reason,
        })
        .await
}

#[tauri::command]
pub async fn doc_close(
    path: String,
    discard_draft: bool,
    state: State<'_, DocumentState>,
) -> Result<EmptyResponse, IpcError> {
    state
        .service
        .doc_close(CloseDocumentRequest {
            path,
            discard_draft,
        })
        .await
}

#[tauri::command]
pub async fn doc_resolve_conflict(
    path: String,
    resolution: ConflictResolution,
    save_as_path: Option<String>,
    state: State<'_, DocumentState>,
) -> Result<ResolveConflictResponse, IpcError> {
    state
        .service
        .doc_resolve_conflict(ResolveConflictRequest {
            path,
            resolution,
            save_as_path,
        })
        .await
}

#[derive(Clone, Copy)]
enum PathMode {
    Existing,
    CreateOrReplace,
}

struct AuthorizedPath {
    path: PathBuf,
    workspace: Option<WorkspaceRecord>,
}

fn owning_workspace(workspaces: &[WorkspaceRecord], path: &Path) -> Option<WorkspaceRecord> {
    workspaces
        .iter()
        .find(|workspace| path.starts_with(Path::new(&workspace.root_path)))
        .cloned()
}

fn normalize_granted_path(path: &Path, mode: PathMode) -> Result<PathBuf, AppError> {
    if path.exists() || matches!(mode, PathMode::Existing) {
        return path.canonicalize().map_err(|source| AppError::Io {
            path: Some(path.to_path_buf()),
            source,
        });
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .ok_or_else(|| AppError::PathAccessDenied(path.to_path_buf()))?;
    let canonical_parent = parent.canonicalize().map_err(|source| AppError::Io {
        path: Some(parent.to_path_buf()),
        source,
    })?;
    Ok(canonical_parent.join(file_name))
}

fn validate_persisted_scene(
    bytes: &[u8],
    maximum_bytes: usize,
) -> Result<serde_json::Value, AppError> {
    validate_scene(bytes, maximum_bytes).map_err(|error| match error {
        SceneValidationError::TooLarge {
            actual_bytes,
            maximum_bytes,
        } => AppError::FileTooLarge {
            actual_bytes,
            maximum_bytes,
        },
        other => AppError::FileCorrupted(other.to_string()),
    })
}

fn validate_active_scene(bytes: &[u8], maximum_bytes: usize) -> Result<(), AppError> {
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

fn read_bounded(path: &Path, maximum_bytes: usize) -> Result<Vec<u8>, AppError> {
    let metadata = fs::metadata(path).map_err(|source| io_error(path, source))?;
    if metadata.len() > maximum_bytes as u64 {
        return Err(AppError::FileTooLarge {
            actual_bytes: metadata.len(),
            maximum_bytes: maximum_bytes as u64,
        });
    }
    let maximum_read = maximum_bytes
        .checked_add(1)
        .ok_or_else(|| AppError::Internal("scene size limit overflowed".to_owned()))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .map_err(|source| io_error(path, source))?
        .take(maximum_read as u64)
        .read_to_end(&mut bytes)
        .map_err(|source| io_error(path, source))?;
    if bytes.len() > maximum_bytes {
        return Err(AppError::FileTooLarge {
            actual_bytes: bytes.len() as u64,
            maximum_bytes: maximum_bytes as u64,
        });
    }
    Ok(bytes)
}

fn file_metadata(path: &Path) -> Result<(i64, i64), AppError> {
    let metadata = fs::metadata(path).map_err(|source| io_error(path, source))?;
    let modified = metadata
        .modified()
        .map_err(|source| io_error(path, source))?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| AppError::Internal(format!("file mtime predates Unix epoch: {error}")))?;
    let mtime = i64::try_from(modified.as_secs())
        .map_err(|_| AppError::Internal("file mtime exceeds the IPC range".to_owned()))?;
    let file_size = i64::try_from(metadata.len())
        .map_err(|_| AppError::Internal("file size exceeds the IPC range".to_owned()))?;
    Ok((mtime, file_size))
}

fn file_index_record(
    workspace: &WorkspaceRecord,
    path: &Path,
    mtime: i64,
    file_size: i64,
    hash: &str,
) -> Result<FileIndexRecord, AppError> {
    let workspace_root = Path::new(&workspace.root_path);
    let relative = path
        .strip_prefix(workspace_root)
        .map_err(|_| AppError::PathAccessDenied(path.to_path_buf()))?;
    let display_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::InvalidScene("document path has no UTF-8 file name".to_owned()))?;
    Ok(FileIndexRecord {
        canonical_path: path_string(path),
        workspace_id: workspace.id.clone(),
        display_name: display_name.to_owned(),
        relative_path: relative.display().to_string(),
        mtime,
        file_size,
        content_hash: Some(hash.to_owned()),
    })
}

fn unix_timestamp() -> Result<i64, AppError> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| AppError::Internal(format!("system clock predates Unix epoch: {error}")))?
        .as_secs();
    i64::try_from(seconds)
        .map_err(|_| AppError::Internal("system time exceeds the IPC range".to_owned()))
}

fn content_hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn path_string(path: &Path) -> String {
    path.display().to_string()
}

fn io_error(path: &Path, source: std::io::Error) -> AppError {
    if source.kind() == std::io::ErrorKind::NotFound {
        AppError::FileNotFound(path.to_path_buf())
    } else {
        AppError::Io {
            path: Some(path.to_path_buf()),
            source,
        }
    }
}

async fn run_blocking<T, F>(operation: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| AppError::Internal(format!("blocking document task failed: {error}")))?
}
