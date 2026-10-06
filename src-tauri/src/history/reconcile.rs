//! Restart reconciliation for protected replacements.
//!
//! This boundary runs after the history store has rehydrated durable pins and
//! before draft, Recovery, or workspace startup work can publish stale state.
//! It never rewrites the target file: an already published target is only
//! accepted after an independent filesystem observation, object validation,
//! and a fresh file/parent-directory sync.

use std::{
    fs::{File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(test)]
use std::{
    fs,
    sync::{Mutex, OnceLock},
};

use sha2::{Digest, Sha256};
use thiserror::Error;

use super::{
    gc::ObjectKind,
    identity::FileSystemIdentity,
    objects::ObjectStoreError,
    operation::{OperationError, OperationRecord, OperationStore, OperationUpdate},
    store::{HistoryStore, HistoryStoreError},
    types::HistoryOperationState,
    validation::{
        validate_scene_and_assets, AssetObject, AssetObjectMetadata, SceneObjectMetadata,
        HISTORY_OBJECT_CODEC, HISTORY_OBJECT_SCHEMA_VERSION,
    },
};
use crate::database::repository::{
    DocumentRepository, DraftRecord, FileIndexRecord, SqliteRepository, WorkspaceRepository,
};

#[cfg(feature = "e2e-harness")]
fn history_fault_repair() -> Result<(), String> {
    crate::e2e_harness::history_fault_barrier_from_environment(
        crate::e2e_harness::HistoryFaultStage::RenameDeleteRepair,
    )
}

#[cfg(not(feature = "e2e-harness"))]
fn history_fault_repair() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
type LateExternalWrite = (String, Vec<u8>);

#[cfg(test)]
static LATE_EXTERNAL_WRITE: OnceLock<Mutex<Option<LateExternalWrite>>> = OnceLock::new();

#[cfg(test)]
static PRECOMMIT_EXTERNAL_WRITE: OnceLock<Mutex<Option<LateExternalWrite>>> = OnceLock::new();

#[cfg(test)]
fn install_late_external_write(request_id: &str, bytes: Vec<u8>) {
    *LATE_EXTERNAL_WRITE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((request_id.to_owned(), bytes));
}

#[cfg(test)]
fn install_precommit_external_write(request_id: &str, bytes: Vec<u8>) {
    *PRECOMMIT_EXTERNAL_WRITE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((request_id.to_owned(), bytes));
}

#[cfg(test)]
fn maybe_apply_late_external_write(path: &Path, request_id: &str) -> io::Result<()> {
    let mut pending = LATE_EXTERNAL_WRITE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let bytes = if pending
        .as_ref()
        .is_some_and(|(expected_request_id, _)| expected_request_id == request_id)
    {
        pending.take().map(|(_, bytes)| bytes)
    } else {
        None
    };
    if let Some(bytes) = bytes {
        fs::write(path, bytes)?;
    }
    Ok(())
}

#[cfg(test)]
fn maybe_apply_precommit_external_write(path: &Path, request_id: &str) -> io::Result<()> {
    let mut pending = PRECOMMIT_EXTERNAL_WRITE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let bytes = if pending
        .as_ref()
        .is_some_and(|(expected_request_id, _)| expected_request_id == request_id)
    {
        pending.take().map(|(_, bytes)| bytes)
    } else {
        None
    };
    if let Some(bytes) = bytes {
        fs::write(path, bytes)?;
    }
    Ok(())
}

#[cfg(not(test))]
fn maybe_apply_late_external_write(_path: &Path, _request_id: &str) -> io::Result<()> {
    Ok(())
}

#[cfg(not(test))]
fn maybe_apply_precommit_external_write(_path: &Path, _request_id: &str) -> io::Result<()> {
    Ok(())
}

/// The result for one incomplete operation. `Pending` intentionally remains a
/// durable `Reconcile` row; a later startup may retry it without replaying the
/// destructive replacement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconciliationOutcome {
    Aborted { request_id: String },
    Completed { request_id: String },
    Conflict { request_id: String, reason: String },
    Pending { request_id: String, reason: String },
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ReconciliationReport {
    pub outcomes: Vec<ReconciliationOutcome>,
}

impl ReconciliationReport {
    pub fn has_pending(&self) -> bool {
        self.outcomes
            .iter()
            .any(|outcome| matches!(outcome, ReconciliationOutcome::Pending { .. }))
    }
}

#[derive(Debug, Error)]
pub enum ReconcileError {
    #[error(transparent)]
    Operation(#[from] OperationError),
    #[error(transparent)]
    Store(#[from] HistoryStoreError),
    #[error(transparent)]
    Object(#[from] ObjectStoreError),
    #[error("history document {document_id} has no canonical path")]
    MissingDocumentPath { document_id: String },
    #[error("history document {document_id} metadata is invalid: {reason}")]
    InvalidMetadata { document_id: String, reason: String },
}

/// Reconcile every incomplete operation before normal startup writes begin.
///
/// The method is synchronous because all history SQLite and filesystem
/// primitives are synchronous. Callers running on an async runtime should use
/// their existing blocking-work boundary; Tauri setup invokes it before the
/// application is exposed to the frontend.
pub fn reconcile_incomplete_operations(
    store: &HistoryStore,
) -> Result<ReconciliationReport, ReconcileError> {
    let now = unix_timestamp()?;
    let operations = OperationStore::new(store);
    let incomplete = operations.list_incomplete()?;
    let mut report = ReconciliationReport::default();

    for operation in incomplete {
        let outcome = reconcile_one(store, &operations, operation, now)?;
        report.outcomes.push(outcome);
    }
    Ok(report)
}

/// Startup reconciliation variant that also repairs the main SQLite draft and
/// file index. A replacement is not terminal until this cross-database
/// checkpoint succeeds, so a stale dirty draft cannot be replayed over the
/// file on the next document open.
pub async fn reconcile_incomplete_operations_with_repository(
    store: &HistoryStore,
    repository: &SqliteRepository,
) -> Result<ReconciliationReport, ReconcileError> {
    let now = unix_timestamp()?;
    let operations = OperationStore::new(store);
    let incomplete = operations.list_incomplete()?;
    let mut report = ReconciliationReport::default();
    for operation in incomplete {
        let outcome =
            reconcile_one_with_repository(store, &operations, repository, operation, now).await?;
        report.outcomes.push(outcome);
    }
    Ok(report)
}

async fn reconcile_one_with_repository(
    store: &HistoryStore,
    operations: &OperationStore<'_>,
    repository: &SqliteRepository,
    operation: OperationRecord,
    now: i64,
) -> Result<ReconciliationOutcome, ReconcileError> {
    let path = document_path(store, &operation)?;
    let observation = match observe_file(&path) {
        Ok(observation) => observation,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let reason = format!("target file is missing at {}", path.display());
            let _ = transition_conflict(operations, &operation, &reason, now)?;
            release_terminal_pin(store, &operation.idempotency_id)?;
            return Ok(ReconciliationOutcome::Conflict {
                request_id: operation.idempotency_id,
                reason,
            });
        }
        Err(error) => {
            return mark_pending(
                operations,
                &operation,
                format!("cannot inspect target file: {error}"),
                now,
            )
        }
    };

    if old_state_matches(&operation, &observation) {
        let confirmed = match observe_file(&path) {
            Ok(observation) if old_state_matches(&operation, &observation) => observation,
            Ok(_) => {
                let reason = "old target changed before draft/index repair".to_owned();
                let _ = transition_conflict(operations, &operation, &reason, now)?;
                release_terminal_pin(store, &operation.idempotency_id)?;
                return Ok(ReconciliationOutcome::Conflict {
                    request_id: operation.idempotency_id,
                    reason,
                });
            }
            Err(error) => {
                return mark_pending(
                    operations,
                    &operation,
                    format!("cannot recheck old target before repair: {error}"),
                    now,
                )
            }
        };
        if let Err(error) = history_fault_repair() {
            return mark_pending(
                operations,
                &operation,
                format!("rename/delete repair barrier is pending: {error}"),
                now,
            );
        }
        if let Err(error) = repair_main_metadata(repository, &path, &confirmed, now).await {
            return mark_pending(
                operations,
                &operation,
                format!("old-state draft/index repair is pending: {error}"),
                now,
            );
        }
        operations.transition(
            &operation.idempotency_id,
            HistoryOperationState::Aborted,
            OperationUpdate {
                actual_target_byte_hash: Some(observation.hash.clone()),
                error_classification: Some("replacement_not_published".to_owned()),
                ..OperationUpdate::default()
            },
            now,
        )?;
        release_terminal_pin(store, &operation.idempotency_id)?;
        return Ok(ReconciliationOutcome::Aborted {
            request_id: operation.idempotency_id,
        });
    }

    let target_is_durably_identified = if new_state_matches(&operation, &observation) {
        true
    } else {
        durable_target_matches_observation(store, &operation, &observation)
    };
    if !target_is_durably_identified {
        let reason = if operation.observed_published_identity.is_none() {
            "new content observed without a durable published identity".to_owned()
        } else {
            "current file matches neither the durable old nor new state".to_owned()
        };
        let _ = transition_conflict(operations, &operation, &reason, now)?;
        release_terminal_pin(store, &operation.idempotency_id)?;
        return Ok(ReconciliationOutcome::Conflict {
            request_id: operation.idempotency_id,
            reason,
        });
    }

    if let Err(error) = validate_target_objects(store, &operation) {
        let reason = format!("published target failed strict object validation: {error}");
        let _ = transition_conflict(operations, &operation, &reason, now)?;
        release_terminal_pin(store, &operation.idempotency_id)?;
        return Ok(ReconciliationOutcome::Conflict {
            request_id: operation.idempotency_id,
            reason,
        });
    }
    if let Err(error) = sync_file_and_parent(&path) {
        return mark_pending(
            operations,
            &operation,
            format!("published target sync is not confirmed: {error}"),
            now,
        );
    }
    let confirmed = match observe_file(&path) {
        Ok(observation)
            if new_state_matches(&operation, &observation)
                || durable_target_matches_observation(store, &operation, &observation) =>
        {
            observation
        }
        Ok(_) => {
            let reason = "new target changed after sync before draft/index repair".to_owned();
            let _ = transition_conflict(operations, &operation, &reason, now)?;
            release_terminal_pin(store, &operation.idempotency_id)?;
            return Ok(ReconciliationOutcome::Conflict {
                request_id: operation.idempotency_id,
                reason,
            });
        }
        Err(error) => {
            return mark_pending(
                operations,
                &operation,
                format!("cannot recheck new target after sync: {error}"),
                now,
            )
        }
    };
    if let Err(error) = history_fault_repair() {
        return mark_pending(
            operations,
            &operation,
            format!("rename/delete repair barrier is pending: {error}"),
            now,
        );
    }
    if let Err(error) = repair_main_metadata(repository, &path, &confirmed, now).await {
        return mark_pending(
            operations,
            &operation,
            format!("new-state draft/index repair is pending: {error}"),
            now,
        );
    }
    if let Err(error) = maybe_apply_late_external_write(&path, &operation.idempotency_id) {
        return mark_pending(
            operations,
            &operation,
            format!("late target write could not be observed: {error}"),
            now,
        );
    }
    let metadata_confirmed = match observe_file(&path) {
        Ok(observation)
            if (new_state_matches(&operation, &observation)
                || durable_target_matches_observation(store, &operation, &observation))
                && observation.hash == confirmed.hash
                && observation.identity_token == confirmed.identity_token =>
        {
            observation
        }
        Ok(_) => {
            return mark_pending(
                operations,
                &operation,
                "new target changed after main metadata repair".to_owned(),
                now,
            )
        }
        Err(error) => {
            return mark_pending(
                operations,
                &operation,
                format!("cannot recheck new target after main metadata repair: {error}"),
                now,
            )
        }
    };
    if let Err(error) = repair_document_metadata(store, &operation, &metadata_confirmed, now) {
        let reason = format!("metadata_repair_failed:{error}");
        operations.transition(
            &operation.idempotency_id,
            HistoryOperationState::Reconcile,
            OperationUpdate {
                error_classification: Some(reason.clone()),
                ..OperationUpdate::default()
            },
            now,
        )?;
        return Ok(ReconciliationOutcome::Pending {
            request_id: operation.idempotency_id,
            reason,
        });
    }
    let final_confirmed = match observe_file(&path) {
        Ok(observation)
            if observation.hash == metadata_confirmed.hash
                && observation.identity_token == metadata_confirmed.identity_token =>
        {
            observation
        }
        Ok(_) => {
            return mark_pending(
                operations,
                &operation,
                "new target changed after history metadata repair".to_owned(),
                now,
            )
        }
        Err(error) => {
            return mark_pending(
                operations,
                &operation,
                format!("cannot recheck new target after history metadata repair: {error}"),
                now,
            )
        }
    };
    transition_to_completed(operations, &operation, &final_confirmed, now)?;
    Ok(ReconciliationOutcome::Completed {
        request_id: operation.idempotency_id,
    })
}

fn reconcile_one(
    store: &HistoryStore,
    operations: &OperationStore<'_>,
    operation: OperationRecord,
    now: i64,
) -> Result<ReconciliationOutcome, ReconcileError> {
    let path = document_path(store, &operation)?;
    let observation = match observe_file(&path) {
        Ok(observation) => observation,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let reason = format!("target file is missing at {}", path.display());
            let _ = transition_conflict(operations, &operation, &reason, now)?;
            release_terminal_pin(store, &operation.idempotency_id)?;
            return Ok(ReconciliationOutcome::Conflict {
                request_id: operation.idempotency_id,
                reason,
            });
        }
        Err(error) => {
            return mark_pending(
                operations,
                &operation,
                format!("cannot inspect target file: {error}"),
                now,
            )
        }
    };

    // The old branch is deliberately strict: both hash and the persisted
    // filesystem identity must match. A path/hash match alone cannot prove
    // that the same document survived a restart.
    if old_state_matches(&operation, &observation) {
        operations.transition(
            &operation.idempotency_id,
            HistoryOperationState::Aborted,
            OperationUpdate {
                actual_target_byte_hash: Some(observation.hash.clone()),
                error_classification: Some("replacement_not_published".to_owned()),
                ..OperationUpdate::default()
            },
            now,
        )?;
        release_terminal_pin(store, &operation.idempotency_id)?;
        return Ok(ReconciliationOutcome::Aborted {
            request_id: operation.idempotency_id,
        });
    }

    // A same-process hash observation is not sufficient. Either the published
    // identity was durable, or the exact target scene/object set proves that
    // this is the rename-before-observation recovery window.
    let target_is_durably_identified = if new_state_matches(&operation, &observation) {
        true
    } else {
        durable_target_matches_observation(store, &operation, &observation)
    };
    if !target_is_durably_identified {
        let reason = if operation.observed_published_identity.is_none() {
            "new content observed without a durable published identity".to_owned()
        } else {
            "current file matches neither the durable old nor new state".to_owned()
        };
        let _ = transition_conflict(operations, &operation, &reason, now)?;
        release_terminal_pin(store, &operation.idempotency_id)?;
        return Ok(ReconciliationOutcome::Conflict {
            request_id: operation.idempotency_id,
            reason,
        });
    }

    if let Err(error) = validate_target_objects(store, &operation) {
        let reason = format!("published target failed strict object validation: {error}");
        let _ = transition_conflict(operations, &operation, &reason, now)?;
        release_terminal_pin(store, &operation.idempotency_id)?;
        return Ok(ReconciliationOutcome::Conflict {
            request_id: operation.idempotency_id,
            reason,
        });
    }

    // Re-sync both the already-published file and its containing directory.
    // Failure here is retryable maintenance debt, not proof of completion.
    if let Err(error) = sync_file_and_parent(&path) {
        return mark_pending(
            operations,
            &operation,
            format!("published target sync is not confirmed: {error}"),
            now,
        );
    }

    if let Err(error) = history_fault_repair() {
        return mark_pending(
            operations,
            &operation,
            format!("rename/delete repair barrier is pending: {error}"),
            now,
        );
    }
    let confirmed = match observe_file(&path) {
        Ok(observation)
            if new_state_matches(&operation, &observation)
                || durable_target_matches_observation(store, &operation, &observation) =>
        {
            observation
        }
        Ok(_) => {
            return mark_pending(
                operations,
                &operation,
                "published target changed after sync before history metadata repair".to_owned(),
                now,
            )
        }
        Err(error) => {
            return mark_pending(
                operations,
                &operation,
                format!("cannot recheck new target before history metadata repair: {error}"),
                now,
            )
        }
    };
    if let Err(error) = repair_document_metadata(store, &operation, &confirmed, now) {
        // The filesystem is already the new target; leave the operation in
        // Reconcile so a later startup can retry metadata repair.
        let reason = format!("metadata_repair_failed:{error}");
        operations.transition(
            &operation.idempotency_id,
            HistoryOperationState::Reconcile,
            OperationUpdate {
                error_classification: Some(reason.clone()),
                ..OperationUpdate::default()
            },
            now,
        )?;
        return Ok(ReconciliationOutcome::Pending {
            request_id: operation.idempotency_id,
            reason,
        });
    }

    let final_confirmed = match observe_file(&path) {
        Ok(observation)
            if observation.hash == confirmed.hash
                && observation.identity_token == confirmed.identity_token =>
        {
            observation
        }
        Ok(_) => {
            return mark_pending(
                operations,
                &operation,
                "published target changed after history metadata repair".to_owned(),
                now,
            )
        }
        Err(error) => {
            return mark_pending(
                operations,
                &operation,
                format!("cannot recheck new target after history metadata repair: {error}"),
                now,
            )
        }
    };

    transition_to_completed(operations, &operation, &final_confirmed, now)?;
    Ok(ReconciliationOutcome::Completed {
        request_id: operation.idempotency_id,
    })
}

fn mark_pending(
    operations: &OperationStore<'_>,
    operation: &OperationRecord,
    reason: String,
    now: i64,
) -> Result<ReconciliationOutcome, ReconcileError> {
    operations.transition(
        &operation.idempotency_id,
        HistoryOperationState::Reconcile,
        OperationUpdate {
            error_classification: Some(reason.clone()),
            ..OperationUpdate::default()
        },
        now,
    )?;
    Ok(ReconciliationOutcome::Pending {
        request_id: operation.idempotency_id.clone(),
        reason,
    })
}

fn transition_conflict(
    operations: &OperationStore<'_>,
    operation: &OperationRecord,
    reason: &str,
    now: i64,
) -> Result<OperationRecord, ReconcileError> {
    Ok(operations.transition(
        &operation.idempotency_id,
        HistoryOperationState::Conflict,
        OperationUpdate {
            error_classification: Some(reason.to_owned()),
            ..OperationUpdate::default()
        },
        now,
    )?)
}

fn transition_to_completed(
    operations: &OperationStore<'_>,
    operation: &OperationRecord,
    observation: &FileObservation,
    now: i64,
) -> Result<(), ReconcileError> {
    let current = operations
        .load(&operation.idempotency_id)?
        .ok_or_else(|| OperationError::NotFound(operation.idempotency_id.clone()))?;
    if current.state != HistoryOperationState::Reconcile {
        operations.transition(
            &operation.idempotency_id,
            HistoryOperationState::Reconcile,
            OperationUpdate {
                error_classification: Some("restart_reconciliation".to_owned()),
                ..OperationUpdate::default()
            },
            now,
        )?;
    }
    let update = OperationUpdate {
        observed_published_identity: Some(observation.identity_token.clone()),
        actual_target_byte_hash: Some(observation.hash.clone()),
        error_classification: None,
        ..OperationUpdate::default()
    };
    for state in [
        HistoryOperationState::TargetObserved,
        HistoryOperationState::TargetPublished,
        HistoryOperationState::MetadataCommitted,
        HistoryOperationState::Completed,
    ] {
        operations.transition(
            &operation.idempotency_id,
            state,
            if state == HistoryOperationState::TargetObserved {
                update.clone()
            } else {
                OperationUpdate::default()
            },
            now,
        )?;
    }
    Ok(())
}

fn old_state_matches(operation: &OperationRecord, observation: &FileObservation) -> bool {
    operation
        .expected_old_disk_hash
        .as_deref()
        .is_some_and(|hash| hash == observation.hash)
        && operation
            .expected_old_identity
            .as_deref()
            .is_some_and(|identity| identity == observation.identity_token)
}

fn new_state_matches(operation: &OperationRecord, observation: &FileObservation) -> bool {
    // `target_manifest_hash` describes the scene/assets manifest and is not
    // interchangeable with the bytes written to the document path.
    operation
        .actual_target_byte_hash
        .as_deref()
        .is_some_and(|hash| hash == observation.hash)
        && operation
            .observed_published_identity
            .as_deref()
            .is_some_and(|identity| identity == observation.identity_token)
}

/// Recover the narrow window after the target rename and before
/// `mark_target_published` can commit its filesystem observation.  The
/// operation row contains the immutable target scene hash and pins before the
/// rename; those durable objects are the only acceptable source of truth when
/// the published identity columns are still empty.
///
/// Exact byte equality with the verified scene object is required.  A hash or
/// parseable JSON value supplied only by the current filesystem is not enough:
/// arbitrary external bytes must remain a conflict.  When no published file
/// identity was durable, a same-byte external rewrite is intentionally treated
/// as content-equivalent because no stronger provenance exists; durable
/// identity rows still reject that identity change. Strict scene/asset
/// validation runs immediately after this predicate in both reconciliation
/// paths, and the repository path separately proves mounted workspace
/// authority before completion.
fn durable_target_matches_observation(
    store: &HistoryStore,
    operation: &OperationRecord,
    observation: &FileObservation,
) -> bool {
    let Some(scene_hash) = operation.target_scene_hash.as_deref() else {
        return false;
    };
    let Ok(target_scene) = store.objects().read_scene(scene_hash) else {
        return false;
    };
    if target_scene != observation.bytes {
        return false;
    }
    if operation
        .actual_target_byte_hash
        .as_deref()
        .is_some_and(|hash| hash != observation.hash)
    {
        return false;
    }
    if operation
        .observed_published_identity
        .as_deref()
        .is_some_and(|identity| identity != observation.identity_token)
    {
        return false;
    }
    true
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileObservation {
    hash: String,
    identity_token: String,
    bytes: Vec<u8>,
    file_size: u64,
    modified_seconds: i64,
}

fn observe_file(path: &Path) -> io::Result<FileObservation> {
    let mut file = File::open(path)?;
    let before = file.metadata()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    let before_identity = FileSystemIdentity::from_metadata(path, &before)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    let after_identity = FileSystemIdentity::from_metadata(path, &after)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    if before_identity != after_identity {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "target file changed while it was being observed",
        ));
    }
    Ok(FileObservation {
        hash: sha256_hex(&bytes),
        identity_token: after_identity.to_string(),
        bytes,
        file_size: after_identity.file_size,
        modified_seconds: after_identity.modified.seconds,
    })
}

async fn repair_main_metadata(
    repository: &SqliteRepository,
    path: &Path,
    observation: &FileObservation,
    updated_at: i64,
) -> Result<(), String> {
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("document path is unavailable: {error}"))?;
    let workspaces = repository
        .workspace_list()
        .await
        .map_err(|error| format!("workspace authority unavailable: {error}"))?;
    let workspace = workspaces
        .iter()
        .filter(|workspace| workspace.mounted)
        .filter_map(|workspace| {
            let root = Path::new(&workspace.root_path);
            let canonical_root = root.canonicalize().ok()?;
            if canonical_path.starts_with(&canonical_root) {
                Some((workspace, canonical_root))
            } else {
                None
            }
        })
        .max_by_key(|(_, root)| root.components().count())
        .ok_or_else(|| format!("no mounted workspace owns {}", path.display()))?;
    let relative_path = canonical_path
        .strip_prefix(&workspace.1)
        .map_err(|error| format!("cannot derive workspace-relative path: {error}"))?
        .to_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "workspace-relative path is not valid UTF-8".to_owned())?
        .to_owned();
    let display_name = canonical_path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "document has no valid file name".to_owned())?
        .to_owned();
    let scene_json = String::from_utf8(observation.bytes.clone())
        .map_err(|error| format!("published document is not UTF-8 JSON: {error}"))?;
    let draft = DraftRecord {
        file_path: canonical_path.display().to_string(),
        scene_json,
        content_hash: observation.hash.clone(),
        base_hash: Some(observation.hash.clone()),
        updated_at,
        is_dirty: false,
    };
    let indexed_file = FileIndexRecord {
        canonical_path: canonical_path.display().to_string(),
        workspace_id: workspace.0.id.clone(),
        display_name,
        relative_path,
        mtime: observation.modified_seconds,
        file_size: i64::try_from(observation.file_size)
            .map_err(|_| "file size exceeds SQLite range".to_owned())?,
        content_hash: Some(observation.hash.clone()),
    };
    repository
        .document_checkpoint_commit(draft, Some(indexed_file))
        .await
        .map_err(|error| format!("main SQLite checkpoint repair failed: {error}"))
}

