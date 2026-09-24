//! Tauri history commands.
//!
//! Read commands are kept in [`HistoryQueryService`]. Protected replacement
//! has its own service so document authority and idempotent operation status
//! remain separate from the list/preview read path.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::{
    commands::{
        documents::{DirectFileGrant, DocumentService, HistoryOperationLease},
        dto::{
            HistoryDocumentLocator, HistoryListRequest, HistoryListResponse,
            HistoryOperationStatusRequest, HistoryOperationStatusResponse, HistoryPreviewRequest,
            HistoryPreviewResponse, HistoryReplaceRequest, HistoryReplaceResponse,
            HistoryReplaceTarget,
        },
        error::{AppError, IpcError},
    },
    database::repository::{SqliteRepository, WorkspaceRepository},
    documents::{
        assets::{asset_root_for, ASSET_DIRECTORY_NAME},
        atomic_write::atomic_write_bytes,
        validation::validate_scene,
    },
    history::{
        gc::{HydrationPin, ObjectKey, ObjectReferences},
        identity::{DocumentIdentity, FileSystemIdentity},
        operation::{OperationObjectPin, OperationRequest, OperationStore, OperationUpdate},
        query::HistoryState,
        replacement::{
            CapturedAsset, CapturedDocument, FinalizedReplacement, PreparedTarget,
            ProtectedReplacementBackend, ProtectedReplacementEngine, ProtectedReplacementRequest,
            ProtectionReceipt, ReplacementOutcome, ReplacementPhase,
        },
        store::HistoryStore,
        types::{HistoryOperationKind, HistoryOperationState, HistoryProtectedAction},
        validation::{
            validate_scene_and_assets, AssetObject, AssetObjectMetadata, SceneObjectMetadata,
            HISTORY_OBJECT_CODEC, HISTORY_OBJECT_SCHEMA_VERSION,
        },
    },
    security::{PathSecurityError, WorkspacePathPolicy},
};

#[tauri::command]
pub async fn history_list(
    request: HistoryListRequest,
    state: State<'_, HistoryState>,
) -> Result<HistoryListResponse, IpcError> {
    state.service.list(request).await
}

#[tauri::command]
pub async fn history_preview(
    request: HistoryPreviewRequest,
    state: State<'_, HistoryState>,
) -> Result<HistoryPreviewResponse, IpcError> {
    state.service.preview(request).await
}

#[derive(Clone)]
pub struct HistoryReplacementState {
    pub service: Arc<HistoryReplacementService>,
}

impl HistoryReplacementState {
    pub fn with_document_service(
        document_service: DocumentService,
        repository: Arc<SqliteRepository>,
        store: Option<Arc<HistoryStore>>,
        direct_file_grant: Arc<dyn DirectFileGrant>,
    ) -> Self {
        Self {
            service: Arc::new(HistoryReplacementService {
                repository,
                store,
                direct_file_grant,
                document_service,
            }),
        }
    }
}

#[derive(Clone)]
pub struct HistoryReplacementService {
    repository: Arc<SqliteRepository>,
    store: Option<Arc<HistoryStore>>,
    direct_file_grant: Arc<dyn DirectFileGrant>,
    document_service: DocumentService,
}

type ResponseAssetGrant = Arc<dyn Fn(&Path, &Value) -> Result<(), AppError> + Send + Sync>;

impl HistoryReplacementService {
    #[cfg(feature = "e2e-harness")]
    pub(crate) async fn e2e_replace(
        &self,
        request: HistoryReplaceRequest,
    ) -> Result<HistoryReplaceResponse, IpcError> {
        self.replace(request, None).await
    }

    #[cfg(feature = "e2e-harness")]
    pub(crate) async fn e2e_operation_status(
        &self,
        request: HistoryOperationStatusRequest,
    ) -> Result<HistoryOperationStatusResponse, IpcError> {
        self.operation_status(request).await
    }

    async fn replace(
        &self,
        request: HistoryReplaceRequest,
        asset_grant: Option<ResponseAssetGrant>,
    ) -> Result<HistoryReplaceResponse, IpcError> {
        request
            .validate()
            .map_err(|error| AppError::HistoryStaleDocument(error.to_string()))?;
        let unresolved = self
            .resolve_document_without_file_check(&request.document)
            .await?;
        // Acquire the shared DocumentService lease before reading or creating
        // the durable operation.  This is the same lock domain used by draft,
        // checkpoint, and close, so two concurrent retries cannot both publish
        // protection for one request id.
        let lease = self
            .document_service
            .acquire_history_operation(&unresolved.path)
            .await?;
        if let Some(response) = self
            .existing_operation_outcome(&unresolved.document_id, &request)
            .await?
        {
            if let (
                Some(grant),
                HistoryReplaceResponse::Completed {
                    adopted_scene,
                    request_id,
                    ..
                },
            ) = (&asset_grant, &response)
            {
                if let Err(error) = grant(&unresolved.asset_root, adopted_scene) {
                    eprintln!("completed history replay asset authorization failed: {error}");
                    // A replay is already committed. Failed display access
                    // cannot turn that durable outcome into a precommit error.
                    return Ok(HistoryReplaceResponse::PendingReconciliation {
                        request_id: request_id.clone(),
                        replacement_committed: None,
                        operation_state: HistoryOperationState::PendingReconciliation,
                    });
                }
            }
            return Ok(response);
        }
        let resolved = self.verify_document(unresolved)?;
        let store = self.store()?;
        let action = action_for_target(&request.target);
        tokio::task::spawn_blocking(move || {
            replace_blocking(request, resolved, store, action, lease, asset_grant)
        })
        .await
        .map_err(|error| AppError::Internal(format!("history replacement task failed: {error}")))?
        .map_err(Into::into)
    }

    async fn operation_status(
        &self,
        request: HistoryOperationStatusRequest,
    ) -> Result<HistoryOperationStatusResponse, IpcError> {
        request
            .validate()
            .map_err(|error| AppError::HistoryStaleDocument(error.to_string()))?;
        let resolved = self
            .resolve_document_without_file_check(&request.document)
            .await?;
        let store = self.store()?;
        let request_id = request.request_id;
        tokio::task::spawn_blocking(move || {
            let operations = OperationStore::new(&store);
            let operation = operations
                .load(&request_id)
                .map_err(|error| AppError::HistoryUnavailable(error.to_string()))?
                .ok_or_else(|| {
                    AppError::HistoryStaleDocument("history operation is unknown".to_owned())
                })?;
            if operation.document_id != resolved.document_id {
                return Err(AppError::HistoryStaleDocument(
                    "history operation belongs to another document".to_owned(),
                ));
            }
            operation_status_response(&store, &operation)
        })
        .await
        .map_err(|error| AppError::Internal(format!("history status task failed: {error}")))?
        .map_err(Into::into)
    }

