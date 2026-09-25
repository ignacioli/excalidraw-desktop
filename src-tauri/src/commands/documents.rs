use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

use crate::{
    database::repository::{
        DocumentRepository, DraftRecord, DraftRepository, FileIndexRecord, SqliteRepository,
        WorkspaceRecord, WorkspaceRepository,
    },
    documents::{
        assets::{
            asset_root_for, assets_dir, externalize_files, hash_from_reference, reembed_files,
        },
        atomic_write::atomic_write,
        recovery::{document_id_for_path, RecoveryStore},
        validation::{validate_scene, SceneValidationError},
    },
    history::{
        automatic::after_successful_checkpoint_with_assets,
        identity::{DocumentIdentity, FileSystemIdentity, IdentityError, IdentityStoreError},
        repository::PublishAsset,
        store::HistoryStore,
        types::{HistoryCurrentFileSaveOutcome, HistoryIssueEvent, HistoryIssueSource},
        validation::{
            validate_scene_and_assets, AssetObject, AssetObjectMetadata, SceneObjectMetadata,
            HISTORY_OBJECT_CODEC, HISTORY_OBJECT_SCHEMA_VERSION,
        },
    },
    security::{PathSecurityError, WorkspacePathPolicy},
    watcher::WatcherService,
};

use super::{
    dto::{
        CheckpointReason, CheckpointRequest, CheckpointResponse, CloseDocumentMode,
        CloseDocumentRequest, ConflictResolution, DraftSavedEvent, EmptyResponse, PathRequest,
        ResolveConflictRequest, ResolveConflictResponse, SaveDraftRequest, SaveDraftResponse,
        SceneOpenResponse,
    },
    error::{AppError, ErrorCode, IpcError},
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
    history_store: Option<Arc<HistoryStore>>,
    history_issues: Arc<tokio::sync::Mutex<HashMap<PathBuf, ErrorCode>>>,
}

/// A per-document lease shared by ordinary document writes and protected
/// history replacement. The lease is acquired after path/conflict authority
/// checks and remains held until replacement finalization or failure.
pub struct HistoryOperationLease {
    service: DocumentService,
    path: PathBuf,
    guard: Option<tokio::sync::OwnedMutexGuard<()>>,
}

impl HistoryOperationLease {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn assert_held(&self) -> Result<(), AppError> {
        self.guard.as_ref().map(|_| ()).ok_or_else(|| {
            AppError::HistoryBusy("history operation lease is no longer held".to_owned())
        })
    }

    /// Finalize the already-published target through DocumentService's normal
    /// repository, identity and watcher boundaries. The caller owns the
    /// filesystem replacement; this method must not write the document again.
    pub async fn finalize(
        &self,
        scene_json: String,
        base_hash: String,
        expected_identity: FileSystemIdentity,
        expected_hash: String,
    ) -> Result<(), AppError> {
        self.finalize_with_barrier(
            scene_json,
            base_hash,
            expected_identity,
            expected_hash,
            |_| {},
        )
        .await
    }

    #[cfg(test)]
    pub async fn finalize_for_test<F>(
        &self,
        scene_json: String,
        base_hash: String,
        expected_identity: FileSystemIdentity,
        expected_hash: String,
        before_final_validation: F,
    ) -> Result<(), AppError>
    where
        F: FnOnce(&Path),
    {
        self.finalize_with_barrier(
            scene_json,
            base_hash,
            expected_identity,
            expected_hash,
            before_final_validation,
        )
        .await
    }

