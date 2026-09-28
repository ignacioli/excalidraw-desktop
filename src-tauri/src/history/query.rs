//! Read-only history queries used by the v3 IPC boundary.
//!
//! The query service is deliberately separate from publication and protected
//! replacement. It resolves the current document authority before touching a
//! version, keeps list responses metadata-only, and hydrates one preview under
//! the same reachability gate used by GC.

use std::{fs, path::PathBuf, sync::Arc};

#[cfg(feature = "e2e-harness")]
use std::{
    sync::{Condvar, Mutex, OnceLock},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    commands::{
        documents::DirectFileGrant,
        dto::{
            HistoryListRequest, HistoryListResponse, HistoryPreviewRequest, HistoryPreviewResponse,
        },
        error::{AppError, IpcError},
    },
    database::repository::{SqliteRepository, WorkspaceRepository},
    history::{
        gc::{ObjectKey, ObjectReferences},
        objects::ObjectStore,
        store::{HistoryStore, HistoryStoreError},
        types::{
            validate_hash, validate_identifier, HistoryDocumentLocator, HistoryProtectedAction,
            HistoryVersionAvailability, HistoryVersionItem, HistoryVersionSource,
            HISTORY_DEFAULT_PAGE_LIMIT,
        },
        validation::{
            validate_scene_and_assets, AssetObject, AssetObjectMetadata, SceneObjectMetadata,
            HISTORY_OBJECT_CODEC, HISTORY_OBJECT_SCHEMA_VERSION,
        },
    },
    security::{PathSecurityError, WorkspacePathPolicy},
};

#[derive(Clone)]
pub struct HistoryQueryService {
    repository: Arc<SqliteRepository>,
    store: Option<Arc<HistoryStore>>,
    direct_file_grant: Arc<dyn DirectFileGrant>,
}

/// In-process rendezvous used only by the deterministic e2e harness.  The
/// barrier is installed by the harness before a preview task is spawned and
/// is entered immediately after the production hydration pin is acquired.
/// This lets the harness run real GC against a live preview without relying
/// on timing or sleeps.  The type and all accessors are absent from a
/// production build.
#[cfg(feature = "e2e-harness")]
pub(crate) struct E2ePreviewHydrationPinBarrier {
    state: Mutex<PreviewHydrationPinBarrierState>,
    changed: Condvar,
}

#[cfg(feature = "e2e-harness")]
#[derive(Default)]
struct PreviewHydrationPinBarrierState {
    reached: bool,
    released: bool,
}