    async fn status_with_asset_grant(
        &self,
        request: HistoryOperationStatusRequest,
        grant: ResponseAssetGrant,
    ) -> Result<HistoryOperationStatusResponse, IpcError> {
        let locator = request.document.clone();
        let mut response = self.operation_status(request).await?;
        if let Some(scene) = &response.adopted_scene {
            let result = match self.resolve_document_without_file_check(&locator).await {
                Ok(resolved) => grant(&resolved.asset_root, scene).map_err(IpcError::from),
                Err(error) => Err(error),
            };
            if let Err(error) = result {
                eprintln!("completed history status asset authorization failed: {error:?}");
                response.state = HistoryOperationState::PendingReconciliation;
                response.replacement_committed = Some(true);
                response.adopted_scene = None;
            }
        }
        Ok(response)
    }

    fn store(&self) -> Result<Arc<HistoryStore>, IpcError> {
        self.store.clone().ok_or_else(|| {
            AppError::HistoryUnavailable("history store is not initialized".to_owned()).into()
        })
    }

    fn verify_document(&self, resolved: ResolvedDocument) -> Result<ResolvedDocument, IpcError> {
        let observation = resolved
            .identity
            .verify_current_file(&resolved.path)
            .map_err(|error| AppError::HistoryStaleDocument(error.to_string()))?;
        let bytes = fs::read(&resolved.path).map_err(|source| AppError::Io {
            path: Some(resolved.path.clone()),
            source,
        })?;
        Ok(ResolvedDocument {
            current_identity: observation.filesystem_identity,
            current_hash: sha256_hex(&bytes),
            ..resolved
        })
    }

    async fn existing_operation_outcome(
        &self,
        document_id: &str,
        request: &HistoryReplaceRequest,
    ) -> Result<Option<HistoryReplaceResponse>, IpcError> {
        let store = self.store()?;
        let document_id = document_id.to_owned();
        let request_id = request.request_id.clone();
        let target = request.target.clone();
        let session_generation = request.session_generation;
        let revision = request.revision;
        let expected_base_hash = request.expected_base_hash.clone();
        tokio::task::spawn_blocking(move || {
            let operations = OperationStore::new(&store);
            let Some(operation) = operations
                .load(&request_id)
                .map_err(|error| AppError::HistoryUnavailable(error.to_string()))?
            else {
                return Ok(None);
            };
            if operation.document_id != document_id {
                return Err(AppError::HistoryStaleDocument(
                    "history operation belongs to another document".to_owned(),
                ));
            }
            let expected_fingerprint = operation
                .expected_old_identity
                .as_deref()
                .map(|identity| {
                    replacement_fingerprint_from_parts(
                        &target,
                        session_generation,
                        revision,
                        &expected_base_hash,
                        identity,
                    )
                })
                .ok_or_else(|| {
                    AppError::HistoryUnavailable(
                        "history operation has no original document identity".to_owned(),
                    )
                })?;
            if operation.prepared_target_identity.as_deref() != Some(expected_fingerprint.as_str())
            {
                return Err(AppError::HistoryStaleDocument(
                    "request id is already bound to a different replacement target".to_owned(),
                ));
            }
            let status = operation_status_response(&store, &operation)?;
            Ok(Some(status_to_replace_response(status)?))
        })
        .await
        .map_err(|error| AppError::Internal(format!("history status task failed: {error}")))?
        .map_err(Into::into)
    }

    async fn resolve_document_without_file_check(
        &self,
        locator: &HistoryDocumentLocator,
    ) -> Result<ResolvedDocument, IpcError> {
        let store = self.store()?;
        let roots = self
            .repository
            .workspace_list()
            .await
            .map_err(AppError::from)?
            .into_iter()
            .map(|workspace| PathBuf::from(workspace.root_path))
            .collect::<Vec<_>>();
        let locator = locator.clone();
        let direct_file_grant = Arc::clone(&self.direct_file_grant);
        tokio::task::spawn_blocking(move || {
            resolve_document_blocking(&store, &locator, roots, direct_file_grant.as_ref())
        })
        .await
        .map_err(|error| AppError::Internal(format!("history authority task failed: {error}")))?
        .map_err(Into::into)
    }
}

#[tauri::command]
pub async fn history_replace(
    request: HistoryReplaceRequest,
    app: AppHandle,
    state: State<'_, HistoryReplacementState>,
) -> Result<HistoryReplaceResponse, IpcError> {
    let grant: ResponseAssetGrant =
        Arc::new(move |root, scene| super::asset_scope::grant_response_assets(&app, root, scene));
    state.service.replace(request, Some(grant)).await
}

#[tauri::command]
pub async fn history_operation_status(
    request: HistoryOperationStatusRequest,
    app: AppHandle,
    state: State<'_, HistoryReplacementState>,
) -> Result<HistoryOperationStatusResponse, IpcError> {
    let grant: ResponseAssetGrant =
        Arc::new(move |root, scene| super::asset_scope::grant_response_assets(&app, root, scene));
    state.service.status_with_asset_grant(request, grant).await
}

#[derive(Debug, Clone)]
struct ResolvedDocument {
    path: PathBuf,
    asset_root: PathBuf,
    document_id: String,
    identity: DocumentIdentity,
    current_identity: FileSystemIdentity,
    current_hash: String,
}