    async fn finalize_with_barrier<F>(
        &self,
        scene_json: String,
        base_hash: String,
        expected_identity: FileSystemIdentity,
        expected_hash: String,
        before_final_validation: F,
    ) -> Result<(), AppError>
    where
        F: FnOnce(&Path),
    {
        if self.guard.is_none() {
            return Err(AppError::HistoryBusy(
                "history operation lease is no longer held".to_owned(),
            ));
        }
        if self.service.conflicts.is_conflicted(&self.path).await {
            return Err(AppError::ConflictPending(self.path.clone()));
        }
        if expected_hash != base_hash {
            return Err(AppError::HistoryStaleDocument(
                "published target hash does not match metadata commit hash".to_owned(),
            ));
        }
        let _ = self.verify_published_target(&expected_identity, &expected_hash)?;
        // This is the second observation after the rename. Test-only callers
        // place an external writer after it; the final observation below is
        // still immediately before the metadata commit.
        let _second_observation =
            self.verify_published_target(&expected_identity, &expected_hash)?;
        before_final_validation(&self.path);
        let (mtime, file_size) =
            self.verify_published_target(&expected_identity, &expected_hash)?;
        let workspaces = self.service.repository.workspace_list().await?;
        let indexed_file = owning_workspace(&workspaces, &self.path)
            .map(|workspace| {
                file_index_record(&workspace, &self.path, mtime, file_size, &base_hash)
            })
            .transpose()?;
        self.service
            .repository
            .document_checkpoint_commit(
                DraftRecord {
                    file_path: path_string(&self.path),
                    scene_json,
                    content_hash: base_hash.clone(),
                    base_hash: Some(base_hash.clone()),
                    updated_at: mtime,
                    is_dirty: false,
                },
                indexed_file,
            )
            .await?;
        self.service.remove_recovery_for_path(&self.path).await?;
        let history_store = self.service.history_store.clone().ok_or_else(|| {
            AppError::HistoryUnavailable("history store is not initialized".to_owned())
        })?;
        let identity = history_store
            .load_active_document_identity(&path_string(&self.path))
            .map_err(|error| AppError::HistoryUnavailable(error.to_string()))?
            .ok_or_else(|| {
                AppError::HistoryStaleDocument("document has no active history identity".to_owned())
            })?;
        let mut identity = identity;
        identity
            .record_self_write(&self.path, base_hash.clone())
            .map_err(map_identity_error)?;
        history_store
            .persist_document_identity(&identity, mtime)
            .map_err(map_history_identity_error)?;
        if let Some(watcher) = self.service.watcher.clone() {
            watcher
                .note_own_write(self.path.clone(), mtime, file_size, base_hash)
                .await;
        }
        Ok(())
    }

    fn verify_published_target(
        &self,
        expected_identity: &FileSystemIdentity,
        expected_hash: &str,
    ) -> Result<(i64, i64), AppError> {
        let identity = FileSystemIdentity::from_path(&self.path).map_err(map_identity_error)?;
        if !identity.reliable || &identity != expected_identity {
            return Err(AppError::HistoryStaleDocument(
                "published target filesystem identity changed before metadata commit".to_owned(),
            ));
        }
        let bytes = fs::read(&self.path).map_err(|source| io_error(&self.path, source))?;
        if content_hash(&bytes) != expected_hash {
            return Err(AppError::HistoryStaleDocument(
                "published target bytes changed before metadata commit".to_owned(),
            ));
        }
        file_metadata(&self.path)
    }
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
            history_store: None,
            history_issues: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
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
            history_store: None,
            history_issues: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
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

    /// Attaches the durable version-history store after the app has opened its
    /// independent history database.  Keeping this as an explicit wiring step
    /// preserves existing unit-test constructors while production uses the
    /// same persistent `history_documents` identity for every document path.
    pub fn attach_history_store(&mut self, history_store: Arc<HistoryStore>) {
        self.history_store = Some(history_store);
    }

    /// Exposes the conflict registry for integration tests and wiring.
    pub fn conflicts(&self) -> &ConflictRegistry {
        &self.conflicts
    }

    /// Acquire the same lock used by open/save/checkpoint/conflict paths.
    /// History replacement must not create a second lock domain.
    pub async fn acquire_history_operation(
        &self,
        path: &Path,
    ) -> Result<HistoryOperationLease, AppError> {
        let authorized = self.authorize_path(path, PathMode::Existing).await?;
        if self.conflicts.is_conflicted(&authorized.path).await {
            return Err(AppError::ConflictPending(authorized.path));
        }
        let guard = self.lock_document(&authorized.path).await;
        if self.conflicts.is_conflicted(&authorized.path).await {
            return Err(AppError::ConflictPending(authorized.path));
        }
        Ok(HistoryOperationLease {
            service: self.clone(),
            path: authorized.path,
            guard: Some(guard),
        })
    }

    /// Returns the latest non-fatal history issue for a document. Current-file
    /// save and Recovery remain authoritative; later history UI/event work can
    /// consume this separate status without turning the save into a failure.
    pub async fn history_issue_for_path(&self, path: &Path) -> Option<ErrorCode> {
        self.history_issues.lock().await.get(path).copied()
    }