fn document_path(
    store: &HistoryStore,
    operation: &OperationRecord,
) -> Result<PathBuf, ReconcileError> {
    store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT canonical_path FROM history_documents WHERE id = ?1",
                [&operation.document_id],
                |row| row.get::<_, String>(0),
            )
        })
        .map(PathBuf::from)
        .map_err(|error| match error {
            HistoryStoreError::Sqlite(rusqlite::Error::QueryReturnedNoRows) => {
                ReconcileError::MissingDocumentPath {
                    document_id: operation.document_id.clone(),
                }
            }
            other => ReconcileError::Store(other),
        })
}

fn validate_target_objects(
    store: &HistoryStore,
    operation: &OperationRecord,
) -> Result<(), ReconcileError> {
    let scene_hash =
        operation
            .target_scene_hash
            .as_deref()
            .ok_or_else(|| ReconcileError::InvalidMetadata {
                document_id: operation.document_id.clone(),
                reason: "target scene hash is missing".to_owned(),
            })?;
    let (schema_version, raw_length, relative_path) =
        store.with_connection(|connection| {
            connection.query_row(
            "SELECT schema_version, raw_length, relative_path FROM scene_objects WHERE hash = ?1",
            [scene_hash],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)),
        )
        })?;
    let scene_bytes = store.objects().read_scene(scene_hash)?;
    let scene_metadata = SceneObjectMetadata {
        schema_version: u32::try_from(schema_version).map_err(|_| {
            ReconcileError::InvalidMetadata {
                document_id: operation.document_id.clone(),
                reason: "scene schema version is invalid".to_owned(),
            }
        })?,
        codec: HISTORY_OBJECT_CODEC.to_owned(),
        raw_length: u64::try_from(raw_length).map_err(|_| ReconcileError::InvalidMetadata {
            document_id: operation.document_id.clone(),
            reason: "scene raw length is invalid".to_owned(),
        })?,
        sha256: scene_hash.to_owned(),
        relative_path: PathBuf::from(relative_path),
    };
    if scene_metadata.schema_version != HISTORY_OBJECT_SCHEMA_VERSION {
        return Err(ReconcileError::InvalidMetadata {
            document_id: operation.document_id.clone(),
            reason: "unsupported scene schema version".to_owned(),
        });
    }
    let files = scene_json_files(&scene_bytes)?;
    if !operation
        .target_object_pins
        .iter()
        .any(|pin| pin.kind == ObjectKind::Scene && pin.hash == scene_hash)
    {
        return Err(ReconcileError::InvalidMetadata {
            document_id: operation.document_id.clone(),
            reason: "target scene is not retained by the operation pin set".to_owned(),
        });
    }
    let mut asset_specs = Vec::with_capacity(files.len());
    let mut asset_bytes = Vec::with_capacity(files.len());
    for (file_id, asset_hash, _mime_type) in files {
        if !operation
            .target_object_pins
            .iter()
            .any(|pin| pin.kind == ObjectKind::Asset && pin.hash == asset_hash)
        {
            return Err(ReconcileError::InvalidMetadata {
                document_id: operation.document_id.clone(),
                reason: format!(
                    "target asset {asset_hash} is not retained by the operation pin set"
                ),
            });
        }
        let (byte_length, persisted_mime, relative_path) = store.with_connection(|connection| {
            connection.query_row(
                "SELECT byte_length, mime_type, relative_path FROM asset_objects WHERE hash = ?1",
                [&asset_hash],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
        })?;
        let bytes = store.objects().read_asset(&asset_hash)?;
        asset_specs.push((
            file_id,
            AssetObjectMetadata {
                sha256: asset_hash,
                byte_length: u64::try_from(byte_length).map_err(|_| {
                    ReconcileError::InvalidMetadata {
                        document_id: operation.document_id.clone(),
                        reason: "asset byte length is invalid".to_owned(),
                    }
                })?,
                mime_type: persisted_mime,
                relative_path: PathBuf::from(relative_path),
            },
        ));
        asset_bytes.push(bytes);
    }
    let assets = asset_specs
        .iter()
        .zip(asset_bytes.iter())
        .map(|((file_id, metadata), bytes)| AssetObject {
            file_id: file_id.clone(),
            metadata: metadata.clone(),
            bytes,
        })
        .collect::<Vec<_>>();
    validate_scene_and_assets(&scene_bytes, &scene_metadata, &assets)
        .map(|_| ())
        .map_err(|error| ReconcileError::InvalidMetadata {
            document_id: operation.document_id.clone(),
            reason: error.to_string(),
        })
}