fn resolve_document_blocking(
    store: &HistoryStore,
    locator: &HistoryDocumentLocator,
    roots: Vec<PathBuf>,
    direct_file_grant: &dyn DirectFileGrant,
) -> Result<ResolvedDocument, AppError> {
    let policy = WorkspacePathPolicy::new(roots.iter().map(PathBuf::as_path))?;
    let requested_path = match locator {
        HistoryDocumentLocator::Path { path } => PathBuf::from(path),
        HistoryDocumentLocator::Handle { document_id } => store
            .with_connection(|connection| {
                connection.query_row(
                    "SELECT canonical_path FROM history_documents WHERE id = ?1 AND state = 'active'",
                    [document_id],
                    |row| row.get::<_, String>(0),
                )
            })
            .map(PathBuf::from)
            .map_err(|error| AppError::HistoryStaleDocument(error.to_string()))?,
    };
    let canonical_path = match policy.authorize_existing(&requested_path) {
        Ok(path) => path,
        Err(PathSecurityError::AccessDenied(_))
            if direct_file_grant.is_allowed(&requested_path) =>
        {
            requested_path
                .canonicalize()
                .map_err(|source| AppError::Io {
                    path: Some(requested_path.clone()),
                    source,
                })?
        }
        Err(error) => return Err(error.into()),
    };
    let identity = store
        .load_active_document_identity(&canonical_path.display().to_string())
        .map_err(|error| AppError::HistoryUnavailable(error.to_string()))?
        .ok_or_else(|| {
            AppError::HistoryStaleDocument("document has no active history identity".to_owned())
        })?;
    if let HistoryDocumentLocator::Handle { document_id } = locator {
        if identity.document_id != *document_id {
            return Err(AppError::HistoryStaleDocument(
                "document handle does not match current identity".to_owned(),
            ));
        }
    }
    let workspace_root = roots
        .iter()
        .filter(|root| canonical_path.starts_with(root))
        .max_by_key(|root| root.components().count())
        .map(PathBuf::as_path);
    let asset_root = asset_root_for(&canonical_path, workspace_root);
    Ok(ResolvedDocument {
        path: canonical_path,
        asset_root,
        document_id: identity.document_id.clone(),
        identity,
        current_identity: FileSystemIdentity::from_path(Path::new(".")).unwrap_or({
            FileSystemIdentity {
                device: None,
                inode: None,
                file_size: 0,
                modified: crate::history::identity::FileTimestamp {
                    seconds: 0,
                    nanoseconds: 0,
                },
                reliable: false,
            }
        }),
        current_hash: String::new(),
    })
}

fn replace_blocking(
    request: HistoryReplaceRequest,
    resolved: ResolvedDocument,
    store: Arc<HistoryStore>,
    action: HistoryProtectedAction,
    lease: HistoryOperationLease,
    asset_grant: Option<ResponseAssetGrant>,
) -> Result<HistoryReplaceResponse, AppError> {
    if resolved.current_hash != request.expected_base_hash {
        return Err(AppError::HistoryStaleDocument(
            "document base hash is stale".to_owned(),
        ));
    }
    let protected_request = ProtectedReplacementRequest {
        request_id: request.request_id.clone(),
        document_id: resolved.document_id.clone(),
        session_generation: request.session_generation,
        revision: request.revision,
        target_path: resolved.path.clone(),
        expected_base_hash: request.expected_base_hash.clone(),
        expected_identity: resolved.current_identity.clone(),
        action,
    };
    let backend = RealReplacementBackend::new(
        request.clone(),
        resolved,
        Arc::clone(&store),
        action,
        lease,
        asset_grant,
    );
    let mut engine = ProtectedReplacementEngine::new(backend);
    match engine.execute(protected_request) {
        ReplacementOutcome::Completed(finalized) => {
            let protection_version_id = engine
                .backend()
                .protection_version_id
                .clone()
                .ok_or_else(|| AppError::Internal("protection receipt missing".to_owned()))?;
            completed_response(request.request_id, protection_version_id, finalized)
        }
        ReplacementOutcome::PublishedButDurabilityUnknown(_) => {
            Ok(HistoryReplaceResponse::PendingReconciliation {
                request_id: request.request_id,
                replacement_committed: None,
                operation_state: HistoryOperationState::PendingReconciliation,
            })
        }
        ReplacementOutcome::PreCommitFailure(failure) => Err(map_replacement_failure(failure)),
        ReplacementOutcome::Conflict(failure) => {
            Err(AppError::HistoryStaleDocument(failure.message))
        }
    }
}

fn completed_response(
    request_id: String,
    protection_version_id: String,
    finalized: FinalizedReplacement,
) -> Result<HistoryReplaceResponse, AppError> {
    let adopted_scene: Value = serde_json::from_slice(&finalized.adopted_scene)
        .map_err(|error| AppError::InvalidScene(error.to_string()))?;
    Ok(HistoryReplaceResponse::Completed {
        request_id,
        replacement_committed: true,
        protection_version_id,
        adopted_scene,
        new_base_hash: finalized.new_base_hash,
        new_session_generation: finalized.new_session_generation,
    })
}

fn map_replacement_failure(failure: crate::history::replacement::ReplacementFailure) -> AppError {
    AppError::HistoryUnavailable(format!(
        "replacement failed during {:?}: {}",
        failure.phase, failure.message
    ))
}

fn operation_status_response(
    store: &HistoryStore,
    operation: &crate::history::operation::OperationRecord,
) -> Result<HistoryOperationStatusResponse, AppError> {
    let pending = operation.state == HistoryOperationState::Reconcile;
    let completed = operation.state == HistoryOperationState::Completed;
    let failed = matches!(
        operation.state,
        HistoryOperationState::Aborted | HistoryOperationState::Conflict
    );
    // A status response may be the only replay opportunity after the original
    // replace response was lost. Keep every target scene/asset live until the
    // complete response buffer has been assembled, including the fallback
    // object reads below.
    let _hydration_pin = if completed {
        let references = completed_target_references(operation)?;
        Some(
            store
                .reachability()
                .acquire_hydration_pin(references)
                .map_err(|error| AppError::HistoryUnavailable(error.to_string()))?,
        )
    } else {
        None
    };
    let (adopted_scene, new_base_hash) = if completed {
        let bytes = completed_target_bytes(store, operation)?;
        let scene = serde_json::from_slice(&bytes)
            .map_err(|error| AppError::HistoryResourceMissing(error.to_string()))?;
        (Some(scene), operation.actual_target_byte_hash.clone())
    } else {
        (None, None)
    };
    Ok(HistoryOperationStatusResponse {
        request_id: operation.idempotency_id.clone(),
        state: if pending {
            HistoryOperationState::PendingReconciliation
        } else {
            operation.state
        },
        replacement_committed: if completed {
            Some(true)
        } else if failed {
            Some(false)
        } else {
            None
        },
        protection_version_id: operation.protection_version_id.clone(),
        adopted_scene,
        new_base_hash,
        new_session_generation: completed.then_some(operation.session_generation.saturating_add(1)),
    })
}

fn completed_target_references(
    operation: &crate::history::operation::OperationRecord,
) -> Result<ObjectReferences, AppError> {
    let mut objects = Vec::with_capacity(operation.target_object_pins.len() + 1);
    if let Some(scene_hash) = operation.target_scene_hash.as_deref() {
        objects.push(
            ObjectKey::scene(scene_hash.to_owned())
                .map_err(|error| AppError::HistoryResourceMissing(error.to_string()))?,
        );
    }
    for pin in &operation.target_object_pins {
        objects.push(
            ObjectKey::new(pin.kind, pin.hash.clone())
                .map_err(|error| AppError::HistoryResourceMissing(error.to_string()))?,
        );
    }
    Ok(ObjectReferences::from_objects(objects))
}