    pub async fn history_issue_event_for_path(&self, path: &Path) -> Option<HistoryIssueEvent> {
        let code = self.history_issue_for_path(path).await?;
        let history_store = self.history_store.clone()?;
        let canonical_path = path_string(path);
        let identity = run_blocking(move || {
            Ok(history_store
                .load_active_document_identity(&canonical_path)
                .ok()
                .flatten())
        })
        .await
        .ok()
        .flatten()?;
        Some(HistoryIssueEvent {
            document_id: identity.document_id,
            operation: None,
            source: HistoryIssueSource::Automatic,
            error: IpcError {
                code,
                message: "Automatic history publication failed.".to_owned(),
                retriable: true,
                context: None,
            },
            current_file_save_outcome: Some(HistoryCurrentFileSaveOutcome::Succeeded),
        })
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

    #[cfg(feature = "e2e-harness")]
    pub(crate) async fn e2e_doc_checkpoint_at(
        &self,
        request: CheckpointRequest,
        recorded_at: i64,
    ) -> Result<CheckpointResponse, IpcError> {
        self.checkpoint_at(request, Some(recorded_at))
            .await
            .map_err(Into::into)
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
        // Establish or reconcile identity only after the real file has been
        // read and validated; an invalid open must not create a durable row.
        self.resolve_history_identity_for_open(&authorized.path)
            .await?;
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
        let asset_root = asset_root_for(
            &authorized.path,
            authorized
                .workspace
                .as_ref()
                .map(|workspace| Path::new(&workspace.root_path)),
        );
        let scene_json = request.scene_json;
        let (scene_json, hash) = run_blocking(move || {
            validate_active_scene(scene_json.as_bytes(), limit)?;
            let scene_json = externalize_files(&scene_json, &asset_root)?;
            let hash = content_hash(scene_json.as_bytes());
            Ok((scene_json, hash))
        })
        .await?;

        // Do not establish a persistent identity for a rejected scene payload.
        self.resolve_history_identity_for_existing(&authorized.path)
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
        self.checkpoint_at(request, None).await
    }

    async fn checkpoint_at(
        &self,
        request: CheckpointRequest,
        history_recorded_at: Option<i64>,
    ) -> Result<CheckpointResponse, AppError> {
        let authorized = self
            .authorize_path(Path::new(&request.path), PathMode::CreateOrReplace)
            .await?;
        if self.conflicts.is_conflicted(&authorized.path).await {
            return Err(AppError::ConflictPending(authorized.path));
        }
        let _document_guard = self.lock_document(&authorized.path).await;
        let limit = self.scene_limit_bytes;
        let history_asset_root = asset_root_for(
            &authorized.path,
            authorized
                .workspace
                .as_ref()
                .map(|workspace| Path::new(&workspace.root_path)),
        );
        let previous_base_hash = self
            .repository
            .draft_get(path_string(&authorized.path))
            .await?
            .and_then(|draft| draft.base_hash);
        let asset_root = asset_root_for(
            &authorized.path,
            authorized
                .workspace
                .as_ref()
                .map(|workspace| Path::new(&workspace.root_path)),
        );
        let scene_json = request.scene_json;
        let (scene_json, hash) = run_blocking(move || {
            validate_active_scene(scene_json.as_bytes(), limit)?;
            let scene_json = externalize_files(&scene_json, &asset_root)?;
            let hash = content_hash(scene_json.as_bytes());
            Ok((scene_json, hash))
        })
        .await?;

        // Only valid checkpoint content may establish the first persistent
        // identity for an existing file.
        let existing_history_identity = self
            .resolve_history_identity_for_existing_or_new(&authorized.path)
            .await?;

        let write_path = authorized.path.clone();
        let write_contents = scene_json.clone();
        run_blocking(move || {
            atomic_write(&write_path, write_contents.as_bytes()).map_err(AppError::from)
        })
        .await?;

        self.persist_history_identity_after_checkpoint(
            &authorized.path,
            existing_history_identity,
            &hash,
        )
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
                    scene_json: scene_json.clone(),
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
                .note_own_write(authorized.path.clone(), mtime, file_size, hash.clone())
                .await;
        }
        let _reason: CheckpointReason = request.reason;
        // History cadence is based on the successful save activity, not on a
        // file-provided mtime that may be preserved or externally adjusted.
        let history_recorded_at =
            history_recorded_at.unwrap_or_else(|| unix_timestamp().unwrap_or(mtime));
        self.publish_automatic_history_after_checkpoint(
            &authorized.path,
            &scene_json,
            &history_asset_root,
            previous_base_hash.as_deref(),
            history_recorded_at,
        )
        .await;
        Ok(CheckpointResponse {
            new_base_hash: hash,
            mtime,
        })
    }

