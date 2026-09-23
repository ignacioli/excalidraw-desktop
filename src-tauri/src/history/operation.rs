//! Durable protected-replacement operation records.
//!
//! A replacement has two persistence boundaries: the filesystem mutation and
//! its history metadata.  `OperationStore` records the intent before either
//! boundary is crossed and advances it monotonically.  The operation id is
//! the request id, so retrying a request reads the existing record instead of
//! acquiring another protection or attempting another replacement.
//!
//! Temporary-file and object-pin values have dedicated schema columns.  The
//! pin column stores a JSON array because each operation can retain a bounded
//! set of scene and asset objects; `target_manifest_hash` remains a normal
//! content hash and is never overloaded with operation metadata.

use std::collections::BTreeSet;

use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::{
    gc::{GcError, ObjectKey, ObjectKind, ObjectReferences, OperationPin, ReachabilityGate},
    store::{HistoryStore, HistoryStoreError},
    types::{
        validate_hash, validate_identifier, validate_text, HistoryOperationKind,
        HistoryOperationState, HISTORY_MAX_IDENTIFIER_LENGTH, HISTORY_MAX_PATH_LENGTH,
    },
};

/// Input for the first durable operation record.  All optional values are
/// persisted before the first filesystem operation so recovery has enough
/// information to decide whether the target was published.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationRequest {
    pub idempotency_id: String,
    pub document_id: String,
    pub session_generation: u64,
    pub revision: u64,
    pub kind: HistoryOperationKind,
    pub protection_version_id: Option<String>,
    pub expected_old_disk_hash: Option<String>,
    pub expected_old_identity: Option<String>,
    pub prepared_target_identity: Option<String>,
    pub target_scene_hash: Option<String>,
    pub target_manifest_hash: Option<String>,
    pub temp_file: Option<String>,
    pub target_object_pins: Vec<OperationObjectPin>,
}

/// A persisted object that must remain reachable while an incomplete
/// operation is recoverable.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct OperationObjectPin {
    pub kind: ObjectKind,
    pub hash: String,
}

impl OperationObjectPin {
    pub fn scene(hash: impl Into<String>) -> Self {
        Self {
            kind: ObjectKind::Scene,
            hash: hash.into(),
        }
    }

    pub fn asset(hash: impl Into<String>) -> Self {
        Self {
            kind: ObjectKind::Asset,
            hash: hash.into(),
        }
    }
}

/// A durable operation row, including the fields encoded in the metadata
/// envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationRecord {
    pub idempotency_id: String,
    pub document_id: String,
    pub session_generation: u64,
    pub revision: u64,
    pub kind: HistoryOperationKind,
    pub protection_version_id: Option<String>,
    pub expected_old_disk_hash: Option<String>,
    pub expected_old_identity: Option<String>,
    pub prepared_target_identity: Option<String>,
    pub observed_published_identity: Option<String>,
    pub target_scene_hash: Option<String>,
    pub target_manifest_hash: Option<String>,
    pub actual_target_byte_hash: Option<String>,
    pub temp_file: Option<String>,
    pub target_object_pins: Vec<OperationObjectPin>,
    pub state: HistoryOperationState,
    pub error_classification: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Fields that may be filled as each state transition becomes durable.
/// `None` means leave the existing value unchanged.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OperationUpdate {
    pub protection_version_id: Option<String>,
    pub prepared_target_identity: Option<String>,
    pub observed_published_identity: Option<String>,
    pub target_scene_hash: Option<String>,
    pub target_manifest_hash: Option<String>,
    pub actual_target_byte_hash: Option<String>,
    pub temp_file: Option<String>,
    pub target_object_pins: Option<Vec<OperationObjectPin>>,
    pub error_classification: Option<String>,
}