fn completed_target_bytes(
    store: &HistoryStore,
    operation: &crate::history::operation::OperationRecord,
) -> Result<Vec<u8>, AppError> {
    let path = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT canonical_path FROM history_documents WHERE id = ?1",
                [&operation.document_id],
                |row| row.get::<_, String>(0),
            )
        })
        .ok()
        .map(PathBuf::from);
    let disk_bytes = if let (Some(path), Some(expected_hash)) =
        (path, operation.actual_target_byte_hash.as_deref())
    {
        fs::read(path)
            .ok()
            .filter(|bytes| sha256_hex(bytes) == expected_hash)
    } else {
        None
    };
    // Read every target asset while the request-scoped hydration pin is held,
    // even when the current file supplies the scene bytes. This makes the
    // status response's complete target dependency set explicit to GC.
    for pin in &operation.target_object_pins {
        if pin.kind == crate::history::gc::ObjectKind::Asset {
            store
                .objects()
                .read_asset(&pin.hash)
                .map_err(|error| AppError::HistoryResourceMissing(error.to_string()))?;
        }
    }
    if let Some(bytes) = disk_bytes {
        return Ok(bytes);
    }
    let hash = operation.target_scene_hash.as_deref().ok_or_else(|| {
        AppError::HistoryUnavailable("completed operation has no target scene".to_owned())
    })?;
    let scene = store
        .objects()
        .read_scene(hash)
        .map_err(|error| AppError::HistoryResourceMissing(error.to_string()))?;
    Ok(scene)
}

pub(crate) fn status_to_replace_response(
    status: HistoryOperationStatusResponse,
) -> Result<HistoryReplaceResponse, AppError> {
    if status.state == HistoryOperationState::Completed
        && status.replacement_committed == Some(true)
    {
        return Ok(HistoryReplaceResponse::Completed {
            request_id: status.request_id,
            replacement_committed: true,
            protection_version_id: status.protection_version_id.ok_or_else(|| {
                AppError::HistoryUnavailable(
                    "completed operation has no protection version".to_owned(),
                )
            })?,
            adopted_scene: status.adopted_scene.ok_or_else(|| {
                AppError::HistoryUnavailable("completed operation has no adopted scene".to_owned())
            })?,
            new_base_hash: status.new_base_hash.ok_or_else(|| {
                AppError::HistoryUnavailable("completed operation has no base hash".to_owned())
            })?,
            new_session_generation: status.new_session_generation.ok_or_else(|| {
                AppError::HistoryUnavailable(
                    "completed operation has no session generation".to_owned(),
                )
            })?,
        });
    }
    if status.state == HistoryOperationState::Aborted
        || status.state == HistoryOperationState::Conflict
    {
        return Err(AppError::HistoryStaleDocument(
            "history replacement did not complete".to_owned(),
        ));
    }
    Ok(HistoryReplaceResponse::PendingReconciliation {
        request_id: status.request_id,
        replacement_committed: None,
        operation_state: HistoryOperationState::PendingReconciliation,
    })
}

struct RealReplacementBackend {
    request: HistoryReplaceRequest,
    resolved: ResolvedDocument,
    store: Arc<HistoryStore>,
    action: HistoryProtectedAction,
    lease: HistoryOperationLease,
    protection_version_id: Option<String>,
    protection: Option<ProtectionReceipt>,
    restore_target: Option<PinnedHistoryTarget>,
    asset_grant: Option<ResponseAssetGrant>,
}

impl RealReplacementBackend {
    fn new(
        request: HistoryReplaceRequest,
        resolved: ResolvedDocument,
        store: Arc<HistoryStore>,
        action: HistoryProtectedAction,
        lease: HistoryOperationLease,
        asset_grant: Option<ResponseAssetGrant>,
    ) -> Self {
        Self {
            request,
            resolved,
            store,
            action,
            lease,
            protection_version_id: None,
            protection: None,
            restore_target: None,
            asset_grant,
        }
    }

    fn now() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_secs() as i64)
            .unwrap_or(i64::MAX)
    }

    fn target_scene(&self) -> Result<(Vec<u8>, Vec<CapturedAsset>), String> {
        match &self.request.target {
            HistoryReplaceTarget::Clear => Ok((empty_scene_bytes(), Vec::new())),
            HistoryReplaceTarget::Import {
                candidate_scene_json,
            } => normalize_scene(&self.resolved.asset_root, candidate_scene_json),
            HistoryReplaceTarget::Restore { .. } => self
                .restore_target
                .as_ref()
                .map(|target| (target.scene.clone(), target.assets.clone()))
                .ok_or_else(|| "restore target was not pinned before protection".to_owned()),
        }
    }
}

impl ProtectedReplacementBackend for RealReplacementBackend {
    type Error = String;

    fn drain_prior_writes(&mut self, _: &ProtectedReplacementRequest) -> Result<(), Self::Error> {
        self.lease.assert_held().map_err(|error| error.to_string())
    }

    fn capture_current(
        &mut self,
        _: &ProtectedReplacementRequest,
    ) -> Result<CapturedDocument, Self::Error> {
        // Protection publication may evict the selected oldest version. Own
        // its immutable bytes and pin its objects before that mutation.
        if let HistoryReplaceTarget::Restore { version_id } = &self.request.target {
            self.restore_target = Some(load_history_scene(
                &self.store,
                &self.resolved.document_id,
                version_id,
            )?);
        }
        let (scene_json, assets) =
            normalize_scene(&self.resolved.asset_root, &self.request.current_scene_json)?;
        Ok(CapturedDocument { scene_json, assets })
    }

    fn publish_protection(
        &mut self,
        request: &ProtectedReplacementRequest,
        captured: &CapturedDocument,
    ) -> Result<ProtectionReceipt, Self::Error> {
        let version_id = format!("protected-{}", Uuid::new_v4());
        let receipt = publish_snapshot(
            &self.store,
            request,
            &version_id,
            captured,
            self.action,
            Self::now(),
        )?;
        self.protection_version_id = Some(version_id);
        self.protection = Some(receipt.clone());
        Ok(receipt)
    }