#[cfg(feature = "e2e-harness")]
impl E2ePreviewHydrationPinBarrier {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(PreviewHydrationPinBarrierState::default()),
            changed: Condvar::new(),
        })
    }

    pub(crate) fn wait_until_reached(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while !state.reached {
            let (next_state, result) = self
                .changed
                .wait_timeout(state, Duration::from_secs(30))
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state = next_state;
            if result.timed_out() && !state.reached {
                return false;
            }
        }
        true
    }

    pub(crate) fn release(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.released = true;
        self.changed.notify_all();
    }

    fn wait_after_pin(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.reached = true;
        self.changed.notify_all();
        while !state.released {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

#[cfg(feature = "e2e-harness")]
static E2E_PREVIEW_HYDRATION_PIN_BARRIER: OnceLock<
    Mutex<Option<Arc<E2ePreviewHydrationPinBarrier>>>,
> = OnceLock::new();

#[cfg(feature = "e2e-harness")]
pub(crate) fn set_e2e_preview_hydration_pin_barrier(
    barrier: Option<Arc<E2ePreviewHydrationPinBarrier>>,
) {
    *E2E_PREVIEW_HYDRATION_PIN_BARRIER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = barrier;
}

#[cfg(feature = "e2e-harness")]
fn e2e_preview_hydration_pin_barrier() -> Option<Arc<E2ePreviewHydrationPinBarrier>> {
    E2E_PREVIEW_HYDRATION_PIN_BARRIER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

impl HistoryQueryService {
    pub fn new(repository: Arc<SqliteRepository>, store: Option<Arc<HistoryStore>>) -> Self {
        Self::with_direct_file_grant(repository, store, Arc::new(DenyDirectFileGrant))
    }

    pub fn with_direct_file_grant(
        repository: Arc<SqliteRepository>,
        store: Option<Arc<HistoryStore>>,
        direct_file_grant: Arc<dyn DirectFileGrant>,
    ) -> Self {
        Self {
            repository,
            store,
            direct_file_grant,
        }
    }

    pub async fn list(&self, request: HistoryListRequest) -> Result<HistoryListResponse, IpcError> {
        request
            .validate()
            .map_err(|error| AppError::HistoryStaleDocument(error.to_string()))?;
        let store = self.store()?;
        let document = self.resolve_document(&store, &request.document).await?;
        let limit = request.limit.unwrap_or(HISTORY_DEFAULT_PAGE_LIMIT) as usize;
        let cursor = decode_cursor(request.cursor.as_deref(), &document.document_id)?;
        let request_cursor = cursor.clone();
        let store_for_query = Arc::clone(&store);
        let response = tokio::task::spawn_blocking(move || {
            query_list(
                &store_for_query,
                &document.document_id,
                request_cursor,
                limit,
            )
        })
        .await
        .map_err(|error| AppError::Internal(format!("history list task failed: {error}")))??;
        Ok(response)
    }

    pub async fn preview(
        &self,
        request: HistoryPreviewRequest,
    ) -> Result<HistoryPreviewResponse, IpcError> {
        request
            .validate()
            .map_err(|error| AppError::HistoryStaleDocument(error.to_string()))?;
        let store = self.store()?;
        let document = self.resolve_document(&store, &request.document).await?;
        let version_id = request.version_id;
        tokio::task::spawn_blocking(move || {
            hydrate_preview(&store, &document.document_id, &version_id)
        })
        .await
        .map_err(|error| AppError::Internal(format!("history preview task failed: {error}")))?
        .map_err(IpcError::from)
    }

    fn store(&self) -> Result<Arc<HistoryStore>, IpcError> {
        self.store.clone().ok_or_else(|| {
            AppError::HistoryUnavailable("history store is not initialized".to_owned()).into()
        })
    }

    async fn resolve_document(
        &self,
        store: &Arc<HistoryStore>,
        locator: &HistoryDocumentLocator,
    ) -> Result<ResolvedDocument, IpcError> {
        let roots = self
            .repository
            .workspace_list()
            .await
            .map_err(AppError::from)?
            .into_iter()
            .map(|workspace| PathBuf::from(workspace.root_path))
            .collect::<Vec<_>>();
        let store = Arc::clone(store);
        let locator = locator.clone();
        let direct_file_grant = Arc::clone(&self.direct_file_grant);
        tokio::task::spawn_blocking(move || {
            resolve_document_blocking(&store, &locator, roots, direct_file_grant.as_ref())
        })
        .await
        .map_err(|error| AppError::Internal(format!("history authority task failed: {error}")))?
        .map_err(|error| IpcError::from(AppError::from(error)))
    }
}

#[derive(Clone)]
pub struct HistoryState {
    pub service: Arc<HistoryQueryService>,
}

impl HistoryState {
    pub fn new(repository: Arc<SqliteRepository>, store: Option<Arc<HistoryStore>>) -> Self {
        Self::with_direct_file_grant(repository, store, Arc::new(DenyDirectFileGrant))
    }

    pub fn with_direct_file_grant(
        repository: Arc<SqliteRepository>,
        store: Option<Arc<HistoryStore>>,
        direct_file_grant: Arc<dyn DirectFileGrant>,
    ) -> Self {
        Self {
            service: Arc::new(HistoryQueryService::with_direct_file_grant(
                repository,
                store,
                direct_file_grant,
            )),
        }
    }
}

struct DenyDirectFileGrant;

impl DirectFileGrant for DenyDirectFileGrant {
    fn is_allowed(&self, _path: &std::path::Path) -> bool {
        false
    }
}

#[derive(Debug, Clone)]
struct ResolvedDocument {
    document_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct HistoryCursor {
    document_id: String,
    recorded_at: i64,
    sequence: u64,
    version_id: String,
}

#[derive(Debug, Clone)]
struct VersionRow {
    version_id: String,
    source: HistoryVersionSource,
    marked: bool,
    protected_action: Option<HistoryProtectedAction>,
    recorded_at: i64,
    sequence: u64,
    scene_hash: String,
    scene_schema_version: Option<u32>,
    scene_codec: Option<String>,
    scene_raw_length: Option<u64>,
    scene_relative_path: Option<String>,
    assets: Vec<AssetRow>,
}

#[derive(Debug, Clone)]
struct AssetRow {
    file_id: String,
    hash: String,
    byte_length: u64,
    mime_type: String,
    relative_path: String,
}

#[derive(Debug, Error)]
enum QueryError {
    #[error("history store is unavailable: {0}")]
    Store(#[from] HistoryStoreError),
    #[error("history document is stale: {0}")]
    Stale(String),
    #[error("history resource is missing or corrupt: {0}")]
    Resource(String),
}

impl From<QueryError> for AppError {
    fn from(error: QueryError) -> Self {
        match error {
            QueryError::Store(error) => AppError::HistoryUnavailable(error.to_string()),
            QueryError::Stale(error) => AppError::HistoryStaleDocument(error),
            QueryError::Resource(error) => AppError::HistoryResourceMissing(error),
        }
    }
}

fn resolve_document_blocking(
    store: &HistoryStore,
    locator: &HistoryDocumentLocator,
    roots: Vec<PathBuf>,
    direct_file_grant: &dyn DirectFileGrant,
) -> Result<ResolvedDocument, QueryError> {
    let policy =
        WorkspacePathPolicy::new(roots).map_err(|error| QueryError::Stale(error.to_string()))?;
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
            .map_err(|error| QueryError::Stale(format!("document handle is not active: {error}")))?,
    };
    if !is_supported_document_path(&requested_path) {
        return Err(QueryError::Stale(
            "document path is not a supported drawing".to_owned(),
        ));
    }
    let canonical_path = match policy.authorize_existing(&requested_path) {
        Ok(path) => path,
        Err(PathSecurityError::AccessDenied(_))
            if direct_file_grant.is_allowed(&requested_path) =>
        {
            requested_path
                .canonicalize()
                .map_err(|error| QueryError::Stale(error.to_string()))?
        }
        Err(error) => return Err(QueryError::Stale(error.to_string())),
    };
    let identity = store
        .load_active_document_identity(&canonical_path.display().to_string())
        .map_err(|error| QueryError::Stale(error.to_string()))?
        .ok_or_else(|| QueryError::Stale("document has no active history identity".to_owned()))?;
    if let HistoryDocumentLocator::Handle { document_id } = locator {
        if identity.document_id != *document_id {
            return Err(QueryError::Stale(
                "document handle does not match the current identity".to_owned(),
            ));
        }
    }
    identity
        .verify_current_file(&canonical_path)
        .map_err(|error| QueryError::Stale(error.to_string()))?;
    Ok(ResolvedDocument {
        document_id: identity.document_id,
    })
}

fn decode_cursor(
    value: Option<&str>,
    document_id: &str,
) -> Result<Option<HistoryCursor>, IpcError> {
    let Some(value) = value else { return Ok(None) };
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| AppError::HistoryStaleDocument("invalid history cursor".to_owned()))?;
    let cursor: HistoryCursor = serde_json::from_slice(&decoded)
        .map_err(|_| AppError::HistoryStaleDocument("invalid history cursor".to_owned()))?;
    if cursor.document_id != document_id
        || cursor.version_id.is_empty()
        || cursor.sequence > i64::MAX as u64
        || validate_identifier(&cursor.version_id, "versionId").is_err()
    {
        return Err(AppError::HistoryStaleDocument(
            "history cursor belongs to another document".to_owned(),
        )
        .into());
    }
    Ok(Some(cursor))
}

fn encode_cursor(cursor: HistoryCursor) -> Result<String, QueryError> {
    let bytes =
        serde_json::to_vec(&cursor).map_err(|error| QueryError::Resource(error.to_string()))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

fn query_list(
    store: &HistoryStore,
    document_id: &str,
    cursor: Option<HistoryCursor>,
    limit: usize,
) -> Result<HistoryListResponse, IpcError> {
    let rows = store
        .with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, source, protected_action, recorded_at, sequence, scene_hash,
                        so.schema_version, so.codec, so.raw_length, so.relative_path, hv.marked
                 FROM history_versions hv
                 LEFT JOIN scene_objects so ON so.hash = hv.scene_hash
                 WHERE hv.document_id = ?1
                   AND (?2 IS NULL OR (hv.recorded_at, hv.sequence, hv.id) < (?3, ?4, ?5))
                 ORDER BY hv.recorded_at DESC, hv.sequence DESC, hv.id DESC
                 LIMIT ?6",
            )?;
            let (cursor_time, cursor_sequence, cursor_id) = cursor
                .as_ref()
                .map(|value| {
                    (
                        Some(value.recorded_at),
                        Some(value.sequence as i64),
                        Some(value.version_id.as_str()),
                    )
                })
                .unwrap_or((None, None, None));
            let rows = statement
                .query_map(
                    rusqlite::params![
                        document_id,
                        cursor_time,
                        cursor_time,
                        cursor_sequence,
                        cursor_id,
                        (limit + 1) as i64,
                    ],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, Option<i64>>(6)?,
                            row.get::<_, Option<String>>(7)?,
                            row.get::<_, Option<i64>>(8)?,
                            row.get::<_, Option<String>>(9)?,
                            row.get::<_, bool>(10)?,
                        ))
                    },
                )?
                .collect::<Result<Vec<_>, _>>()?;
            let mut result = Vec::with_capacity(rows.len());
            for (
                version_id,
                source,
                protected_action,
                recorded_at,
                sequence,
                scene_hash,
                schema_version,
                codec,
                raw_length,
                relative_path,
                marked,
            ) in rows
            {
                let assets = load_asset_rows(connection, &version_id)?;
                result.push(VersionRow {
                    version_id,
                    source: parse_source(&source)?,
                    marked,
                    protected_action: parse_protected_action(protected_action.as_deref())?,
                    recorded_at,
                    sequence: u64::try_from(sequence)
                        .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, sequence))?,
                    scene_hash,
                    scene_schema_version: schema_version
                        .and_then(|value| u32::try_from(value).ok()),
                    scene_codec: codec,
                    scene_raw_length: raw_length
                        .map(|value| u64::try_from(value).unwrap_or(u64::MAX)),
                    scene_relative_path: relative_path,
                    assets,
                });
            }
            Ok(result)
        })
        .map_err(|error| AppError::HistoryUnavailable(error.to_string()))?;
    let mut items = Vec::with_capacity(rows.len().min(limit));
    for row in rows.iter().take(limit) {
        items.push(version_item(store, row));
    }
    let next_cursor = rows
        .get(limit)
        .map(|row| {
            encode_cursor(HistoryCursor {
                document_id: document_id.to_owned(),
                recorded_at: row.recorded_at,
                sequence: row.sequence,
                version_id: row.version_id.clone(),
            })
        })
        .transpose()
        .map_err(AppError::from)?;
    let list_revision = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT COALESCE(MAX(sequence), 0) FROM history_versions WHERE document_id = ?1",
                [document_id],
                |row| row.get::<_, i64>(0),
            )
        })
        .map_err(|error| AppError::HistoryUnavailable(error.to_string()))?
        .max(0) as u64;
    let pending_issue = pending_issue(store, document_id)?;
    Ok(HistoryListResponse {
        document_id: document_id.to_owned(),
        items,
        next_cursor,
        pending_issue,
        list_revision,
    })
}