    /// Automatic history is deliberately downstream of the successful cold
    /// checkpoint.  Any history failure is converted into a visible,
    /// durable issue and never changes the already-successful save result.
    async fn publish_automatic_history_after_checkpoint(
        &self,
        path: &Path,
        scene_json: &str,
        asset_root: &Path,
        previous_base_hash: Option<&str>,
        recorded_at: i64,
    ) {
        let Some(history_store) = self.history_store.clone() else {
            return;
        };
        let canonical_path = path_string(path);
        let identity = match history_store.load_active_document_identity(&canonical_path) {
            Ok(Some(identity)) => identity,
            Ok(None) => {
                self.remember_history_issue(path, ErrorCode::HistoryUnavailable)
                    .await;
                return;
            }
            Err(error) => {
                self.remember_history_issue(path, ErrorCode::HistoryUnavailable)
                    .await;
                eprintln!("automatic history identity lookup failed: {error}");
                return;
            }
        };
        let document_id = identity.document_id;
        let store = history_store;
        let scene = scene_json.as_bytes().to_vec();
        let asset_root = asset_root.to_path_buf();
        let previous_base_hash = previous_base_hash.map(str::to_owned);
        let document_id_for_publish = document_id.clone();
        let result = run_blocking(move || {
            let assets = checkpoint_assets(&scene, &asset_root)?;
            after_successful_checkpoint_with_assets(
                &store,
                &document_id_for_publish,
                &scene,
                assets,
                previous_base_hash.as_deref(),
                recorded_at,
            )
            .map(|_| ())
            .map_err(|error| AppError::HistoryUnavailable(error.to_string()))
        })
        .await;
        match result {
            Ok(()) => {
                self.clear_history_issue(path).await;
                // A successful baseline/no-op is also a successful recovery
                // of a prior automatic issue.
                let Some(store) = self.history_store.clone() else {
                    return;
                };
                let document_id = document_id.clone();
                let _ = run_blocking(move || {
                    store
                        .clear_maintenance_issue(&document_id)
                        .map_err(|error| AppError::HistoryUnavailable(error.to_string()))
                })
                .await;
            }
            Err(error) => {
                let code = history_error_code(&error);
                self.remember_history_issue(path, code).await;
                let Some(store) = self.history_store.clone() else {
                    return;
                };
                let document_id = document_id.clone();
                let code_name = format!("{code:?}");
                let _ = run_blocking(move || {
                    store
                        .record_maintenance_issue(
                            &document_id,
                            &code_name,
                            "automatic",
                            recorded_at,
                        )
                        .map_err(|error| AppError::HistoryUnavailable(error.to_string()))
                })
                .await;
                eprintln!("automatic history publication failed: {error}");
            }
        }
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
                let workspaces = self.repository.workspace_list().await?;
                let source_asset_root = asset_root_for(
                    &authorized.path,
                    authorized
                        .workspace
                        .as_ref()
                        .map(|workspace| Path::new(&workspace.root_path)),
                );
                let target_workspace = owning_workspace(&workspaces, &target);
                let target_asset_root = asset_root_for(
                    &target,
                    target_workspace
                        .as_ref()
                        .map(|workspace| Path::new(&workspace.root_path)),
                );
                let write_path = target.clone();
                let scene_json = draft.scene_json.clone();
                let (write_scene, stored_scene, local_hash) = run_blocking(move || {
                    let reembedded = reembed_files(&scene_json, &source_asset_root)?;
                    let stored_scene = if source_asset_root == target_asset_root {
                        scene_json
                    } else {
                        externalize_files(&reembedded, &target_asset_root)?
                    };
                    let local_hash = content_hash(stored_scene.as_bytes());
                    Ok((reembedded, stored_scene, local_hash))
                })
                .await?;
                let disk_hash = content_hash(write_scene.as_bytes());
                run_blocking(move || {
                    atomic_write(&write_path, write_scene.as_bytes()).map_err(AppError::from)
                })
                .await?;
                let metadata_path = target.clone();
                let (mtime, file_size) =
                    run_blocking(move || file_metadata(&metadata_path)).await?;
                let indexed_file = target_workspace
                    .map(|workspace| {
                        file_index_record(&workspace, &target, mtime, file_size, &disk_hash)
                    })
                    .transpose()?;
                self.repository
                    .document_checkpoint_commit(
                        DraftRecord {
                            file_path: path_string(&target),
                            scene_json: stored_scene,
                            content_hash: local_hash.clone(),
                            base_hash: Some(disk_hash.clone()),
                            updated_at: mtime,
                            is_dirty: false,
                        },
                        indexed_file,
                    )
                    .await?;
                self.repository.draft_delete(canonical_path).await?;
                if let Some(watcher) = self.watcher.clone() {
                    watcher
                        .note_own_write(target, mtime, file_size, disk_hash.clone())
                        .await;
                }
                ResolveConflictResponse {
                    scene: None,
                    new_base_hash: disk_hash,
                }
            }
        };

        self.conflicts.clear_conflicted(&authorized.path).await;
        Ok(response)
    }

    async fn close(&self, request: CloseDocumentRequest) -> Result<EmptyResponse, AppError> {
        let requested = PathBuf::from(&request.path);
        let canonical_path = match request.mode {
            CloseDocumentMode::Checkpointed if requested.exists() => {
                self.authorize_path(&requested, PathMode::Existing)
                    .await?
                    .path
            }
            CloseDocumentMode::Checkpointed => return Err(AppError::FileNotFound(requested)),
            CloseDocumentMode::DiscardOrphan if !requested.exists() => {
                self.authorize_missing_orphan(&requested).await?
            }
            CloseDocumentMode::DiscardOrphan => {
                let authorized = self.authorize_path(&requested, PathMode::Existing).await?;
                return Err(AppError::EntryChanged(authorized.path));
            }
        };
        let _document_guard = self.lock_document(&canonical_path).await;
        let canonical_path_string = path_string(&canonical_path);
        let draft = self
            .repository
            .draft_get(canonical_path_string.clone())
            .await?;
        if request.mode == CloseDocumentMode::Checkpointed
            && draft.as_ref().is_some_and(|draft| draft.is_dirty)
        {
            return Err(AppError::ConflictPending(canonical_path));
        }

        // A successful close consumes both the exact draft row and all
        // recovery slots belonging to this deterministic document id. Remove
        // snapshots first so a storage failure leaves the draft available for
        // a retry instead of silently losing the recovery record.
        self.remove_recovery_for_path(&canonical_path).await?;
        self.repository.draft_delete(canonical_path_string).await?;
        Ok(EmptyResponse {})
    }

    async fn authorize_missing_orphan(&self, requested: &Path) -> Result<PathBuf, AppError> {
        if !is_supported_document_path(requested) {
            return Err(AppError::PathAccessDenied(requested.to_path_buf()));
        }
        let requested_string = path_string(requested);
        let has_draft = self
            .repository
            .draft_get(requested_string.clone())
            .await?
            .is_some();
        let has_recovery = if let Some(recovery) = self.recovery.clone() {
            let requested_string = requested_string.clone();
            run_blocking(move || {
                recovery
                    .list_snapshots()
                    .map(|snapshots| {
                        snapshots.into_iter().any(|(_, snapshot)| {
                            snapshot.original_path.as_deref() == Some(requested_string.as_str())
                        })
                    })
                    .map_err(AppError::from)
            })
            .await?
        } else {
            false
        };
        if has_draft || has_recovery {
            Ok(requested.to_path_buf())
        } else {
            Err(AppError::FileNotFound(requested.to_path_buf()))
        }
    }

    async fn remove_recovery_for_path(&self, path: &Path) -> Result<(), AppError> {
        let Some(recovery) = self.recovery.clone() else {
            return Ok(());
        };
        let document_id = document_id_for_path(path);
        run_blocking(move || {
            recovery
                .remove_document(&document_id)
                .map_err(AppError::from)
        })
        .await
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

    async fn resolve_history_identity_for_open(&self, path: &Path) -> Result<(), AppError> {
        let Some(history_store) = self.history_store.clone() else {
            return Ok(());
        };
        let path = path.to_path_buf();
        let operation_path = path.clone();
        let created_at = unix_timestamp()?;
        let result = run_blocking(move || {
            history_store
                .resolve_document_identity_for_open(&operation_path, created_at)
                .map(|_| ())
                .map_err(map_history_identity_error)
        })
        .await;
        match result {
            Ok(()) => {
                self.clear_history_issue(&path).await;
                Ok(())
            }
            Err(error) if is_history_store_failure(&error) => {
                self.remember_history_issue(&path, ErrorCode::HistoryUnavailable)
                    .await;
                Ok(())
            }
            Err(error) => {
                self.remember_history_issue(&path, history_error_code(&error))
                    .await;
                Err(error)
            }
        }
    }

    async fn resolve_history_identity_for_existing(&self, path: &Path) -> Result<(), AppError> {
        let Some(history_store) = self.history_store.clone() else {
            return Ok(());
        };
        let path = path.to_path_buf();
        let operation_path = path.clone();
        let created_at = unix_timestamp()?;
        let result = run_blocking(move || {
            history_store
                .resolve_document_identity_for_existing(&operation_path, created_at)
                .map(|_| ())
                .map_err(map_history_identity_error)
        })
        .await;
        match result {
            Ok(()) => {
                self.clear_history_issue(&path).await;
                Ok(())
            }
            Err(error) if is_history_store_failure(&error) => {
                self.remember_history_issue(&path, ErrorCode::HistoryUnavailable)
                    .await;
                Ok(())
            }
            Err(error) => {
                self.remember_history_issue(&path, history_error_code(&error))
                    .await;
                Err(error)
            }
        }
    }

    async fn resolve_history_identity_for_existing_or_new(
        &self,
        path: &Path,
    ) -> Result<Option<DocumentIdentity>, AppError> {
        let Some(history_store) = self.history_store.clone() else {
            return Ok(None);
        };
        if !path.exists() {
            return Ok(None);
        }
        let path = path.to_path_buf();
        let operation_path = path.clone();
        let created_at = unix_timestamp()?;
        let result = run_blocking(move || {
            history_store
                .resolve_document_identity_for_existing(&operation_path, created_at)
                .map(Some)
                .map_err(map_history_identity_error)
        })
        .await;
        match result {
            Ok(identity) => {
                self.clear_history_issue(&path).await;
                Ok(identity)
            }
            Err(error) if is_history_store_failure(&error) => {
                self.remember_history_issue(&path, ErrorCode::HistoryUnavailable)
                    .await;
                Ok(None)
            }
            Err(error) => {
                self.remember_history_issue(&path, history_error_code(&error))
                    .await;
                Err(error)
            }
        }
    }

    async fn persist_history_identity_after_checkpoint(
        &self,
        path: &Path,
        existing: Option<DocumentIdentity>,
        content_hash: &str,
    ) -> Result<(), AppError> {
        let Some(history_store) = self.history_store.clone() else {
            return Ok(());
        };
        let path = path.to_path_buf();
        let operation_path = path.clone();
        let content_hash = content_hash.to_owned();
        let checkpoint_time = unix_timestamp()?;
        let result = run_blocking(move || {
            let mut identity = match existing {
                Some(identity) => identity,
                None => DocumentIdentity::establish(&operation_path).map_err(map_identity_error)?,
            };
            identity
                .record_self_write(&operation_path, content_hash)
                .map_err(map_identity_error)?;
            history_store
                .persist_document_identity(&identity, checkpoint_time)
                .map_err(map_history_identity_error)
        })
        .await;
        match result {
            Ok(()) => {
                self.clear_history_issue(&path).await;
                Ok(())
            }
            Err(error) if is_history_store_failure(&error) => {
                self.remember_history_issue(&path, ErrorCode::HistoryUnavailable)
                    .await;
                Ok(())
            }
            Err(error) => {
                self.remember_history_issue(&path, history_error_code(&error))
                    .await;
                Err(error)
            }
        }
    }

    async fn remember_history_issue(&self, path: &Path, code: ErrorCode) {
        self.history_issues
            .lock()
            .await
            .insert(path.to_path_buf(), code);
    }

    async fn clear_history_issue(&self, path: &Path) {
        self.history_issues.lock().await.remove(path);
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
    app: AppHandle,
    state: State<'_, DocumentState>,
) -> Result<SceneOpenResponse, IpcError> {
    let response = state
        .service
        .doc_open(PathRequest { path: path.clone() })
        .await?;
    let authorized = state
        .service
        .authorize_path(Path::new(&path), PathMode::Existing)
        .await?;
    let asset_root = asset_root_for(
        &authorized.path,
        authorized
            .workspace
            .as_ref()
            .map(|workspace| Path::new(&workspace.root_path)),
    );
    super::asset_scope::grant_response_assets(&app, &asset_root, &response.scene)?;
    Ok(response)
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
    app: AppHandle,
    state: State<'_, DocumentState>,
) -> Result<CheckpointResponse, IpcError> {
    let event_path = fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    let response = state
        .service
        .doc_checkpoint(CheckpointRequest {
            path,
            scene_json,
            reason,
        })
        .await?;
    if let Some(event) = state
        .service
        .history_issue_event_for_path(&event_path)
        .await
    {
        let _ = app.emit("history-issue", event);
    }
    Ok(response)
}

#[tauri::command]
pub async fn doc_close(
    path: String,
    mode: CloseDocumentMode,
    state: State<'_, DocumentState>,
) -> Result<EmptyResponse, IpcError> {
    state
        .service
        .doc_close(CloseDocumentRequest { path, mode })
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

fn checkpoint_assets(scene_json: &[u8], asset_root: &Path) -> Result<Vec<PublishAsset>, AppError> {
    let scene: Value = serde_json::from_slice(scene_json)
        .map_err(|error| AppError::InvalidScene(error.to_string()))?;
    let Some(files) = scene.get("files").and_then(Value::as_object) else {
        return Ok(Vec::new());
    };
    let mut assets = Vec::new();
    for (file_id, file) in files {
        let file = file.as_object().ok_or_else(|| {
            AppError::InvalidScene(format!("history asset {file_id} is not an object"))
        })?;
        let reference = file.get("dataURL").and_then(Value::as_str).ok_or_else(|| {
            AppError::InvalidScene(format!("history asset {file_id} has no dataURL"))
        })?;
        let hash = hash_from_reference(reference).ok_or_else(|| {
            AppError::InvalidScene(format!(
                "history asset {file_id} is not an internal content-addressed reference"
            ))
        })?;
        let path = assets_dir(asset_root).join(hash);
        let bytes = fs::read(&path).map_err(|source| io_error(&path, source))?;
        let actual_hash = content_hash(&bytes);
        if actual_hash != hash {
            return Err(AppError::InvalidScene(format!(
                "history asset {file_id} content hash does not match its reference"
            )));
        }
        let mime_type = file
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("application/octet-stream")
            .to_owned();
        assets.push(PublishAsset {
            file_id: file_id.clone(),
            bytes,
            mime_type,
        });
    }
    let scene_metadata = SceneObjectMetadata {
        schema_version: HISTORY_OBJECT_SCHEMA_VERSION,
        codec: HISTORY_OBJECT_CODEC.to_owned(),
        raw_length: scene_json.len() as u64,
        sha256: content_hash(scene_json),
        relative_path: PathBuf::from("scenes/checkpoint-validation.json"),
    };
    let asset_objects = assets
        .iter()
        .map(|asset| {
            let hash = content_hash(&asset.bytes);
            AssetObject {
                file_id: asset.file_id.clone(),
                metadata: AssetObjectMetadata {
                    sha256: hash.clone(),
                    byte_length: asset.bytes.len() as u64,
                    mime_type: asset.mime_type.clone(),
                    relative_path: PathBuf::from(format!("assets/{hash}")),
                },
                bytes: &asset.bytes,
            }
        })
        .collect::<Vec<_>>();
    validate_scene_and_assets(scene_json, &scene_metadata, &asset_objects)
        .map_err(|error| AppError::InvalidScene(error.to_string()))?;
    Ok(assets)
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

fn map_identity_error(error: IdentityError) -> AppError {
    if error.is_stale_boundary() {
        AppError::HistoryStaleDocument(
            "document filesystem identity is no longer current".to_owned(),
        )
    } else {
        AppError::HistoryUnavailable(error.to_string())
    }
}

fn map_history_identity_error(error: IdentityStoreError) -> AppError {
    match error {
        IdentityStoreError::Identity(error) => map_identity_error(error),
        other => AppError::HistoryUnavailable(other.to_string()),
    }
}

fn is_history_store_failure(error: &AppError) -> bool {
    matches!(error, AppError::HistoryUnavailable(_))
}

fn history_error_code(error: &AppError) -> ErrorCode {
    match error {
        AppError::HistoryStaleDocument(_) => ErrorCode::HistoryStaleDocument,
        _ => ErrorCode::HistoryUnavailable,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::repository::SqliteRepository;
    use std::sync::Arc;
    use uuid::Uuid;

    #[test]
    fn checkpoint_assets_rejects_bytes_that_do_not_match_the_reference_hash() {
        let root =
            std::env::temp_dir().join(format!("excalidraw-history-asset-hash-{}", Uuid::new_v4()));
        fs::create_dir_all(assets_dir(&root)).expect("create asset directory");
        let expected_bytes = b"expected image bytes";
        let expected_hash = content_hash(expected_bytes);
        fs::write(assets_dir(&root).join(&expected_hash), b"corrupted bytes")
            .expect("write corrupt asset");
        let scene = serde_json::json!({
            "files": {
                "image": {
                    "dataURL": format!("asset://{expected_hash}"),
                    "mimeType": "image/png"
                }
            }
        });

        let error = checkpoint_assets(scene.to_string().as_bytes(), &root)
            .expect_err("corrupt asset must block automatic history publication");
        assert!(
            matches!(error, AppError::InvalidScene(message) if message.contains("content hash"))
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn checkpoint_assets_rejects_digest_valid_non_image_bytes() {
        let root =
            std::env::temp_dir().join(format!("excalidraw-history-asset-image-{}", Uuid::new_v4()));
        fs::create_dir_all(assets_dir(&root)).expect("create asset directory");
        let bytes = b"not a PNG";
        let hash = content_hash(bytes);
        fs::write(assets_dir(&root).join(&hash), bytes).expect("write invalid image");
        let scene = serde_json::json!({
            "type": "excalidraw",
            "version": 2,
            "elements": [{"id":"image","type":"image","fileId":"image"}],
            "appState": {},
            "files": {
                "image": {
                    "dataURL": format!("asset://{hash}"),
                    "mimeType": "image/png"
                }
            }
        });

        let error = checkpoint_assets(scene.to_string().as_bytes(), &root)
            .expect_err("non-image bytes must block automatic history publication");
        assert!(
            matches!(error, AppError::InvalidScene(message) if message.contains("image bytes"))
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[tokio::test]
    async fn finalize_rechecks_after_external_writer_barrier_before_metadata_commit() {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-history-finalize-barrier-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create test root");
        let path = root.join("drawing.excalidraw");
        let scene =
            br#"{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}"#.to_vec();
        fs::write(&path, &scene).expect("write initial scene");
        let repository = Arc::new(
            SqliteRepository::open(&root.join("state.sqlite3"))
                .await
                .expect("open repository"),
        );
        let service = DocumentService::new(repository.clone());
        let identity = FileSystemIdentity::from_path(&path).expect("read initial identity");
        let hash = content_hash(&scene);
        let guard = service.lock_document(&path).await;
        let lease = HistoryOperationLease {
            service,
            path: path.clone(),
            guard: Some(guard),
        };

        let error = lease
            .finalize_for_test(
                String::from_utf8(scene.clone()).expect("scene UTF-8"),
                hash.clone(),
                identity,
                hash,
                |target| {
                    fs::write(target, b"external writer after observation")
                        .expect("external writer");
                },
            )
            .await
            .expect_err("external write must block metadata commit");
        assert!(matches!(error, AppError::HistoryStaleDocument(_)));
        assert!(repository
            .draft_get(path.display().to_string())
            .await
            .expect("read draft")
            .is_none());
        assert_eq!(
            fs::read(&path).expect("read externally changed file"),
            b"external writer after observation"
        );
        drop(lease);
        fs::remove_dir_all(root).expect("remove test root");
    }
}