#[derive(Debug, Error)]
pub enum OperationError {
    #[error(transparent)]
    Store(#[from] HistoryStoreError),
    #[error("history operation idempotency key conflicts with an existing request: {0}")]
    IdempotencyConflict(String),
    #[error("history operation {0} was not found")]
    NotFound(String),
    #[error("invalid history operation transition from {from:?} to {to:?}")]
    InvalidTransition {
        from: HistoryOperationState,
        to: HistoryOperationState,
    },
    #[error("history operation metadata is invalid: {0}")]
    InvalidMetadata(String),
    #[error("history operation value is invalid: {0}")]
    InvalidValue(String),
    #[error("history operation payload encoding failed: {0}")]
    Encoding(#[from] serde_json::Error),
    #[error("history GC failed: {0}")]
    Gc(#[from] GcError),
}

/// A recovered operation together with its in-memory reachability pin.
/// Keep this value alive until the operation reaches a durable terminal state.
#[derive(Debug)]
pub struct RehydratedOperationPin {
    pub operation: OperationRecord,
    pub pin: OperationPin,
}

pub struct OperationStore<'store> {
    store: &'store HistoryStore,
}

/// Name kept explicit for callers that prefer the history-domain spelling.
pub type HistoryOperationStore<'store> = OperationStore<'store>;

impl<'store> OperationStore<'store> {
    pub fn new(store: &'store HistoryStore) -> Self {
        Self { store }
    }

    pub fn store(&self) -> &'store HistoryStore {
        self.store
    }

    /// Insert a Preparing record, or return the already persisted record for
    /// the same idempotency key.  The unique primary key and transaction make
    /// concurrent retries converge on one durable operation.
    pub fn create_or_get(
        &self,
        request: OperationRequest,
        now: i64,
    ) -> Result<OperationRecord, OperationError> {
        validate_request(&request)?;
        let pins = encode_pins(&request.target_object_pins)?;
        let kind = kind_sql(request.kind);
        let generation = sqlite_u64(request.session_generation, "session generation")?;
        let revision = sqlite_u64(request.revision, "revision")?;
        let row = self.store.with_transaction(|transaction| {
            transaction.execute(
                "INSERT INTO history_operations
                 (idempotency_id, document_id, session_generation, revision, kind,
                  protection_version_id, expected_old_disk_hash, expected_old_identity,
                  prepared_target_identity, target_scene_hash, target_manifest_hash,
                  temp_file, target_object_pins_json, state, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                         'preparing', ?14, ?14)
                 ON CONFLICT(idempotency_id) DO NOTHING",
                params![
                    &request.idempotency_id,
                    &request.document_id,
                    generation,
                    revision,
                    kind,
                    &request.protection_version_id,
                    &request.expected_old_disk_hash,
                    &request.expected_old_identity,
                    &request.prepared_target_identity,
                    &request.target_scene_hash,
                    &request.target_manifest_hash,
                    &request.temp_file,
                    pins,
                    now,
                ],
            )?;
            read_row(transaction, &request.idempotency_id)
        })?;
        let record = decode_row(row)?;
        if !same_request(&record, &request) {
            return Err(OperationError::IdempotencyConflict(request.idempotency_id));
        }
        Ok(record)
    }

    pub fn begin(
        &self,
        request: OperationRequest,
        now: i64,
    ) -> Result<OperationRecord, OperationError> {
        self.create_or_get(request, now)
    }

    pub fn load(&self, idempotency_id: &str) -> Result<Option<OperationRecord>, OperationError> {
        validate_identifier(idempotency_id, "requestId")
            .map_err(|error| OperationError::InvalidValue(error.to_string()))?;
        let row = self.store.with_connection(|connection| {
            connection
                .query_row(
                    &format!(
                        "{OPERATION_SELECT}{OPERATION_COLUMNS} FROM history_operations \
                         WHERE idempotency_id = ?1"
                    ),
                    [idempotency_id],
                    row_from_sql,
                )
                .optional()
        })?;
        row.map(decode_row).transpose()
    }

    /// Persist one monotonic state transition and any observations acquired at
    /// that boundary.  Repeating the same transition is idempotent.
    pub fn transition(
        &self,
        idempotency_id: &str,
        next: HistoryOperationState,
        update: OperationUpdate,
        now: i64,
    ) -> Result<OperationRecord, OperationError> {
        validate_identifier(idempotency_id, "requestId")
            .map_err(|error| OperationError::InvalidValue(error.to_string()))?;
        validate_update(&update)?;
        if next == HistoryOperationState::PendingReconciliation {
            return Err(OperationError::InvalidValue(
                "pendingReconciliation is a response status, not a durable SQLite state".to_owned(),
            ));
        }
        let encoded_pins = update
            .target_object_pins
            .as_deref()
            .map(encode_pins)
            .transpose()?;
        let next_sql = state_sql(next);
        let row = self.store.with_transaction(|transaction| {
            let raw = read_row(transaction, idempotency_id)?;
            let current = decode_row(raw.clone()).map_err(sqlite_metadata_error)?;
            if current.state != next && !is_allowed_transition(current.state, next) {
                return Err(HistoryStoreError::Sqlite(rusqlite::Error::InvalidQuery));
            }
            transaction.execute(
                "UPDATE history_operations SET
                    state = ?2,
                    protection_version_id = COALESCE(?3, protection_version_id),
                    prepared_target_identity = COALESCE(?4, prepared_target_identity),
                    observed_published_identity = COALESCE(?5, observed_published_identity),
                    target_scene_hash = COALESCE(?6, target_scene_hash),
                    target_manifest_hash = COALESCE(?7, target_manifest_hash),
                    actual_target_byte_hash = COALESCE(?8, actual_target_byte_hash),
                    temp_file = COALESCE(?9, temp_file),
                    target_object_pins_json = COALESCE(?10, target_object_pins_json),
                    error_classification = COALESCE(?11, error_classification),
                    updated_at = ?12
                 WHERE idempotency_id = ?1",
                params![
                    idempotency_id,
                    next_sql,
                    &update.protection_version_id,
                    &update.prepared_target_identity,
                    &update.observed_published_identity,
                    &update.target_scene_hash,
                    &update.target_manifest_hash,
                    &update.actual_target_byte_hash,
                    &update.temp_file,
                    encoded_pins,
                    &update.error_classification,
                    now,
                ],
            )?;
            read_row(transaction, idempotency_id)
        });
        match row {
            Ok(row) => decode_row(row),
            Err(HistoryStoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows)) => {
                Err(OperationError::NotFound(idempotency_id.to_owned()))
            }
            Err(HistoryStoreError::Sqlite(rusqlite::Error::InvalidQuery)) => {
                let current = self.load_required(idempotency_id)?;
                Err(OperationError::InvalidTransition {
                    from: current.state,
                    to: next,
                })
            }
            Err(error) => Err(OperationError::Store(error)),
        }
    }