fn version_item(store: &HistoryStore, row: &VersionRow) -> HistoryVersionItem {
    let availability = if row.scene_schema_version != Some(HISTORY_OBJECT_SCHEMA_VERSION)
        || row.scene_codec.as_deref() != Some(HISTORY_OBJECT_CODEC)
        || row.scene_raw_length.is_none()
        || row.scene_relative_path.as_deref().is_none_or(str::is_empty)
        || validate_hash(&row.scene_hash, "sceneHash").is_err()
    {
        unavailable_resource()
    } else {
        match store.objects().scene_path(&row.scene_hash) {
            Ok(path)
                if fs::metadata(path.clone())
                    .is_ok_and(|metadata| Some(metadata.len()) == row.scene_raw_length) =>
            {
                if row.scene_relative_path.as_deref()
                    != ObjectStore::scene_relative_path(&row.scene_hash)
                        .ok()
                        .as_deref()
                {
                    return HistoryVersionItem {
                        version_id: row.version_id.clone(),
                        source: row.source,
                        marked: row.marked,
                        protected_action: row.protected_action,
                        recorded_at: row.recorded_at,
                        sequence: row.sequence,
                        content_hash: row.scene_hash.clone(),
                        availability: unavailable_resource(),
                    };
                }
                let assets_ok = row.assets.iter().all(|asset| {
                    !asset.relative_path.is_empty()
                        && validate_hash(&asset.hash, "assetHash").is_ok()
                        && !asset.mime_type.is_empty()
                        && ObjectStore::asset_relative_path(&asset.hash)
                            .ok()
                            .is_some_and(|expected| expected == asset.relative_path)
                        && store
                            .objects()
                            .asset_path(&asset.hash)
                            .ok()
                            .is_some_and(|path| {
                                fs::metadata(path)
                                    .is_ok_and(|metadata| metadata.len() == asset.byte_length)
                            })
                });
                if assets_ok {
                    HistoryVersionAvailability::Available
                } else {
                    unavailable_resource()
                }
            }
            _ => unavailable_resource(),
        }
    };
    HistoryVersionItem {
        version_id: row.version_id.clone(),
        source: row.source,
        marked: row.marked,
        protected_action: row.protected_action,
        recorded_at: row.recorded_at,
        sequence: row.sequence,
        content_hash: row.scene_hash.clone(),
        availability,
    }
}