    fn begin_operation(
        &mut self,
        request: &ProtectedReplacementRequest,
        protection: &ProtectionReceipt,
    ) -> Result<(), Self::Error> {
        let operations = OperationStore::new(&self.store);
        operations
            .begin(
                OperationRequest {
                    idempotency_id: request.request_id.clone(),
                    document_id: request.document_id.clone(),
                    session_generation: request.session_generation,
                    revision: request.revision,
                    kind: HistoryOperationKind::Replace,
                    protection_version_id: Some(protection.version_id.clone()),
                    expected_old_disk_hash: Some(request.expected_base_hash.clone()),
                    expected_old_identity: Some(request.expected_identity.to_string()),
                    prepared_target_identity: Some(replacement_fingerprint(
                        &self.request.target,
                        request,
                    )),
                    target_scene_hash: None,
                    target_manifest_hash: None,
                    temp_file: None,
                    target_object_pins: Vec::new(),
                },
                Self::now(),
            )
            .map_err(|error| error.to_string())?;
        let refs = protection
            .object_pins
            .iter()
            .map(|pin| ObjectKey::new(pin.kind, pin.hash.clone()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        if let Err(error) = self.store.reachability().acquire_operation_pin(
            request.request_id.clone(),
            ObjectReferences::from_objects(refs),
        ) {
            let reason = error.to_string();
            let _ = operations.transition(
                &request.request_id,
                HistoryOperationState::Aborted,
                OperationUpdate {
                    error_classification: Some(reason.clone()),
                    ..OperationUpdate::default()
                },
                Self::now(),
            );
            return Err(reason);
        }
        if let Err(error) = OperationStore::new(&self.store).transition(
            &request.request_id,
            HistoryOperationState::Protected,
            OperationUpdate::default(),
            Self::now(),
        ) {
            let reason = error.to_string();
            let _ = operations.transition(
                &request.request_id,
                HistoryOperationState::Aborted,
                OperationUpdate {
                    error_classification: Some(reason.clone()),
                    ..OperationUpdate::default()
                },
                Self::now(),
            );
            let _ = self
                .store
                .reachability()
                .release_operation_pin(&request.request_id);
            return Err(reason);
        }
        Ok(())
    }

    fn resolve_target(
        &mut self,
        _: &ProtectedReplacementRequest,
        _: &ProtectionReceipt,
    ) -> Result<PreparedTarget, Self::Error> {
        let (scene_json, target_assets) = self.target_scene()?;
        validate_scene_payload(&scene_json, &target_assets)?;
        materialize_workspace_assets(&self.resolved.asset_root, &target_assets)?;
        if let Some(grant) = &self.asset_grant {
            let scene = serde_json::from_slice(&scene_json).map_err(|error| error.to_string())?;
            grant(&self.resolved.asset_root, &scene).map_err(|error| error.to_string())?;
        }
        let scene = self
            .store
            .put_scene(&scene_json, 1)
            .map_err(|error| error.to_string())?;
        let mut pins = vec![OperationObjectPin::scene(scene.hash.clone())];
        let mut asset_objects = Vec::new();
        for asset in target_assets {
            let object = self
                .store
                .put_asset(&asset.bytes, &asset.mime_type)
                .map_err(|error| error.to_string())?;
            pins.push(OperationObjectPin::asset(object.hash.clone()));
            asset_objects.push(object);
        }
        let mut references = self
            .protection
            .as_ref()
            .map(|protection| protection.object_pins.clone())
            .unwrap_or_default();
        references.extend(pins.clone());
        self.store
            .reachability()
            .restore_operation_pin(
                self.request.request_id.clone(),
                ObjectReferences::from_objects(
                    references
                        .iter()
                        .map(|pin| ObjectKey::new(pin.kind, pin.hash.clone()))
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|error| error.to_string())?,
                ),
            )
            .map_err(|error| error.to_string())?;
        self.store
            .register_scene_object(&scene, Self::now())
            .map_err(|error| error.to_string())?;
        for object in asset_objects {
            self.store
                .register_asset_object(&object, Self::now())
                .map_err(|error| error.to_string())?;
        }
        Ok(PreparedTarget {
            scene_json,
            target_scene_hash: scene.hash,
            object_pins: pins,
        })
    }

    fn mark_target_observed(
        &mut self,
        request: &ProtectedReplacementRequest,
        target: &PreparedTarget,
    ) -> Result<(), Self::Error> {
        let operations = OperationStore::new(&self.store);
        operations
            .transition(
                &request.request_id,
                HistoryOperationState::IntentCommitted,
                OperationUpdate {
                    target_scene_hash: Some(target.target_scene_hash.clone()),
                    target_object_pins: Some(target.object_pins.clone()),
                    ..OperationUpdate::default()
                },
                Self::now(),
            )
            .map_err(|error| error.to_string())?;
        operations
            .transition(
                &request.request_id,
                HistoryOperationState::TargetObserved,
                OperationUpdate::default(),
                Self::now(),
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn mark_target_published(
        &mut self,
        request: &ProtectedReplacementRequest,
        target: &PreparedTarget,
    ) -> Result<(), Self::Error> {
        let (identity, target_hash) = observe_published_target(&request.target_path, target)?;
        OperationStore::new(&self.store)
            .transition(
                &request.request_id,
                HistoryOperationState::TargetPublished,
                OperationUpdate {
                    observed_published_identity: Some(identity.to_string()),
                    actual_target_byte_hash: Some(target_hash),
                    ..OperationUpdate::default()
                },
                Self::now(),
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn finalize_published_target(
        &mut self,
        request: &ProtectedReplacementRequest,
        _: &ProtectionReceipt,
        target: &PreparedTarget,
    ) -> Result<FinalizedReplacement, Self::Error> {
        let (identity, new_hash) = observe_published_target(&request.target_path, target)?;
        let operation = OperationStore::new(&self.store)
            .load(&request.request_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "published replacement operation is missing".to_owned())?;
        let identity_string = identity.to_string();
        if operation.observed_published_identity.as_deref() != Some(identity_string.as_str())
            || operation.actual_target_byte_hash.as_deref() != Some(new_hash.as_str())
        {
            return Err(
                "published target identity or bytes changed before metadata finalization"
                    .to_owned(),
            );
        }
        let bytes = fs::read(&request.target_path).map_err(|error| error.to_string())?;
        let now = Self::now();
        let scene_json = String::from_utf8(bytes.clone()).map_err(|error| error.to_string())?;
        block_on_history_lease(
            &self.lease,
            scene_json,
            new_hash.clone(),
            identity,
            new_hash.clone(),
        )?;
        let operations = OperationStore::new(&self.store);
        operations
            .transition(
                &request.request_id,
                HistoryOperationState::MetadataCommitted,
                OperationUpdate::default(),
                now,
            )
            .map_err(|error| error.to_string())?;
        operations
            .transition(
                &request.request_id,
                HistoryOperationState::Completed,
                OperationUpdate::default(),
                now,
            )
            .map_err(|error| error.to_string())?;
        // Keep target scene/assets pinned as a durable completed-result root.
        // HistoryStore rehydrates recent completed roots on restart and
        // expires them at the documented TTL before GC, so a delayed status
        // replay does not observe a target object that was collected between
        // the rename and the frontend acknowledgement.
        Ok(FinalizedReplacement {
            adopted_scene: target.scene_json.clone(),
            new_base_hash: new_hash,
            new_session_generation: request.session_generation.saturating_add(1),
        })
    }

    fn mark_reconcile(
        &mut self,
        request: &ProtectedReplacementRequest,
        _: ReplacementPhase,
        reason: &str,
    ) -> Result<(), Self::Error> {
        OperationStore::new(&self.store)
            .transition(
                &request.request_id,
                HistoryOperationState::Reconcile,
                OperationUpdate {
                    error_classification: Some(reason.to_owned()),
                    ..OperationUpdate::default()
                },
                Self::now(),
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn mark_conflict(
        &mut self,
        request: &ProtectedReplacementRequest,
        reason: &str,
    ) -> Result<(), Self::Error> {
        OperationStore::new(&self.store)
            .transition(
                &request.request_id,
                HistoryOperationState::Conflict,
                OperationUpdate {
                    error_classification: Some(reason.to_owned()),
                    ..OperationUpdate::default()
                },
                Self::now(),
            )
            .map_err(|error| error.to_string())?;
        let _ = self
            .store
            .reachability()
            .release_operation_pin(&request.request_id);
        Ok(())
    }

    fn abort_operation(
        &mut self,
        request: &ProtectedReplacementRequest,
        phase: ReplacementPhase,
        reason: &str,
    ) -> Result<(), Self::Error> {
        let operations = OperationStore::new(&self.store);
        operations
            .transition(
                &request.request_id,
                HistoryOperationState::Aborted,
                OperationUpdate {
                    error_classification: Some(format!("{phase:?}: {reason}")),
                    ..OperationUpdate::default()
                },
                Self::now(),
            )
            .map_err(|error| error.to_string())?;
        let _ = self
            .store
            .reachability()
            .release_operation_pin(&request.request_id);
        Ok(())
    }
}

pub(crate) fn observe_published_target(
    path: &Path,
    target: &PreparedTarget,
) -> Result<(FileSystemIdentity, String), String> {
    let identity = FileSystemIdentity::from_path(path).map_err(|error| error.to_string())?;
    if !identity.reliable {
        return Err("published target filesystem identity is unreliable".to_owned());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let target_hash = sha256_hex(&target.scene_json);
    let actual_hash = sha256_hex(&bytes);
    if actual_hash != target_hash || actual_hash != target.target_scene_hash {
        return Err("published target bytes differ from the prepared scene".to_owned());
    }
    Ok((identity, actual_hash))
}

fn publish_snapshot(
    store: &HistoryStore,
    request: &ProtectedReplacementRequest,
    version_id: &str,
    captured: &CapturedDocument,
    action: HistoryProtectedAction,
    now: i64,
) -> Result<ProtectionReceipt, String> {
    let scene = store
        .put_scene(&captured.scene_json, 1)
        .map_err(|error| error.to_string())?;
    let mut asset_objects = Vec::new();
    for asset in &captured.assets {
        asset_objects.push((
            asset.file_id.clone(),
            store
                .put_asset(&asset.bytes, &asset.mime_type)
                .map_err(|error| error.to_string())?,
        ));
    }
    let scene_metadata = SceneObjectMetadata {
        schema_version: HISTORY_OBJECT_SCHEMA_VERSION,
        codec: HISTORY_OBJECT_CODEC.to_owned(),
        raw_length: scene.raw_length as u64,
        sha256: scene.hash.clone(),
        relative_path: PathBuf::from(scene.relative_path.clone()),
    };
    let asset_payloads = asset_objects
        .iter()
        .zip(captured.assets.iter())
        .map(|((_, object), captured)| AssetObject {
            file_id: captured.file_id.clone(),
            metadata: AssetObjectMetadata {
                sha256: object.hash.clone(),
                byte_length: object.byte_length as u64,
                mime_type: object.mime_type.clone(),
                relative_path: PathBuf::from(object.relative_path.clone()),
            },
            bytes: captured.bytes.as_slice(),
        })
        .collect::<Vec<_>>();
    validate_scene_and_assets(&captured.scene_json, &scene_metadata, &asset_payloads)
        .map_err(|error| error.to_string())?;
    let sequence = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT COALESCE(MAX(sequence), 0) + 1 FROM history_versions WHERE document_id = ?1",
                [&request.document_id],
                |row| row.get::<_, i64>(0),
            )
        })
        .map_err(|error| error.to_string())?;
    let refs = ObjectReferences::from_objects(
        std::iter::once(ObjectKey::scene(scene.hash.clone()))
            .chain(
                asset_objects
                    .iter()
                    .map(|(_, object)| ObjectKey::asset(object.hash.clone())),
            )
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?,
    );
    store
        .with_mutation(|mutation| {
            store
                .objects()
                .verify_scene(&scene)
                .map_err(crate::history::store::HistoryStoreError::from)?;
            let evicted = store.with_transaction(|transaction| {
                transaction.execute(
                    "INSERT INTO scene_objects (hash, schema_version, codec, raw_length, relative_path, created_at) VALUES (?1, ?2, 'none', ?3, ?4, ?5) ON CONFLICT(hash) DO NOTHING",
                    rusqlite::params![scene.hash, scene.schema_version, scene.raw_length, scene.relative_path, now],
                )?;
                for (_, object) in &asset_objects {
                    transaction.execute(
                        "INSERT INTO asset_objects (hash, byte_length, mime_type, relative_path, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(hash) DO NOTHING",
                        rusqlite::params![object.hash, object.byte_length, object.mime_type, object.relative_path, now],
                    )?;
                }
                transaction.execute(
                    "INSERT INTO history_versions (id, document_id, scene_hash, source, protected_action, recorded_at, sequence) VALUES (?1, ?2, ?3, 'protected', ?4, ?5, ?6)",
                    rusqlite::params![version_id, request.document_id, scene.hash, action_name(action), now, sequence],
                )?;
                for (file_id, object) in &asset_objects {
                    transaction.execute(
                        "INSERT INTO version_assets (version_id, sdk_file_id, asset_hash, mime_type, byte_length) VALUES (?1, ?2, ?3, ?4, ?5)",
                        rusqlite::params![version_id, file_id, object.hash, object.mime_type, object.byte_length],
                    )?;
                }
                let ids = transaction
                    .prepare("SELECT id FROM history_versions WHERE document_id=?1 AND source IN ('automatic','protected') ORDER BY recorded_at DESC, sequence DESC, id DESC LIMIT -1 OFFSET 20")?
                    .query_map([&request.document_id], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                for id in &ids {
                    transaction.execute("DELETE FROM history_versions WHERE id=?1", [id])?;
                }
                Ok::<Vec<String>, rusqlite::Error>(ids)
            })?;
            mutation.set_committed_version(version_id.to_owned(), refs.clone());
            for id in evicted {
                mutation.remove_committed_version(&id);
            }
            Ok::<(), crate::history::store::HistoryStoreError>(())
        })
        .map_err(|error| error.to_string())?;
    Ok(ProtectionReceipt {
        version_id: version_id.to_owned(),
        scene_hash: scene.hash,
        object_pins: refs
            .iter()
            .map(|key| OperationObjectPin {
                kind: key.kind,
                hash: key.hash.clone(),
            })
            .collect(),
    })
}

fn normalize_scene(
    asset_root: &Path,
    scene_json: &str,
) -> Result<(Vec<u8>, Vec<CapturedAsset>), String> {
    validate_scene(
        scene_json.as_bytes(),
        crate::history::types::HISTORY_MAX_SCENE_BYTES,
    )
    .map_err(|error| error.to_string())?;
    let mut scene: Value = serde_json::from_str(scene_json).map_err(|error| error.to_string())?;
    let mut assets = Vec::new();
    if let Some(files) = scene.get_mut("files").and_then(Value::as_object_mut) {
        for (file_id, file) in files.iter_mut() {
            let object = file
                .as_object_mut()
                .ok_or_else(|| format!("asset {file_id} is invalid"))?;
            let data_url = object
                .get("dataURL")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("asset {file_id} has no dataURL"))?
                .to_owned();
            let mime = object
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream")
                .to_owned();
            let bytes = if let Some(hash) = data_url.strip_prefix("asset://") {
                if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return Err(format!("asset {file_id} reference is invalid"));
                }
                fs::read(asset_root.join(ASSET_DIRECTORY_NAME).join(hash))
                    .map_err(|error| error.to_string())?
            } else {
                decode_data_url(&data_url)
                    .ok_or_else(|| format!("asset {file_id} data URL is invalid"))?
                    .0
            };
            let hash = sha256_hex(&bytes);
            object.insert(
                "dataURL".to_owned(),
                Value::String(format!("asset://{hash}")),
            );
            assets.push(CapturedAsset {
                file_id: file_id.clone(),
                bytes,
                mime_type: mime,
            });
        }
    }
    serde_json::to_vec(&scene)
        .map(|bytes| (bytes, assets))
        .map_err(|error| error.to_string())
}

fn validate_scene_payload(scene_json: &[u8], assets: &[CapturedAsset]) -> Result<(), String> {
    let scene_hash = sha256_hex(scene_json);
    let scene_metadata = SceneObjectMetadata {
        schema_version: HISTORY_OBJECT_SCHEMA_VERSION,
        codec: HISTORY_OBJECT_CODEC.to_owned(),
        raw_length: scene_json.len() as u64,
        sha256: scene_hash.clone(),
        relative_path: PathBuf::from(
            crate::history::objects::ObjectStore::scene_relative_path(&scene_hash)
                .map_err(|error| error.to_string())?,
        ),
    };
    let metadata = assets
        .iter()
        .map(|asset| {
            let hash = sha256_hex(&asset.bytes);
            Ok(AssetObject {
                file_id: asset.file_id.clone(),
                metadata: AssetObjectMetadata {
                    sha256: hash.clone(),
                    byte_length: asset.bytes.len() as u64,
                    mime_type: asset.mime_type.clone(),
                    relative_path: PathBuf::from(
                        crate::history::objects::ObjectStore::asset_relative_path(&hash)
                            .map_err(|error| error.to_string())?,
                    ),
                },
                bytes: asset.bytes.as_slice(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    validate_scene_and_assets(scene_json, &scene_metadata, &metadata)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn materialize_workspace_assets(asset_root: &Path, assets: &[CapturedAsset]) -> Result<(), String> {
    if assets.is_empty() {
        return Ok(());
    }
    let directory = asset_root.join(ASSET_DIRECTORY_NAME);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    for asset in assets {
        let hash = sha256_hex(&asset.bytes);
        let path = directory.join(&hash);
        match fs::read(&path) {
            Ok(existing) if existing == asset.bytes => continue,
            Ok(_) => {
                return Err(format!(
                    "workspace asset hash collision for {}",
                    asset.file_id
                ))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        atomic_write_bytes(&path, &asset.bytes).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn decode_data_url(value: &str) -> Option<(Vec<u8>, String)> {
    let rest = value.strip_prefix("data:")?;
    let (metadata, payload) = rest.split_once(',')?;
    if !metadata
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        return None;
    }
    let mime = metadata.split(';').next()?.to_owned();
    Some((BASE64.decode(payload.as_bytes()).ok()?, mime))
}

pub(crate) struct PinnedHistoryTarget {
    pub(crate) scene: Vec<u8>,
    pub(crate) assets: Vec<CapturedAsset>,
    _pin: HydrationPin,
}

pub(crate) fn load_history_scene(
    store: &HistoryStore,
    document_id: &str,
    version_id: &str,
) -> Result<PinnedHistoryTarget, String> {
    let (scene_hash, assets) = store
        .with_connection(|connection| {
            let scene_hash = connection.query_row(
                "SELECT scene_hash FROM history_versions WHERE id=?1 AND document_id=?2",
                rusqlite::params![version_id, document_id],
                |row| row.get::<_, String>(0),
            )?;
            let mut statement = connection.prepare(
                "SELECT sdk_file_id, asset_hash, mime_type FROM version_assets WHERE version_id=?1 ORDER BY sdk_file_id",
            )?;
            let rows = statement
                .query_map([version_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>((scene_hash, rows))
        })
        .map_err(|error| error.to_string())?;
    let references = ObjectReferences::new(
        scene_hash.clone(),
        assets.iter().map(|(_, hash, _)| hash.clone()),
    )
    .map_err(|error| error.to_string())?;
    let pin = store
        .reachability()
        .acquire_hydration_pin(references)
        .map_err(|error| error.to_string())?;
    let scene = store
        .objects()
        .read_scene(&scene_hash)
        .map_err(|error| error.to_string())?;
    let assets = assets
        .into_iter()
        .map(|(file_id, hash, mime_type)| {
            Ok(CapturedAsset {
                file_id,
                bytes: store
                    .objects()
                    .read_asset(&hash)
                    .map_err(|error| error.to_string())?,
                mime_type,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    validate_scene_payload(&scene, &assets)?;
    Ok(PinnedHistoryTarget {
        scene,
        assets,
        _pin: pin,
    })
}

pub(crate) fn empty_scene_bytes() -> Vec<u8> {
    br#"{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}"#.to_vec()
}

pub(crate) fn action_for_target(target: &HistoryReplaceTarget) -> HistoryProtectedAction {
    match target {
        HistoryReplaceTarget::Restore { .. } => HistoryProtectedAction::Restore,
        HistoryReplaceTarget::Clear => HistoryProtectedAction::Clear,
        HistoryReplaceTarget::Import { .. } => HistoryProtectedAction::Import,
    }
}

fn action_name(action: HistoryProtectedAction) -> &'static str {
    match action {
        HistoryProtectedAction::Restore => "restore",
        HistoryProtectedAction::Clear => "clear",
        HistoryProtectedAction::Import => "import",
    }
}

fn replacement_fingerprint(
    target: &HistoryReplaceTarget,
    request: &ProtectedReplacementRequest,
) -> String {
    replacement_fingerprint_from_parts(
        target,
        request.session_generation,
        request.revision,
        &request.expected_base_hash,
        &request.expected_identity.to_string(),
    )
}

/// The operation id is the retry key, while this digest binds that key to the
/// complete replacement intent.  Keep the target discriminator and its
/// version/import digest explicit so a reused request id cannot silently
/// switch from restore to import (or between two imports).
pub(crate) fn replacement_fingerprint_from_parts(
    target: &HistoryReplaceTarget,
    session_generation: u64,
    revision: u64,
    expected_base_hash: &str,
    expected_identity: &str,
) -> String {
    let target_binding = match target {
        HistoryReplaceTarget::Clear => "kind=clear".to_owned(),
        HistoryReplaceTarget::Restore { version_id } => {
            format!("kind=restore;version={version_id}")
        }
        HistoryReplaceTarget::Import {
            candidate_scene_json,
        } => format!(
            "kind=import;sceneHash={}",
            sha256_hex(candidate_scene_json.as_bytes())
        ),
    };
    sha256_hex(
        format!(
            "{target_binding};generation={session_generation};revision={revision};base={expected_base_hash};identity={expected_identity}"
        )
        .as_bytes(),
    )
}

fn block_on_history_lease(
    lease: &HistoryOperationLease,
    scene_json: String,
    base_hash: String,
    expected_identity: FileSystemIdentity,
    expected_hash: String,
) -> Result<(), String> {
    tokio::runtime::Handle::current()
        .block_on(lease.finalize(scene_json, base_hash, expected_identity, expected_hash))
        .map_err(|error| error.to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod asset_grant_lifecycle_tests {
    use super::*;
    use crate::{commands::dto::PathRequest, database::repository::WorkspaceRecord};

    struct DenyDirect;
    impl DirectFileGrant for DenyDirect {
        fn is_allowed(&self, _: &Path) -> bool {
            false
        }
    }

    async fn fixture() -> (
        PathBuf,
        PathBuf,
        HistoryReplacementService,
        HistoryReplaceRequest,
    ) {
        let root = std::env::temp_dir().join(format!("history-grant-lifecycle-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("workspace")).unwrap();
        let workspace = root.join("workspace").canonicalize().unwrap();
        let path = workspace.join("drawing.excalidraw");
        let current = r##"{"type":"excalidraw","version":2,"elements":[],"appState":{"viewBackgroundColor":"#123456"},"files":{}}"##;
        fs::write(&path, current).unwrap();
        let repository = Arc::new(
            SqliteRepository::open(&root.join("documents.sqlite3"))
                .await
                .unwrap(),
        );
        repository
            .workspace_upsert(WorkspaceRecord {
                id: "workspace".to_owned(),
                name: "workspace".to_owned(),
                root_path: workspace.display().to_string(),
                created_at: 1,
                mounted: true,
            })
            .await
            .unwrap();
        let store = Arc::new(HistoryStore::open(&root).unwrap());
        let mut document_service = DocumentService::new(Arc::clone(&repository));
        document_service.attach_history_store(Arc::clone(&store));
        document_service
            .doc_open(PathRequest {
                path: path.display().to_string(),
            })
            .await
            .unwrap();
        let service = HistoryReplacementService {
            repository,
            store: Some(store),
            direct_file_grant: Arc::new(DenyDirect),
            document_service,
        };
        let request = HistoryReplaceRequest {
            document: HistoryDocumentLocator::Path {
                path: path.display().to_string(),
            },
            request_id: "grant-request".to_owned(),
            session_generation: 1,
            revision: 1,
            expected_base_hash: sha256_hex(current.as_bytes()),
            current_scene_json: current.to_owned(),
            target: HistoryReplaceTarget::Clear,
        };
        (root, path, service, request)
    }

    fn reject_grant() -> ResponseAssetGrant {
        Arc::new(|_, _| {
            Err(AppError::Internal(
                "injected asset scope rejection".to_owned(),
            ))
        })
    }

    #[tokio::test]
    async fn asset_grant_failure_aborts_before_disk_replacement() {
        let (root, path, service, request) = fixture().await;
        let before = fs::read(&path).unwrap();
        assert!(service
            .replace(request.clone(), Some(reject_grant()))
            .await
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        let status = service
            .operation_status(HistoryOperationStatusRequest {
                document: request.document,
                request_id: request.request_id,
            })
            .await
            .unwrap();
        assert_eq!(status.state, HistoryOperationState::Aborted);
        assert_eq!(status.replacement_committed, Some(false));
        assert!(status.adopted_scene.is_none());
        drop(service);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn committed_asset_grant_failure_remains_pending_and_recoverable() {
        let (root, path, service, request) = fixture().await;
        let completed = service.replace(request.clone(), None).await.unwrap();
        assert!(matches!(
            completed,
            HistoryReplaceResponse::Completed { .. }
        ));
        let committed = fs::read(&path).unwrap();
        let replay = service
            .replace(request.clone(), Some(reject_grant()))
            .await
            .unwrap();
        let json = serde_json::to_value(replay).unwrap();
        assert_eq!(json["status"], "pendingReconciliation");
        assert!(json["replacementCommitted"].is_null());
        assert_eq!(json["operationState"], "pendingReconciliation");
        let query = HistoryOperationStatusRequest {
            document: request.document,
            request_id: request.request_id,
        };
        let pending = service
            .status_with_asset_grant(query.clone(), reject_grant())
            .await
            .unwrap();
        assert_eq!(pending.state, HistoryOperationState::PendingReconciliation);
        assert_eq!(pending.replacement_committed, Some(true));
        assert!(pending.adopted_scene.is_none());
        let recovered = service
            .status_with_asset_grant(query, Arc::new(|_, _| Ok(())))
            .await
            .unwrap();
        assert_eq!(recovered.state, HistoryOperationState::Completed);
        assert!(recovered.adopted_scene.is_some());
        assert_eq!(fs::read(&path).unwrap(), committed);
        drop(service);
        fs::remove_dir_all(root).unwrap();
    }
}