    /// Read all recoverable records and acquire their operation pins in the
    /// same process-wide reachability gate used by collection.
    pub fn rehydrate_incomplete_pins(
        &self,
        gate: &ReachabilityGate,
    ) -> Result<Vec<RehydratedOperationPin>, OperationError> {
        let rows = self.store.with_connection(|connection| {
            let mut statement = connection.prepare(&format!(
                "SELECT {OPERATION_COLUMNS}
                 FROM history_operations
                 WHERE state NOT IN ('completed', 'aborted', 'conflict')
                 ORDER BY updated_at, idempotency_id"
            ))?;
            let rows = statement
                .query_map([], row_from_sql)
                .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())?;
            Ok(rows)
        })?;
        let mut recovered = Vec::with_capacity(rows.len());
        for row in rows {
            let operation = decode_row(row)?;
            let references = operation_references(&operation)?;
            let pin = gate.acquire_operation_pin(operation.idempotency_id.clone(), references)?;
            recovered.push(RehydratedOperationPin { operation, pin });
        }
        Ok(recovered)
    }

    pub fn list_incomplete(&self) -> Result<Vec<OperationRecord>, OperationError> {
        let rows = self.store.with_connection(|connection| {
            let mut statement = connection.prepare(&format!(
                "SELECT {OPERATION_COLUMNS}
                 FROM history_operations
                 WHERE state NOT IN ('completed', 'aborted', 'conflict')
                 ORDER BY updated_at, idempotency_id"
            ))?;
            let rows = statement
                .query_map([], row_from_sql)
                .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())?;
            Ok(rows)
        })?;
        rows.into_iter().map(decode_row).collect()
    }

    fn load_required(&self, idempotency_id: &str) -> Result<OperationRecord, OperationError> {
        self.load(idempotency_id)?
            .ok_or_else(|| OperationError::NotFound(idempotency_id.to_owned()))
    }
}