fn is_supported_document_path(path: &std::path::Path) -> bool {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("excalidraw") => true,
        Some("json") => path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".excalidraw.json")),
        _ => false,
    }
}

fn unavailable_resource() -> HistoryVersionAvailability {
    HistoryVersionAvailability::Unavailable {
        error: AppError::HistoryResourceMissing("history object is missing or corrupt".to_owned())
            .into_ipc(),
    }
}

fn pending_issue(
    store: &HistoryStore,
    document_id: &str,
) -> Result<Option<crate::commands::error::IpcError>, AppError> {
    let pending = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM history_operations
                   WHERE document_id = ?1 AND state NOT IN ('completed', 'aborted', 'conflict')
                 ) OR EXISTS(
                   SELECT 1 FROM maintenance_state
                   WHERE document_id = ?1 AND (issue_code IS NOT NULL OR cleanup_work IS NOT NULL OR reconciliation_work IS NOT NULL)
                 )",
                [document_id],
                |row| row.get::<_, bool>(0),
            )
        })
        .map_err(|error| AppError::HistoryUnavailable(error.to_string()))?;
    Ok(pending.then(|| {
        AppError::HistoryOperationPending("history operation requires reconciliation".to_owned())
            .into_ipc()
    }))
}

fn hydrate_preview(
    store: &HistoryStore,
    document_id: &str,
    version_id: &str,
) -> Result<HistoryPreviewResponse, AppError> {
    let row = store
        .with_connection(|connection| load_version_row(connection, document_id, version_id))
        .map_err(|error| AppError::HistoryStaleDocument(error.to_string()))?
        .ok_or_else(|| {
            AppError::HistoryStaleDocument(
                "version does not belong to the current document".to_owned(),
            )
        })?;
    let scene_hash = ObjectKey::scene(row.scene_hash.clone())
        .map_err(|error| AppError::HistoryResourceMissing(error.to_string()))?;
    let asset_keys = row
        .assets
        .iter()
        .map(|asset| ObjectKey::asset(asset.hash.clone()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| AppError::HistoryResourceMissing(error.to_string()))?;
    let references = ObjectReferences::from_objects(std::iter::once(scene_hash).chain(asset_keys));
    let _pin = store
        .reachability()
        .acquire_hydration_pin(references)
        .map_err(|error| AppError::HistoryUnavailable(error.to_string()))?;
    #[cfg(feature = "e2e-harness")]
    if let Some(barrier) = e2e_preview_hydration_pin_barrier() {
        barrier.wait_after_pin();
    }
    let scene_bytes = store
        .objects()
        .read_scene(&row.scene_hash)
        .map_err(resource_error)?;
    let scene_metadata = SceneObjectMetadata {
        schema_version: row
            .scene_schema_version
            .ok_or_else(|| resource_error("scene metadata missing"))?,
        codec: row
            .scene_codec
            .ok_or_else(|| resource_error("scene metadata missing"))?,
        raw_length: row
            .scene_raw_length
            .ok_or_else(|| resource_error("scene metadata missing"))?,
        sha256: row.scene_hash.clone(),
        relative_path: PathBuf::from(
            row.scene_relative_path
                .ok_or_else(|| resource_error("scene metadata missing"))?,
        ),
    };
    let mut asset_bytes = Vec::with_capacity(row.assets.len());
    let mut asset_objects = Vec::with_capacity(row.assets.len());
    for asset in &row.assets {
        let bytes = store
            .objects()
            .read_asset(&asset.hash)
            .map_err(resource_error)?;
        asset_bytes.push(bytes);
    }
    for (asset, bytes) in row.assets.iter().zip(asset_bytes.iter()) {
        asset_objects.push(AssetObject {
            file_id: asset.file_id.clone(),
            metadata: AssetObjectMetadata {
                sha256: asset.hash.clone(),
                byte_length: asset.byte_length,
                mime_type: asset.mime_type.clone(),
                relative_path: PathBuf::from(asset.relative_path.clone()),
            },
            bytes,
        });
    }
    let validated = validate_scene_and_assets(&scene_bytes, &scene_metadata, &asset_objects)
        .map_err(|error| AppError::HistoryResourceMissing(error.to_string()))?;
    let mut scene = validated.value;
    if let Some(files) = scene
        .get_mut("files")
        .and_then(serde_json::Value::as_object_mut)
    {
        for (file_id, reference) in validated.image_files {
            let asset = row
                .assets
                .iter()
                .find(|asset| asset.file_id == file_id)
                .ok_or_else(|| {
                    AppError::HistoryResourceMissing(format!("asset {file_id} is unavailable"))
                })?;
            let bytes = row
                .assets
                .iter()
                .position(|item| item.file_id == file_id)
                .and_then(|index| asset_bytes.get(index))
                .ok_or_else(|| {
                    AppError::HistoryResourceMissing(format!("asset {file_id} is unavailable"))
                })?;
            let file = files.get_mut(&file_id).ok_or_else(|| {
                AppError::HistoryResourceMissing(format!("asset {file_id} is unavailable"))
            })?;
            let expected_hash = Sha256::digest(bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            if expected_hash != reference.asset_hash {
                return Err(AppError::HistoryResourceMissing(format!(
                    "asset {file_id} hash mismatch"
                )));
            }
            file["dataURL"] = serde_json::Value::String(format!(
                "data:{};base64,{}",
                asset.mime_type,
                BASE64.encode(bytes)
            ));
        }
    }
    Ok(HistoryPreviewResponse {
        version_id: version_id.to_owned(),
        scene,
    })
}

fn load_version_row(
    connection: &rusqlite::Connection,
    document_id: &str,
    version_id: &str,
) -> Result<Option<VersionRow>, rusqlite::Error> {
    let result = rusqlite::OptionalExtension::optional(connection.query_row(
        "SELECT id, source, protected_action, recorded_at, sequence, scene_hash,
                so.schema_version, so.codec, so.raw_length, so.relative_path, hv.marked
         FROM history_versions hv
         LEFT JOIN scene_objects so ON so.hash = hv.scene_hash
         WHERE hv.document_id = ?1 AND hv.id = ?2",
        rusqlite::params![document_id, version_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<i64>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, bool>(10)?,
            ))
        },
    ))?;
    result
        .map(
            |(
                id,
                source,
                protected_action,
                recorded_at,
                sequence,
                scene_hash,
                schema_version,
                codec,
                raw_length,
                relative_path,
                marked,
            )| {
                Ok(VersionRow {
                    version_id: id,
                    source: parse_source(&source)?,
                    marked,
                    protected_action: parse_protected_action(protected_action.as_deref())?,
                    recorded_at,
                    sequence: u64::try_from(sequence)
                        .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, sequence))?,
                    scene_hash,
                    scene_schema_version: schema_version
                        .and_then(|value| u32::try_from(value).ok()),
                    scene_codec: codec,
                    scene_raw_length: raw_length
                        .map(|value| u64::try_from(value).unwrap_or(u64::MAX)),
                    scene_relative_path: relative_path,
                    assets: load_asset_rows(connection, version_id)?,
                })
            },
        )
        .transpose()
}