fn scene_json_files(bytes: &[u8]) -> Result<Vec<(String, String, String)>, ReconcileError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| ReconcileError::InvalidMetadata {
            document_id: "<target>".to_owned(),
            reason: format!("scene JSON is invalid: {error}"),
        })?;
    let Some(files) = value.get("files").and_then(serde_json::Value::as_object) else {
        return Ok(Vec::new());
    };
    files
        .iter()
        .map(|(file_id, file)| {
            let data_url = file
                .get("dataURL")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| ReconcileError::InvalidMetadata {
                    document_id: "<target>".to_owned(),
                    reason: format!("asset {file_id} has no dataURL"),
                })?;
            let hash = data_url.strip_prefix("asset://").ok_or_else(|| {
                ReconcileError::InvalidMetadata {
                    document_id: "<target>".to_owned(),
                    reason: format!("asset {file_id} does not use asset://"),
                }
            })?;
            let mime = file
                .get("mimeType")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| ReconcileError::InvalidMetadata {
                    document_id: "<target>".to_owned(),
                    reason: format!("asset {file_id} has no MIME type"),
                })?;
            Ok((file_id.clone(), hash.to_owned(), mime.to_owned()))
        })
        .collect()
}

fn repair_document_metadata(
    store: &HistoryStore,
    operation: &OperationRecord,
    observation: &FileObservation,
    now: i64,
) -> Result<(), ReconcileError> {
    let path = document_path(store, operation)?;
    maybe_apply_precommit_external_write(&path, &operation.idempotency_id).map_err(|error| {
        ReconcileError::InvalidMetadata {
            document_id: operation.document_id.clone(),
            reason: format!("precommit target write failed: {error}"),
        }
    })?;
    let identity =
        FileSystemIdentity::from_path(&path).map_err(|error| ReconcileError::InvalidMetadata {
            document_id: operation.document_id.clone(),
            reason: error.to_string(),
        })?;
    if identity.to_string() != observation.identity_token {
        return Err(ReconcileError::InvalidMetadata {
            document_id: operation.document_id.clone(),
            reason: "target identity changed before history metadata transaction".to_owned(),
        });
    }
    let device = identity
        .device
        .map(i64::try_from)
        .transpose()
        .map_err(|_| ReconcileError::InvalidMetadata {
            document_id: operation.document_id.clone(),
            reason: "device exceeds SQLite range".to_owned(),
        })?;
    let inode = identity.inode.map(i64::try_from).transpose().map_err(|_| {
        ReconcileError::InvalidMetadata {
            document_id: operation.document_id.clone(),
            reason: "inode exceeds SQLite range".to_owned(),
        }
    })?;
    let file_size =
        i64::try_from(identity.file_size).map_err(|_| ReconcileError::InvalidMetadata {
            document_id: operation.document_id.clone(),
            reason: "file size exceeds SQLite range".to_owned(),
        })?;
    store.with_transaction(|transaction| {
        transaction.execute(
            "UPDATE history_documents SET filesystem_device = ?2,
             filesystem_inode = ?3, filesystem_file_size = ?4,
             filesystem_modified_seconds = ?5, filesystem_modified_nanos = ?6,
             filesystem_reliable = ?7, last_self_written_hash = ?8,
             state = 'active' WHERE id = ?1",
            rusqlite::params![
                &operation.document_id,
                device,
                inode,
                file_size,
                identity.modified.seconds,
                i64::from(identity.modified.nanoseconds),
                i64::from(u8::from(identity.reliable)),
                &observation.hash,
            ],
        )?;
        transaction.execute(
            "UPDATE history_operations SET updated_at = ?2 WHERE idempotency_id = ?1",
            rusqlite::params![&operation.idempotency_id, now],
        )?;
        Ok::<(), HistoryStoreError>(())
    })?;
    Ok(())
}

fn sync_file_and_parent(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    OpenOptions::new().read(true).open(parent)?.sync_all()
}

fn release_terminal_pin(store: &HistoryStore, request_id: &str) -> Result<(), ReconcileError> {
    match store.reachability().release_operation_pin(request_id) {
        Ok(()) => Ok(()),
        Err(crate::history::gc::GcError::PinNotActive(_)) => Ok(()),
        Err(error) => Err(ReconcileError::Store(HistoryStoreError::Gc(error))),
    }
}

fn unix_timestamp() -> Result<i64, ReconcileError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .map_err(|error| ReconcileError::InvalidMetadata {
            document_id: "<startup>".to_owned(),
            reason: format!("system clock is before Unix epoch: {error}"),
        })
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
#[path = "reconcile_test.rs"]
mod tests;