const OPERATION_COLUMNS: &str = "idempotency_id, document_id, session_generation, revision,
    kind, protection_version_id, expected_old_disk_hash, expected_old_identity,
    prepared_target_identity, observed_published_identity, target_scene_hash,
    target_manifest_hash, actual_target_byte_hash, temp_file,
    target_object_pins_json, state, error_classification, created_at, updated_at";

const OPERATION_SELECT: &str = "SELECT ";

fn read_row(
    transaction: &Transaction<'_>,
    idempotency_id: &str,
) -> Result<RawOperationRow, HistoryStoreError> {
    transaction
        .query_row(
            &format!("{OPERATION_SELECT}{OPERATION_COLUMNS} FROM history_operations WHERE idempotency_id = ?1"),
            [idempotency_id],
            row_from_sql,
        )
        .optional()?
        .ok_or_else(|| HistoryStoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows))
}

type RawOperationRow = (
    String,
    String,
    i64,
    i64,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    String,
    Option<String>,
    i64,
    i64,
);

fn row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawOperationRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
        row.get(10)?,
        row.get(11)?,
        row.get(12)?,
        row.get(13)?,
        row.get(14)?,
        row.get(15)?,
        row.get(16)?,
        row.get(17)?,
        row.get(18)?,
    ))
}

#[derive(Debug, Serialize, Deserialize)]
struct SerializedObjectPin {
    kind: String,
    hash: String,
}

fn encode_pins(pins: &[OperationObjectPin]) -> Result<String, OperationError> {
    let payload = pins.iter().map(serialize_pin).collect::<Vec<_>>();
    Ok(serde_json::to_string(&payload)?)
}

fn decode_pins(raw: &str) -> Result<Vec<OperationObjectPin>, OperationError> {
    serde_json::from_str::<Vec<SerializedObjectPin>>(raw)
        .map_err(OperationError::Encoding)?
        .into_iter()
        .map(deserialize_pin)
        .collect()
}

fn serialize_pin(pin: &OperationObjectPin) -> SerializedObjectPin {
    SerializedObjectPin {
        kind: match pin.kind {
            ObjectKind::Scene => "scene".to_owned(),
            ObjectKind::Asset => "asset".to_owned(),
        },
        hash: pin.hash.clone(),
    }
}

fn deserialize_pin(pin: SerializedObjectPin) -> Result<OperationObjectPin, OperationError> {
    let kind = match pin.kind.as_str() {
        "scene" => ObjectKind::Scene,
        "asset" => ObjectKind::Asset,
        other => {
            return Err(OperationError::InvalidMetadata(format!(
                "unknown pin kind {other}"
            )))
        }
    };
    ObjectKey::new(kind, pin.hash.clone())
        .map_err(|error| OperationError::InvalidMetadata(error.to_string()))?;
    Ok(OperationObjectPin {
        kind,
        hash: pin.hash,
    })
}

fn decode_row(row: RawOperationRow) -> Result<OperationRecord, OperationError> {
    let pins = decode_pins(&row.14)?;
    let state = parse_state(&row.15)?;
    let kind = parse_kind(&row.4)?;
    let session_generation = u64::try_from(row.2)
        .map_err(|_| OperationError::InvalidMetadata("negative session generation".to_owned()))?;
    let revision = u64::try_from(row.3)
        .map_err(|_| OperationError::InvalidMetadata("negative revision".to_owned()))?;
    Ok(OperationRecord {
        idempotency_id: row.0,
        document_id: row.1,
        session_generation,
        revision,
        kind,
        protection_version_id: row.5,
        expected_old_disk_hash: row.6,
        expected_old_identity: row.7,
        prepared_target_identity: row.8,
        observed_published_identity: row.9,
        target_scene_hash: row.10,
        target_manifest_hash: row.11,
        actual_target_byte_hash: row.12,
        temp_file: row.13,
        target_object_pins: pins,
        state,
        error_classification: row.16,
        created_at: row.17,
        updated_at: row.18,
    })
}