fn load_asset_rows(
    connection: &rusqlite::Connection,
    version_id: &str,
) -> Result<Vec<AssetRow>, rusqlite::Error> {
    let mut statement = connection.prepare(
        "SELECT va.sdk_file_id, va.asset_hash, va.byte_length, va.mime_type, ao.relative_path
         FROM version_assets va LEFT JOIN asset_objects ao ON ao.hash = va.asset_hash
         WHERE va.version_id = ?1 ORDER BY va.sdk_file_id",
    )?;
    let rows = statement
        .query_map([version_id], |row| {
            Ok(AssetRow {
                file_id: row.get(0)?,
                hash: row.get(1)?,
                byte_length: u64::try_from(row.get::<_, i64>(2)?).unwrap_or(u64::MAX),
                mime_type: row.get(3)?,
                relative_path: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            })
        })?
        .collect();
    rows
}

fn parse_source(value: &str) -> Result<HistoryVersionSource, rusqlite::Error> {
    match value {
        "automatic" => Ok(HistoryVersionSource::Automatic),
        "manual" => Ok(HistoryVersionSource::Manual),
        "protected" => Ok(HistoryVersionSource::Protected),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn parse_protected_action(
    value: Option<&str>,
) -> Result<Option<HistoryProtectedAction>, rusqlite::Error> {
    value
        .map(|value| match value {
            "restore" => Ok(HistoryProtectedAction::Restore),
            "clear" => Ok(HistoryProtectedAction::Clear),
            "import" => Ok(HistoryProtectedAction::Import),
            _ => Err(rusqlite::Error::InvalidQuery),
        })
        .transpose()
}

fn resource_error(error: impl std::fmt::Display) -> AppError {
    AppError::HistoryResourceMissing(error.to_string())
}