fn operation_references(operation: &OperationRecord) -> Result<ObjectReferences, OperationError> {
    let mut objects = operation
        .target_object_pins
        .iter()
        .map(|pin| ObjectKey::new(pin.kind, pin.hash.clone()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| OperationError::InvalidMetadata(error.to_string()))?;
    if let Some(scene_hash) = &operation.target_scene_hash {
        let scene = ObjectKey::scene(scene_hash.clone())
            .map_err(|error| OperationError::InvalidMetadata(error.to_string()))?;
        objects.push(scene);
    }
    Ok(ObjectReferences::from_objects(objects))
}

fn same_request(record: &OperationRecord, request: &OperationRequest) -> bool {
    record.document_id == request.document_id
        && record.session_generation == request.session_generation
        && record.revision == request.revision
        && record.kind == request.kind
        && record.expected_old_disk_hash == request.expected_old_disk_hash
        && record.expected_old_identity == request.expected_old_identity
        && record.prepared_target_identity == request.prepared_target_identity
        && record.target_scene_hash == request.target_scene_hash
        && record.target_manifest_hash == request.target_manifest_hash
        && record.temp_file == request.temp_file
        && record.target_object_pins == request.target_object_pins
}

fn validate_request(request: &OperationRequest) -> Result<(), OperationError> {
    for (value, field) in [
        (&request.idempotency_id, "requestId"),
        (&request.document_id, "documentId"),
    ] {
        validate_identifier(value, field)
            .map_err(|error| OperationError::InvalidValue(error.to_string()))?;
    }
    for (hash, field) in [
        (
            request.expected_old_disk_hash.as_deref(),
            "expectedOldDiskHash",
        ),
        (request.target_scene_hash.as_deref(), "targetSceneHash"),
        (
            request.target_manifest_hash.as_deref(),
            "targetManifestHash",
        ),
    ] {
        if let Some(hash) = hash {
            validate_hash(hash, field)
                .map_err(|error| OperationError::InvalidValue(error.to_string()))?;
        }
    }
    if let Some(version_id) = &request.protection_version_id {
        validate_identifier(version_id, "protectionVersionId")
            .map_err(|error| OperationError::InvalidValue(error.to_string()))?;
    }
    if let Some(identity) = &request.expected_old_identity {
        validate_text(
            identity,
            "expectedOldIdentity",
            HISTORY_MAX_IDENTIFIER_LENGTH,
        )
        .map_err(|error| OperationError::InvalidValue(error.to_string()))?;
    }
    if let Some(identity) = &request.prepared_target_identity {
        validate_text(
            identity,
            "preparedTargetIdentity",
            HISTORY_MAX_IDENTIFIER_LENGTH,
        )
        .map_err(|error| OperationError::InvalidValue(error.to_string()))?;
    }
    if let Some(temp_file) = &request.temp_file {
        validate_text(temp_file, "tempFile", HISTORY_MAX_PATH_LENGTH)
            .map_err(|error| OperationError::InvalidValue(error.to_string()))?;
    }
    validate_pins(&request.target_object_pins)
}

fn validate_update(update: &OperationUpdate) -> Result<(), OperationError> {
    if let Some(hash) = &update.target_scene_hash {
        validate_hash(hash, "targetSceneHash")
            .map_err(|error| OperationError::InvalidValue(error.to_string()))?;
    }
    if let Some(hash) = &update.target_manifest_hash {
        validate_hash(hash, "targetManifestHash")
            .map_err(|error| OperationError::InvalidValue(error.to_string()))?;
    }
    if let Some(hash) = &update.actual_target_byte_hash {
        validate_hash(hash, "actualTargetByteHash")
            .map_err(|error| OperationError::InvalidValue(error.to_string()))?;
    }
    if let Some(temp_file) = &update.temp_file {
        validate_text(temp_file, "tempFile", HISTORY_MAX_PATH_LENGTH)
            .map_err(|error| OperationError::InvalidValue(error.to_string()))?;
    }
    if let Some(pins) = &update.target_object_pins {
        validate_pins(pins)?;
    }
    Ok(())
}

fn validate_pins(pins: &[OperationObjectPin]) -> Result<(), OperationError> {
    let mut seen = BTreeSet::new();
    for pin in pins {
        ObjectKey::new(pin.kind, pin.hash.clone())
            .map_err(|error| OperationError::InvalidValue(error.to_string()))?;
        if !seen.insert((pin.kind, pin.hash.clone())) {
            return Err(OperationError::InvalidValue(
                "target object pins must be unique".to_owned(),
            ));
        }
    }
    Ok(())
}

fn sqlite_u64(value: u64, field: &str) -> Result<i64, OperationError> {
    i64::try_from(value)
        .map_err(|_| OperationError::InvalidValue(format!("{field} exceeds SQLite range")))
}

fn sqlite_metadata_error(_: OperationError) -> HistoryStoreError {
    HistoryStoreError::Sqlite(rusqlite::Error::InvalidQuery)
}

fn kind_sql(kind: HistoryOperationKind) -> &'static str {
    match kind {
        HistoryOperationKind::Mark => "mark",
        HistoryOperationKind::Replace => "replace",
        HistoryOperationKind::Delete => "delete",
        HistoryOperationKind::Reconcile => "reconcile",
    }
}

fn parse_kind(value: &str) -> Result<HistoryOperationKind, OperationError> {
    match value {
        "mark" => Ok(HistoryOperationKind::Mark),
        "replace" => Ok(HistoryOperationKind::Replace),
        "delete" => Ok(HistoryOperationKind::Delete),
        "reconcile" => Ok(HistoryOperationKind::Reconcile),
        other => Err(OperationError::InvalidMetadata(format!(
            "unknown operation kind {other}"
        ))),
    }
}

fn state_sql(state: HistoryOperationState) -> &'static str {
    match state {
        HistoryOperationState::Preparing => "preparing",
        HistoryOperationState::Protected => "protected",
        HistoryOperationState::IntentCommitted => "intent_committed",
        HistoryOperationState::TargetObserved => "target_observed",
        HistoryOperationState::TargetPublished => "target_published",
        HistoryOperationState::MetadataCommitted => "metadata_committed",
        HistoryOperationState::Completed => "completed",
        HistoryOperationState::Aborted => "aborted",
        HistoryOperationState::Reconcile | HistoryOperationState::PendingReconciliation => {
            "reconcile"
        }
        HistoryOperationState::Conflict => "conflict",
    }
}

fn parse_state(value: &str) -> Result<HistoryOperationState, OperationError> {
    match value {
        "preparing" => Ok(HistoryOperationState::Preparing),
        "protected" => Ok(HistoryOperationState::Protected),
        "intent_committed" => Ok(HistoryOperationState::IntentCommitted),
        "target_observed" => Ok(HistoryOperationState::TargetObserved),
        "target_published" => Ok(HistoryOperationState::TargetPublished),
        "metadata_committed" => Ok(HistoryOperationState::MetadataCommitted),
        "completed" => Ok(HistoryOperationState::Completed),
        "aborted" => Ok(HistoryOperationState::Aborted),
        "reconcile" => Ok(HistoryOperationState::Reconcile),
        "conflict" => Ok(HistoryOperationState::Conflict),
        other => Err(OperationError::InvalidMetadata(format!(
            "unknown operation state {other}"
        ))),
    }
}

fn is_allowed_transition(from: HistoryOperationState, to: HistoryOperationState) -> bool {
    if to == HistoryOperationState::Aborted
        || to == HistoryOperationState::Conflict
        || to == HistoryOperationState::Reconcile
    {
        return !matches!(
            from,
            HistoryOperationState::Completed
                | HistoryOperationState::Aborted
                | HistoryOperationState::Conflict
        );
    }
    match from {
        HistoryOperationState::Preparing => to == HistoryOperationState::Protected,
        HistoryOperationState::Protected => to == HistoryOperationState::IntentCommitted,
        HistoryOperationState::IntentCommitted => to == HistoryOperationState::TargetObserved,
        HistoryOperationState::TargetObserved => to == HistoryOperationState::TargetPublished,
        HistoryOperationState::TargetPublished => to == HistoryOperationState::MetadataCommitted,
        HistoryOperationState::MetadataCommitted => to == HistoryOperationState::Completed,
        HistoryOperationState::Reconcile => matches!(
            to,
            HistoryOperationState::TargetObserved
                | HistoryOperationState::TargetPublished
                | HistoryOperationState::MetadataCommitted
                | HistoryOperationState::Completed
        ),
        HistoryOperationState::Completed
        | HistoryOperationState::Aborted
        | HistoryOperationState::Conflict
        | HistoryOperationState::PendingReconciliation => false,
    }
}

#[cfg(test)]
#[path = "operation_test.rs"]
mod tests;
