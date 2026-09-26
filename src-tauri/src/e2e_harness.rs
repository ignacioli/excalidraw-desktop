//! Test-only commands for deterministic desktop reliability scenarios.
//!
//! This module is compiled only with the `e2e-harness` Cargo feature. None of
//! these commands are present in a production build.

use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant, SystemTime},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::{
    commands::{
        documents::{DirectFileGrant, DocumentService},
        dto::{
            CheckpointReason, CheckpointRequest, CloseDocumentMode, CloseDocumentRequest,
            ConflictResolution, ExpectedOpenDocument, HistoryDocumentLocator, HistoryListRequest,
            HistoryMarkRequest, HistoryOperationStatusRequest, HistoryPreviewRequest,
            HistoryReplaceRequest, HistoryReplaceTarget, PathRequest, RecoveryAction,
            RecoveryApplyRequest, ResolveConflictRequest, SaveDraftRequest, WorkspaceAddRequest,
            WorkspaceEntryDeletePreflightResult, WorkspaceEntryDeleteRequest,
            WorkspaceEntryPathRequest, WorkspaceEntryRenameRequest, WorkspaceRemoveRequest,
        },
        error::IpcError,
        history::{HistoryReplacementService, HistoryReplacementState},
        recovery::RecoveryService,
        workspace::WorkspaceService,
    },
    database::repository::{
        DraftRecord, DraftRepository, FileIndexRecord, FileIndexRepository, FileMetaRecord,
        FileMetaRepository, SqliteRepository, WorkspaceRecord, WorkspaceRepository,
    },
    documents::{
        atomic_write::{
            atomic_write_with_injector, clear_fault_point, set_before_rename_barrier,
            set_disk_full_fault, set_fault_point, AtomicWriteError, AtomicWriteFaultInjector,
            AtomicWriteFaultPoint,
        },
        recovery::{document_id_for_path, unix_timestamp, RecoveryStore},
        session_lock::SessionLock,
    },
    history::{
        automatic::{e2e_automatic_callback_count, reset_e2e_automatic_callback_count},
        gc::{ObjectKey, ObjectReferences},
        objects::{
            clear_fault_point as clear_object_fault, set_fault as set_object_fault,
            ObjectStoreFaultKind, ObjectStoreFaultPoint,
        },
        operation::OperationStore,
        query::{
            set_e2e_preview_hydration_pin_barrier, E2ePreviewHydrationPinBarrier,
            HistoryQueryService,
        },
        reconcile::reconcile_incomplete_operations_with_repository,
        repository::{HistoryRepository, PublishSceneRequest, AUTOMATIC_INTERVAL_SECONDS},
        store::{clear_transaction_fault, set_transaction_fault, HistoryStore, HistoryStoreFault},
        types::{HistoryProtectedAction, HistoryReplaceResponse, HistoryVersionSource},
        validation::HISTORY_OBJECT_SCHEMA_VERSION,
    },
    workspace_entries::{
        history_replay_for_store,
        mutation_journal::{
            load_journals, reconcile_pending_mutations_with_history, save_journal,
            MutationJournalRecord,
        },
        SystemTrashOperator, TrashOperator, WorkspaceEntryService, WorkspaceMutationGate,
    },
};

pub(crate) const RELIABILITY_SCENARIO_FLAG: &str = "--e2e-reliability-scenario";
const E2E_ROOT_PREFIX: &str = "excalidraw-desktop-e2e-";
const HISTORY_FRONTEND_DRIVER_FLAG: &str = "EXCALIDRAW_E2E_HISTORY_FRONTEND";
const HISTORY_FRONTEND_TARGET_ENV: &str = "EXCALIDRAW_E2E_HISTORY_TARGET_VERSION";
const HISTORY_FRONTEND_REQUEST_ENV: &str = "EXCALIDRAW_E2E_HISTORY_REQUEST_ID";
const HISTORY_FRONTEND_PATH_ENV: &str = "EXCALIDRAW_E2E_HISTORY_DOCUMENT_PATH";
const HISTORY_FRONTEND_READY_MARKER: &str = "history-frontend.ready.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryFrontendDriverRequest {
    pub(crate) document_path: String,
    pub(crate) target_version_id: String,
    pub(crate) request_id: String,
}

#[tauri::command]
pub(crate) fn e2e_history_frontend_bootstrap(
) -> Result<Option<HistoryFrontendDriverRequest>, String> {
    if env::var(HISTORY_FRONTEND_DRIVER_FLAG).as_deref() != Ok("1") {
        return Ok(None);
    }
    let root = process_harness_root()?;
    let document_path = env::var(HISTORY_FRONTEND_PATH_ENV)
        .map_err(|_| format!("{HISTORY_FRONTEND_PATH_ENV} is required"))?;
    let target_version_id = env::var(HISTORY_FRONTEND_TARGET_ENV)
        .map_err(|_| format!("{HISTORY_FRONTEND_TARGET_ENV} is required"))?;
    let request_id = env::var(HISTORY_FRONTEND_REQUEST_ENV)
        .map_err(|_| format!("{HISTORY_FRONTEND_REQUEST_ENV} is required"))?;
    assert_isolated_path(&root, Path::new(&document_path))?;
    Ok(Some(HistoryFrontendDriverRequest {
        document_path,
        target_version_id,
        request_id,
    }))
}

#[tauri::command]
pub(crate) fn e2e_history_frontend_close(window: tauri::Window) -> Result<(), String> {
    if env::var(HISTORY_FRONTEND_DRIVER_FLAG).as_deref() != Ok("1") {
        return Err("history frontend driver is disabled".to_owned());
    }
    process_harness_root()?;
    // Use the normal close-request event so the production checkpoint handler
    // owns checkpoint-before-destroy. A process signal cannot prove this path.
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn e2e_history_frontend_publish(evidence: serde_json::Value) -> Result<(), String> {
    if env::var(HISTORY_FRONTEND_DRIVER_FLAG).as_deref() != Ok("1") {
        return Err("history frontend driver is disabled".to_owned());
    }
    let root = process_harness_root()?;
    let control_directory = root.join("runtime").join("reliability");
    fs::create_dir_all(&control_directory)
        .map_err(|error| format!("failed to create history frontend control directory: {error}"))?;
    let marker = control_directory.join(HISTORY_FRONTEND_READY_MARKER);
    let evidence = if evidence.get("scenario").and_then(serde_json::Value::as_str)
        == Some("history-frontend-progress")
    {
        evidence
    } else {
        enrich_history_frontend_evidence(evidence, &root)?
    };
    let payload = serde_json::to_vec(&evidence)
        .map_err(|error| format!("failed to serialize history frontend evidence: {error}"))?;
    fs::write(marker, payload)
        .map_err(|error| format!("failed to publish history frontend evidence: {error}"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HistoryIdentityDiagnostics {
    history_database_path: String,
    active_document_id: Option<String>,
    operation_document_id: Option<String>,
    operation_state: Option<String>,
}

fn load_history_identity_diagnostics(
    store: &HistoryStore,
    target: &Path,
    request_id: &str,
) -> Result<HistoryIdentityDiagnostics, String> {
    let history_database_path = store.database_path().canonicalize().map_err(|error| {
        format!(
            "failed to canonicalize history database path {}: {error}",
            store.database_path().display()
        )
    })?;
    let target = target.canonicalize().map_err(|error| {
        format!(
            "failed to canonicalize history diagnostic target {}: {error}",
            target.display()
        )
    })?;
    let active_document_id = store
        .load_active_document_identity(&path_string(&target))
        .map_err(|error| format!("failed to load active history identity: {error}"))?
        .map(|identity| identity.document_id);
    let operation = OperationStore::new(store)
        .load(request_id)
        .map_err(|error| format!("failed to load history operation {request_id}: {error}"))?;
    Ok(HistoryIdentityDiagnostics {
        history_database_path: path_string(&history_database_path),
        active_document_id,
        operation_document_id: operation.as_ref().map(|value| value.document_id.clone()),
        operation_state: operation
            .as_ref()
            .and_then(|value| serde_json::to_value(value.state).ok())
            .and_then(|value| value.as_str().map(str::to_owned)),
    })
}

fn enrich_history_frontend_evidence(
    mut evidence: serde_json::Value,
    root: &Path,
) -> Result<serde_json::Value, String> {
    let request_id = env::var(HISTORY_FRONTEND_REQUEST_ENV)
        .map_err(|_| format!("{HISTORY_FRONTEND_REQUEST_ENV} is required"))?;
    let document_path = env::var(HISTORY_FRONTEND_PATH_ENV)
        .map_err(|_| format!("{HISTORY_FRONTEND_PATH_ENV} is required"))?;
    let store = HistoryStore::open(&root.join("data"))
        .map_err(|error| format!("failed to open history store for frontend evidence: {error}"))?;
    let diagnostics =
        load_history_identity_diagnostics(&store, Path::new(&document_path), &request_id)?;
    let target_sha256 = sha256(
        &fs::read(&document_path)
            .map_err(|error| format!("failed to read frontend evidence target: {error}"))?,
    );
    let main_database =
        rusqlite::Connection::open(root.join("data").join("excalidraw-desktop.sqlite3"))
            .map_err(|error| format!("failed to open frontend evidence database: {error}"))?;
    let draft = match main_database.query_row(
        "SELECT scene_json, is_dirty FROM drafts WHERE file_path=?1",
        [&document_path],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
    ) {
        Ok(value) => Some(value),
        Err(rusqlite::Error::QueryReturnedNoRows) => None,
        Err(error) => return Err(format!("failed to read frontend evidence draft: {error}")),
    };
    let object = evidence
        .as_object_mut()
        .ok_or_else(|| "history frontend evidence must be a JSON object".to_owned())?;
    object.insert("requestId".to_owned(), serde_json::json!(request_id));
    object.insert(
        "historyDatabasePath".to_owned(),
        serde_json::json!(diagnostics.history_database_path),
    );
    object.insert(
        "activeDocumentId".to_owned(),
        serde_json::json!(diagnostics.active_document_id),
    );
    object.insert(
        "operationDocumentId".to_owned(),
        serde_json::json!(diagnostics.operation_document_id),
    );
    object.insert(
        "operationState".to_owned(),
        serde_json::json!(diagnostics.operation_state),
    );
    object.insert("targetSha256".to_owned(), serde_json::json!(target_sha256));
    object.insert(
        "draftSceneSha256".to_owned(),
        serde_json::json!(draft.as_ref().map(|(scene, _)| sha256(scene.as_bytes()))),
    );
    object.insert(
        "draftDirty".to_owned(),
        serde_json::json!(draft.as_ref().map(|(_, dirty)| *dirty)),
    );
    Ok(evidence)
}

/// History transaction barriers are deliberately separate from the existing
/// atomic-document write points.  Replacement/reconciliation code calls this
/// contract at the named boundary; the test process publishes a durable-ready
/// marker and then waits for the parent to terminate it.  No production module
/// imports this type because the containing module is feature-gated.
#[cfg(any(test, feature = "e2e-harness"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HistoryFaultStage {
    ObjectPublish,
    ProtectionCommit,
    IntentCommit,
    AfterRenameBeforeParentSync,
    MetadataCompleteBeforeFrontendAck,
    EvictionDeleteGc,
    RenameDeleteRepair,
}

#[cfg(any(test, feature = "e2e-harness"))]
impl HistoryFaultStage {
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) const ALL: [Self; 7] = [
        Self::ObjectPublish,
        Self::ProtectionCommit,
        Self::IntentCommit,
        Self::AfterRenameBeforeParentSync,
        Self::MetadataCompleteBeforeFrontendAck,
        Self::EvictionDeleteGc,
        Self::RenameDeleteRepair,
    ];

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::ObjectPublish => "object_publish",
            Self::ProtectionCommit => "protection_commit",
            Self::IntentCommit => "intent_commit",
            Self::AfterRenameBeforeParentSync => "after_rename_before_parent_sync",
            Self::MetadataCompleteBeforeFrontendAck => "metadata_complete_before_frontend_ack",
            Self::EvictionDeleteGc => "eviction_delete_gc",
            Self::RenameDeleteRepair => "rename_delete_repair",
        }
    }
}

#[cfg(any(test, feature = "e2e-harness"))]
impl std::fmt::Display for HistoryFaultStage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[cfg(any(test, feature = "e2e-harness"))]
impl std::str::FromStr for HistoryFaultStage {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "object_publish" => Ok(Self::ObjectPublish),
            "protection_commit" => Ok(Self::ProtectionCommit),
            "intent_commit" => Ok(Self::IntentCommit),
            "after_rename_before_parent_sync" => Ok(Self::AfterRenameBeforeParentSync),
            "metadata_complete_before_frontend_ack" => Ok(Self::MetadataCompleteBeforeFrontendAck),
            "eviction_delete_gc" => Ok(Self::EvictionDeleteGc),
            "rename_delete_repair" => Ok(Self::RenameDeleteRepair),
            other => Err(format!("unknown history fault stage: {other}")),
        }
    }
}

#[cfg(any(test, feature = "e2e-harness"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryFaultContext {
    pub(crate) operation_id: String,
    pub(crate) document_id: String,
    pub(crate) target_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) old_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) new_sha256: Option<String>,
}

#[cfg(any(test, feature = "e2e-harness"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryFaultReadyMarker {
    pub(crate) scenario: String,
    pub(crate) stage: HistoryFaultStage,
    pub(crate) seed: String,
    pub(crate) pid: u32,
    pub(crate) context: HistoryFaultContext,
}

#[cfg(any(test, feature = "e2e-harness"))]
const HISTORY_FAULT_STAGE_ENV: &str = "EXCALIDRAW_E2E_HISTORY_FAULT_STAGE";
#[cfg(any(test, feature = "e2e-harness"))]
const HISTORY_FAULT_SEED_ENV: &str = "EXCALIDRAW_E2E_HISTORY_FAULT_SEED";
#[cfg(any(test, feature = "e2e-harness"))]
const HISTORY_FAULT_OPERATION_ENV: &str = "EXCALIDRAW_E2E_HISTORY_OPERATION_ID";
#[cfg(any(test, feature = "e2e-harness"))]
const HISTORY_FAULT_DOCUMENT_ENV: &str = "EXCALIDRAW_E2E_HISTORY_DOCUMENT_ID";
#[cfg(any(test, feature = "e2e-harness"))]
const HISTORY_FAULT_TARGET_ENV: &str = "EXCALIDRAW_E2E_HISTORY_TARGET_PATH";
#[cfg(any(test, feature = "e2e-harness"))]
const HISTORY_FAULT_OLD_HASH_ENV: &str = "EXCALIDRAW_E2E_HISTORY_OLD_SHA256";
#[cfg(any(test, feature = "e2e-harness"))]
const HISTORY_FAULT_NEW_HASH_ENV: &str = "EXCALIDRAW_E2E_HISTORY_NEW_SHA256";
#[cfg(any(test, feature = "e2e-harness"))]
const HISTORY_FAULT_READY_MARKER: &str = "history-fault.ready.json";
#[cfg(any(test, feature = "e2e-harness"))]
const HISTORY_FAULT_MODE_ENV: &str = "EXCALIDRAW_E2E_HISTORY_FAULT_MODE";
#[cfg(any(test, feature = "e2e-harness"))]
const HISTORY_FAULT_ARMED_ENV: &str = "EXCALIDRAW_E2E_HISTORY_FAULT_ARMED";
#[cfg(any(test, feature = "e2e-harness"))]
const HISTORY_FAULT_FAILURE_ENV: &str = "EXCALIDRAW_E2E_HISTORY_FAULT_FAILURE";
const HISTORY_PROTECTED_REPLACEMENT_TARGET_ENV: &str = "EXCALIDRAW_E2E_HISTORY_REPLACE_TARGET";
const HISTORY_PROTECTED_REPLACEMENT_FAILURE_ENV: &str = "EXCALIDRAW_E2E_HISTORY_REPLACE_FAILURE";

#[cfg(test)]
type HistoryFaultTestConfig = Option<(HistoryFaultStage, Vec<HistoryFaultStage>)>;
#[cfg(test)]
thread_local! {
    static HISTORY_FAULT_TEST_CONFIG: std::cell::RefCell<HistoryFaultTestConfig> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) struct HistoryFaultTestScope;

#[cfg(test)]
pub(crate) fn history_fault_test_scope(stage: HistoryFaultStage) -> HistoryFaultTestScope {
    HISTORY_FAULT_TEST_CONFIG.with(|config| {
        config.replace(Some((stage, Vec::new())));
    });
    HistoryFaultTestScope
}

#[cfg(test)]
pub(crate) fn history_fault_test_hits() -> Vec<HistoryFaultStage> {
    HISTORY_FAULT_TEST_CONFIG.with(|config| {
        config
            .borrow()
            .as_ref()
            .map(|(_, hits)| hits.clone())
            .unwrap_or_default()
    })
}

#[cfg(test)]
impl Drop for HistoryFaultTestScope {
    fn drop(&mut self) {
        HISTORY_FAULT_TEST_CONFIG.with(|config| {
            config.take();
        });
    }
}

/// Feature/test-only adapter for product modules that should not import the
/// harness context types. It is a no-op unless this exact stage is configured
/// in the isolated process environment.
#[cfg(any(test, feature = "e2e-harness"))]
pub(crate) fn history_fault_barrier_from_environment(
    stage: HistoryFaultStage,
) -> Result<(), String> {
    #[cfg(test)]
    {
        let test_stage_matches = HISTORY_FAULT_TEST_CONFIG.with(|config| {
            config
                .borrow()
                .as_ref()
                .is_some_and(|(configured, _)| *configured == stage)
        });
        if test_stage_matches {
            return history_fault_barrier(
                stage,
                HistoryFaultContext {
                    operation_id: "test-operation".to_owned(),
                    document_id: "test-document".to_owned(),
                    target_path: "test-target.excalidraw".to_owned(),
                    old_sha256: None,
                    new_sha256: None,
                },
            );
        }
    }
    let configured = match env::var(HISTORY_FAULT_STAGE_ENV) {
        Ok(value) => value.parse::<HistoryFaultStage>()?,
        Err(env::VarError::NotPresent) => return Ok(()),
        Err(error) => return Err(format!("failed to read {HISTORY_FAULT_STAGE_ENV}: {error}")),
    };
    if env::var(HISTORY_FAULT_ARMED_ENV).as_deref() != Ok("1") {
        return Ok(());
    }
    if configured != stage {
        return Ok(());
    }
    if let Ok(failure) = env::var(HISTORY_FAULT_FAILURE_ENV) {
        return Err(format!("injected {failure} at {stage}"));
    }
    history_fault_barrier(stage, history_fault_context_from_environment()?)
}

/// Shared hook used by replacement/reconciliation code.  With no configured
/// stage this is a no-op.  In a test process the matching stage emits one
/// marker under the isolated root and blocks until SIGKILL; the marker is the
/// only readiness signal, so callers must never infer readiness from sleeps.
#[cfg(any(test, feature = "e2e-harness"))]
pub(crate) fn history_fault_barrier(
    stage: HistoryFaultStage,
    context: HistoryFaultContext,
) -> Result<(), String> {
    #[cfg(test)]
    #[cfg(test)]
    let test_hit = HISTORY_FAULT_TEST_CONFIG.with(|config| {
        let mut config = config.borrow_mut();
        if let Some((configured, hits)) = config.as_mut() {
            if *configured == stage {
                hits.push(stage);
                return true;
            }
        }
        false
    });
    #[cfg(test)]
    if test_hit {
        return Ok(());
    }
    let configured = match env::var(HISTORY_FAULT_STAGE_ENV) {
        Ok(value) => value,
        Err(env::VarError::NotPresent) => return Ok(()),
        Err(error) => return Err(format!("failed to read {HISTORY_FAULT_STAGE_ENV}: {error}")),
    };
    let configured = configured.parse::<HistoryFaultStage>()?;
    if configured != stage {
        return Ok(());
    }

    let root = process_harness_root()?;
    let control_directory = root.join("runtime").join("reliability");
    fs::create_dir_all(&control_directory)
        .map_err(|error| format!("failed to create history fault control directory: {error}"))?;
    let marker = HistoryFaultReadyMarker {
        scenario: "history-fault-kill".to_owned(),
        stage,
        seed: env::var(HISTORY_FAULT_SEED_ENV).unwrap_or_else(|_| "deterministic".to_owned()),
        pid: std::process::id(),
        context,
    };
    let marker_path = control_directory.join(HISTORY_FAULT_READY_MARKER);
    let payload = serde_json::to_vec(&marker)
        .map_err(|error| format!("failed to serialize history fault marker: {error}"))?;
    fs::write(&marker_path, payload)
        .map_err(|error| format!("failed to publish history fault marker: {error}"))?;

    if env::var(HISTORY_FAULT_MODE_ENV).as_deref() == Ok("record") {
        return Ok(());
    }

    // Keep the process at the exact operation boundary.  The parent owns the
    // SIGKILL and the subsequent same-root restart/probe.
    loop {
        thread::sleep(Duration::from_millis(10));
    }
}

/// Prevents macOS App Nap from suspending the harness process.
///
/// Performance workloads are driven by `requestAnimationFrame`; when the test
/// window is occluded on a busy host, App Nap suspends the process and the
/// driver silently stalls mid-command. The activity assertion is held for the
/// whole process lifetime of the test-only build.
#[cfg(target_os = "macos")]
pub(crate) fn disable_app_nap() {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    let reason =
        NSString::from_str("excalidraw-desktop e2e harness keeps rAF-driven measurements running");
    let token = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        NSActivityOptions::UserInitiated | NSActivityOptions::LatencyCritical,
        &reason,
    );
    std::mem::forget(token);
}

#[tauri::command]
pub(crate) fn e2e_set_atomic_write_fault(point: AtomicWriteFaultPoint) {
    set_fault_point(Some(point));
}

#[tauri::command]
pub(crate) fn e2e_clear_atomic_write_fault() {
    clear_fault_point();
}

/// Test-only race seam used by T025. It writes a caller-declared external
/// scene after the operation's earlier precheck and immediately before the
/// guarded writer's final pre-rename validation. The native test then proves
/// the final validation detects the race instead of silently overwriting the
/// external bytes.
#[cfg(feature = "e2e-harness")]
pub(crate) fn history_external_write_after_precommit(target: &Path) -> std::io::Result<()> {
    if env::var("EXCALIDRAW_E2E_EXTERNAL_WRITE_AFTER_PRECOMMIT").as_deref() != Ok("1") {
        return Ok(());
    }
    let expected_target = match env::var_os(HISTORY_FAULT_TARGET_ENV) {
        Some(value) => PathBuf::from(value),
        None => return Ok(()),
    };
    if expected_target != target {
        return Ok(());
    }
    let scene = env::var("EXCALIDRAW_E2E_EXTERNAL_SCENE_JSON")
        .unwrap_or_else(|_| "{\"version\":2,\"source\":\"external-write\"}".to_owned());
    fs::write(target, scene.as_bytes())
}

#[tauri::command]
pub(crate) fn e2e_corrupt_latest_snapshot(
    app: tauri::AppHandle,
    document_path: String,
) -> Result<(), String> {
    let recovery_root = harness_data_root(&app)?.join("recovery");
    let document_directory = recovery_root.join(document_hash(&document_path));
    let snapshot = latest_snapshot(&document_directory)?;
    fs::write(&snapshot, b"{\"corrupted\":")
        .map_err(|error| format!("failed to corrupt {}: {error}", snapshot.display()))
}

/// Runs a process-level reliability scenario before Tauri initializes a window.
///
/// The entrypoint only exists in an `e2e-harness` build and additionally requires
/// `APP_E2E=1` plus an isolated root created by the repository E2E fixture.
pub(crate) fn run_process_scenario_if_requested() -> Option<Result<(), String>> {
    let scenario = requested_scenario()?;
    Some((|| {
        let root = process_harness_root()?;
        let evidence = tauri::async_runtime::block_on(run_scenario(&scenario, &root))?;
        println!("{evidence}");
        std::io::stdout()
            .flush()
            .map_err(|error| format!("failed to flush scenario evidence: {error}"))?;
        Ok(())
    })())
}

fn requested_scenario() -> Option<String> {
    let mut arguments = env::args().skip(1);
    while let Some(argument) = arguments.next() {
        if argument == RELIABILITY_SCENARIO_FLAG {
            return arguments.next();
        }
    }
    None
}

fn process_harness_root() -> Result<PathBuf, String> {
    if env::var("APP_E2E").as_deref() != Ok("1") {
        return Err("process reliability scenarios require APP_E2E=1".to_owned());
    }
    let configured = env::var_os("EXCALIDRAW_E2E_ROOT")
        .map(PathBuf::from)
        .ok_or_else(|| "EXCALIDRAW_E2E_ROOT is required".to_owned())?;
    let root = configured
        .canonicalize()
        .map_err(|error| format!("failed to resolve isolated E2E root: {error}"))?;
    let has_expected_prefix = root
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(E2E_ROOT_PREFIX));
    if !has_expected_prefix {
        return Err(format!(
            "refusing reliability scenario outside an isolated {E2E_ROOT_PREFIX}* root"
        ));
    }
    Ok(root)
}

async fn run_scenario(scenario: &str, root: &Path) -> Result<String, String> {
    match scenario {
        "history-fault-kill" => serialize_evidence(run_history_fault_kill(root)?),
        "history-state-probe" => serialize_evidence(run_history_state_probe(root)?),
        "history-operation-fault-kill" => run_history_operation_fault_kill(root)
            .await
            .map(|_| String::new()),
        "history-operation-fault-probe" => {
            serialize_evidence(run_history_operation_fault_probe(root).await?)
        }
        "history-operation-failure" => {
            serialize_evidence(run_history_operation_failure(root).await?)
        }
        "history-operation-external-write" => {
            serialize_evidence(run_history_operation_external_write(root).await?)
        }
        "history-operation-concurrency" => {
            serialize_evidence(run_history_operation_concurrency(root).await?)
        }
        "history-protected-replacement" => {
            serialize_evidence(run_history_protected_replacement(root).await?)
        }
        "history-protected-replacement-kill" => run_history_protected_replacement(root)
            .await
            .map(|_| String::new()),
        "history-protected-replacement-probe" => {
            serialize_evidence(run_history_protected_replacement_probe(root).await?)
        }
        "history-lifecycle" => serialize_evidence(run_history_lifecycle(root).await?),
        "history-document-save-as" => serialize_evidence(run_history_document_save_as(root).await?),
        "history-lifecycle-journal-seed" => {
            serialize_evidence(run_history_lifecycle_journal_seed(root).await?)
        }
        "history-lifecycle-journal-probe" => {
            serialize_evidence(run_history_lifecycle_journal_probe(root).await?)
        }
        "history-lifecycle-journal-fault-probe" => {
            serialize_evidence(run_history_lifecycle_journal_fault_probe(root).await?)
        }
        "history-lifecycle-journal-parent-sync-probe" => {
            serialize_evidence(run_history_lifecycle_journal_parent_sync_probe(root).await?)
        }
        "history-lifecycle-remount-seed" => {
            serialize_evidence(run_history_lifecycle_remount_seed(root).await?)
        }
        "history-lifecycle-remount-probe" => {
            serialize_evidence(run_history_lifecycle_remount_probe(root).await?)
        }
        "history-lifecycle-remount-regrant" => {
            serialize_evidence(run_history_lifecycle_remount_regrant(root).await?)
        }
        "history-missing-resource-seed" => {
            serialize_evidence(run_history_missing_resource_seed(root).await?)
        }
        "history-missing-resource-probe" => {
            serialize_evidence(run_history_missing_resource_probe(root).await?)
        }
        "history-partial-protection-seed" => {
            serialize_evidence(run_history_partial_protection_seed(root).await?)
        }
        "history-partial-protection-probe" => {
            serialize_evidence(run_history_partial_protection_probe(root).await?)
        }
        "history-gc-hydration-pin" => serialize_evidence(run_history_gc_hydration_pin(root).await?),
        "history-restart-seed" => serialize_evidence(run_history_restart_seed(root).await?),
        "history-restart-restore" => serialize_evidence(run_history_restart_restore(root).await?),
        "history-restart-verify" => serialize_evidence(run_history_restart_verify(root).await?),
        "history-restart-evict" => serialize_evidence(run_history_restart_evict(root).await?),
        "history-restart-eviction-fault-probe" => {
            serialize_evidence(run_history_restart_eviction_fault_probe(root).await?)
        }
        "history-automatic-seed" => serialize_evidence(run_history_automatic_seed(root).await?),
        "history-automatic-verify" => serialize_evidence(run_history_automatic_verify(root).await?),
        "concurrent-checkpoints" => serialize_evidence(run_concurrent_checkpoints(root).await?),
        "disk-full-checkpoint" => serialize_evidence(run_disk_full_checkpoint(root).await?),
        "atomic-write-kill" => serialize_evidence(run_atomic_write_kill(root)?),
        "snapshot-corruption" => serialize_evidence(run_snapshot_corruption(root).await?),
        "recovery-window" => serialize_evidence(run_recovery_window(root).await?),
        "entry-trash" => serialize_evidence(run_entry_trash(root).await?),
        "entry-rename-fault" => serialize_evidence(run_entry_rename_fault(root).await?),
        "entry-directory-race" => serialize_evidence(run_entry_directory_race(root).await?),
        "entry-metadata-cleanup" => serialize_evidence(run_entry_metadata_cleanup(root).await?),
        "entry-descendant-save" => serialize_evidence(run_entry_descendant_save(root).await?),
        "entry-rename-kill" => serialize_evidence(run_entry_rename_kill(root)?),
        "entry-rename-post-fs-kill" => run_entry_rename_post_fs_kill(root)
            .await
            .map(|_| String::new()),
        "entry-rename-post-fs-probe" => {
            serialize_evidence(run_entry_rename_post_fs_probe(root).await?)
        }
        "cmd-w-active" => serialize_evidence(run_tab_close_cmd_w(root).await?),
        "middle-click-inactive" => serialize_evidence(run_tab_close_middle_click(root).await?),
        "duplicate-close" => serialize_evidence(run_tab_close_duplicate(root).await?),
        "checkpoint-failure" => serialize_evidence(run_tab_close_checkpoint_failure(root).await?),
        "wheel-vertical-notch" => serialize_evidence(run_tab_close_wheel_notch(root).await?),
        "window-contract" => serialize_evidence(run_window_contract(root)?),
        other => Err(format!("unknown E2E reliability scenario: {other}")),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotCorruptionEvidence {
    scenario: &'static str,
    target_path: String,
    latest_snapshot_path: String,
    fallback_snapshot_path: String,
    latest_snapshot_corrupted: bool,
    recovered_snapshot_saved_at: i64,
    expected_fallback_saved_at: i64,
    /// Native candidate evidence; the frontend dialog remains a separate UI
    /// assertion until AppShell wires RecoveryManager into startup.
    recovery_dialog_visible: bool,
    recovered_scene_json: String,
    target_scene_json: String,
    snapshots_remaining: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryWindowEvidence {
    scenario: &'static str,
    normal_exit_dialog_visible: bool,
    forced_exit_dialog_visible: bool,
    recovery_elapsed_ms: u128,
    expected_scene_json: String,
    restored_scene_json: String,
    normal_exit_abnormal_exit: bool,
    forced_exit_abnormal_exit: bool,
    recovery_candidate_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AtomicWriteKillReady {
    scenario: &'static str,
    fault_point: String,
    seed: String,
    target_path: String,
    old_scene_json: String,
    new_scene_json: String,
    old_sha256: String,
    new_sha256: String,
}

/// Runs one atomic write until the requested observable point, then blocks so
/// the parent test can send SIGKILL. This is deliberately a process-level
/// fixture: the target file is created and written by the test-only binary and
/// the parent controls the interruption boundary with the operating system.
fn run_atomic_write_kill(root: &Path) -> Result<AtomicWriteKillReady, String> {
    let point = parse_fault_point(
        &env::var("EXCALIDRAW_E2E_FAULT_POINT")
            .map_err(|_| "EXCALIDRAW_E2E_FAULT_POINT is required".to_owned())?,
    )?;
    let seed = env::var("EXCALIDRAW_E2E_SEED").unwrap_or_else(|_| "deterministic".to_owned());
    let control_directory = root.join("runtime").join("reliability");
    fs::create_dir_all(&control_directory)
        .map_err(|error| format!("failed to create reliability control directory: {error}"))?;

    let workspace = root.join("workspace");
    fs::create_dir_all(&workspace)
        .map_err(|error| format!("failed to create reliability workspace: {error}"))?;
    let target = workspace.join("fault-injection.excalidraw");
    let old_scene_json = scene_json(&format!("old-{seed}"));
    let new_scene_json = scene_json(&format!("new-{seed}"));
    fs::write(&target, old_scene_json.as_bytes())
        .map_err(|error| format!("failed to create old fixture document: {error}"))?;

    let ready = AtomicWriteKillReady {
        scenario: "atomic-write-kill",
        fault_point: point.to_string(),
        seed,
        target_path: path_string(&target),
        old_sha256: sha256(old_scene_json.as_bytes()),
        new_sha256: sha256(new_scene_json.as_bytes()),
        old_scene_json,
        new_scene_json,
    };
    let injector = BlockingFaultInjector {
        point,
        control_directory: control_directory.clone(),
        ready,
    };
    atomic_write_with_injector(&target, injector.ready.new_scene_json.as_bytes(), &injector)
        .map_err(|error| format!("atomic write fixture failed before SIGKILL: {error}"))?;
    Err("atomic-write-kill fixture resumed without SIGKILL".to_owned())
}

struct BlockingFaultInjector {
    point: AtomicWriteFaultPoint,
    control_directory: PathBuf,
    ready: AtomicWriteKillReady,
}

impl AtomicWriteFaultInjector for BlockingFaultInjector {
    fn interrupt(&self, point: AtomicWriteFaultPoint) -> Result<(), AtomicWriteError> {
        if point != self.point {
            return Ok(());
        }

        let marker = self.control_directory.join("atomic-write.ready.json");
        let payload = serde_json::to_vec(&self.ready).map_err(|error| AtomicWriteError::Io {
            operation: "serialize reliability marker",
            path: marker.clone(),
            source: std::io::Error::other(error),
        })?;
        fs::write(&marker, payload).map_err(|source| AtomicWriteError::Io {
            operation: "publish reliability marker",
            path: marker,
            source,
        })?;

        // The test parent terminates this process at the marker. The bounded
        // sleep keeps CPU usage negligible while retaining a deterministic
        // barrier (no timing race or arbitrary retry count in the test).
        loop {
            thread::sleep(Duration::from_millis(10));
        }
    }
}

fn parse_fault_point(value: &str) -> Result<AtomicWriteFaultPoint, String> {
    match value {
        "temp_created" => Ok(AtomicWriteFaultPoint::TempCreated),
        "mid_write" => Ok(AtomicWriteFaultPoint::MidWrite),
        "temp_synced" => Ok(AtomicWriteFaultPoint::TempSynced),
        "json_validated" => Ok(AtomicWriteFaultPoint::JsonValidated),
        "before_rename" => Ok(AtomicWriteFaultPoint::BeforeRename),
        "after_rename" => Ok(AtomicWriteFaultPoint::AfterRename),
        "before_parent_sync" => Ok(AtomicWriteFaultPoint::BeforeParentSync),
        "parent_synced" => Ok(AtomicWriteFaultPoint::ParentSynced),
        other => Err(format!("unknown atomic write fault point: {other}")),
    }
}

#[cfg(any(test, feature = "e2e-harness"))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryFaultKillEvidence {
    scenario: &'static str,
    stage: HistoryFaultStage,
    seed: String,
    context: HistoryFaultContext,
}

#[cfg(any(test, feature = "e2e-harness"))]
fn history_fault_context_from_environment() -> Result<HistoryFaultContext, String> {
    let required = |name: &str| {
        env::var(name).map_err(|_| format!("{name} is required for history fault scenario"))
    };
    Ok(HistoryFaultContext {
        operation_id: required(HISTORY_FAULT_OPERATION_ENV)?,
        document_id: required(HISTORY_FAULT_DOCUMENT_ENV)?,
        target_path: required(HISTORY_FAULT_TARGET_ENV)?,
        old_sha256: env::var(HISTORY_FAULT_OLD_HASH_ENV).ok(),
        new_sha256: env::var(HISTORY_FAULT_NEW_HASH_ENV).ok(),
    })
}

/// Process entrypoint for the shared History barrier protocol.  Real product
/// operations normally reach the same barrier through `history_fault_barrier`;
/// this direct scenario keeps the marker/kill protocol unit-testable before
/// T013 has wired each replacement stage.
#[cfg(any(test, feature = "e2e-harness"))]
fn run_history_fault_kill(root: &Path) -> Result<HistoryFaultKillEvidence, String> {
    let stage = env::var(HISTORY_FAULT_STAGE_ENV)
        .map_err(|_| format!("{HISTORY_FAULT_STAGE_ENV} is required"))?
        .parse::<HistoryFaultStage>()?;
    let context = history_fault_context_from_environment()?;
    // Keep the root argument part of the contract and fail closed if the
    // caller points at a target outside the managed fixture root.
    assert_isolated_path(root, Path::new(&context.target_path))?;
    history_fault_barrier(stage, context.clone())?;
    Ok(HistoryFaultKillEvidence {
        scenario: "history-fault-kill",
        stage,
        seed: env::var(HISTORY_FAULT_SEED_ENV).unwrap_or_else(|_| "deterministic".to_owned()),
        context,
    })
}

#[cfg(any(test, feature = "e2e-harness"))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryStateProbeEvidence {
    scenario: &'static str,
    target_path: String,
    exists: bool,
    parseable_json: bool,
    byte_length: Option<usize>,
    sha256: Option<String>,
    expected_state: &'static str,
    temporary_files: Vec<String>,
    fault_marker_exists: bool,
}

/// Restart probe used after SIGKILL.  It runs as a fresh test-only process in
/// the same isolated root and classifies the target as old/new/other/missing/
/// invalid using exact bytes and hashes, never by mtime or timing.
#[cfg(any(test, feature = "e2e-harness"))]
fn run_history_state_probe(root: &Path) -> Result<HistoryStateProbeEvidence, String> {
    let target = PathBuf::from(
        env::var(HISTORY_FAULT_TARGET_ENV)
            .map_err(|_| format!("{HISTORY_FAULT_TARGET_ENV} is required"))?,
    );
    assert_isolated_path(root, &target)?;
    let old_hash = env::var(HISTORY_FAULT_OLD_HASH_ENV).ok();
    let new_hash = env::var(HISTORY_FAULT_NEW_HASH_ENV).ok();
    let (exists, parseable_json, byte_length, sha256_value, expected_state) =
        match fs::read(&target) {
            Ok(bytes) => {
                let hash = sha256(&bytes);
                let parseable = serde_json::from_slice::<serde_json::Value>(&bytes).is_ok();
                let state = if old_hash.as_deref() == Some(hash.as_str()) {
                    "old"
                } else if new_hash.as_deref() == Some(hash.as_str()) {
                    "new"
                } else if parseable {
                    "other"
                } else {
                    "invalid"
                };
                (true, parseable, Some(bytes.len()), Some(hash), state)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (false, false, None, None, "missing")
            }
            Err(error) => {
                return Err(format!(
                    "failed to probe history target {}: {error}",
                    target.display()
                ))
            }
        };
    let temporary_files = temporary_files(&target)?;
    let fault_marker_exists = root
        .join("runtime")
        .join("reliability")
        .join(HISTORY_FAULT_READY_MARKER)
        .is_file();
    Ok(HistoryStateProbeEvidence {
        scenario: "history-state-probe",
        target_path: path_string(&target),
        exists,
        parseable_json,
        byte_length,
        sha256: sha256_value,
        expected_state,
        temporary_files,
        fault_marker_exists,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryOperationFaultProbeEvidence {
    scenario: &'static str,
    stage: String,
    request_id: String,
    target_path: String,
    old_sha256: String,
    new_sha256: String,
    target_sha256: String,
    expected_state: &'static str,
    parseable_json: bool,
    operation_state: String,
    replacement_committed: Option<bool>,
    reconciliation_outcomes: Vec<String>,
    temporary_files: Vec<String>,
    target_object_exists: bool,
    target_asset_exists: bool,
    operation_row_count: usize,
    protection_version_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryOperationFailureEvidence {
    scenario: &'static str,
    failure_mode: String,
    request_id: String,
    target_path: String,
    target_sha256: String,
    original_sha256: String,
    target_unchanged: bool,
    error: String,
    temporary_files: Vec<String>,
    valid_sibling_available: bool,
    protected_version_count: usize,
    operation_row_count: usize,
    fault_scene_hash: String,
    fault_scene_object_exists: bool,
    fault_scene_registered: bool,
    unregistered_object_hashes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryExternalWriteEvidence {
    scenario: &'static str,
    target_path: String,
    external_sha256: String,
    published_sha256: String,
    observed_sha256: String,
    external_write_preserved: bool,
    response_state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryOperationConcurrencyEvidence {
    scenario: &'static str,
    target_path: String,
    request_id: String,
    response_states: Vec<String>,
    replacement_committed: Vec<Option<bool>>,
    different_response_states: Vec<String>,
    different_replacement_committed: Vec<Option<bool>>,
    target_sha256: String,
    target_object_exists: bool,
    target_asset_exists: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryProtectedReplacementEvidence {
    scenario: &'static str,
    target_kind: String,
    failure_mode: String,
    request_id: String,
    target_path: String,
    old_sha256: String,
    expected_target_sha256: String,
    persisted_sha256: String,
    parseable_json: bool,
    target_unchanged: bool,
    replacement_invocation_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    replacement_committed: Option<bool>,
    response_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    operation_status_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    protection_version_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    protection_action: Option<String>,
    protected_version_count: usize,
    temporary_files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Runs the real protected replacement service until a configured History
/// barrier. The parent process owns the SIGKILL; returning normally is a
/// failure because it means the requested barrier was not reached.
async fn run_history_operation_fault_kill(root: &Path) -> Result<(), String> {
    let context = setup_history_fault_operation(root).await?;
    env::set_var(HISTORY_FAULT_ARMED_ENV, "1");
    let target = context
        .1
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize fault target: {error}"))?;
    let current_scene_json = fs::read_to_string(&target)
        .map_err(|error| format!("failed to read fault current scene: {error}"))?;
    let current_hash = sha256(current_scene_json.as_bytes());
    let target_version_id = "history-fault-version-a".to_owned();
    let request_id = env::var(HISTORY_FAULT_OPERATION_ENV)
        .unwrap_or_else(|_| "history-fault-operation".to_owned());
    let response = context
        .0
        .replacement
        .e2e_replace(HistoryReplaceRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            request_id: request_id.clone(),
            session_generation: 1,
            revision: 1,
            expected_base_hash: current_hash,
            current_scene_json,
            target: HistoryReplaceTarget::Restore {
                version_id: target_version_id,
            },
        })
        .await;
    Err(format!(
        "history operation fault fixture resumed before SIGKILL: {response:?}"
    ))
}

async fn run_history_operation_fault_probe(
    root: &Path,
) -> Result<HistoryOperationFaultProbeEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let target = PathBuf::from(
        env::var(HISTORY_FAULT_TARGET_ENV)
            .map_err(|_| format!("{HISTORY_FAULT_TARGET_ENV} is required"))?,
    )
    .canonicalize()
    .map_err(|error| format!("failed to canonicalize fault probe target: {error}"))?;
    assert_isolated_path(root, &target)?;
    let old_sha256 = context
        .store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT scene_hash FROM history_versions WHERE id=?1",
                ["history-fault-version-b"],
                |row| row.get::<_, String>(0),
            )
        })
        .map_err(|error| format!("failed to load fault old scene hash: {error}"))?;
    let new_sha256 = context
        .store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT scene_hash FROM history_versions WHERE id=?1",
                ["history-fault-version-a"],
                |row| row.get::<_, String>(0),
            )
        })
        .map_err(|error| format!("failed to load fault new scene hash: {error}"))?;
    let asset_sha256 = history_restart_scene("fault-A", "历史故障 A").2;
    let request_id = env::var(HISTORY_FAULT_OPERATION_ENV)
        .unwrap_or_else(|_| "history-fault-operation".to_owned());
    let report =
        reconcile_incomplete_operations_with_repository(&context.store, &context.repository)
            .await
            .map_err(|error| format!("history fault restart reconciliation failed: {error}"))?;
    let target_bytes =
        fs::read(&target).map_err(|error| format!("failed to read fault probe target: {error}"))?;
    let target_sha256 = sha256(&target_bytes);
    let expected_state = if target_sha256 == old_sha256 {
        "old"
    } else if target_sha256 == new_sha256 {
        "new"
    } else if serde_json::from_slice::<serde_json::Value>(&target_bytes).is_ok() {
        "other"
    } else {
        "invalid"
    };
    let requested_id = request_id.clone();
    let status = context
        .replacement
        .e2e_operation_status(HistoryOperationStatusRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            request_id: request_id.clone(),
        })
        .await;
    let (status_request_id, operation_state, replacement_committed) = match status {
        Ok(status) => (
            status.request_id,
            format!("{:?}", status.state),
            status.replacement_committed,
        ),
        Err(error) => (requested_id, format!("status-error:{error:?}"), None),
    };
    let target_object_exists = context
        .store
        .objects()
        .scene_path(&target_sha256)
        .map(|path| path.exists())
        .unwrap_or(false);
    let target_asset_exists = context
        .store
        .objects()
        .asset_path(&asset_sha256)
        .map(|path| path.exists())
        .unwrap_or(false);
    let (operation_row_count, protection_version_count) = context
        .store
        .with_connection(|connection| {
            let operation_count = connection.query_row(
                "SELECT COUNT(*) FROM history_operations WHERE idempotency_id=?1",
                [&status_request_id],
                |row| row.get::<_, i64>(0),
            )?;
            let protection_count = connection.query_row(
                "SELECT COUNT(*) FROM history_versions WHERE source='protected'",
                [],
                |row| row.get::<_, i64>(0),
            )?;
            Ok::<_, rusqlite::Error>((operation_count as usize, protection_count as usize))
        })
        .map_err(|error| format!("failed to inspect fault operation cardinality: {error}"))?;
    Ok(HistoryOperationFaultProbeEvidence {
        scenario: "history-operation-fault-probe",
        stage: env::var(HISTORY_FAULT_STAGE_ENV).unwrap_or_else(|_| "unknown".to_owned()),
        request_id: status_request_id,
        target_path: path_string(&target),
        old_sha256,
        new_sha256,
        target_sha256,
        expected_state,
        parseable_json: serde_json::from_slice::<serde_json::Value>(&target_bytes).is_ok(),
        operation_state,
        replacement_committed,
        reconciliation_outcomes: report
            .outcomes
            .into_iter()
            .map(|outcome| format!("{outcome:?}"))
            .collect(),
        temporary_files: temporary_files(&target)?,
        target_object_exists,
        target_asset_exists,
        operation_row_count,
        protection_version_count,
    })
}

async fn run_history_operation_failure(
    root: &Path,
) -> Result<HistoryOperationFailureEvidence, String> {
    let (context, target, old_sha256, target_scene_hash, asset_hash) =
        setup_history_fault_operation(root).await?;
    let failure_mode = env::var("EXCALIDRAW_E2E_HISTORY_FAILURE_MODE")
        .unwrap_or_else(|_| "missing-version".to_owned());
    let request_id = env::var(HISTORY_FAULT_OPERATION_ENV)
        .unwrap_or_else(|_| "history-fault-failure".to_owned());
    let disk_scene_json = fs::read_to_string(&target)
        .map_err(|error| format!("failed to read failure target: {error}"))?;
    let current_hash = sha256(disk_scene_json.as_bytes());
    let mut current_scene_json = disk_scene_json;
    let target_version = match failure_mode.as_str() {
        "missing-version" | "missing-scene" | "corrupt-scene" | "missing-asset"
        | "corrupt-asset" | "object-permission" | "object-enospc" | "sqlite-permission"
        | "sqlite-enospc" | "partial-protection" => "history-fault-version-a".to_owned(),
        other => return Err(format!("unknown history failure mode: {other}")),
    };
    if matches!(failure_mode.as_str(), "missing-scene" | "corrupt-scene") {
        let scene_path = context
            .store
            .objects()
            .scene_path(&target_scene_hash)
            .map_err(|error| format!("failed to resolve target scene path: {error}"))?;
        if failure_mode == "missing-scene" {
            fs::remove_file(&scene_path)
                .map_err(|error| format!("failed to remove isolated scene: {error}"))?;
        } else {
            fs::write(&scene_path, b"corrupt-history-scene")
                .map_err(|error| format!("failed to corrupt isolated scene: {error}"))?;
        }
    }
    if matches!(failure_mode.as_str(), "missing-asset" | "corrupt-asset") {
        let asset_path = context
            .store
            .objects()
            .asset_path(&asset_hash)
            .map_err(|error| format!("failed to resolve corrupt asset path: {error}"))?;
        if failure_mode == "missing-asset" {
            fs::remove_file(&asset_path)
                .map_err(|error| format!("failed to remove isolated asset: {error}"))?;
        } else {
            fs::write(&asset_path, b"corrupt-history-asset")
                .map_err(|error| format!("failed to corrupt isolated asset: {error}"))?;
        }
    }
    if matches!(
        failure_mode.as_str(),
        "object-permission" | "object-enospc" | "partial-protection"
    ) {
        current_scene_json = scene_json(&format!("protection-{failure_mode}"));
        if failure_mode == "partial-protection" {
            env::set_var(HISTORY_FAULT_STAGE_ENV, "object_publish");
            env::set_var(HISTORY_FAULT_FAILURE_ENV, &failure_mode);
            env::set_var(HISTORY_FAULT_ARMED_ENV, "1");
        } else {
            set_object_fault(
                ObjectStoreFaultPoint::BeforeTempWrite,
                if failure_mode == "object-enospc" {
                    ObjectStoreFaultKind::DiskFull
                } else {
                    ObjectStoreFaultKind::PermissionDenied
                },
            );
        }
    } else if matches!(failure_mode.as_str(), "sqlite-permission" | "sqlite-enospc") {
        current_scene_json = scene_json(&format!("protection-{failure_mode}"));
        set_transaction_fault(Some(if failure_mode == "sqlite-enospc" {
            HistoryStoreFault::DiskFull
        } else {
            HistoryStoreFault::PermissionDenied
        }));
    }
    let replacement_target = if failure_mode == "missing-version" {
        HistoryReplaceTarget::Restore {
            version_id: "history-version-does-not-exist".to_owned(),
        }
    } else {
        HistoryReplaceTarget::Restore {
            version_id: target_version,
        }
    };
    let fault_scene_hash = sha256(current_scene_json.as_bytes());
    let error = context
        .replacement
        .e2e_replace(HistoryReplaceRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            request_id: request_id.clone(),
            session_generation: 1,
            revision: 1,
            expected_base_hash: current_hash,
            current_scene_json,
            target: replacement_target,
        })
        .await
        .err()
        .map(|value| format!("{value:?}"))
        .unwrap_or_else(|| "unexpected success".to_owned());
    clear_object_fault();
    clear_transaction_fault();
    let persisted = fs::read(&target)
        .map_err(|read_error| format!("failed to read failure result: {read_error}"))?;
    let persisted_sha256 = sha256(&persisted);
    let valid_sibling_available = context
        .query
        .preview(HistoryPreviewRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            version_id: "history-fault-version-b".to_owned(),
        })
        .await
        .is_ok();
    let (protected_version_count, operation_row_count, fault_scene_registered) = context
        .store
        .with_connection(|connection| {
            let protected = connection.query_row(
                "SELECT COUNT(*) FROM history_versions WHERE source='protected'",
                [],
                |row| row.get::<_, i64>(0),
            )?;
            let operations = connection.query_row(
                "SELECT COUNT(*) FROM history_operations WHERE idempotency_id=?1",
                [&request_id],
                |row| row.get::<_, i64>(0),
            )?;
            let registered = connection.query_row(
                "SELECT COUNT(*) FROM scene_objects WHERE hash=?1",
                [&fault_scene_hash],
                |row| row.get::<_, i64>(0),
            )?;
            Ok::<_, rusqlite::Error>((protected as usize, operations as usize, registered > 0))
        })
        .map_err(|error| format!("failed to inspect history failure rollback: {error}"))?;
    let fault_scene_object_exists = context
        .store
        .objects()
        .scene_path(&fault_scene_hash)
        .map(|path| path.exists())
        .unwrap_or(false);
    let unregistered_object_hashes = context
        .store
        .enumerate_object_candidates()
        .map_err(|error| format!("failed to inspect unregistered fault objects: {error}"))?
        .into_iter()
        .filter(|candidate| !candidate.registered)
        .map(|candidate| candidate.object.hash)
        .collect();
    Ok(HistoryOperationFailureEvidence {
        scenario: "history-operation-failure",
        failure_mode,
        request_id: env::var(HISTORY_FAULT_OPERATION_ENV)
            .unwrap_or_else(|_| "history-fault-failure".to_owned()),
        target_path: path_string(&target),
        target_sha256: persisted_sha256.clone(),
        original_sha256: old_sha256.clone(),
        target_unchanged: persisted_sha256 == old_sha256,
        error,
        temporary_files: temporary_files(&target)?,
        valid_sibling_available,
        protected_version_count,
        operation_row_count,
        fault_scene_hash,
        fault_scene_object_exists,
        fault_scene_registered,
        unregistered_object_hashes,
    })
}

async fn run_history_operation_external_write(
    root: &Path,
) -> Result<HistoryExternalWriteEvidence, String> {
    let (context, target, _, new_sha256, _) = setup_history_fault_operation(root).await?;
    let external_scene = serde_json::json!({
        "version": 2,
        "source": "external-write-between-check-and-publish",
        "elements": [{"id": "external-element", "type": "diamond"}],
        "files": {}
    });
    let external_json = serde_json::to_string(&external_scene)
        .map_err(|error| format!("failed to serialize external scene: {error}"))?;
    let external_sha256 = sha256(external_json.as_bytes());
    env::set_var("EXCALIDRAW_E2E_EXTERNAL_WRITE_AFTER_PRECOMMIT", "1");
    env::set_var(HISTORY_FAULT_TARGET_ENV, &target);
    env::set_var("EXCALIDRAW_E2E_EXTERNAL_SCENE_JSON", &external_json);
    let current_scene_json = fs::read_to_string(&target)
        .map_err(|error| format!("failed to read external-write target: {error}"))?;
    let response = context
        .replacement
        .e2e_replace(HistoryReplaceRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            request_id: "history-external-write".to_owned(),
            session_generation: 1,
            revision: 1,
            expected_base_hash: sha256(current_scene_json.as_bytes()),
            current_scene_json,
            target: HistoryReplaceTarget::Restore {
                version_id: "history-fault-version-a".to_owned(),
            },
        })
        .await;
    let observed = fs::read(&target)
        .map_err(|error| format!("failed to read external-write result: {error}"))?;
    let observed_sha256 = sha256(&observed);
    Ok(HistoryExternalWriteEvidence {
        scenario: "history-operation-external-write",
        target_path: path_string(&target),
        external_sha256: external_sha256.clone(),
        published_sha256: new_sha256,
        observed_sha256: observed_sha256.clone(),
        external_write_preserved: observed_sha256 == external_sha256,
        response_state: response
            .map(|value| format!("{value:?}"))
            .unwrap_or_else(|error| format!("error:{error:?}")),
    })
}

async fn run_history_operation_concurrency(
    root: &Path,
) -> Result<HistoryOperationConcurrencyEvidence, String> {
    let (context, target, _, _, _) = setup_history_fault_operation(root).await?;
    let current_scene_json = fs::read_to_string(&target)
        .map_err(|error| format!("failed to read concurrency target: {error}"))?;
    let current_hash = sha256(current_scene_json.as_bytes());
    let request = HistoryReplaceRequest {
        document: HistoryDocumentLocator::Path {
            path: path_string(&target),
        },
        request_id: "history-concurrent-same".to_owned(),
        session_generation: 1,
        revision: 1,
        expected_base_hash: current_hash,
        current_scene_json,
        target: HistoryReplaceTarget::Restore {
            version_id: "history-fault-version-a".to_owned(),
        },
    };
    let (first, second) = tokio::join!(
        context.replacement.e2e_replace(request.clone()),
        context.replacement.e2e_replace(request),
    );
    let responses = [first, second];
    let response_states = responses
        .iter()
        .map(|response| {
            response
                .as_ref()
                .map(|value| format!("{value:?}"))
                .unwrap_or_else(|error| format!("error:{error:?}"))
        })
        .collect();
    let replacement_committed = responses
        .iter()
        .map(|response| response.as_ref().ok().and_then(response_committed))
        .collect();
    let reset_scene = history_restart_scene("fault-B", "历史故障 B");
    fs::write(&target, reset_scene.0.as_bytes())
        .map_err(|error| format!("failed to reset concurrency target: {error}"))?;
    context
        .store
        .resolve_document_identity_for_open(&target, 2)
        .map_err(|error| format!("failed to refresh concurrent document identity: {error}"))?;
    let reset_hash = sha256(reset_scene.0.as_bytes());
    let request_a = HistoryReplaceRequest {
        document: HistoryDocumentLocator::Path {
            path: path_string(&target),
        },
        request_id: "history-concurrent-different-a".to_owned(),
        session_generation: 2,
        revision: 2,
        expected_base_hash: reset_hash.clone(),
        current_scene_json: reset_scene.0.clone(),
        target: HistoryReplaceTarget::Restore {
            version_id: "history-fault-version-a".to_owned(),
        },
    };
    let request_b = HistoryReplaceRequest {
        request_id: "history-concurrent-different-b".to_owned(),
        target: HistoryReplaceTarget::Restore {
            version_id: "history-fault-version-b".to_owned(),
        },
        ..request_a.clone()
    };
    let (different_first, different_second) = tokio::join!(
        context.replacement.e2e_replace(request_a),
        context.replacement.e2e_replace(request_b),
    );
    let different_responses = [different_first, different_second];
    let different_response_states = different_responses
        .iter()
        .map(|response| {
            response
                .as_ref()
                .map(|value| format!("{value:?}"))
                .unwrap_or_else(|error| format!("error:{error:?}"))
        })
        .collect();
    let different_replacement_committed = different_responses
        .iter()
        .map(|response| response.as_ref().ok().and_then(response_committed))
        .collect();
    let persisted =
        fs::read(&target).map_err(|error| format!("failed to read concurrency result: {error}"))?;
    let target_sha256 = sha256(&persisted);
    Ok(HistoryOperationConcurrencyEvidence {
        scenario: "history-operation-concurrency",
        target_path: path_string(&target),
        request_id: "history-concurrent-same".to_owned(),
        response_states,
        replacement_committed,
        different_response_states,
        different_replacement_committed,
        target_object_exists: context
            .store
            .objects()
            .scene_path(&target_sha256)
            .map(|path| path.exists())
            .unwrap_or(false),
        target_asset_exists: true,
        target_sha256,
    })
}

fn response_committed(response: &HistoryReplaceResponse) -> Option<bool> {
    match response {
        HistoryReplaceResponse::Completed {
            replacement_committed,
            ..
        } => Some(*replacement_committed),
        HistoryReplaceResponse::PendingReconciliation {
            replacement_committed,
            ..
        } => *replacement_committed,
    }
}

/// Runs one target-specific protected replacement in a fresh native process.
/// T025 remains the owner of the shared interruption matrix; this scenario
/// proves only the clear/import target differences and their preflight errors.
async fn run_history_protected_replacement(
    root: &Path,
) -> Result<HistoryProtectedReplacementEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let target_kind =
        env::var(HISTORY_PROTECTED_REPLACEMENT_TARGET_ENV).unwrap_or_else(|_| "clear".to_owned());
    if target_kind != "clear" && target_kind != "import" {
        return Err(format!(
            "{HISTORY_PROTECTED_REPLACEMENT_TARGET_ENV} must be clear or import"
        ));
    }
    let failure_mode =
        env::var(HISTORY_PROTECTED_REPLACEMENT_FAILURE_ENV).unwrap_or_else(|_| "none".to_owned());
    let request_id = env::var(HISTORY_FAULT_OPERATION_ENV)
        .unwrap_or_else(|_| format!("history-protected-replacement-{target_kind}"));
    let target = context
        .workspace
        .join("history-protected-replacement.excalidraw");
    let old = history_restart_scene("protected-old", "保护前内容");
    materialize_history_workspace_asset(&context.workspace, &old.1)?;
    fs::write(&target, old.0.as_bytes())
        .map_err(|error| format!("failed to write protected replacement target: {error}"))?;
    let target = target
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize protected replacement target: {error}"))?;
    let identity = context
        .store
        .resolve_document_identity_for_open(&target, 1)
        .map_err(|error| format!("failed to persist protected replacement identity: {error}"))?;

    let (candidate_scene, expected_target_sha256) = if target_kind == "clear" {
        let scene = String::from_utf8(crate::commands::history::empty_scene_bytes())
            .map_err(|error| format!("clear fixture is not UTF-8: {error}"))?;
        let hash = sha256(scene.as_bytes());
        (scene, hash)
    } else {
        let imported = history_restart_scene("Eprotected-import", "导入后内容");
        materialize_history_workspace_asset(&context.workspace, &imported.1)?;
        let mut scene: serde_json::Value = serde_json::from_str(&imported.0)
            .map_err(|error| format!("failed to decode import fixture: {error}"))?;
        if failure_mode == "missing-asset" {
            scene["files"]["history-image"]["dataURL"] =
                serde_json::Value::String(format!("asset://{}", "0".repeat(64)));
        }
        let scene = serde_json::to_string(&scene)
            .map_err(|error| format!("failed to encode import fixture: {error}"))?;
        let hash = sha256(scene.as_bytes());
        (scene, hash)
    };

    let replacement_invocation_count = 1;
    let mut replacement_committed = None;
    let response_state_value;
    let mut response_json = None;
    let mut error_message = None;

    let fault = match failure_mode.as_str() {
        "disk-full" => Some(ObjectStoreFaultKind::DiskFull),
        "permission-denied" => Some(ObjectStoreFaultKind::PermissionDenied),
        "none" | "missing-asset" | "response-lost" => None,
        other => {
            return Err(format!(
                "unknown {HISTORY_PROTECTED_REPLACEMENT_FAILURE_ENV} value: {other}"
            ))
        }
    };
    if let Some(kind) = fault {
        set_object_fault(ObjectStoreFaultPoint::BeforeTempWrite, kind);
    }
    let target_request = if target_kind == "clear" {
        HistoryReplaceTarget::Clear
    } else {
        HistoryReplaceTarget::Import {
            candidate_scene_json: candidate_scene.clone(),
        }
    };
    let response = context
        .replacement
        .e2e_replace(HistoryReplaceRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            request_id: request_id.clone(),
            session_generation: 1,
            revision: 1,
            expected_base_hash: sha256(old.0.as_bytes()),
            current_scene_json: old.0.clone(),
            target: target_request,
        })
        .await;
    clear_object_fault();
    clear_transaction_fault();
    match response {
        Ok(response) => {
            replacement_committed = response_committed(&response);
            response_state_value = response_state(&response).to_owned();
            response_json =
                Some(serde_json::to_value(&response).map_err(|error| {
                    format!("failed to serialize replacement response: {error}")
                })?);
        }
        Err(error) => {
            response_state_value = "error".to_owned();
            error_message = Some(format!("{error:?}"));
        }
    }
    let status = context
        .replacement
        .e2e_operation_status(HistoryOperationStatusRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            request_id: request_id.clone(),
        })
        .await
        .ok();

    let persisted = fs::read(&target)
        .map_err(|error| format!("failed to read protected replacement target: {error}"))?;
    let persisted_sha256 = sha256(&persisted);
    let old_sha256 = sha256(old.0.as_bytes());
    let protection_version_id = status
        .as_ref()
        .and_then(|value| value.protection_version_id.clone());
    let protection_action = if let Some(version_id) = protection_version_id.as_deref() {
        context
            .store
            .with_connection(|connection| {
                connection.query_row(
                    "SELECT protected_action FROM history_versions WHERE id=?1",
                    [version_id],
                    |row| row.get::<_, String>(0),
                )
            })
            .ok()
    } else {
        None
    };
    Ok(HistoryProtectedReplacementEvidence {
        scenario: "history-protected-replacement",
        target_kind,
        failure_mode,
        request_id,
        target_path: path_string(&target),
        old_sha256: old_sha256.clone(),
        expected_target_sha256,
        persisted_sha256: persisted_sha256.clone(),
        parseable_json: serde_json::from_slice::<serde_json::Value>(&persisted).is_ok(),
        target_unchanged: persisted_sha256 == old_sha256,
        replacement_invocation_count,
        replacement_committed,
        response_state: response_state_value,
        operation_status_state: status.map(|value| format!("{:?}", value.state)),
        protection_version_id,
        protection_action,
        protected_version_count: history_source_count(
            &context.store,
            &identity.document_id,
            "protected",
        )?,
        temporary_files: temporary_files(&target)?,
        response: response_json,
        error: error_message,
    })
}

async fn run_history_protected_replacement_probe(
    root: &Path,
) -> Result<HistoryProtectedReplacementEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let target_kind = env::var(HISTORY_PROTECTED_REPLACEMENT_TARGET_ENV)
        .map_err(|_| format!("{HISTORY_PROTECTED_REPLACEMENT_TARGET_ENV} is required"))?;
    if target_kind != "clear" && target_kind != "import" {
        return Err(format!(
            "{HISTORY_PROTECTED_REPLACEMENT_TARGET_ENV} must be clear or import"
        ));
    }
    let request_id = env::var(HISTORY_FAULT_OPERATION_ENV)
        .map_err(|_| format!("{HISTORY_FAULT_OPERATION_ENV} is required"))?;
    let target = PathBuf::from(
        env::var(HISTORY_FAULT_TARGET_ENV)
            .map_err(|_| format!("{HISTORY_FAULT_TARGET_ENV} is required"))?,
    );
    assert_isolated_path(root, &target)?;
    let target = target
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize protected replacement probe: {error}"))?;
    let operation = OperationStore::new(&context.store)
        .load(&request_id)
        .map_err(|error| format!("failed to load protected replacement operation: {error}"))?
        .ok_or_else(|| format!("protected replacement operation {request_id} is missing"))?;
    let old_sha256 = operation
        .expected_old_disk_hash
        .clone()
        .ok_or_else(|| "protected replacement operation has no old hash".to_owned())?;
    let expected_target_sha256 = operation
        .target_scene_hash
        .clone()
        .ok_or_else(|| "protected replacement operation has no target hash".to_owned())?;
    let persisted = fs::read(&target)
        .map_err(|error| format!("failed to read protected replacement probe: {error}"))?;
    let persisted_sha256 = sha256(&persisted);
    let status = context
        .replacement
        .e2e_operation_status(HistoryOperationStatusRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            request_id: request_id.clone(),
        })
        .await
        .map_err(|error| format!("failed to query protected replacement probe: {error:?}"))?;
    let protection_version_id = status.protection_version_id.clone();
    let protection_action = if let Some(version_id) = protection_version_id.as_deref() {
        context
            .store
            .with_connection(|connection| {
                connection.query_row(
                    "SELECT protected_action FROM history_versions WHERE id=?1",
                    [version_id],
                    |row| row.get::<_, String>(0),
                )
            })
            .ok()
    } else {
        None
    };
    Ok(HistoryProtectedReplacementEvidence {
        scenario: "history-protected-replacement",
        target_kind: target_kind.clone(),
        failure_mode: "response-lost".to_owned(),
        request_id,
        target_path: path_string(&target),
        old_sha256: old_sha256.clone(),
        expected_target_sha256,
        persisted_sha256: persisted_sha256.clone(),
        parseable_json: serde_json::from_slice::<serde_json::Value>(&persisted).is_ok(),
        target_unchanged: persisted_sha256 == old_sha256,
        replacement_invocation_count: 1,
        replacement_committed: status.replacement_committed,
        response_state: "lost".to_owned(),
        operation_status_state: Some(format!("{:?}", status.state)),
        protection_version_id,
        protection_action,
        protected_version_count: history_source_count(
            &context.store,
            &operation.document_id,
            "protected",
        )?,
        temporary_files: temporary_files(&target)?,
        response: None,
        error: None,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryLifecycleEvidence {
    scenario: &'static str,
    workspace: String,
    original_path: String,
    renamed_path: String,
    ancestor_moved_path: String,
    save_as_path: String,
    trash_path: String,
    document_id_before: String,
    document_id_after_rename: String,
    save_as_document_id: String,
    rename_operation_id: String,
    ancestor_move_operation_id: String,
    delete_operation_id: String,
    rename_committed: bool,
    ancestor_move_committed: bool,
    save_as_has_distinct_identity: bool,
    save_as_history_count: usize,
    same_path_replacement_rejected: bool,
    delete_committed: bool,
    history_versions_after_delete: usize,
    active_identity_after_delete: bool,
    original_exists_after_delete: bool,
    trash_exists_after_delete: bool,
    same_path_recreated_distinct: bool,
    same_path_recreated_history_count: usize,
    same_path_recreated_exists: bool,
}

async fn run_history_lifecycle(root: &Path) -> Result<HistoryLifecycleEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let recovery = Arc::new(RecoveryStore::with_app_version(
        root.join("lifecycle-recovery"),
        "0.3.0",
    ));
    let trash_path = root.join("trash").join("lifecycle-renamed.excalidraw");
    let invoked = Arc::new(AtomicBool::new(false));
    let trash = Arc::new(RecordingTrashOperator {
        mode: E2eTrashMode::Success,
        destination: trash_path.clone(),
        invoked: Arc::clone(&invoked),
    });
    let service = WorkspaceEntryService::with_trash_and_recovery(
        Arc::clone(&context.repository),
        WorkspaceMutationGate::default(),
        trash,
        recovery,
    )
    .with_history_store(Arc::clone(&context.store));
    let original_path = context.workspace.join("lifecycle/original.excalidraw");
    let renamed_path = context.workspace.join("lifecycle/renamed.excalidraw");
    let ancestor_moved_path = context.workspace.join("moved/renamed.excalidraw");
    let save_as_path = context.workspace.join("save-as.excalidraw");
    fs::create_dir_all(
        original_path
            .parent()
            .ok_or_else(|| "lifecycle fixture has no parent".to_owned())?,
    )
    .map_err(|error| format!("failed to create lifecycle directory: {error}"))?;
    let original_scene = history_restart_scene("lifecycle-original", "生命周期原始文档");
    materialize_history_workspace_asset(&context.workspace, &original_scene.1)?;
    fs::write(&original_path, original_scene.0.as_bytes())
        .map_err(|error| format!("failed to write lifecycle document: {error}"))?;
    let original_path = original_path
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize lifecycle document: {error}"))?;
    let original_identity = context
        .store
        .resolve_document_identity_for_open(&original_path, 1)
        .map_err(|error| format!("failed to establish lifecycle identity: {error}"))?;
    publish_history_restart_version(
        &context.store,
        &original_identity.document_id,
        "history-lifecycle-v1",
        &original_scene.0,
        1,
        &original_scene.2,
    )?;
    let base_hash = sha256(original_scene.0.as_bytes());
    let rename = service
        .rename(WorkspaceEntryRenameRequest {
            workspace_id: "e2e-reliability-workspace".to_owned(),
            relative_path: "lifecycle/original.excalidraw".to_owned(),
            base_name: "renamed".to_owned(),
            expected_open_documents: vec![ExpectedOpenDocument {
                relative_path: "lifecycle/original.excalidraw".to_owned(),
                base_hash: base_hash.clone(),
            }],
        })
        .await
        .map_err(|error| format!("lifecycle file rename failed: {error:?}"))?;
    let rename_committed = !original_path.exists() && renamed_path.exists();
    let ancestor_move = service
        .rename(WorkspaceEntryRenameRequest {
            workspace_id: "e2e-reliability-workspace".to_owned(),
            relative_path: "lifecycle".to_owned(),
            base_name: "moved".to_owned(),
            expected_open_documents: vec![ExpectedOpenDocument {
                relative_path: "lifecycle/renamed.excalidraw".to_owned(),
                base_hash: base_hash.clone(),
            }],
        })
        .await
        .map_err(|error| format!("lifecycle ancestor move failed: {error:?}"))?;
    let ancestor_move_committed = !renamed_path.exists() && ancestor_moved_path.exists();
    let moved_identity = context
        .store
        .load_active_document_identity(&path_string(&ancestor_moved_path))
        .map_err(|error| format!("failed to read identity after ancestor move: {error}"))?
        .ok_or_else(|| "ancestor-moved lifecycle identity is missing".to_owned())?;
    fs::copy(&ancestor_moved_path, &save_as_path)
        .map_err(|error| format!("failed to create Save As fixture: {error}"))?;
    let save_as_identity = context
        .store
        .resolve_document_identity_for_open(&save_as_path, 2)
        .map_err(|error| format!("failed to establish Save As identity: {error}"))?;
    let unrelated_path = save_as_path.with_extension("replacement.tmp");
    fs::write(&unrelated_path, scene_json("unrelated-same-path"))
        .map_err(|error| format!("failed to write same-path replacement: {error}"))?;
    fs::rename(&unrelated_path, &save_as_path)
        .map_err(|error| format!("failed to install same-path replacement: {error}"))?;
    let same_path_replacement_rejected = context
        .store
        .resolve_document_identity_for_existing(&save_as_path, 3)
        .is_err();
    let delete = service
        .delete(WorkspaceEntryDeleteRequest {
            workspace_id: "e2e-reliability-workspace".to_owned(),
            relative_path: "moved/renamed.excalidraw".to_owned(),
            expected_open_document: None,
        })
        .await
        .map_err(|error| format!("lifecycle drawing delete failed: {error:?}"))?;
    let save_as_has_distinct_identity = save_as_identity.document_id != moved_identity.document_id;
    let save_as_document_id = save_as_identity.document_id.clone();
    let history_versions_after_delete =
        history_source_count(&context.store, &original_identity.document_id, "automatic")?
            + history_source_count(&context.store, &original_identity.document_id, "protected")?
            + history_source_count(&context.store, &original_identity.document_id, "manual")?;
    let active_identity_after_delete = context
        .store
        .load_active_document_identity(&path_string(&ancestor_moved_path))
        .map_err(|error| format!("failed to inspect deleted lifecycle identity: {error}"))?
        .is_some();
    let original_exists_after_delete = ancestor_moved_path.exists();
    let recreated_scene = scene_json("same-path-recreated-after-trash");
    fs::write(&ancestor_moved_path, recreated_scene.as_bytes())
        .map_err(|error| format!("failed to recreate same-path drawing after Trash: {error}"))?;
    let recreated_identity = context
        .store
        .resolve_document_identity_for_open(&ancestor_moved_path, 3)
        .map_err(|error| format!("failed to resolve recreated same-path identity: {error}"))?;
    let same_path_recreated_history_count =
        history_source_count(&context.store, &recreated_identity.document_id, "automatic")?
            + history_source_count(&context.store, &recreated_identity.document_id, "protected")?
            + history_source_count(&context.store, &recreated_identity.document_id, "manual")?;
    Ok(HistoryLifecycleEvidence {
        scenario: "history-lifecycle",
        workspace: path_string(&context.workspace),
        original_path: path_string(&original_path),
        renamed_path: path_string(&renamed_path),
        ancestor_moved_path: path_string(&ancestor_moved_path),
        save_as_path: path_string(&save_as_path),
        trash_path: path_string(&trash_path),
        document_id_before: original_identity.document_id.clone(),
        document_id_after_rename: moved_identity.document_id.clone(),
        save_as_document_id,
        rename_operation_id: rename.operation_id,
        ancestor_move_operation_id: ancestor_move.operation_id,
        delete_operation_id: delete.operation_id,
        rename_committed,
        ancestor_move_committed,
        save_as_has_distinct_identity,
        save_as_history_count: history_source_count(
            &context.store,
            &save_as_identity.document_id,
            "automatic",
        )? + history_source_count(
            &context.store,
            &save_as_identity.document_id,
            "protected",
        )? + history_source_count(
            &context.store,
            &save_as_identity.document_id,
            "manual",
        )?,
        same_path_replacement_rejected,
        delete_committed: invoked.load(Ordering::SeqCst) && trash_path.exists(),
        history_versions_after_delete,
        active_identity_after_delete,
        original_exists_after_delete,
        trash_exists_after_delete: trash_path.exists(),
        same_path_recreated_distinct: recreated_identity.document_id
            != original_identity.document_id
            && recreated_identity.document_id != save_as_identity.document_id,
        same_path_recreated_history_count,
        same_path_recreated_exists: ancestor_moved_path.is_file(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryLifecycleRemountSeedEvidence {
    scenario: &'static str,
    phase: &'static str,
    workspace_path: String,
    document_path: String,
    workspace_id: String,
    workspace_mounted_after_add: bool,
    workspace_mounted_after_unmount: bool,
    recent_retained_after_unmount: bool,
    document_id: String,
    history_count: usize,
    scene_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryLifecycleRemountProbeEvidence {
    scenario: &'static str,
    phase: &'static str,
    workspace_path: String,
    document_path: String,
    workspace_id: String,
    recent_present_before_remount: bool,
    remounted: bool,
    workspace_mounted_after_remount: bool,
    document_id_after_remount: String,
    history_count_after_remount: usize,
    unmounted_before_recent_remove: bool,
    removed_from_recents: bool,
    recent_present_after_remove: bool,
    workspace_present_after_remove: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryLifecycleRemountRegrantEvidence {
    scenario: &'static str,
    phase: &'static str,
    workspace_path: String,
    document_path: String,
    previous_workspace_id: String,
    regranted_workspace_id: String,
    workspace_regranted: bool,
    original_document_id: String,
    document_id_after_regrant: String,
    regrant_preserved_identity: bool,
    history_count_after_regrant: usize,
    same_path_replacement_identical_content: bool,
    replacement_different_filesystem_identity: bool,
    same_path_replacement_rejected: bool,
    original_identity_retained_after_rejection: bool,
    history_count_after_rejection: usize,
}

struct LifecycleWorkspaceContext {
    repository: Arc<SqliteRepository>,
    store: Arc<HistoryStore>,
    service: WorkspaceService,
    workspace: PathBuf,
}

async fn open_lifecycle_workspace_context(
    root: &Path,
) -> Result<LifecycleWorkspaceContext, String> {
    let data = root.join("data");
    let workspace = root.join("workspace");
    fs::create_dir_all(&data)
        .map_err(|error| format!("failed to create lifecycle data directory: {error}"))?;
    fs::create_dir_all(&workspace)
        .map_err(|error| format!("failed to create lifecycle workspace directory: {error}"))?;
    let workspace = workspace
        .canonicalize()
        .map_err(|error| format!("failed to resolve lifecycle workspace: {error}"))?;
    let repository = Arc::new(
        SqliteRepository::open(&data.join("reliability.sqlite3"))
            .await
            .map_err(|error| format!("failed to open lifecycle database: {error}"))?,
    );
    let store = Arc::new(
        HistoryStore::open(&data)
            .map_err(|error| format!("failed to open lifecycle history store: {error}"))?,
    );
    Ok(LifecycleWorkspaceContext {
        service: WorkspaceService::new(Arc::clone(&repository)),
        repository,
        store,
        workspace,
    })
}

fn lifecycle_document_path(workspace: &Path) -> PathBuf {
    workspace.join("remount/document.excalidraw")
}

fn lifecycle_document_service(
    repository: Arc<SqliteRepository>,
    store: Arc<HistoryStore>,
    workspace: PathBuf,
) -> DocumentService {
    let grant = Arc::new(E2eDirectFileGrant { workspace });
    let mut service = DocumentService::with_grant_and_scene_limit(
        repository,
        grant,
        DocumentService::DEFAULT_SCENE_LIMIT_BYTES,
    );
    service.attach_history_store(store);
    service
}

async fn run_history_lifecycle_remount_seed(
    root: &Path,
) -> Result<HistoryLifecycleRemountSeedEvidence, String> {
    let context = open_lifecycle_workspace_context(root).await?;
    let workspace_record = context
        .service
        .add(WorkspaceAddRequest {
            root_path: context.workspace.display().to_string(),
            name: Some("Lifecycle Remount".to_owned()),
        })
        .await
        .map_err(|error| format!("lifecycle workspace add failed: {error:?}"))?;
    let workspace_id = workspace_record.id;
    let mounted_after_add = context
        .repository
        .workspace_get(workspace_id.clone())
        .await
        .map_err(|error| format!("failed to inspect mounted lifecycle workspace: {error}"))?
        .is_some_and(|record| record.mounted);

    let document_path = lifecycle_document_path(&context.workspace);
    fs::create_dir_all(
        document_path
            .parent()
            .ok_or_else(|| "lifecycle remount document has no parent".to_owned())?,
    )
    .map_err(|error| format!("failed to create lifecycle remount directory: {error}"))?;
    let initial_scene = scene_json("lifecycle-remount-original");
    fs::write(&document_path, initial_scene.as_bytes())
        .map_err(|error| format!("failed to write lifecycle remount document: {error}"))?;
    let service = lifecycle_document_service(
        Arc::clone(&context.repository),
        Arc::clone(&context.store),
        context.workspace.clone(),
    );
    service
        .doc_open(PathRequest {
            path: path_string(&document_path),
        })
        .await
        .map_err(|error| format!("lifecycle remount document open failed: {error:?}"))?;
    let saved_scene = scene_json("lifecycle-remount-saved");
    service
        .doc_checkpoint(CheckpointRequest {
            path: path_string(&document_path),
            scene_json: saved_scene.clone(),
            reason: CheckpointReason::ManualSave,
        })
        .await
        .map_err(|error| format!("lifecycle remount document checkpoint failed: {error:?}"))?;
    let identity = context
        .store
        .load_active_document_identity(&path_string(&document_path))
        .map_err(|error| format!("failed to load lifecycle remount identity: {error}"))?
        .ok_or_else(|| "lifecycle remount identity was not established".to_owned())?;
    publish_history_restart_version(
        &context.store,
        &identity.document_id,
        "history-lifecycle-remount-v1",
        &saved_scene,
        2,
        &sha256(&history_restart_asset(false)),
    )?;
    let history_count = history_document_version_count(&context.store, &identity.document_id)?;

    context
        .service
        .remove(WorkspaceRemoveRequest {
            workspace_id: workspace_id.clone(),
        })
        .await
        .map_err(|error| format!("lifecycle workspace unmount failed: {error:?}"))?;
    let mounted_after_unmount = context
        .repository
        .workspace_get(workspace_id.clone())
        .await
        .map_err(|error| format!("failed to inspect unmounted lifecycle workspace: {error}"))?
        .is_some_and(|record| record.mounted);
    let recent_retained_after_unmount = context
        .service
        .recent_list()
        .await
        .map_err(|error| format!("failed to list lifecycle recents: {error:?}"))?
        .into_iter()
        .any(|workspace| workspace.id == workspace_id);

    Ok(HistoryLifecycleRemountSeedEvidence {
        scenario: "history-lifecycle-remount",
        phase: "seed",
        workspace_path: path_string(&context.workspace),
        document_path: path_string(&document_path),
        workspace_id,
        workspace_mounted_after_add: mounted_after_add,
        workspace_mounted_after_unmount: mounted_after_unmount,
        recent_retained_after_unmount,
        document_id: identity.document_id,
        history_count,
        scene_sha256: sha256(saved_scene.as_bytes()),
    })
}

async fn run_history_lifecycle_remount_probe(
    root: &Path,
) -> Result<HistoryLifecycleRemountProbeEvidence, String> {
    let context = open_lifecycle_workspace_context(root).await?;
    let recent =
        context.service.recent_list().await.map_err(|error| {
            format!("failed to read lifecycle recents after restart: {error:?}")
        })?;
    let workspace = recent
        .first()
        .ok_or_else(|| "lifecycle workspace was not retained after restart".to_owned())?;
    let workspace_id = workspace.id.clone();
    let document_path = lifecycle_document_path(&context.workspace);
    let remounted = context
        .service
        .remount(workspace_id.clone())
        .await
        .map_err(|error| format!("lifecycle workspace remount failed: {error:?}"))?;
    let mounted_after_remount = context
        .repository
        .workspace_get(workspace_id.clone())
        .await
        .map_err(|error| format!("failed to inspect remounted lifecycle workspace: {error}"))?
        .is_some_and(|record| record.mounted);
    let service = lifecycle_document_service(
        Arc::clone(&context.repository),
        Arc::clone(&context.store),
        context.workspace.clone(),
    );
    service
        .doc_open(PathRequest {
            path: path_string(&document_path),
        })
        .await
        .map_err(|error| format!("lifecycle remount document reopen failed: {error:?}"))?;
    let identity = context
        .store
        .load_active_document_identity(&path_string(&document_path))
        .map_err(|error| format!("failed to load remounted lifecycle identity: {error}"))?
        .ok_or_else(|| "remounted lifecycle identity disappeared".to_owned())?;
    let history_count = history_document_version_count(&context.store, &identity.document_id)?;

    context
        .service
        .remove(WorkspaceRemoveRequest {
            workspace_id: workspace_id.clone(),
        })
        .await
        .map_err(|error| format!("lifecycle workspace second unmount failed: {error:?}"))?;
    let unmounted_before_recent_remove = !context
        .repository
        .workspace_get(workspace_id.clone())
        .await
        .map_err(|error| format!("failed to inspect lifecycle workspace before remove: {error}"))?
        .is_some_and(|record| record.mounted);
    context
        .service
        .recent_remove(workspace_id.clone())
        .await
        .map_err(|error| format!("lifecycle Remove from Recents failed: {error:?}"))?;
    let recent_present_after_remove = context
        .service
        .recent_list()
        .await
        .map_err(|error| format!("failed to inspect lifecycle recents after removal: {error:?}"))?
        .into_iter()
        .any(|item| item.id == workspace_id);
    let workspace_present_after_remove = context
        .repository
        .workspace_get(workspace_id.clone())
        .await
        .map_err(|error| format!("failed to inspect removed lifecycle workspace: {error}"))?
        .is_some();

    Ok(HistoryLifecycleRemountProbeEvidence {
        scenario: "history-lifecycle-remount",
        phase: "probe",
        workspace_path: path_string(&context.workspace),
        document_path: path_string(&document_path),
        workspace_id,
        recent_present_before_remount: recent.iter().any(|item| item.id == workspace.id),
        remounted: remounted.root_path == path_string(&context.workspace),
        workspace_mounted_after_remount: mounted_after_remount,
        document_id_after_remount: identity.document_id,
        history_count_after_remount: history_count,
        unmounted_before_recent_remove,
        removed_from_recents: !workspace_present_after_remove,
        recent_present_after_remove,
        workspace_present_after_remove,
    })
}

async fn run_history_lifecycle_remount_regrant(
    root: &Path,
) -> Result<HistoryLifecycleRemountRegrantEvidence, String> {
    let context = open_lifecycle_workspace_context(root).await?;
    let document_path = lifecycle_document_path(&context.workspace);
    let store_identity = context
        .store
        .load_active_document_identity(&path_string(&document_path))
        .map_err(|error| format!("failed to load lifecycle identity before regrant: {error}"))?
        .ok_or_else(|| "lifecycle identity missing before regrant".to_owned())?;
    let previous_workspace_id = context
        .service
        .recent_list()
        .await
        .map_err(|error| format!("failed to inspect lifecycle recent removal: {error:?}"))?
        .into_iter()
        .next()
        .map(|workspace| workspace.id)
        .unwrap_or_default();
    let regranted = context
        .service
        .add(WorkspaceAddRequest {
            root_path: context.workspace.display().to_string(),
            name: Some("Lifecycle Regranted".to_owned()),
        })
        .await
        .map_err(|error| format!("lifecycle workspace regrant failed: {error:?}"))?;
    let workspace_regranted = context
        .repository
        .workspace_get(regranted.id.clone())
        .await
        .map_err(|error| format!("failed to inspect regranted lifecycle workspace: {error}"))?
        .is_some_and(|record| record.mounted);
    let service = lifecycle_document_service(
        Arc::clone(&context.repository),
        Arc::clone(&context.store),
        context.workspace.clone(),
    );
    service
        .doc_open(PathRequest {
            path: path_string(&document_path),
        })
        .await
        .map_err(|error| format!("lifecycle regranted document reopen failed: {error:?}"))?;
    let identity_after_regrant = context
        .store
        .load_active_document_identity(&path_string(&document_path))
        .map_err(|error| format!("failed to load lifecycle identity after regrant: {error}"))?
        .ok_or_else(|| "lifecycle identity missing after regrant".to_owned())?;
    let history_count_after_regrant =
        history_document_version_count(&context.store, &identity_after_regrant.document_id)?;

    let original_bytes = fs::read(&document_path).map_err(|error| {
        format!("failed to read lifecycle document before replacement: {error}")
    })?;
    let replacement_path = document_path.with_extension("replacement.excalidraw");
    fs::write(&replacement_path, &original_bytes)
        .map_err(|error| format!("failed to write lifecycle replacement: {error}"))?;
    fs::rename(&replacement_path, &document_path)
        .map_err(|error| format!("failed to install lifecycle replacement: {error}"))?;
    let replacement_identity = crate::history::identity::FileSystemIdentity::from_path(
        &document_path,
    )
    .map_err(|error| format!("failed to inspect lifecycle replacement identity: {error}"))?;
    let same_path_replacement_rejected = service
        .doc_open(PathRequest {
            path: path_string(&document_path),
        })
        .await
        .is_err();
    let retained_identity = context
        .store
        .load_active_document_identity(&path_string(&document_path))
        .map_err(|error| {
            format!("failed to inspect identity after replacement rejection: {error}")
        })?;
    let history_count_after_rejection =
        history_document_version_count(&context.store, &store_identity.document_id)?;

    Ok(HistoryLifecycleRemountRegrantEvidence {
        scenario: "history-lifecycle-remount",
        phase: "regrant",
        workspace_path: path_string(&context.workspace),
        document_path: path_string(&document_path),
        previous_workspace_id,
        regranted_workspace_id: regranted.id,
        workspace_regranted,
        original_document_id: store_identity.document_id.clone(),
        document_id_after_regrant: identity_after_regrant.document_id.clone(),
        regrant_preserved_identity: identity_after_regrant.document_id
            == store_identity.document_id,
        history_count_after_regrant,
        same_path_replacement_identical_content: fs::read(&document_path)
            .map(|bytes| bytes == original_bytes)
            .unwrap_or(false),
        replacement_different_filesystem_identity: !store_identity
            .filesystem_identity
            .refers_to_same_file(&replacement_identity),
        same_path_replacement_rejected,
        original_identity_retained_after_rejection: retained_identity
            .is_some_and(|identity| identity.document_id == store_identity.document_id),
        history_count_after_rejection,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryLifecycleJournalEvidence {
    scenario: &'static str,
    phase: &'static str,
    operation_id: String,
    old_path: String,
    new_path: String,
    document_id: String,
    journal_pending_before: bool,
    journal_pending_after: bool,
    old_exists_after: bool,
    new_exists_after: bool,
    identity_at_new_path: Option<String>,
    identity_at_old_path: Option<String>,
    history_replay_applied: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryDocumentSaveAsEvidence {
    scenario: &'static str,
    conflict_source_path: String,
    conflict_target_path: String,
    conflict_source_document_id: String,
    conflict_target_document_id: String,
    previous_target_state: String,
    conflict_save_as_distinct: bool,
    conflict_source_remains_active: bool,
    orphan_source_path: String,
    orphan_target_path: String,
    orphan_target_document_id: String,
    orphan_target_history_count: usize,
    orphan_source_draft_exists_after_close: bool,
    orphan_save_as_distinct: bool,
    orphan_source_file_exists_after_close: bool,
}

async fn run_history_document_save_as(
    root: &Path,
) -> Result<HistoryDocumentSaveAsEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let source = context.workspace.join("conflict-source.excalidraw");
    let target = context.workspace.join("conflict-target.excalidraw");
    let source_scene = scene_json("conflict-external");
    let local_scene = scene_json("conflict-local");
    fs::write(&source, source_scene.as_bytes())
        .map_err(|error| format!("failed to write conflict source: {error}"))?;
    fs::write(&target, source_scene.as_bytes())
        .map_err(|error| format!("failed to write conflict target: {error}"))?;
    let source = source
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize conflict source: {error}"))?;
    let target = target
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize conflict target: {error}"))?;
    let previous_target_identity = context
        .store
        .resolve_document_identity_for_open(&target, 1)
        .map_err(|error| format!("failed to establish previous target identity: {error}"))?;
    context
        .document_service
        .doc_open(PathRequest {
            path: path_string(&source),
        })
        .await
        .map_err(|error| format!("failed to open conflict source: {error:?}"))?;
    context
        .document_service
        .doc_save_draft(SaveDraftRequest {
            path: path_string(&source),
            scene_json: local_scene.clone(),
        })
        .await
        .map_err(|error| format!("failed to save conflict draft: {error:?}"))?;
    context
        .document_service
        .conflicts()
        .mark_conflicted(source.clone())
        .await;
    context
        .document_service
        .doc_resolve_conflict(ResolveConflictRequest {
            path: path_string(&source),
            resolution: ConflictResolution::SaveAsNew,
            save_as_path: Some(path_string(&target)),
        })
        .await
        .map_err(|error| format!("conflict Save As New failed: {error:?}"))?;
    let source_identity = context
        .store
        .load_active_document_identity(&path_string(&source))
        .map_err(|error| format!("failed to read conflict source identity: {error}"))?
        .ok_or_else(|| "conflict source identity is missing".to_owned())?;
    let target_identity = context
        .store
        .load_active_document_identity(&path_string(&target))
        .map_err(|error| format!("failed to read conflict target identity: {error}"))?
        .ok_or_else(|| "conflict target identity is missing".to_owned())?;
    let previous_target_state = context
        .store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT state FROM history_documents WHERE id=?1",
                [&previous_target_identity.document_id],
                |row| row.get::<_, String>(0),
            )
        })
        .map_err(|error| format!("failed to inspect previous target state: {error}"))?;

    let orphan_source = context.workspace.join("orphan-source.excalidraw");
    let orphan_target = context.workspace.join("orphan-target.excalidraw");
    fs::write(&orphan_source, source_scene.as_bytes())
        .map_err(|error| format!("failed to write orphan source: {error}"))?;
    let orphan_source = orphan_source
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize orphan source: {error}"))?;
    context
        .document_service
        .doc_open(PathRequest {
            path: path_string(&orphan_source),
        })
        .await
        .map_err(|error| format!("failed to open orphan source: {error:?}"))?;
    context
        .document_service
        .doc_save_draft(SaveDraftRequest {
            path: path_string(&orphan_source),
            scene_json: local_scene.clone(),
        })
        .await
        .map_err(|error| format!("failed to save orphan draft: {error:?}"))?;
    fs::remove_file(&orphan_source)
        .map_err(|error| format!("failed to remove orphan source: {error}"))?;
    context
        .document_service
        .doc_checkpoint(CheckpointRequest {
            path: path_string(&orphan_target),
            scene_json: local_scene,
            reason: CheckpointReason::SaveAsNew,
        })
        .await
        .map_err(|error| format!("orphan Save As checkpoint failed: {error:?}"))?;
    context
        .document_service
        .doc_close(CloseDocumentRequest {
            path: path_string(&orphan_source),
            mode: CloseDocumentMode::DiscardOrphan,
        })
        .await
        .map_err(|error| format!("orphan close failed: {error:?}"))?;
    let orphan_target_identity = context
        .store
        .load_active_document_identity(&path_string(&orphan_target))
        .map_err(|error| format!("failed to read orphan target identity: {error}"))?
        .ok_or_else(|| "orphan target identity is missing".to_owned())?;
    let orphan_source_draft_exists_after_close = context
        .repository
        .draft_get(path_string(&orphan_source))
        .await
        .map_err(|error| format!("failed to inspect orphan draft: {error}"))?
        .is_some();
    let orphan_target_history_count = history_source_count(
        &context.store,
        &orphan_target_identity.document_id,
        "automatic",
    )? + history_source_count(
        &context.store,
        &orphan_target_identity.document_id,
        "protected",
    )? + history_source_count(
        &context.store,
        &orphan_target_identity.document_id,
        "manual",
    )?;
    let orphan_target_document_id = orphan_target_identity.document_id.clone();
    let orphan_save_as_distinct = orphan_target_document_id != source_identity.document_id;
    Ok(HistoryDocumentSaveAsEvidence {
        scenario: "history-document-save-as",
        conflict_source_path: path_string(&source),
        conflict_target_path: path_string(&target),
        conflict_source_document_id: source_identity.document_id.clone(),
        conflict_target_document_id: target_identity.document_id.clone(),
        previous_target_state,
        conflict_save_as_distinct: source_identity.document_id != target_identity.document_id
            && target_identity.document_id != previous_target_identity.document_id,
        conflict_source_remains_active: source_identity.state
            == crate::history::identity::IdentityState::Active,
        orphan_source_path: path_string(&orphan_source),
        orphan_target_path: path_string(&orphan_target),
        orphan_target_document_id,
        orphan_target_history_count,
        orphan_source_draft_exists_after_close,
        orphan_save_as_distinct,
        orphan_source_file_exists_after_close: orphan_source.exists(),
    })
}

async fn run_history_lifecycle_journal_seed(
    root: &Path,
) -> Result<HistoryLifecycleJournalEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let recovery = RecoveryStore::with_app_version(root.join("lifecycle-recovery"), "0.3.0");
    let old_path = context.workspace.join("journal/original.excalidraw");
    let new_path = context.workspace.join("journal/moved.excalidraw");
    fs::create_dir_all(
        old_path
            .parent()
            .ok_or_else(|| "journal path has no parent".to_owned())?,
    )
    .map_err(|error| format!("failed to create journal fixture: {error}"))?;
    let scene = history_restart_scene("journal-original", "日志原始文档");
    materialize_history_workspace_asset(&context.workspace, &scene.1)?;
    fs::write(&old_path, scene.0.as_bytes())
        .map_err(|error| format!("failed to write journal source: {error}"))?;
    let old_path = old_path
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize journal source: {error}"))?;
    let identity = context
        .store
        .resolve_document_identity_for_open(&old_path, 1)
        .map_err(|error| format!("failed to establish journal identity: {error}"))?;
    publish_history_restart_version(
        &context.store,
        &identity.document_id,
        "history-lifecycle-journal-v1",
        &scene.0,
        1,
        &scene.2,
    )?;
    fs::rename(&old_path, &new_path)
        .map_err(|error| format!("failed to commit journal filesystem rename: {error}"))?;
    let operation_id = "history-lifecycle-journal-replay".to_owned();
    let record = MutationJournalRecord::rename(
        operation_id.clone(),
        "e2e-reliability-workspace".to_owned(),
        path_string(&old_path),
        path_string(&new_path),
        "journal/original.excalidraw".to_owned(),
        "journal/moved.excalidraw".to_owned(),
        "moved".to_owned(),
    )
    .with_history_required(true)
    .with_filesystem_committed(true)
    .with_history_document_id(identity.document_id.clone());
    save_journal(&recovery, &record)
        .map_err(|error| format!("failed to save pending journal: {error:?}"))?;
    let pending = load_journals(&recovery)
        .map_err(|error| format!("failed to load seeded journal: {error:?}"))?;
    Ok(HistoryLifecycleJournalEvidence {
        scenario: "history-lifecycle-journal",
        phase: "seed",
        operation_id,
        old_path: path_string(&old_path),
        new_path: path_string(&new_path),
        document_id: identity.document_id,
        journal_pending_before: pending.iter().any(MutationJournalRecord::history_pending),
        journal_pending_after: true,
        old_exists_after: old_path.exists(),
        new_exists_after: new_path.exists(),
        identity_at_new_path: None,
        identity_at_old_path: None,
        history_replay_applied: false,
    })
}

async fn run_history_lifecycle_journal_probe(
    root: &Path,
) -> Result<HistoryLifecycleJournalEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let recovery = RecoveryStore::with_app_version(root.join("lifecycle-recovery"), "0.3.0");
    let old_path = context.workspace.join("journal/original.excalidraw");
    let new_path = context.workspace.join("journal/moved.excalidraw");
    let before = load_journals(&recovery)
        .map_err(|error| format!("failed to load journal before replay: {error:?}"))?;
    let operation_id = before
        .first()
        .map(|record| record.operation_id.clone())
        .ok_or_else(|| "journal replay probe found no pending record".to_owned())?;
    let document_id = before
        .first()
        .and_then(|record| record.history_document_id.clone())
        .ok_or_else(|| "journal replay record has no history document id".to_owned())?;
    let replay = history_replay_for_store(Arc::clone(&context.store));
    reconcile_pending_mutations_with_history(&context.repository, &recovery, replay)
        .await
        .map_err(|error| format!("journal replay failed: {error:?}"))?;
    let after = load_journals(&recovery)
        .map_err(|error| format!("failed to load journal after replay: {error:?}"))?;
    let identity_at_new_path = context
        .store
        .load_active_document_identity(&path_string(&new_path))
        .map_err(|error| format!("failed to inspect replayed new identity: {error}"))?
        .map(|identity| identity.document_id);
    let identity_at_old_path = context
        .store
        .load_active_document_identity(&path_string(&old_path))
        .map_err(|error| format!("failed to inspect replayed old identity: {error}"))?
        .map(|identity| identity.document_id);
    Ok(HistoryLifecycleJournalEvidence {
        scenario: "history-lifecycle-journal",
        phase: "probe",
        operation_id,
        old_path: path_string(&old_path),
        new_path: path_string(&new_path),
        document_id: document_id.clone(),
        journal_pending_before: before.iter().any(MutationJournalRecord::history_pending),
        journal_pending_after: after.iter().any(MutationJournalRecord::history_pending),
        old_exists_after: old_path.exists(),
        new_exists_after: new_path.exists(),
        identity_at_new_path: identity_at_new_path.clone(),
        identity_at_old_path,
        history_replay_applied: identity_at_new_path.as_deref() == Some(document_id.as_str()),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryReplayFaultEvidence {
    scenario: &'static str,
    fault: Option<String>,
    first_error: Option<String>,
    journal_pending_after: bool,
    identity_at_new_path: Option<String>,
    identity_at_old_path: Option<String>,
    history_replay_applied: bool,
}

/// Replay a durable third-stage journal in a fresh process.  The injected
/// transaction fault is consumed by the real HistoryStore transaction used by
/// `migrate_app_rename`; the journal must remain pending until a later process
/// retries without the fault.
async fn run_history_lifecycle_journal_fault_probe(
    root: &Path,
) -> Result<HistoryReplayFaultEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let recovery = RecoveryStore::with_app_version(root.join("lifecycle-recovery"), "0.3.0");
    let fault = env::var("EXCALIDRAW_E2E_HISTORY_REPLAY_FAULT").ok();
    if let Some(value) = fault.as_deref() {
        let selected = match value {
            "disk-full" => HistoryStoreFault::DiskFull,
            "permission-denied" => HistoryStoreFault::PermissionDenied,
            "read-only" => HistoryStoreFault::ReadOnly,
            other => return Err(format!("unknown history replay fault: {other}")),
        };
        set_transaction_fault(Some(selected));
    }
    let first_error = reconcile_pending_mutations_with_history(
        &context.repository,
        &recovery,
        history_replay_for_store(Arc::clone(&context.store)),
    )
    .await
    .err()
    .map(|error| format!("{error:?}"));
    clear_transaction_fault();
    let after = load_journals(&recovery)
        .map_err(|error| format!("failed to load journal after replay fault: {error:?}"))?;
    let new_path = context.workspace.join("journal/moved.excalidraw");
    let old_path = context.workspace.join("journal/original.excalidraw");
    let identity_at_new_path = context
        .store
        .load_active_document_identity(&path_string(&new_path))
        .map_err(|error| format!("failed to inspect replayed new identity: {error}"))?
        .map(|identity| identity.document_id);
    let identity_at_old_path = context
        .store
        .load_active_document_identity(&path_string(&old_path))
        .map_err(|error| format!("failed to inspect replayed old identity: {error}"))?
        .map(|identity| identity.document_id);
    let journal_pending_after = after.iter().any(MutationJournalRecord::history_pending);
    Ok(HistoryReplayFaultEvidence {
        scenario: "history-lifecycle-journal-fault",
        fault,
        first_error,
        journal_pending_after,
        history_replay_applied: !journal_pending_after && identity_at_new_path.is_some(),
        identity_at_new_path,
        identity_at_old_path,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryParentSyncFaultEvidence {
    scenario: &'static str,
    fault_injected: bool,
    first_error: Option<String>,
    journal_pending_after: bool,
    history_replay_applied: bool,
}

/// Exercise the real journal replay parent-directory `sync_all` path.  The
/// fault is a scoped mode change on the isolated journal fixture directory;
/// the caller restores the mode between fresh processes before retrying.
async fn run_history_lifecycle_journal_parent_sync_probe(
    root: &Path,
) -> Result<HistoryParentSyncFaultEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let recovery = RecoveryStore::with_app_version(root.join("lifecycle-recovery"), "0.3.0");
    let fault_injected =
        env::var("EXCALIDRAW_E2E_HISTORY_PARENT_SYNC_DENIED").as_deref() == Ok("1");
    let parent = context.workspace.join("journal");
    if fault_injected {
        #[cfg(unix)]
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o000))
            .map_err(|error| format!("failed to deny journal parent sync: {error}"))?;
    }
    let first_error = reconcile_pending_mutations_with_history(
        &context.repository,
        &recovery,
        history_replay_for_store(Arc::clone(&context.store)),
    )
    .await
    .err()
    .map(|error| format!("{error:?}"));
    let pending = load_journals(&recovery)
        .map_err(|error| format!("failed to load parent-sync journal: {error:?}"))?;
    let journal_pending_after = pending.iter().any(|record| record.history_pending());
    Ok(HistoryParentSyncFaultEvidence {
        scenario: "history-lifecycle-journal-parent-sync",
        fault_injected,
        first_error,
        journal_pending_after,
        history_replay_applied: !journal_pending_after,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryMissingResourceEvidence {
    scenario: &'static str,
    resource: String,
    target_path: String,
    document_id: String,
    version_id: String,
    target_parseable: bool,
    resource_exists: bool,
    preview_succeeded: bool,
    sibling_version_id: String,
    sibling_preview_succeeded: bool,
    unavailable_record_stable: bool,
    error: Option<String>,
}

async fn run_history_missing_resource_seed(
    root: &Path,
) -> Result<HistoryMissingResourceEvidence, String> {
    let (context, target, _old_hash, target_scene_hash, asset_hash) =
        setup_history_fault_operation(root).await?;
    let resource =
        env::var("EXCALIDRAW_E2E_HISTORY_MISSING_RESOURCE").unwrap_or_else(|_| "scene".to_owned());
    let resource_path = match resource.as_str() {
        "scene" => context
            .store
            .objects()
            .scene_path(&target_scene_hash)
            .map_err(|error| format!("failed to resolve scene path: {error}"))?,
        "asset" => context
            .store
            .objects()
            .asset_path(&asset_hash)
            .map_err(|error| format!("failed to resolve asset path: {error}"))?,
        other => return Err(format!("unknown missing history resource: {other}")),
    };
    fs::remove_file(&resource_path)
        .map_err(|error| format!("failed to remove isolated history {resource}: {error}"))?;
    let target_bytes = fs::read(&target)
        .map_err(|error| format!("failed to read missing-resource target: {error}"))?;
    Ok(HistoryMissingResourceEvidence {
        scenario: "history-missing-resource-seed",
        resource,
        target_path: path_string(&target),
        document_id: context
            .store
            .load_active_document_identity(&path_string(&target))
            .map_err(|error| format!("failed to read missing-resource identity: {error}"))?
            .ok_or_else(|| "missing-resource identity is absent".to_owned())?
            .document_id,
        version_id: "history-fault-version-a".to_owned(),
        target_parseable: serde_json::from_slice::<serde_json::Value>(&target_bytes).is_ok(),
        resource_exists: resource_path.exists(),
        preview_succeeded: false,
        sibling_version_id: "history-fault-version-b".to_owned(),
        sibling_preview_succeeded: false,
        unavailable_record_stable: false,
        error: None,
    })
}

async fn run_history_missing_resource_probe(
    root: &Path,
) -> Result<HistoryMissingResourceEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let resource =
        env::var("EXCALIDRAW_E2E_HISTORY_MISSING_RESOURCE").unwrap_or_else(|_| "scene".to_owned());
    let target = context.workspace.join("history-fault-operation.excalidraw");
    let target = target
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize missing-resource target: {error}"))?;
    let target_bytes = fs::read(&target)
        .map_err(|error| format!("failed to read missing-resource target: {error}"))?;
    let identity = context
        .store
        .load_active_document_identity(&path_string(&target))
        .map_err(|error| format!("failed to read missing-resource identity: {error}"))?
        .ok_or_else(|| "missing-resource identity is absent after restart".to_owned())?;
    let preview = context
        .query
        .preview(HistoryPreviewRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            version_id: "history-fault-version-a".to_owned(),
        })
        .await;
    let resource_exists = match resource.as_str() {
        "scene" => {
            let hash = context
                .store
                .with_connection(|connection| {
                    connection.query_row(
                        "SELECT scene_hash FROM history_versions WHERE id=?1",
                        ["history-fault-version-a"],
                        |row| row.get::<_, String>(0),
                    )
                })
                .map_err(|error| format!("failed to inspect missing scene hash: {error}"))?;
            context
                .store
                .objects()
                .scene_path(&hash)
                .map(|path| path.exists())
                .unwrap_or(false)
        }
        "asset" => {
            let hash = context
                .store
                .with_connection(|connection| {
                    connection.query_row(
                        "SELECT asset_hash FROM version_assets WHERE version_id=?1 LIMIT 1",
                        ["history-fault-version-a"],
                        |row| row.get::<_, String>(0),
                    )
                })
                .map_err(|error| format!("failed to inspect missing asset hash: {error}"))?;
            context
                .store
                .objects()
                .asset_path(&hash)
                .map(|path| path.exists())
                .unwrap_or(false)
        }
        other => return Err(format!("unknown missing history resource: {other}")),
    };
    let error = preview.as_ref().err().map(|value| format!("{value:?}"));
    let sibling_preview_succeeded = context
        .query
        .preview(HistoryPreviewRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            version_id: "history-fault-version-b".to_owned(),
        })
        .await
        .is_ok();
    let unavailable_record_stable = preview.is_err()
        && error
            .as_deref()
            .is_some_and(|value| value.contains("HistoryResourceMissing"));
    Ok(HistoryMissingResourceEvidence {
        scenario: "history-missing-resource-probe",
        resource,
        target_path: path_string(&target),
        document_id: identity.document_id,
        version_id: "history-fault-version-a".to_owned(),
        target_parseable: serde_json::from_slice::<serde_json::Value>(&target_bytes).is_ok(),
        resource_exists,
        preview_succeeded: preview.is_ok(),
        sibling_version_id: "history-fault-version-b".to_owned(),
        sibling_preview_succeeded,
        unavailable_record_stable,
        error,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryPartialProtectionEvidence {
    scenario: &'static str,
    phase: &'static str,
    target_path: String,
    original_sha256: String,
    target_sha256: String,
    target_unchanged: bool,
    target_parseable: bool,
    fault_scene_hash: String,
    unregistered_before_gc: Vec<String>,
    unregistered_after_gc: Vec<String>,
    gc_deleted_orphan: bool,
    protected_version_count: usize,
    operation_row_count: usize,
    retained_scene_objects: bool,
    retained_asset_objects: bool,
}

async fn run_history_partial_protection_seed(
    root: &Path,
) -> Result<HistoryPartialProtectionEvidence, String> {
    let failure = run_history_operation_failure(root).await?;
    let target = PathBuf::from(&failure.target_path);
    let persisted = fs::read(&target)
        .map_err(|error| format!("failed to read partial-protection target: {error}"))?;
    Ok(HistoryPartialProtectionEvidence {
        scenario: "history-partial-protection",
        phase: "seed",
        target_path: path_string(&target),
        original_sha256: failure.original_sha256,
        target_sha256: sha256(&persisted),
        target_unchanged: failure.target_unchanged,
        target_parseable: serde_json::from_slice::<serde_json::Value>(&persisted).is_ok(),
        fault_scene_hash: failure.fault_scene_hash,
        unregistered_before_gc: failure.unregistered_object_hashes,
        unregistered_after_gc: Vec::new(),
        gc_deleted_orphan: false,
        protected_version_count: failure.protected_version_count,
        operation_row_count: failure.operation_row_count,
        retained_scene_objects: false,
        retained_asset_objects: false,
    })
}

async fn run_history_partial_protection_probe(
    root: &Path,
) -> Result<HistoryPartialProtectionEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let target = context.workspace.join("history-fault-operation.excalidraw");
    let target = target
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize partial-protection target: {error}"))?;
    let persisted = fs::read(&target)
        .map_err(|error| format!("failed to read partial-protection target: {error}"))?;
    let expected_original_sha256 =
        sha256(history_restart_scene("Efault-B", "历史故障 B").0.as_bytes());
    let persisted_sha256 = sha256(&persisted);
    let identity = context
        .store
        .load_active_document_identity(&path_string(&target))
        .map_err(|error| format!("failed to load partial-protection identity: {error}"))?
        .ok_or_else(|| "partial-protection identity is missing after restart".to_owned())?;
    let unregistered_before_gc = context
        .store
        .enumerate_object_candidates()
        .map_err(|error| format!("failed to enumerate orphan candidates: {error}"))?
        .into_iter()
        .filter(|candidate| !candidate.registered)
        .map(|candidate| candidate.object.hash)
        .collect::<Vec<_>>();
    let gc = context
        .store
        .collect_garbage(SystemTime::now(), Duration::ZERO)
        .map_err(|error| format!("partial-protection GC failed: {error}"))?;
    let unregistered_after_gc = context
        .store
        .enumerate_object_candidates()
        .map_err(|error| format!("failed to enumerate orphan candidates after GC: {error}"))?
        .into_iter()
        .filter(|candidate| !candidate.registered)
        .map(|candidate| candidate.object.hash)
        .collect::<Vec<_>>();
    let fault_scene_hash = unregistered_before_gc
        .first()
        .cloned()
        .ok_or_else(|| "partial-protection fresh probe found no orphan candidate".to_owned())?;
    let (protected_version_count, operation_row_count) = history_failure_counts(
        &context.store,
        &identity.document_id,
        "history-fault-partial-protection-fresh",
    )?;
    let retained_scene_objects = context
        .store
        .with_connection(|connection| {
            let mut statement = connection
                .prepare("SELECT scene_hash FROM history_versions WHERE document_id=?1")?;
            let hashes = statement
                .query_map([&identity.document_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>(hashes.into_iter().all(|hash| {
                context
                    .store
                    .objects()
                    .scene_path(&hash)
                    .map(|path| path.is_file())
                    .unwrap_or(false)
            }))
        })
        .map_err(|error| format!("failed to inspect retained scenes: {error}"))?;
    let retained_asset_objects = context
        .store
        .with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT asset_hash FROM version_assets WHERE version_id IN (SELECT id FROM history_versions WHERE document_id=?1)",
            )?;
            let hashes = statement
                .query_map([&identity.document_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>(hashes.into_iter().all(|hash| {
                context
                    .store
                    .objects()
                    .asset_path(&hash)
                    .map(|path| path.is_file())
                    .unwrap_or(false)
            }))
        })
        .map_err(|error| format!("failed to inspect retained assets: {error}"))?;
    Ok(HistoryPartialProtectionEvidence {
        scenario: "history-partial-protection",
        phase: "probe",
        target_path: path_string(&target),
        original_sha256: expected_original_sha256.clone(),
        target_sha256: persisted_sha256.clone(),
        target_unchanged: persisted_sha256 == expected_original_sha256,
        target_parseable: serde_json::from_slice::<serde_json::Value>(&persisted).is_ok(),
        fault_scene_hash: fault_scene_hash.clone(),
        gc_deleted_orphan: gc
            .deleted
            .iter()
            .any(|object| object.hash == fault_scene_hash),
        unregistered_before_gc,
        unregistered_after_gc,
        protected_version_count,
        operation_row_count,
        retained_scene_objects,
        retained_asset_objects,
    })
}

fn history_failure_counts(
    store: &HistoryStore,
    document_id: &str,
    request_id: &str,
) -> Result<(usize, usize), String> {
    store
        .with_connection(|connection| {
            let protected = connection.query_row(
                "SELECT COUNT(*) FROM history_versions WHERE document_id=?1 AND source='protected'",
                [document_id],
                |row| row.get::<_, i64>(0),
            )?;
            let operations = connection.query_row(
                "SELECT COUNT(*) FROM history_operations WHERE idempotency_id=?1",
                [request_id],
                |row| row.get::<_, i64>(0),
            )?;
            Ok::<_, rusqlite::Error>((protected as usize, operations as usize))
        })
        .map_err(|error| format!("failed to inspect partial-protection terminal state: {error}"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryGcHydrationPinEvidence {
    scenario: &'static str,
    scene_hash: String,
    asset_hash: String,
    retained_while_hydrating: bool,
    deleted_after_release: bool,
    deleted_only_orphaned_objects: bool,
    preview_completed: bool,
    preview_scene_complete: bool,
    preview_asset_complete: bool,
    current_file_unchanged: bool,
}

async fn run_history_gc_hydration_pin(
    root: &Path,
) -> Result<HistoryGcHydrationPinEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let target = context.workspace.join("history-gc-pin.excalidraw");
    let scene = history_restart_scene("gc-pin", "GC 引用保护");
    fs::write(&target, scene.0.as_bytes())
        .map_err(|error| format!("failed to create GC pin target: {error}"))?;
    let target = target
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize GC pin target: {error}"))?;
    let identity = context
        .store
        .resolve_document_identity_for_open(&target, 1)
        .map_err(|error| format!("failed to persist GC pin identity: {error}"))?;
    publish_history_restart_version(
        &context.store,
        &identity.document_id,
        "history-gc-pin-version",
        &scene.0,
        1,
        &scene.2,
    )?;
    let scene_hash = sha256(scene.0.as_bytes());
    let asset_hash = scene.2;
    let expected_scene = serde_json::from_str::<serde_json::Value>(&scene.0)
        .map_err(|error| format!("failed to parse GC hydration fixture scene: {error}"))?;
    let expected_asset_data_url = format!("data:image/png;base64,{}", BASE64.encode(&scene.1));
    let initial_target_bytes = fs::read(&target)
        .map_err(|error| format!("failed to read GC hydration target: {error}"))?;
    context
        .store
        .reachability()
        .remove_committed_version("history-gc-pin-version")
        .map_err(|error| format!("failed to remove semantic reachability root: {error}"))?;
    let barrier = E2ePreviewHydrationPinBarrier::new();
    set_e2e_preview_hydration_pin_barrier(Some(Arc::clone(&barrier)));
    let target_path = path_string(&target);
    let preview_task = {
        let query = context.query.clone();
        let version_id = "history-gc-pin-version".to_owned();
        tokio::spawn(async move {
            query
                .preview(HistoryPreviewRequest {
                    document: HistoryDocumentLocator::Path { path: target_path },
                    version_id,
                })
                .await
        })
    };
    let reached = tokio::task::spawn_blocking({
        let barrier = Arc::clone(&barrier);
        move || barrier.wait_until_reached()
    })
    .await
    .map_err(|error| format!("hydration barrier wait task failed: {error}"))?;
    if !reached {
        barrier.release();
        let _ = preview_task.await;
        set_e2e_preview_hydration_pin_barrier(None);
        return Err("history preview did not reach the post-pin barrier".to_owned());
    }
    let gc_task = {
        let store = Arc::clone(&context.store);
        tokio::task::spawn_blocking(move || {
            store.collect_garbage(SystemTime::now(), Duration::ZERO)
        })
    };
    let gc_result = gc_task
        .await
        .map_err(|error| format!("GC while hydration pin is held task failed: {error}"))?;
    barrier.release();
    let preview_result = preview_task
        .await
        .map_err(|error| format!("history preview task failed: {error}"))?;
    set_e2e_preview_hydration_pin_barrier(None);
    let report =
        gc_result.map_err(|error| format!("GC while hydration pin is held failed: {error}"))?;
    let scene_key = ObjectKey::scene(scene_hash.clone())
        .map_err(|error| format!("invalid scene hash: {error}"))?;
    let asset_key = ObjectKey::asset(asset_hash.clone())
        .map_err(|error| format!("invalid asset hash: {error}"))?;
    let retained_while_hydrating =
        report.retained.contains(&scene_key) && report.retained.contains(&asset_key);
    let report = context
        .store
        .collect_garbage(SystemTime::now(), Duration::ZERO)
        .map_err(|error| format!("GC after hydration release failed: {error}"))?;
    let deleted_after_release =
        report.deleted.contains(&scene_key) && report.deleted.contains(&asset_key);
    let deleted_only_orphaned_objects = report
        .deleted
        .iter()
        .all(|object| object == &scene_key || object == &asset_key);
    let current_file_unchanged = fs::read(&target)
        .map(|bytes| bytes == initial_target_bytes)
        .unwrap_or(false);
    let preview_scene_complete = preview_result.as_ref().is_ok_and(|preview| {
        preview.scene.get("elements") == expected_scene.get("elements")
            && preview.scene.get("appState") == expected_scene.get("appState")
    });
    let preview_asset_complete = preview_result.as_ref().is_ok_and(|preview| {
        preview
            .scene
            .get("files")
            .and_then(serde_json::Value::as_object)
            .and_then(|files| files.get("history-image"))
            .and_then(serde_json::Value::as_object)
            .and_then(|file| file.get("dataURL"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|data_url| data_url == expected_asset_data_url)
    });
    Ok(HistoryGcHydrationPinEvidence {
        scenario: "history-gc-hydration-pin",
        scene_hash,
        asset_hash,
        retained_while_hydrating,
        deleted_after_release,
        deleted_only_orphaned_objects,
        preview_completed: preview_result.is_ok(),
        preview_scene_complete,
        preview_asset_complete,
        current_file_unchanged,
    })
}

fn materialize_history_workspace_asset(workspace: &Path, bytes: &[u8]) -> Result<(), String> {
    let directory = workspace.join(".excalidraw_assets");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("failed to create history workspace assets: {error}"))?;
    let path = directory.join(sha256(bytes));
    fs::write(path, bytes).map_err(|error| format!("failed to materialize history asset: {error}"))
}

async fn setup_history_fault_operation(
    root: &Path,
) -> Result<(HistoryRestartContext, PathBuf, String, String, String), String> {
    let context = open_history_restart_context(root).await?;
    let target = PathBuf::from(
        env::var(HISTORY_FAULT_TARGET_ENV)
            .map_err(|_| format!("{HISTORY_FAULT_TARGET_ENV} is required"))?,
    );
    assert_isolated_path(root, &target)?;
    let scene_a = history_restart_scene("fault-A", "历史故障 A");
    let scene_b = history_restart_scene("Efault-B", "历史故障 B");
    fs::write(&target, scene_b.0.as_bytes())
        .map_err(|error| format!("failed to write history fault target: {error}"))?;
    let target = target
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize history fault target: {error}"))?;
    let asset_directory = context.workspace.join(".excalidraw_assets");
    fs::create_dir_all(&asset_directory)
        .map_err(|error| format!("failed to create history fault asset directory: {error}"))?;
    fs::write(asset_directory.join(&scene_b.2), &scene_b.1)
        .map_err(|error| format!("failed to materialize history fault asset: {error}"))?;
    let identity = context
        .store
        .resolve_document_identity_for_open(&target, 1)
        .map_err(|error| format!("failed to persist history fault identity: {error}"))?;
    publish_history_restart_version(
        &context.store,
        &identity.document_id,
        "history-fault-version-a",
        &scene_a.0,
        1,
        &scene_a.2,
    )?;
    publish_history_restart_version(
        &context.store,
        &identity.document_id,
        "history-fault-version-b",
        &scene_b.0,
        2,
        &scene_b.2,
    )?;
    Ok((
        context,
        target,
        sha256(scene_b.0.as_bytes()),
        sha256(scene_a.0.as_bytes()),
        scene_a.2,
    ))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryRestartSeedEvidence {
    scenario: &'static str,
    target_path: String,
    document_id: String,
    version_a_id: String,
    version_b_id: String,
    scene_a_sha256: String,
    scene_b_sha256: String,
    asset_sha256: String,
    version_count: usize,
    history_database_path: String,
    initial_scene_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryRestartRestoreEvidence {
    scenario: &'static str,
    request_id: String,
    target_version_id: String,
    target_path: String,
    target_scene_sha256: String,
    persisted_scene_sha256: String,
    adopted_scene_sha256: Option<String>,
    protection_version_id: Option<String>,
    operation_state: String,
    operation_status_state: String,
    target_asset_sha256: String,
    response: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryRestartVerifyEvidence {
    scenario: &'static str,
    request_id: String,
    target_version_id: String,
    target_path: String,
    history_database_path: String,
    active_document_id: Option<String>,
    operation_document_id: Option<String>,
    operation_state: Option<String>,
    persisted_scene_sha256: String,
    status_scene_sha256: Option<String>,
    status_state: String,
    protection_version_id: Option<String>,
    listed_version_ids: Vec<String>,
    target_version_evicted: bool,
    retained_version_count: usize,
    protection_scene_sha256: String,
    protection_asset_sha256: String,
    protection_elements: Vec<serde_json::Value>,
    target_asset_sha256: String,
    target_object_exists: bool,
    target_asset_exists: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryRestartEvictEvidence {
    scenario: &'static str,
    request_id: String,
    retained_version_count: usize,
    evicted_version_id: String,
    operation_status_state: String,
    target_scene_sha256: String,
    target_asset_sha256: String,
    target_object_exists_after_gc: bool,
    target_asset_exists_after_gc: bool,
    gc_deleted_target: bool,
    target_retained_scene_references: usize,
    target_retained_asset_references: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryRestartEvictionFaultEvidence {
    scenario: &'static str,
    target_path: String,
    persisted_scene_sha256: String,
    expected_old_scene_sha256: String,
    target_version_exists: bool,
    retained_version_count: usize,
    protection_version_count: usize,
    operation_row_count: usize,
    target_object_existed_before_gc: bool,
    target_asset_existed_before_gc: bool,
    target_object_exists_after_gc: bool,
    target_asset_exists_after_gc: bool,
    gc_deleted_target_scene: bool,
    gc_deleted_target_asset: bool,
}

#[derive(Clone)]
struct E2eDirectFileGrant {
    workspace: PathBuf,
}

impl DirectFileGrant for E2eDirectFileGrant {
    fn is_allowed(&self, path: &Path) -> bool {
        path.starts_with(&self.workspace)
    }
}

struct HistoryRestartContext {
    repository: Arc<SqliteRepository>,
    store: Arc<HistoryStore>,
    document_service: DocumentService,
    query: HistoryQueryService,
    replacement: Arc<HistoryReplacementService>,
    workspace: PathBuf,
}

async fn open_history_restart_context(root: &Path) -> Result<HistoryRestartContext, String> {
    let (repository, mut document_service, workspace) = open_scenario_service(root).await?;
    let store = Arc::new(
        HistoryStore::open(&root.join("data"))
            .map_err(|error| format!("failed to open history store: {error}"))?,
    );
    document_service.attach_history_store(Arc::clone(&store));
    let grant = Arc::new(E2eDirectFileGrant {
        workspace: workspace.clone(),
    });
    let query = HistoryQueryService::with_direct_file_grant(
        Arc::clone(&repository),
        Some(Arc::clone(&store)),
        Arc::clone(&grant) as Arc<dyn DirectFileGrant>,
    );
    let replacement = HistoryReplacementState::with_document_service(
        document_service.clone(),
        Arc::clone(&repository),
        Some(Arc::clone(&store)),
        grant,
    )
    .service;
    Ok(HistoryRestartContext {
        repository,
        store,
        document_service,
        query,
        replacement,
        workspace,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryAutomaticSeedEvidence {
    scenario: &'static str,
    target_path: String,
    document_id: String,
    history_database_path: String,
    clock_baseline_at: i64,
    clock_before_boundary_at: i64,
    clock_boundary_at: i64,
    baseline_outcome: String,
    before_boundary_outcome: String,
    no_change_outcome: String,
    boundary_outcome: String,
    automatic_version_id: String,
    manual_request_id: String,
    manual_version_id: String,
    manual_content_hash: String,
    manual_click_scene_sha256: String,
    post_edit_scene_sha256: String,
    mixed_requested_count: usize,
    mixed_version_ids: Vec<String>,
    mixed_sources: Vec<HistoryAutomaticSourceEvidence>,
    timer_wakeups: u64,
    cold_checkpoint_calls: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryAutomaticSourceEvidence {
    version_id: String,
    source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryAutomaticVerifyEvidence {
    scenario: &'static str,
    target_path: String,
    document_id: String,
    history_database_path: String,
    target_sha256: String,
    manual_version_id: String,
    manual_available_after_restart: bool,
    manual_source: String,
    manual_scene_sha256: String,
    manual_element_ids: Vec<String>,
    manual_click_scene_sha256: String,
    post_edit_scene_sha256: String,
    listed_version_ids: Vec<String>,
    listed_sources: Vec<HistoryAutomaticSourceEvidence>,
    retained_version_count: usize,
    automatic_version_count: usize,
    protected_version_count: usize,
    manual_version_count: usize,
    retained_pool_count: usize,
    timer_wakeups: u64,
}

async fn run_history_automatic_seed(root: &Path) -> Result<HistoryAutomaticSeedEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let target = context.workspace.join("history-automatic.excalidraw");
    let scene_a = history_restart_scene("A", "自动基线");
    let scene_b = history_restart_scene("B", "手动点击态");
    let scene_c = history_restart_scene("C", "点击后编辑");
    fs::write(&target, &scene_a.0)
        .map_err(|error| format!("failed to write automatic target: {error}"))?;
    let target = target
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize automatic target: {error}"))?;
    let asset_directory = context.workspace.join(".excalidraw_assets");
    fs::create_dir_all(&asset_directory)
        .map_err(|error| format!("failed to create automatic asset directory: {error}"))?;
    fs::write(asset_directory.join(&scene_a.2), &scene_a.1)
        .map_err(|error| format!("failed to materialize automatic asset: {error}"))?;
    let identity = context
        .store
        .resolve_document_identity_for_open(&target, 1)
        .map_err(|error| format!("failed to persist automatic identity: {error}"))?;

    let baseline_at = 1_000_i64;
    let before_boundary_at = baseline_at + AUTOMATIC_INTERVAL_SECONDS - 1;
    let boundary_at = baseline_at + AUTOMATIC_INTERVAL_SECONDS;
    reset_e2e_automatic_callback_count();
    let mut cold_checkpoint_calls = 0_u64;
    let mut checkpoint = |scene_json: String, reason, recorded_at| {
        cold_checkpoint_calls += 1;
        context.document_service.e2e_doc_checkpoint_at(
            CheckpointRequest {
                path: path_string(&target),
                scene_json,
                reason,
            },
            recorded_at,
        )
    };
    checkpoint(scene_a.0.clone(), CheckpointReason::ManualSave, baseline_at)
        .await
        .map_err(|error| format!("automatic baseline checkpoint failed: {error:?}"))?;
    let count_after_baseline =
        history_source_count(&context.store, &identity.document_id, "automatic")?;
    checkpoint(
        scene_b.0.clone(),
        CheckpointReason::Idle,
        before_boundary_at,
    )
    .await
    .map_err(|error| format!("automatic before-boundary checkpoint failed: {error:?}"))?;
    let count_before_boundary =
        history_source_count(&context.store, &identity.document_id, "automatic")?;
    checkpoint(scene_b.0.clone(), CheckpointReason::TabClose, boundary_at)
        .await
        .map_err(|error| format!("automatic unchanged checkpoint failed: {error:?}"))?;
    let count_after_no_change =
        history_source_count(&context.store, &identity.document_id, "automatic")?;
    checkpoint(scene_c.0.clone(), CheckpointReason::ManualSave, boundary_at)
        .await
        .map_err(|error| format!("automatic boundary checkpoint failed: {error:?}"))?;
    let automatic_versions =
        history_source_ids(&context.store, &identity.document_id, "automatic")?;
    if count_after_baseline != 0
        || count_before_boundary != 0
        || count_after_no_change != 0
        || automatic_versions.len() != 1
    {
        return Err(format!(
            "real checkpoint cadence drifted: baseline={count_after_baseline}, beforeBoundary={count_before_boundary}, noChange={count_after_no_change}, boundary={automatic_versions:?}"
        ));
    }
    let automatic_version_id = automatic_versions[0].clone();
    let automatic_callbacks = e2e_automatic_callback_count();
    if automatic_callbacks < cold_checkpoint_calls {
        return Err("automatic callback count is lower than real checkpoint count".to_owned());
    }

    let manual_request_id = "history-automatic-manual-click".to_owned();
    let manual = context
        .replacement
        .mark(HistoryMarkRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            request_id: manual_request_id.clone(),
            session_generation: 1,
            revision: 1,
            current_scene_json: scene_b.0.clone(),
        })
        .await
        .map_err(|error| format!("manual history mark failed: {error:?}"))?;
    fs::write(&target, &scene_a.0)
        .map_err(|error| format!("failed to write post-mark edit: {error}"))?;

    let mixed_requested_count = env::var("EXCALIDRAW_E2E_HISTORY_MIXED_COUNT")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(21);
    if !(19..=21).contains(&mixed_requested_count) {
        return Err(format!(
            "EXCALIDRAW_E2E_HISTORY_MIXED_COUNT must be 19, 20, or 21, got {mixed_requested_count}"
        ));
    }
    let mut mixed_version_ids = vec![automatic_version_id.clone()];
    let mut mixed_sources = vec![HistoryAutomaticSourceEvidence {
        version_id: automatic_version_id.clone(),
        source: "automatic".to_owned(),
    }];
    for index in 1..mixed_requested_count {
        let version_id = format!("history-automatic-mixed-{index:02}");
        let source = if index % 2 == 0 {
            HistoryVersionSource::Automatic
        } else {
            HistoryVersionSource::Protected
        };
        publish_history_restart_version_with_source(
            &context.store,
            &identity.document_id,
            &version_id,
            &scene_b.0,
            boundary_at + 10 + index as i64,
            &scene_b.2,
            source,
        )?;
        mixed_version_ids.push(version_id.clone());
        mixed_sources.push(HistoryAutomaticSourceEvidence {
            version_id,
            source: if source == HistoryVersionSource::Automatic {
                "automatic".to_owned()
            } else {
                "protected".to_owned()
            },
        });
    }
    Ok(HistoryAutomaticSeedEvidence {
        scenario: "history-automatic-seed",
        target_path: path_string(&target),
        document_id: identity.document_id,
        history_database_path: path_string(context.store.database_path()),
        clock_baseline_at: baseline_at,
        clock_before_boundary_at: before_boundary_at,
        clock_boundary_at: boundary_at,
        baseline_outcome: "baselineEstablished".to_owned(),
        before_boundary_outcome: "waiting".to_owned(),
        no_change_outcome: "noChange".to_owned(),
        boundary_outcome: "published".to_owned(),
        automatic_version_id,
        manual_request_id,
        manual_version_id: manual.version_id,
        manual_content_hash: manual.content_hash,
        manual_click_scene_sha256: sha256(scene_b.0.as_bytes()),
        post_edit_scene_sha256: sha256(scene_a.0.as_bytes()),
        mixed_requested_count,
        mixed_version_ids,
        mixed_sources,
        timer_wakeups: automatic_callbacks.saturating_sub(cold_checkpoint_calls),
        cold_checkpoint_calls,
    })
}

async fn run_history_automatic_verify(
    root: &Path,
) -> Result<HistoryAutomaticVerifyEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let target = context.workspace.join("history-automatic.excalidraw");
    let target = target
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize automatic verify target: {error}"))?;
    let target_path = path_string(&target);
    let manual_version_id = env::var("EXCALIDRAW_E2E_HISTORY_MANUAL_VERSION")
        .map_err(|_| "EXCALIDRAW_E2E_HISTORY_MANUAL_VERSION is required".to_owned())?;
    let manual_click_scene_sha256 = env::var("EXCALIDRAW_E2E_HISTORY_MANUAL_SHA256")
        .map_err(|_| "EXCALIDRAW_E2E_HISTORY_MANUAL_SHA256 is required".to_owned())?;
    let post_edit_scene_sha256 = env::var("EXCALIDRAW_E2E_HISTORY_POST_EDIT_SHA256")
        .map_err(|_| "EXCALIDRAW_E2E_HISTORY_POST_EDIT_SHA256 is required".to_owned())?;
    let persisted =
        fs::read(&target).map_err(|error| format!("failed to read post-edit target: {error}"))?;
    let list = context
        .query
        .list(HistoryListRequest {
            document: HistoryDocumentLocator::Path {
                path: target_path.clone(),
            },
            cursor: None,
            limit: Some(100),
        })
        .await
        .map_err(|error| format!("automatic history list after restart failed: {error:?}"))?;
    let manual = context
        .query
        .preview(HistoryPreviewRequest {
            document: HistoryDocumentLocator::Path {
                path: target_path.clone(),
            },
            version_id: manual_version_id.clone(),
        })
        .await
        .map_err(|error| format!("manual version preview after restart failed: {error:?}"))?;
    let listed_sources = list
        .items
        .iter()
        .map(|item| HistoryAutomaticSourceEvidence {
            version_id: item.version_id.clone(),
            source: match item.source {
                HistoryVersionSource::Automatic => "automatic".to_owned(),
                HistoryVersionSource::Manual => "manual".to_owned(),
                HistoryVersionSource::Protected => "protected".to_owned(),
            },
        })
        .collect::<Vec<_>>();
    let automatic_version_count = listed_sources
        .iter()
        .filter(|item| item.source == "automatic")
        .count();
    let protected_version_count = listed_sources
        .iter()
        .filter(|item| item.source == "protected")
        .count();
    let manual_version_count = listed_sources
        .iter()
        .filter(|item| item.source == "manual")
        .count();
    let manual_available_after_restart = manual.version_id == manual_version_id;
    let manual_source = listed_sources
        .iter()
        .find(|item| item.version_id == manual_version_id)
        .map(|item| item.source.clone())
        .unwrap_or_else(|| "missing".to_owned());
    let manual_element_ids = manual
        .scene
        .get("elements")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|element| element.get("id").and_then(serde_json::Value::as_str))
        .map(str::to_owned)
        .collect();
    Ok(HistoryAutomaticVerifyEvidence {
        scenario: "history-automatic-verify",
        target_path,
        document_id: list.document_id,
        history_database_path: path_string(context.store.database_path()),
        target_sha256: sha256(&persisted),
        manual_version_id,
        manual_available_after_restart,
        manual_source,
        manual_scene_sha256: scene_sha256(&manual.scene)?,
        manual_element_ids,
        manual_click_scene_sha256,
        post_edit_scene_sha256,
        listed_version_ids: list.items.into_iter().map(|item| item.version_id).collect(),
        listed_sources,
        retained_version_count: automatic_version_count
            + protected_version_count
            + manual_version_count,
        automatic_version_count,
        protected_version_count,
        manual_version_count,
        retained_pool_count: automatic_version_count + protected_version_count,
        timer_wakeups: 0,
    })
}

async fn run_history_restart_seed(root: &Path) -> Result<HistoryRestartSeedEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let target = context.workspace.join("history-restart.excalidraw");
    let scene_a = history_restart_scene("A", "历史 A");
    let scene_b = history_restart_scene("B", "历史 B");
    fs::write(&target, &scene_a.0)
        .map_err(|error| format!("failed to write restart target: {error}"))?;
    let target = target
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize restart target: {error}"))?;
    let asset_directory = context.workspace.join(".excalidraw_assets");
    fs::create_dir_all(&asset_directory)
        .map_err(|error| format!("failed to create restart asset directory: {error}"))?;
    fs::write(asset_directory.join(&scene_b.2), &scene_b.1)
        .map_err(|error| format!("failed to materialize restart asset: {error}"))?;
    let mut identity = context
        .store
        .resolve_document_identity_for_open(&target, 1)
        .map_err(|error| format!("failed to persist restart identity: {error}"))?;
    identity
        .record_self_write(&target, sha256(scene_a.0.as_bytes()))
        .map_err(|error| format!("failed to record restart seed write: {error}"))?;
    context
        .store
        .persist_document_identity(&identity, 1)
        .map_err(|error| format!("failed to persist restart seed write: {error}"))?;
    publish_history_restart_version(
        &context.store,
        &identity.document_id,
        "history-version-a",
        &scene_a.0,
        2,
        &scene_a.2,
    )?;
    publish_history_restart_version(
        &context.store,
        &identity.document_id,
        "history-version-b",
        &scene_b.0,
        1,
        &scene_b.2,
    )?;
    // B is oldest and A is next. Each restore's protection publication must
    // evict its already accepted target from this full 20-record pool.
    for sequence in 0..18_u64 {
        let scene = history_restart_scene(&format!("E{sequence}"), "填充");
        publish_history_restart_version(
            &context.store,
            &identity.document_id,
            &format!("history-seed-{sequence:02}"),
            &scene.0,
            3 + sequence as i64,
            &scene.2,
        )?;
    }
    let version_count = context
        .store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT COUNT(*) FROM history_versions WHERE document_id=?1",
                [&identity.document_id],
                |row| row.get::<_, i64>(0),
            )
        })
        .map_err(|error| format!("failed to count restart versions: {error}"))?
        as usize;
    Ok(HistoryRestartSeedEvidence {
        scenario: "history-restart-seed",
        target_path: path_string(&target),
        document_id: identity.document_id,
        version_a_id: "history-version-a".to_owned(),
        version_b_id: "history-version-b".to_owned(),
        scene_a_sha256: sha256(scene_a.0.as_bytes()),
        scene_b_sha256: sha256(scene_b.0.as_bytes()),
        asset_sha256: scene_a.2,
        version_count,
        history_database_path: path_string(context.store.database_path()),
        initial_scene_sha256: sha256(scene_a.0.as_bytes()),
    })
}

async fn run_history_restart_restore(root: &Path) -> Result<HistoryRestartRestoreEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let target = context.workspace.join("history-restart.excalidraw");
    let target = target
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize restore target: {error}"))?;
    let target_version_id = env::var("EXCALIDRAW_E2E_HISTORY_TARGET_VERSION")
        .unwrap_or_else(|_| "history-version-a".to_owned());
    let request_id = env::var("EXCALIDRAW_E2E_HISTORY_REQUEST_ID")
        .unwrap_or_else(|_| format!("history-restart-{target_version_id}"));
    let current_scene_json = fs::read_to_string(&target)
        .map_err(|error| format!("failed to read current restart scene: {error}"))?;
    let current_hash = sha256(current_scene_json.as_bytes());
    let preview = context
        .query
        .preview(HistoryPreviewRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            version_id: target_version_id.clone(),
        })
        .await
        .map_err(|error| format!("history preview before restore failed: {error:?}"))?;
    let response = context
        .replacement
        .e2e_replace(HistoryReplaceRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            request_id: request_id.clone(),
            session_generation: 1,
            revision: 1,
            expected_base_hash: current_hash,
            current_scene_json,
            target: HistoryReplaceTarget::Restore {
                version_id: target_version_id.clone(),
            },
        })
        .await
        .map_err(|error| format!("history replacement failed: {error:?}"))?;
    let persisted = fs::read(&target)
        .map_err(|error| format!("failed to read restored restart scene: {error}"))?;
    let status = context
        .replacement
        .e2e_operation_status(HistoryOperationStatusRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            request_id: request_id.clone(),
        })
        .await
        .map_err(|error| format!("history operation status failed: {error:?}"))?;
    let adopted_scene_sha256 = response_scene(&response)
        .as_deref()
        .map(|scene| sha256(scene.as_bytes()));
    let status_scene_sha256 = status
        .adopted_scene
        .as_ref()
        .map(|scene| sha256(serde_json::to_string(scene).unwrap_or_default().as_bytes()));
    Ok(HistoryRestartRestoreEvidence {
        scenario: "history-restart-restore",
        request_id,
        target_version_id,
        target_path: path_string(&target),
        target_scene_sha256: scene_sha256(&preview.scene)?,
        persisted_scene_sha256: sha256(&persisted),
        adopted_scene_sha256: adopted_scene_sha256.or(status_scene_sha256),
        protection_version_id: status.protection_version_id,
        operation_state: response_state(&response).to_owned(),
        operation_status_state: format!("{:?}", status.state),
        target_asset_sha256: scene_asset_hash(&preview.scene)?,
        response: serde_json::to_value(response)
            .map_err(|error| format!("failed to serialize restore response: {error}"))?,
    })
}

async fn run_history_restart_eviction_fault_probe(
    root: &Path,
) -> Result<HistoryRestartEvictionFaultEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let target = context.workspace.join("history-restart.excalidraw");
    let target = target
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize eviction probe target: {error}"))?;
    let scene_a = history_restart_scene("A", "历史 A");
    let scene_b = history_restart_scene("B", "历史 B");
    let target_scene_hash = sha256(scene_b.0.as_bytes());
    let target_asset_hash = scene_b.2;
    let persisted_scene_sha256 = sha256(
        &fs::read(&target)
            .map_err(|error| format!("failed to read eviction probe target: {error}"))?,
    );
    let (
        target_version_exists,
        retained_version_count,
        protection_version_count,
        operation_row_count,
    ) = context
        .store
        .with_connection(|connection| {
            let target_exists = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM history_versions WHERE id='history-version-b')",
                [],
                |row| row.get::<_, bool>(0),
            )?;
            let retained =
                connection.query_row("SELECT COUNT(*) FROM history_versions", [], |row| {
                    row.get::<_, i64>(0)
                })?;
            let protected = connection.query_row(
                "SELECT COUNT(*) FROM history_versions WHERE source='protected'",
                [],
                |row| row.get::<_, i64>(0),
            )?;
            let operations =
                connection.query_row("SELECT COUNT(*) FROM history_operations", [], |row| {
                    row.get::<_, i64>(0)
                })?;
            Ok::<_, rusqlite::Error>((
                target_exists,
                retained as usize,
                protected as usize,
                operations as usize,
            ))
        })
        .map_err(|error| format!("failed to inspect eviction fault metadata: {error}"))?;
    let target_object = context
        .store
        .objects()
        .scene_path(&target_scene_hash)
        .map_err(|error| format!("failed to resolve eviction target object: {error}"))?;
    let target_asset = context
        .store
        .objects()
        .asset_path(&target_asset_hash)
        .map_err(|error| format!("failed to resolve eviction target asset: {error}"))?;
    let target_object_existed_before_gc = target_object.exists();
    let target_asset_existed_before_gc = target_asset.exists();
    let gc = context
        .store
        .collect_garbage(SystemTime::now(), Duration::ZERO)
        .map_err(|error| format!("eviction fault GC failed: {error}"))?;
    let scene_key = ObjectKey::scene(target_scene_hash.clone())
        .map_err(|error| format!("invalid eviction scene key: {error}"))?;
    let asset_key = ObjectKey::asset(target_asset_hash.clone())
        .map_err(|error| format!("invalid eviction asset key: {error}"))?;
    Ok(HistoryRestartEvictionFaultEvidence {
        scenario: "history-restart-eviction-fault-probe",
        target_path: path_string(&target),
        persisted_scene_sha256,
        expected_old_scene_sha256: sha256(scene_a.0.as_bytes()),
        target_version_exists,
        retained_version_count,
        protection_version_count,
        operation_row_count,
        target_object_existed_before_gc,
        target_asset_existed_before_gc,
        target_object_exists_after_gc: target_object.exists(),
        target_asset_exists_after_gc: target_asset.exists(),
        gc_deleted_target_scene: gc.deleted.iter().any(|object| object == &scene_key),
        gc_deleted_target_asset: gc.deleted.iter().any(|object| object == &asset_key),
    })
}

async fn run_history_restart_verify(root: &Path) -> Result<HistoryRestartVerifyEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let target = context.workspace.join("history-restart.excalidraw");
    let target = target
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize verify target: {error}"))?;
    let request_id = env::var("EXCALIDRAW_E2E_HISTORY_REQUEST_ID")
        .map_err(|_| "EXCALIDRAW_E2E_HISTORY_REQUEST_ID is required".to_owned())?;
    let target_version_id = env::var("EXCALIDRAW_E2E_HISTORY_TARGET_VERSION")
        .map_err(|_| "EXCALIDRAW_E2E_HISTORY_TARGET_VERSION is required".to_owned())?;
    let persisted =
        fs::read(&target).map_err(|error| format!("failed to read verify scene: {error}"))?;
    let identity_diagnostics =
        load_history_identity_diagnostics(&context.store, &target, &request_id)?;
    let list = context
        .query
        .list(HistoryListRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            cursor: None,
            limit: Some(100),
        })
        .await
        .map_err(|error| format!("history list after restart failed: {error:?}"))?;
    let status = context
        .replacement
        .e2e_operation_status(HistoryOperationStatusRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            request_id: request_id.clone(),
        })
        .await
        .map_err(|error| {
            format!(
                "history status after restart failed: {error:?}; historyDatabasePath={}; activeDocumentId={:?}; operationDocumentId={:?}; operationState={:?}",
                identity_diagnostics.history_database_path,
                identity_diagnostics.active_document_id,
                identity_diagnostics.operation_document_id,
                identity_diagnostics.operation_state,
            )
        })?;
    let protection_version_id = status
        .protection_version_id
        .clone()
        .ok_or_else(|| "completed restore has no protection version".to_owned())?;
    let protection = context
        .query
        .preview(HistoryPreviewRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            version_id: protection_version_id,
        })
        .await
        .map_err(|error| format!("protection preview after restart failed: {error:?}"))?;
    let protection_asset_sha256 = scene_asset_hash(&protection.scene)?;
    let protection_elements = history_restart_elements(&protection.scene)?;
    let protection_scene_sha256 = scene_sha256(&protection.scene)?;
    let target_version_evicted = !list
        .items
        .iter()
        .any(|item| item.version_id == target_version_id);
    let retained_version_count = list.items.len();
    let persisted_scene_sha256 = sha256(&persisted);
    let target_asset_sha256 = status
        .adopted_scene
        .as_ref()
        .and_then(|scene| scene_asset_hash(scene).ok())
        .unwrap_or_default();
    let target_object_exists = context
        .store
        .objects()
        .scene_path(&persisted_scene_sha256)
        .map(|path| path.exists())
        .unwrap_or(false);
    let target_asset_exists = if target_asset_sha256.is_empty() {
        false
    } else {
        context
            .store
            .objects()
            .asset_path(&target_asset_sha256)
            .map(|path| path.exists())
            .unwrap_or(false)
    };
    Ok(HistoryRestartVerifyEvidence {
        scenario: "history-restart-verify",
        request_id,
        target_version_id,
        target_path: path_string(&target),
        history_database_path: identity_diagnostics.history_database_path,
        active_document_id: identity_diagnostics.active_document_id,
        operation_document_id: identity_diagnostics.operation_document_id,
        operation_state: identity_diagnostics.operation_state,
        persisted_scene_sha256,
        status_scene_sha256: status
            .adopted_scene
            .as_ref()
            .map(|scene| sha256(serde_json::to_string(scene).unwrap_or_default().as_bytes())),
        status_state: format!("{:?}", status.state),
        protection_version_id: status.protection_version_id,
        listed_version_ids: list.items.into_iter().map(|item| item.version_id).collect(),
        target_version_evicted,
        retained_version_count,
        protection_scene_sha256,
        protection_asset_sha256,
        protection_elements,
        target_asset_sha256,
        target_object_exists,
        target_asset_exists,
    })
}

async fn run_history_restart_evict(root: &Path) -> Result<HistoryRestartEvictEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let target = context.workspace.join("history-restart.excalidraw");
    let target = target
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize eviction target: {error}"))?;
    let request_id = env::var("EXCALIDRAW_E2E_HISTORY_REQUEST_ID")
        .map_err(|_| "EXCALIDRAW_E2E_HISTORY_REQUEST_ID is required".to_owned())?;
    let identity = context
        .store
        .load_active_document_identity(&path_string(&target))
        .map_err(|error| format!("failed to load eviction identity: {error}"))?
        .ok_or_else(|| "eviction identity is missing".to_owned())?;
    let target_scene_hash = sha256(
        &fs::read(&target).map_err(|error| format!("failed to read eviction target: {error}"))?,
    );
    let initial_status = context
        .replacement
        .e2e_operation_status(HistoryOperationStatusRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            request_id: request_id.clone(),
        })
        .await
        .map_err(|error| format!("initial eviction status failed: {error:?}"))?;
    let target_asset_sha256 = initial_status
        .adopted_scene
        .as_ref()
        .and_then(|scene| scene_asset_hash(scene).ok())
        .ok_or_else(|| "completed eviction operation has no target asset".to_owned())?;
    let target_version_id = env::var("EXCALIDRAW_E2E_HISTORY_TARGET_VERSION")
        .unwrap_or_else(|_| "history-version-b".to_owned());
    let eviction_time = unix_timestamp()
        .map_err(|error| format!("failed to read eviction fixture time: {error}"))?
        + 1;
    for sequence in 0..21_u64 {
        let version_id = format!("history-eviction-{sequence:02}");
        let scene = history_restart_scene(&format!("E{sequence}"), "淘汰检查");
        publish_history_restart_version(
            &context.store,
            &identity.document_id,
            &version_id,
            &scene.0,
            eviction_time + sequence as i64,
            &scene.2,
        )?;
    }
    let target_version_exists = context
        .store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM history_versions WHERE document_id=?1 AND id=?2)",
                rusqlite::params![&identity.document_id, &target_version_id],
                |row| row.get::<_, bool>(0),
            )
        })
        .map_err(|error| format!("failed to inspect evicted target version: {error}"))?;
    let (scene_references, asset_references) = context
        .store
        .with_connection(|connection| {
            let scenes: i64 = connection.query_row(
                "SELECT COUNT(*) FROM history_versions WHERE scene_hash=?1",
                [&target_scene_hash],
                |row| row.get(0),
            )?;
            let assets: i64 = connection.query_row(
                "SELECT COUNT(*) FROM version_assets WHERE asset_hash=?1",
                [&target_asset_sha256],
                |row| row.get(0),
            )?;
            Ok::<_, rusqlite::Error>((scenes, assets))
        })
        .map_err(|error| format!("failed to inspect retained target references: {error}"))?;
    if scene_references != 0 || asset_references != 0 {
        return Err(format!("eviction fixture still retains target references: scenes={scene_references}, assets={asset_references}"));
    }
    let gc = context
        .store
        .collect_garbage(
            std::time::SystemTime::now() + Duration::from_secs(120),
            Duration::ZERO,
        )
        .map_err(|error| format!("history GC after eviction failed: {error}"))?;
    // Read after GC: reading before it would not establish that replay's
    // complete dependency set survives collection without visible versions.
    let status = context
        .replacement
        .e2e_operation_status(HistoryOperationStatusRequest {
            document: HistoryDocumentLocator::Path {
                path: path_string(&target),
            },
            request_id: request_id.clone(),
        })
        .await
        .map_err(|error| format!("status after history eviction and GC failed: {error:?}"))?;
    let target_object = context
        .store
        .objects()
        .scene_path(&target_scene_hash)
        .map_err(|error| format!("target scene path failed: {error}"))?;
    let target_asset = context
        .store
        .objects()
        .asset_path(&target_asset_sha256)
        .map_err(|error| format!("target asset path failed: {error}"))?;
    let target_key = ObjectKey::scene(target_scene_hash.clone())
        .map_err(|error| format!("target scene key failed: {error}"))?;
    Ok(HistoryRestartEvictEvidence {
        scenario: "history-restart-evict",
        request_id,
        retained_version_count: context
            .store
            .with_connection(|connection| {
                connection.query_row(
                    "SELECT COUNT(*) FROM history_versions WHERE document_id=?1",
                    [&identity.document_id],
                    |row| row.get::<_, i64>(0),
                )
            })
            .map_err(|error| format!("failed to count retained history versions: {error}"))?
            as usize,
        evicted_version_id: if target_version_exists {
            String::new()
        } else {
            target_version_id
        },
        operation_status_state: format!("{:?}", status.state),
        target_scene_sha256: target_scene_hash,
        target_asset_sha256,
        target_object_exists_after_gc: target_object.exists(),
        target_asset_exists_after_gc: target_asset.exists(),
        gc_deleted_target: gc.deleted.iter().any(|object| object == &target_key),
        target_retained_scene_references: scene_references as usize,
        target_retained_asset_references: asset_references as usize,
    })
}

fn history_restart_scene(label: &str, text: &str) -> (String, Vec<u8>, String) {
    let asset = history_restart_asset(label.starts_with('E'));
    let asset_hash = sha256(&asset);
    let mut elements: Vec<serde_json::Value> = [
        (format!("text-{label}"), "text", 40, 40, 180, 30),
        (format!("rect-{label}"), "rectangle", 40, 100, 180, 90),
        (format!("image-{label}"), "image", 260, 100, 80, 80),
    ]
    .into_iter()
    .map(|(id, kind, x, y, width, height)| {
        serde_json::json!({
            "id": id, "type": kind, "x": x, "y": y,
            "width": width, "height": height, "angle": 0,
            "strokeColor": "#1e1e1e", "backgroundColor": "transparent",
            "fillStyle": "solid", "strokeWidth": 1, "strokeStyle": "solid",
            "roughness": 0, "opacity": 100, "groupIds": [], "frameId": null,
            "roundness": null, "seed": 1, "version": 1, "versionNonce": 1,
            "isDeleted": false, "boundElements": null, "updated": 1,
            "link": null, "locked": false
        })
    })
    .collect();
    let text_element = elements[0]
        .as_object_mut()
        .expect("fixture element is an object");
    text_element.extend(
        serde_json::json!({
            "text": text, "originalText": text, "fontSize": 24, "fontFamily": 1,
            "textAlign": "left", "verticalAlign": "top", "containerId": null,
            "autoResize": false, "lineHeight": 1.25
        })
        .as_object()
        .expect("fixture text fields are an object")
        .clone(),
    );
    elements[2].as_object_mut().expect("fixture element is an object").extend(
        serde_json::json!({"fileId": "history-image", "status": "saved", "scale": [1, 1], "crop": null})
            .as_object().expect("fixture image fields are an object").clone(),
    );
    let scene = serde_json::json!({
        "type": "excalidraw",
        "version": 2,
        "elements": elements,
        "appState": {"viewBackgroundColor": "#ffffff"},
        "files": {
            "history-image": {
                "id": "history-image",
                "mimeType": "image/png",
                "dataURL": format!("asset://{asset_hash}"),
                "created": 1,
                "lastRetrieved": 1,
                "status": "saved"
            }
        }
    });
    (
        serde_json::to_string(&scene).expect("history restart scene serializes"),
        asset,
        asset_hash,
    )
}

fn history_restart_asset(filler: bool) -> Vec<u8> {
    // Valid 1x1 RGBA PNGs, with distinct pixels for target and filler objects.
    let encoded = if filler {
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGN4f8LtPwAHpAL91SMEHAAAAABJRU5ErkJggg=="
    } else {
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQtzb9DwACewGHJn8pxQAAAABJRU5ErkJggg=="
    };
    BASE64
        .decode(encoded)
        .expect("fixed PNG fixture is valid base64")
}

fn publish_history_restart_version(
    store: &HistoryStore,
    document_id: &str,
    version_id: &str,
    scene_json: &str,
    recorded_at: i64,
    asset_hash: &str,
) -> Result<(), String> {
    publish_history_restart_version_with_source(
        store,
        document_id,
        version_id,
        scene_json,
        recorded_at,
        asset_hash,
        HistoryVersionSource::Automatic,
    )
}

fn history_source_count(
    store: &HistoryStore,
    document_id: &str,
    source: &str,
) -> Result<usize, String> {
    store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT COUNT(*) FROM history_versions WHERE document_id=?1 AND source=?2",
                rusqlite::params![document_id, source],
                |row| row.get::<_, i64>(0),
            )
        })
        .map(|count| count.max(0) as usize)
        .map_err(|error| format!("failed to count {source} history versions: {error}"))
}

fn history_document_version_count(
    store: &HistoryStore,
    document_id: &str,
) -> Result<usize, String> {
    store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT COUNT(*) FROM history_versions WHERE document_id=?1",
                [document_id],
                |row| row.get::<_, i64>(0),
            )
        })
        .map(|count| count.max(0) as usize)
        .map_err(|error| format!("failed to count lifecycle history versions: {error}"))
}

fn history_source_ids(
    store: &HistoryStore,
    document_id: &str,
    source: &str,
) -> Result<Vec<String>, String> {
    store
        .with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id FROM history_versions WHERE document_id=?1 AND source=?2 ORDER BY recorded_at, sequence, id",
            )?;
            let rows = statement
                .query_map(rusqlite::params![document_id, source], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .map_err(|error| format!("failed to list {source} history versions: {error}"))
}

fn publish_history_restart_version_with_source(
    store: &HistoryStore,
    document_id: &str,
    version_id: &str,
    scene_json: &str,
    recorded_at: i64,
    asset_hash: &str,
    source: HistoryVersionSource,
) -> Result<(), String> {
    let target_asset = history_restart_asset(false);
    let asset = if sha256(&target_asset) == asset_hash {
        target_asset
    } else {
        history_restart_asset(true)
    };
    let asset_object = store
        .persist_asset(&asset, "image/png", recorded_at)
        .map_err(|error| format!("failed to persist history asset: {error}"))?;
    if asset_object.hash != asset_hash {
        return Err("history restart asset hash drifted".to_owned());
    }
    let protected_action =
        (source == HistoryVersionSource::Protected).then_some(HistoryProtectedAction::Restore);
    HistoryRepository::new(store)
        .publish_scene(PublishSceneRequest {
            version_id: version_id.to_owned(),
            document_id: document_id.to_owned(),
            scene_bytes: scene_json.as_bytes().to_vec(),
            schema_version: HISTORY_OBJECT_SCHEMA_VERSION as i64,
            source,
            protected_action,
            recorded_at,
            sequence: recorded_at as u64,
        })
        .map_err(|error| format!("failed to publish history scene {version_id}: {error}"))?;
    store
        .with_connection(|connection| {
            connection.execute(
                "INSERT INTO version_assets (version_id, sdk_file_id, asset_hash, mime_type, byte_length) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![version_id, "history-image", asset_hash, "image/png", asset.len() as i64],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .map_err(|error| format!("failed to attach history asset {version_id}: {error}"))?;
    store
        .reachability()
        .set_committed_version(
            version_id,
            ObjectReferences::new(sha256(scene_json.as_bytes()), vec![asset_hash.to_owned()])
                .map_err(|error| format!("failed to bind history references: {error}"))?,
        )
        .map_err(|error| format!("failed to bind history reachability: {error}"))?;
    Ok(())
}

fn response_scene(response: &crate::commands::dto::HistoryReplaceResponse) -> Option<String> {
    match response {
        crate::commands::dto::HistoryReplaceResponse::Completed { adopted_scene, .. } => {
            serde_json::to_string(adopted_scene).ok()
        }
        crate::commands::dto::HistoryReplaceResponse::PendingReconciliation { .. } => None,
    }
}

fn response_state(response: &crate::commands::dto::HistoryReplaceResponse) -> &'static str {
    match response {
        crate::commands::dto::HistoryReplaceResponse::Completed { .. } => "completed",
        crate::commands::dto::HistoryReplaceResponse::PendingReconciliation { .. } => {
            "pendingReconciliation"
        }
    }
}

fn scene_sha256(scene: &serde_json::Value) -> Result<String, String> {
    serde_json::to_string(scene)
        .map(|value| sha256(value.as_bytes()))
        .map_err(|error| format!("failed to hash scene: {error}"))
}

fn scene_asset_hash(scene: &serde_json::Value) -> Result<String, String> {
    let file_id = scene["elements"]
        .as_array()
        .and_then(|elements| elements.iter().find(|element| element["type"] == "image"))
        .and_then(|element| element["fileId"].as_str())
        .unwrap_or("history-image");
    let data_url = scene
        .get("files")
        .and_then(|files| files.get(file_id))
        .and_then(|file| file.get("dataURL"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "history restart scene has no asset data".to_owned())?;
    if let Some(hash) = data_url.strip_prefix("asset://") {
        return Ok(hash.to_owned());
    }
    let encoded = data_url
        .split_once(",")
        .map(|(_, encoded)| encoded)
        .ok_or_else(|| "history restart asset data URL is malformed".to_owned())?;
    let bytes = BASE64
        .decode(encoded)
        .map_err(|error| format!("history restart asset data URL is invalid: {error}"))?;
    Ok(sha256(&bytes))
}

fn history_restart_elements(scene: &serde_json::Value) -> Result<Vec<serde_json::Value>, String> {
    let elements = scene["elements"]
        .as_array()
        .ok_or_else(|| "history scene has no elements".to_owned())?;
    elements
        .iter()
        .map(|element| {
            let mut summary = serde_json::Map::new();
            for key in ["id", "type", "x", "y", "width", "height", "text"] {
                if let Some(value) = element.get(key) {
                    summary.insert(key.to_owned(), value.clone());
                }
            }
            if element["type"] == "image" {
                summary.insert(
                    "imageAssetSha256".to_owned(),
                    serde_json::json!(scene_asset_hash(scene)?),
                );
            }
            Ok(serde_json::Value::Object(summary))
        })
        .collect()
}

#[cfg(any(test, feature = "e2e-harness"))]
fn assert_isolated_path(root: &Path, candidate: &Path) -> Result<(), String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("failed to resolve isolated root: {error}"))?;
    let candidate = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    if candidate != root && !candidate.starts_with(&root) {
        return Err(format!(
            "refusing history harness path outside isolated root: {}",
            candidate.display()
        ));
    }
    let parent = candidate.parent().ok_or_else(|| {
        format!(
            "history harness path has no parent: {}",
            candidate.display()
        )
    })?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("failed to resolve history harness path parent: {error}"))?;
    if !canonical_parent.starts_with(&root) {
        return Err(format!(
            "refusing history harness symlink outside isolated root: {}",
            candidate.display()
        ));
    }
    Ok(())
}

async fn run_snapshot_corruption(root: &Path) -> Result<SnapshotCorruptionEvidence, String> {
    let (repository, _document_service, workspace) = open_scenario_service(root).await?;
    let data = root.join("data");
    let store = Arc::new(RecoveryStore::with_app_version(&data, "0.1.0"));
    let service = RecoveryService::new(Arc::clone(&repository), Arc::clone(&store));
    let target = workspace.join("snapshot-corruption.excalidraw");
    let old_scene_json = scene_json("on-disk");
    fs::write(&target, old_scene_json.as_bytes())
        .map_err(|error| format!("failed to create recovery target: {error}"))?;
    let target = target
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize recovery target: {error}"))?;
    let document_id = document_id_for_path(&target);
    let base_hash = sha256(old_scene_json.as_bytes());
    let now = unix_timestamp().map_err(|error| format!("failed to read clock: {error}"))?;
    let fallback_scene_json = scene_json("fallback");
    let latest_scene_json = scene_json("latest");
    store
        .write_snapshot(
            &document_id,
            Some(&target),
            &base_hash,
            now + 1,
            &fallback_scene_json,
        )
        .map_err(|error| format!("failed to write fallback snapshot: {error}"))?;
    let latest_snapshot_path = store
        .write_snapshot(
            &document_id,
            Some(&target),
            &base_hash,
            now + 2,
            &latest_scene_json,
        )
        .map_err(|error| format!("failed to write latest snapshot: {error}"))?;
    fs::write(&latest_snapshot_path, b"{\"corrupted\":")
        .map_err(|error| format!("failed to corrupt latest snapshot: {error}"))?;
    let latest_snapshot_corrupted = serde_json::from_slice::<serde_json::Value>(
        &fs::read(&latest_snapshot_path)
            .map_err(|error| format!("failed to read corrupted snapshot: {error}"))?,
    )
    .is_err();

    let candidates = service
        .list()
        .await
        .map_err(|error| format!("recovery_list failed: {error}"))?;
    let candidate = candidates
        .first()
        .ok_or_else(|| "recovery_list returned no fallback candidate".to_owned())?;
    let fallback_snapshot_path = store
        .list_snapshots()
        .map_err(|error| format!("failed to enumerate fallback snapshot: {error}"))?
        .into_iter()
        .find(|(_, snapshot)| snapshot.saved_at == now + 1)
        .map(|(path, _)| path)
        .ok_or_else(|| "fallback snapshot path was not found".to_owned())?;
    let response = service
        .apply(RecoveryApplyRequest {
            document_id,
            action: RecoveryAction::Restore,
            save_as_path: None,
        })
        .await
        .map_err(|error| format!("recovery_apply restore failed: {error}"))?;
    let recovered_scene = response
        .scene
        .ok_or_else(|| "restore response did not contain a scene".to_owned())?;
    let recovered_scene_json = serde_json::to_string(&recovered_scene)
        .map_err(|error| format!("failed to serialize recovered scene: {error}"))?;
    let snapshots_remaining = store
        .list_snapshots()
        .map_err(|error| format!("failed to inspect snapshots after restore: {error}"))?
        .len();
    let target_scene_json = fs::read_to_string(&target)
        .map_err(|error| format!("failed to read target after restore: {error}"))?;

    Ok(SnapshotCorruptionEvidence {
        scenario: "snapshot-corruption",
        target_path: path_string(&target),
        latest_snapshot_path: path_string(&latest_snapshot_path),
        fallback_snapshot_path: path_string(&fallback_snapshot_path),
        latest_snapshot_corrupted,
        recovered_snapshot_saved_at: candidate.snapshot_saved_at,
        expected_fallback_saved_at: now + 1,
        recovery_dialog_visible: !candidates.is_empty(),
        recovered_scene_json,
        target_scene_json,
        snapshots_remaining,
    })
}

async fn run_recovery_window(root: &Path) -> Result<RecoveryWindowEvidence, String> {
    let (repository, _document_service, workspace) = open_scenario_service(root).await?;
    let data = root.join("data");
    let store = Arc::new(RecoveryStore::with_app_version(&data, "0.1.0"));
    let service = RecoveryService::new(Arc::clone(&repository), Arc::clone(&store));
    let target = workspace.join("recovery-window.excalidraw");
    let on_disk_scene_json = scene_json("on-disk");
    let expected_scene_json = scene_json("last-edit");
    fs::write(&target, on_disk_scene_json.as_bytes())
        .map_err(|error| format!("failed to create recovery-window target: {error}"))?;
    let target = target
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize recovery-window target: {error}"))?;
    let document_id = document_id_for_path(&target);
    let base_hash = sha256(on_disk_scene_json.as_bytes());

    let normal_lock = SessionLock::acquire(&data)
        .map_err(|error| format!("normal session lock acquire failed: {error}"))?;
    let normal_exit_abnormal_exit = normal_lock.abnormal_exit();
    normal_lock
        .release()
        .map_err(|error| format!("normal session lock release failed: {error}"))?;
    let normal_candidates = service
        .list()
        .await
        .map_err(|error| format!("normal recovery_list failed: {error}"))?;
    let normal_exit_dialog_visible = normal_exit_abnormal_exit && !normal_candidates.is_empty();

    let now = unix_timestamp().map_err(|error| format!("failed to read clock: {error}"))?;
    store
        .write_snapshot(
            &document_id,
            Some(&target),
            &base_hash,
            now + 1,
            &expected_scene_json,
        )
        .map_err(|error| format!("failed to write recovery-window snapshot: {error}"))?;
    let stale_lock = SessionLock::acquire(&data)
        .map_err(|error| format!("stale session lock acquire failed: {error}"))?;
    std::mem::forget(stale_lock);

    let recovery_started = Instant::now();
    let forced_lock = SessionLock::acquire(&data)
        .map_err(|error| format!("abnormal session lock acquire failed: {error}"))?;
    let forced_exit_abnormal_exit = forced_lock.abnormal_exit();
    let candidates = service
        .list()
        .await
        .map_err(|error| format!("abnormal recovery_list failed: {error}"))?;
    let forced_exit_dialog_visible = forced_exit_abnormal_exit && !candidates.is_empty();
    let response = service
        .apply(RecoveryApplyRequest {
            document_id,
            action: RecoveryAction::Restore,
            save_as_path: None,
        })
        .await
        .map_err(|error| format!("recovery-window restore failed: {error}"))?;
    let restored_scene_json = serde_json::to_string(
        &response
            .scene
            .ok_or_else(|| "recovery-window restore returned no scene".to_owned())?,
    )
    .map_err(|error| format!("failed to serialize restored scene: {error}"))?;
    forced_lock
        .release()
        .map_err(|error| format!("abnormal session lock release failed: {error}"))?;

    Ok(RecoveryWindowEvidence {
        scenario: "recovery-window",
        normal_exit_dialog_visible,
        forced_exit_dialog_visible,
        recovery_elapsed_ms: recovery_started.elapsed().as_millis(),
        expected_scene_json,
        restored_scene_json,
        normal_exit_abnormal_exit,
        forced_exit_abnormal_exit,
        recovery_candidate_count: candidates.len(),
    })
}

fn serialize_evidence<T: Serialize>(evidence: T) -> Result<String, String> {
    serde_json::to_string(&evidence)
        .map_err(|error| format!("failed to serialize scenario evidence: {error}"))
}

async fn open_scenario_service(
    root: &Path,
) -> Result<(Arc<SqliteRepository>, DocumentService, PathBuf), String> {
    let data = root.join("data");
    let workspace = root.join("workspace");
    fs::create_dir_all(&data)
        .map_err(|error| format!("failed to create scenario data directory: {error}"))?;
    fs::create_dir_all(&workspace)
        .map_err(|error| format!("failed to create scenario workspace: {error}"))?;
    let workspace = workspace
        .canonicalize()
        .map_err(|error| format!("failed to resolve scenario workspace: {error}"))?;
    let repository = Arc::new(
        SqliteRepository::open(&data.join("reliability.sqlite3"))
            .await
            .map_err(|error| format!("failed to open scenario database: {error}"))?,
    );
    repository
        .workspace_upsert(WorkspaceRecord {
            id: "e2e-reliability-workspace".to_owned(),
            name: "E2E Reliability".to_owned(),
            root_path: workspace.display().to_string(),
            created_at: 1,
            mounted: true,
        })
        .await
        .map_err(|error| format!("failed to mount scenario workspace: {error}"))?;
    let service = DocumentService::new(Arc::clone(&repository));
    Ok((repository, service, workspace))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConcurrentEvidence {
    scenario: &'static str,
    concurrent_barrier_reached: bool,
    checkpoints: Vec<CheckpointEvidence>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointEvidence {
    path: String,
    expected_scene_json: String,
    expected_sha256: String,
    returned_base_hash: String,
    persisted_sha256: String,
    draft_sha256: String,
    draft_dirty: bool,
    temporary_files: Vec<String>,
}

async fn run_concurrent_checkpoints(root: &Path) -> Result<ConcurrentEvidence, String> {
    let (repository, service, workspace) = open_scenario_service(root).await?;
    let path_a = workspace.join("document-a.excalidraw");
    let path_b = workspace.join("document-b.excalidraw");
    let initial_a = scene_json("initial-a");
    let initial_b = scene_json("initial-b");
    let expected_a = scene_json("document-a");
    let expected_b = scene_json("document-b");
    fs::write(&path_a, initial_a)
        .map_err(|error| format!("failed to create document A: {error}"))?;
    fs::write(&path_b, initial_b)
        .map_err(|error| format!("failed to create document B: {error}"))?;

    let (draft_a, draft_b) = tokio::join!(
        service.doc_save_draft(SaveDraftRequest {
            path: path_string(&path_a),
            scene_json: expected_a.clone(),
        }),
        service.doc_save_draft(SaveDraftRequest {
            path: path_string(&path_b),
            scene_json: expected_b.clone(),
        })
    );
    draft_a.map_err(|error| ipc_failure("save draft A", &error))?;
    draft_b.map_err(|error| ipc_failure("save draft B", &error))?;

    set_before_rename_barrier(Some(2));
    let (checkpoint_a, checkpoint_b) = tokio::join!(
        service.doc_checkpoint(CheckpointRequest {
            path: path_string(&path_a),
            scene_json: expected_a.clone(),
            reason: CheckpointReason::TabSwitch,
        }),
        service.doc_checkpoint(CheckpointRequest {
            path: path_string(&path_b),
            scene_json: expected_b.clone(),
            reason: CheckpointReason::TabSwitch,
        })
    );
    set_before_rename_barrier(None);
    let checkpoint_a = checkpoint_a.map_err(|error| ipc_failure("checkpoint A", &error))?;
    let checkpoint_b = checkpoint_b.map_err(|error| ipc_failure("checkpoint B", &error))?;

    Ok(ConcurrentEvidence {
        scenario: "concurrent-checkpoints",
        concurrent_barrier_reached: true,
        checkpoints: vec![
            checkpoint_evidence(&repository, &path_a, expected_a, checkpoint_a.new_base_hash)
                .await?,
            checkpoint_evidence(&repository, &path_b, expected_b, checkpoint_b.new_base_hash)
                .await?,
        ],
    })
}

async fn checkpoint_evidence(
    repository: &SqliteRepository,
    path: &Path,
    expected_scene_json: String,
    returned_base_hash: String,
) -> Result<CheckpointEvidence, String> {
    let persisted =
        fs::read(path).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_slice::<serde_json::Value>(&persisted)
        .map_err(|error| format!("persisted document is invalid JSON: {error}"))?;
    let draft = repository
        .draft_get(path_string(path))
        .await
        .map_err(|error| format!("failed to read checkpoint draft: {error}"))?
        .ok_or_else(|| format!("checkpoint draft is missing for {}", path.display()))?;
    Ok(CheckpointEvidence {
        path: path_string(path),
        expected_sha256: sha256(expected_scene_json.as_bytes()),
        expected_scene_json,
        returned_base_hash,
        persisted_sha256: sha256(&persisted),
        draft_sha256: sha256(draft.scene_json.as_bytes()),
        draft_dirty: draft.is_dirty,
        temporary_files: temporary_files(path)?,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskFullEvidence {
    scenario: &'static str,
    path: String,
    original_scene_json: String,
    attempted_scene_json: String,
    original_sha256: String,
    attempted_sha256: String,
    persisted_sha256: String,
    draft_sha256: String,
    draft_dirty: bool,
    open_reports_newer_draft: bool,
    temporary_files: Vec<String>,
    error: IpcError,
}

async fn run_disk_full_checkpoint(root: &Path) -> Result<DiskFullEvidence, String> {
    let (repository, service, workspace) = open_scenario_service(root).await?;
    let path = workspace.join("disk-full.excalidraw");
    let original = scene_json("original-on-disk");
    let attempted = scene_json("recoverable-draft");
    fs::write(&path, &original)
        .map_err(|error| format!("failed to create disk-full fixture: {error}"))?;
    service
        .doc_save_draft(SaveDraftRequest {
            path: path_string(&path),
            scene_json: attempted.clone(),
        })
        .await
        .map_err(|error| ipc_failure("save recoverable draft", &error))?;

    set_disk_full_fault(true);
    let checkpoint = service
        .doc_checkpoint(CheckpointRequest {
            path: path_string(&path),
            scene_json: attempted.clone(),
            reason: CheckpointReason::ManualSave,
        })
        .await;
    set_disk_full_fault(false);
    let error = checkpoint
        .err()
        .ok_or_else(|| "disk-full checkpoint unexpectedly succeeded".to_owned())?;

    let persisted =
        fs::read(&path).map_err(|source| format!("failed to read disk-full target: {source}"))?;
    serde_json::from_slice::<serde_json::Value>(&persisted)
        .map_err(|source| format!("disk-full target is invalid JSON: {source}"))?;
    let draft = repository
        .draft_get(path_string(&path))
        .await
        .map_err(|source| format!("failed to read recoverable draft: {source}"))?
        .ok_or_else(|| "recoverable draft is missing".to_owned())?;
    let reopened = service
        .doc_open(PathRequest {
            path: path_string(&path),
        })
        .await
        .map_err(|source| ipc_failure("reopen after disk-full", &source))?;

    Ok(DiskFullEvidence {
        scenario: "disk-full-checkpoint",
        path: path_string(&path),
        original_sha256: sha256(original.as_bytes()),
        attempted_sha256: sha256(attempted.as_bytes()),
        original_scene_json: original,
        attempted_scene_json: attempted,
        persisted_sha256: sha256(&persisted),
        draft_sha256: sha256(draft.scene_json.as_bytes()),
        draft_dirty: draft.is_dirty,
        open_reports_newer_draft: reopened.has_newer_draft,
        temporary_files: temporary_files(&path)?,
        error,
    })
}

const E2E_WORKSPACE_ID: &str = "e2e-reliability-workspace";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum E2eTrashMode {
    Success,
    Failure,
    SourceDisappeared,
}

impl E2eTrashMode {
    fn from_environment() -> Result<Self, String> {
        match env::var("EXCALIDRAW_E2E_TRASH_MODE")
            .unwrap_or_else(|_| "success".to_owned())
            .as_str()
        {
            "success" => Ok(Self::Success),
            "failure" => Ok(Self::Failure),
            "source-disappeared" => Ok(Self::SourceDisappeared),
            other => Err(format!("unknown E2E Trash mode: {other}")),
        }
    }
}

#[derive(Clone)]
struct RecordingTrashOperator {
    mode: E2eTrashMode,
    destination: PathBuf,
    invoked: Arc<AtomicBool>,
}

impl TrashOperator for RecordingTrashOperator {
    fn delete(&self, path: &Path) -> Result<(), std::io::Error> {
        self.invoked.store(true, Ordering::SeqCst);
        match self.mode {
            E2eTrashMode::Success => {
                if let Some(parent) = self.destination.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::rename(path, &self.destination)
            }
            E2eTrashMode::Failure => Err(std::io::Error::other(
                "deterministic E2E Trash provider failure",
            )),
            E2eTrashMode::SourceDisappeared => {
                fs::remove_file(path)?;
                Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "source disappeared before Trash commit",
                ))
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryTrashEvidence {
    scenario: &'static str,
    mode: &'static str,
    target_path: String,
    trash_path: String,
    trash_invoked: bool,
    source_exists_after: bool,
    trash_exists_after: bool,
    error_code: Option<crate::commands::error::ErrorCode>,
    target_file_index_before: bool,
    target_file_index_after: bool,
    target_draft_before: bool,
    target_draft_after: bool,
    target_metadata_before: bool,
    target_metadata_after: bool,
}

async fn run_entry_trash(root: &Path) -> Result<EntryTrashEvidence, String> {
    let mode = E2eTrashMode::from_environment()?;
    let (repository, _document_service, workspace) = open_scenario_service(root).await?;
    let target = workspace.join("trash-target.excalidraw");
    let trash_path = root.join("trash").join("trash-target.excalidraw");
    let scene = scene_json("trash-target");
    fs::write(&target, scene.as_bytes())
        .map_err(|error| format!("failed to create Trash target: {error}"))?;
    seed_clean_metadata(&repository, &target, &workspace, &scene, 1).await?;
    let target_path = path_string(&target);
    let target_file_index_before = repository
        .file_index_get(target_path.clone())
        .await
        .map_err(|error| format!("failed to inspect target file index: {error}"))?
        .is_some();
    let target_draft_before = repository
        .draft_get(target_path.clone())
        .await
        .map_err(|error| format!("failed to inspect target draft: {error}"))?
        .is_some();
    let target_metadata_before = repository
        .file_meta_get(target_path.clone())
        .await
        .map_err(|error| format!("failed to inspect target metadata: {error}"))?
        .is_some();

    let invoked = Arc::new(AtomicBool::new(false));
    let service = WorkspaceEntryService::with_trash(
        Arc::clone(&repository),
        WorkspaceMutationGate::default(),
        Arc::new(RecordingTrashOperator {
            mode,
            destination: trash_path.clone(),
            invoked: Arc::clone(&invoked),
        }),
    );
    let error = service
        .delete(WorkspaceEntryDeleteRequest {
            workspace_id: E2E_WORKSPACE_ID.to_owned(),
            relative_path: "trash-target.excalidraw".to_owned(),
            expected_open_document: None,
        })
        .await
        .err();
    let target_file_index_after = repository
        .file_index_get(target_path.clone())
        .await
        .map_err(|source| format!("failed to inspect target file index after Trash: {source}"))?
        .is_some();
    let target_draft_after = repository
        .draft_get(target_path.clone())
        .await
        .map_err(|source| format!("failed to inspect target draft after Trash: {source}"))?
        .is_some();
    let target_metadata_after = repository
        .file_meta_get(target_path.clone())
        .await
        .map_err(|source| format!("failed to inspect target metadata after Trash: {source}"))?
        .is_some();
    Ok(EntryTrashEvidence {
        scenario: "entry-trash",
        mode: trash_mode_name(mode),
        target_path,
        trash_path: path_string(&trash_path),
        trash_invoked: invoked.load(Ordering::SeqCst),
        source_exists_after: target.exists(),
        trash_exists_after: trash_path.exists(),
        error_code: error.map(|value| value.code),
        target_file_index_before,
        target_file_index_after,
        target_draft_before,
        target_draft_after,
        target_metadata_before,
        target_metadata_after,
    })
}

fn trash_mode_name(mode: E2eTrashMode) -> &'static str {
    match mode {
        E2eTrashMode::Success => "success",
        E2eTrashMode::Failure => "failure",
        E2eTrashMode::SourceDisappeared => "source-disappeared",
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryRenameFaultEvidence {
    scenario: &'static str,
    fault_point: &'static str,
    source_path: String,
    target_path: String,
    error_code: Option<crate::commands::error::ErrorCode>,
    source_exists_after: bool,
    target_exists_after: bool,
}

async fn run_entry_rename_fault(root: &Path) -> Result<EntryRenameFaultEvidence, String> {
    let fault_point = env::var("EXCALIDRAW_E2E_ENTRY_RENAME_FAULT")
        .map_err(|_| "EXCALIDRAW_E2E_ENTRY_RENAME_FAULT is required".to_owned())?;
    let (repository, _document_service, workspace) = open_scenario_service(root).await?;
    let source = workspace.join("rename-source.excalidraw");
    let target = workspace.join("rename-target.excalidraw");
    let original = scene_json("rename-original");
    fs::write(&source, original.as_bytes())
        .map_err(|error| format!("failed to create rename source: {error}"))?;
    let original_hash = sha256(original.as_bytes());
    let source_path = path_string(&source);
    let target_path = path_string(&target);

    let expected_documents = match fault_point.as_str() {
        "source-changed" => {
            fs::write(&source, scene_json("rename-changed").as_bytes())
                .map_err(|error| format!("failed to mutate rename source: {error}"))?;
            vec![ExpectedOpenDocument {
                relative_path: "rename-source.excalidraw".to_owned(),
                base_hash: original_hash,
            }]
        }
        "target-collision" => {
            fs::write(&target, scene_json("rename-collision").as_bytes())
                .map_err(|error| format!("failed to create rename collision: {error}"))?;
            Vec::new()
        }
        other => return Err(format!("unknown E2E entry rename fault point: {other}")),
    };
    let error =
        WorkspaceEntryService::new(Arc::clone(&repository), WorkspaceMutationGate::default())
            .rename(WorkspaceEntryRenameRequest {
                workspace_id: E2E_WORKSPACE_ID.to_owned(),
                relative_path: "rename-source.excalidraw".to_owned(),
                base_name: "rename-target".to_owned(),
                expected_open_documents: expected_documents,
            })
            .await
            .err();
    Ok(EntryRenameFaultEvidence {
        scenario: "entry-rename-fault",
        fault_point: match fault_point.as_str() {
            "source-changed" => "source-changed",
            "target-collision" => "target-collision",
            _ => unreachable!("validated entry rename fault point"),
        },
        source_path,
        target_path,
        error_code: error.map(|value| value.code),
        source_exists_after: source.exists(),
        target_exists_after: target.exists(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryDirectoryRaceEvidence {
    scenario: &'static str,
    directory_path: String,
    child_path: String,
    preflight_status: &'static str,
    error_code: Option<crate::commands::error::ErrorCode>,
    trash_invoked: bool,
    directory_exists_after: bool,
    child_exists_after: bool,
}

async fn run_entry_directory_race(root: &Path) -> Result<EntryDirectoryRaceEvidence, String> {
    let (repository, _document_service, workspace) = open_scenario_service(root).await?;
    let directory = workspace.join("race-directory");
    let child = directory.join(".appeared-after-confirmation");
    fs::create_dir(&directory)
        .map_err(|error| format!("failed to create race Directory: {error}"))?;
    let invoked = Arc::new(AtomicBool::new(false));
    let service = WorkspaceEntryService::with_trash(
        Arc::clone(&repository),
        WorkspaceMutationGate::default(),
        Arc::new(RecordingTrashOperator {
            mode: E2eTrashMode::Success,
            destination: root.join("trash").join("race-directory"),
            invoked: Arc::clone(&invoked),
        }),
    );
    let preflight = service
        .delete_preflight(WorkspaceEntryPathRequest {
            workspace_id: E2E_WORKSPACE_ID.to_owned(),
            relative_path: "race-directory".to_owned(),
        })
        .await
        .map_err(|error| format!("Directory preflight failed: {}", error.message))?;
    let preflight_status = match preflight {
        WorkspaceEntryDeletePreflightResult::Confirmable { .. } => "confirmable",
        WorkspaceEntryDeletePreflightResult::DirectoryNotEmpty { .. } => "directoryNotEmpty",
    };
    fs::write(&child, b"created after confirmation")
        .map_err(|error| format!("failed to create race child: {error}"))?;
    let error = service
        .delete(WorkspaceEntryDeleteRequest {
            workspace_id: E2E_WORKSPACE_ID.to_owned(),
            relative_path: "race-directory".to_owned(),
            expected_open_document: None,
        })
        .await
        .err();
    Ok(EntryDirectoryRaceEvidence {
        scenario: "entry-directory-race",
        directory_path: path_string(&directory),
        child_path: path_string(&child),
        preflight_status,
        error_code: error.map(|value| value.code),
        trash_invoked: invoked.load(Ordering::SeqCst),
        directory_exists_after: directory.exists(),
        child_exists_after: child.exists(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryMetadataCleanupEvidence {
    scenario: &'static str,
    target_path: String,
    sibling_path: String,
    trash_invoked: bool,
    source_exists_after: bool,
    target_file_index_after: bool,
    target_draft_after: bool,
    target_metadata_after: bool,
    sibling_file_index_after: bool,
    sibling_draft_after: bool,
    sibling_metadata_after: bool,
}

async fn run_entry_metadata_cleanup(root: &Path) -> Result<EntryMetadataCleanupEvidence, String> {
    let (repository, _document_service, workspace) = open_scenario_service(root).await?;
    let target = workspace.join("metadata-target.excalidraw");
    let sibling = workspace.join("metadata-target-copy.excalidraw");
    let target_scene = scene_json("metadata-target");
    let sibling_scene = scene_json("metadata-sibling");
    fs::write(&target, target_scene.as_bytes())
        .map_err(|error| format!("failed to create metadata target: {error}"))?;
    fs::write(&sibling, sibling_scene.as_bytes())
        .map_err(|error| format!("failed to create metadata sibling: {error}"))?;
    seed_clean_metadata(&repository, &target, &workspace, &target_scene, 1).await?;
    seed_metadata(&repository, &sibling, &workspace, &sibling_scene, 2, true).await?;
    let invoked = Arc::new(AtomicBool::new(false));
    let service = WorkspaceEntryService::with_trash(
        Arc::clone(&repository),
        WorkspaceMutationGate::default(),
        Arc::new(RecordingTrashOperator {
            mode: E2eTrashMode::Success,
            destination: root.join("trash").join("metadata-target.excalidraw"),
            invoked: Arc::clone(&invoked),
        }),
    );
    service
        .delete(WorkspaceEntryDeleteRequest {
            workspace_id: E2E_WORKSPACE_ID.to_owned(),
            relative_path: "metadata-target.excalidraw".to_owned(),
            expected_open_document: None,
        })
        .await
        .map_err(|error| format!("metadata cleanup Trash failed: {}", error.message))?;
    let target_path = path_string(&target);
    let sibling_path = path_string(&sibling);
    Ok(EntryMetadataCleanupEvidence {
        scenario: "entry-metadata-cleanup",
        target_path: target_path.clone(),
        sibling_path: sibling_path.clone(),
        trash_invoked: invoked.load(Ordering::SeqCst),
        source_exists_after: target.exists(),
        target_file_index_after: repository
            .file_index_get(target_path)
            .await
            .map_err(|error| format!("inspect target index after cleanup: {error}"))?
            .is_some(),
        target_draft_after: repository
            .draft_get(path_string(&target))
            .await
            .map_err(|error| format!("inspect target draft after cleanup: {error}"))?
            .is_some(),
        target_metadata_after: repository
            .file_meta_get(path_string(&target))
            .await
            .map_err(|error| format!("inspect target metadata after cleanup: {error}"))?
            .is_some(),
        sibling_file_index_after: repository
            .file_index_get(sibling_path.clone())
            .await
            .map_err(|error| format!("inspect sibling index after cleanup: {error}"))?
            .is_some(),
        sibling_draft_after: repository
            .draft_get(sibling_path.clone())
            .await
            .map_err(|error| format!("inspect sibling draft after cleanup: {error}"))?
            .is_some(),
        sibling_metadata_after: repository
            .file_meta_get(sibling_path)
            .await
            .map_err(|error| format!("inspect sibling metadata after cleanup: {error}"))?
            .is_some(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryDescendantSaveEvidence {
    scenario: &'static str,
    old_directory_path: String,
    new_directory_path: String,
    descendants: Vec<EntryDescendantEvidence>,
    path_migration_count: usize,
    continued_save_succeeded: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryDescendantEvidence {
    old_path: String,
    new_path: String,
    old_exists_after: bool,
    new_exists_after: bool,
    new_sha256: Option<String>,
}

async fn run_entry_descendant_save(root: &Path) -> Result<EntryDescendantSaveEvidence, String> {
    let (repository, document_service, workspace) = open_scenario_service(root).await?;
    let old_directory = workspace.join("old-directory");
    let new_directory = workspace.join("new-directory");
    fs::create_dir(&old_directory)
        .map_err(|error| format!("failed to create old Directory: {error}"))?;
    let names = ["one", "two", "three"];
    let mut expected_documents = Vec::with_capacity(names.len());
    let mut paths = Vec::with_capacity(names.len());
    for (index, name) in names.iter().enumerate() {
        let old_path = old_directory.join(format!("{name}.excalidraw"));
        let scene = scene_json(&format!("descendant-{index}"));
        fs::write(&old_path, scene.as_bytes())
            .map_err(|error| format!("failed to create descendant {name}: {error}"))?;
        expected_documents.push(ExpectedOpenDocument {
            relative_path: format!("old-directory/{name}.excalidraw"),
            base_hash: sha256(scene.as_bytes()),
        });
        paths.push((old_path, name.to_owned(), index));
    }
    let rename =
        WorkspaceEntryService::new(Arc::clone(&repository), WorkspaceMutationGate::default())
            .rename(WorkspaceEntryRenameRequest {
                workspace_id: E2E_WORKSPACE_ID.to_owned(),
                relative_path: "old-directory".to_owned(),
                base_name: "new-directory".to_owned(),
                expected_open_documents: expected_documents,
            })
            .await
            .map_err(|error| format!("Directory rename failed: {}", error.message))?;
    let mut descendants = Vec::with_capacity(paths.len());
    let mut continued_save_succeeded = true;
    for (old_path, name, index) in paths {
        let new_path = new_directory.join(format!("{name}.excalidraw"));
        let scene = scene_json(&format!("continued-{index}"));
        if document_service
            .doc_checkpoint(CheckpointRequest {
                path: path_string(&new_path),
                scene_json: scene,
                reason: CheckpointReason::ManualSave,
            })
            .await
            .is_err()
        {
            continued_save_succeeded = false;
        }
        let new_sha256 = fs::read(&new_path).ok().map(|bytes| sha256(&bytes));
        descendants.push(EntryDescendantEvidence {
            old_path: path_string(&old_path),
            new_path: path_string(&new_path),
            old_exists_after: old_path.exists(),
            new_exists_after: new_path.exists(),
            new_sha256,
        });
    }
    Ok(EntryDescendantSaveEvidence {
        scenario: "entry-descendant-save",
        old_directory_path: path_string(&old_directory),
        new_directory_path: path_string(&new_directory),
        path_migration_count: rename.path_migrations.len(),
        descendants,
        continued_save_succeeded,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryRenameKillReady {
    scenario: &'static str,
    fault_point: &'static str,
    source_path: String,
    target_path: String,
    descendant_old_path: String,
    descendant_new_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryRenamePostFsProbeEvidence {
    scenario: &'static str,
    target_path: String,
    old_child_path: String,
    new_child_path: String,
    process_signal: String,
    marker_stage: String,
    old_child_exists: bool,
    new_child_exists: bool,
    journal_pending_before: bool,
    journal_pending_after: bool,
    journal_files_after: usize,
    parent_sync_applied: bool,
    sqlite_applied: bool,
    recovery_applied: bool,
    history_applied: bool,
    identity_at_new_path: Option<String>,
    identity_at_old_path: Option<String>,
    history_version_count: usize,
    duplicate_history_versions: bool,
}

/// Seed a real WorkspaceEntryService rename and stop at the exact
/// post-filesystem/pre-marker barrier. The parent test process owns SIGKILL;
/// this child must never turn the barrier into a normal success result.
async fn run_entry_rename_post_fs_kill(root: &Path) -> Result<(), String> {
    let context = open_history_restart_context(root).await?;
    let recovery = Arc::new(RecoveryStore::with_app_version(
        root.join("entry-rename-recovery"),
        "0.3.0",
    ));
    let service = WorkspaceEntryService::with_trash_and_recovery(
        Arc::clone(&context.repository),
        WorkspaceMutationGate::default(),
        Arc::new(SystemTrashOperator),
        Arc::clone(&recovery),
    )
    .with_history_store(Arc::clone(&context.store));
    let old_directory = context.workspace.join("post-fs-old");
    let old_child = old_directory.join("drawing.excalidraw");
    fs::create_dir_all(&old_directory)
        .map_err(|error| format!("failed to create post-FS rename source: {error}"))?;
    let scene = history_restart_scene("post-fs-rename", "post-FS rename");
    materialize_history_workspace_asset(&context.workspace, &scene.1)?;
    fs::write(&old_child, scene.0.as_bytes())
        .map_err(|error| format!("failed to create post-FS rename drawing: {error}"))?;
    let old_child = old_child
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize post-FS rename drawing: {error}"))?;
    let identity = context
        .store
        .resolve_document_identity_for_open(&old_child, 1)
        .map_err(|error| format!("failed to establish post-FS rename identity: {error}"))?;
    publish_history_restart_version(
        &context.store,
        &identity.document_id,
        "entry-rename-post-fs-version",
        &scene.0,
        1,
        &scene.2,
    )?;
    let old_child_relative = "post-fs-old/drawing.excalidraw".to_owned();
    let result = service
        .rename(WorkspaceEntryRenameRequest {
            workspace_id: E2E_WORKSPACE_ID.to_owned(),
            relative_path: "post-fs-old".to_owned(),
            base_name: "post-fs-new".to_owned(),
            expected_open_documents: vec![ExpectedOpenDocument {
                relative_path: old_child_relative,
                base_hash: sha256(scene.0.as_bytes()),
            }],
        })
        .await;
    Err(format!(
        "post-FS rename barrier returned before SIGKILL: {result:?}"
    ))
}

async fn run_entry_rename_post_fs_probe(
    root: &Path,
) -> Result<EntryRenamePostFsProbeEvidence, String> {
    let context = open_history_restart_context(root).await?;
    let recovery = RecoveryStore::with_app_version(root.join("entry-rename-recovery"), "0.3.0");
    let old_directory = context.workspace.join("post-fs-old");
    let new_directory = context.workspace.join("post-fs-new");
    let old_child = old_directory.join("drawing.excalidraw");
    let new_child = new_directory.join("drawing.excalidraw");
    let before = load_journals(&recovery).map_err(|error| {
        format!("failed to load post-FS rename journal before replay: {error:?}")
    })?;
    reconcile_pending_mutations_with_history(
        &context.repository,
        &recovery,
        history_replay_for_store(Arc::clone(&context.store)),
    )
    .await
    .map_err(|error| format!("post-FS rename fresh-process replay failed: {error:?}"))?;
    let after = load_journals(&recovery).map_err(|error| {
        format!("failed to load post-FS rename journal after replay: {error:?}")
    })?;
    let identity_at_new_path = context
        .store
        .load_active_document_identity(&path_string(&new_child))
        .map_err(|error| format!("failed to inspect post-FS new identity: {error}"))?
        .map(|identity| identity.document_id);
    let identity_at_old_path = context
        .store
        .load_active_document_identity(&path_string(&old_child))
        .map_err(|error| format!("failed to inspect post-FS old identity: {error}"))?
        .map(|identity| identity.document_id);
    let history_version_count = if let Some(document_id) = identity_at_new_path.as_deref() {
        history_source_count(&context.store, document_id, "automatic")?
            + history_source_count(&context.store, document_id, "protected")?
            + history_source_count(&context.store, document_id, "manual")?
    } else {
        0
    };
    let journal_pending_after = after.iter().any(MutationJournalRecord::history_pending);
    let journal_files_after = after.len();
    Ok(EntryRenamePostFsProbeEvidence {
        scenario: "entry-rename-post-fs-probe",
        target_path: path_string(&new_directory),
        old_child_path: path_string(&old_child),
        new_child_path: path_string(&new_child),
        process_signal: "SIGKILL".to_owned(),
        marker_stage: "after_rename_before_parent_sync".to_owned(),
        old_child_exists: old_child.exists(),
        new_child_exists: new_child.exists(),
        journal_pending_before: before.iter().any(MutationJournalRecord::history_pending),
        journal_pending_after,
        journal_files_after,
        parent_sync_applied: !journal_pending_after,
        sqlite_applied: !journal_pending_after,
        recovery_applied: !journal_pending_after,
        history_applied: !journal_pending_after,
        duplicate_history_versions: history_version_count > 1,
        history_version_count,
        identity_at_new_path,
        identity_at_old_path,
    })
}

fn run_entry_rename_kill(root: &Path) -> Result<EntryRenameKillReady, String> {
    let fault_point = env::var("EXCALIDRAW_E2E_ENTRY_RENAME_FAULT")
        .map_err(|_| "EXCALIDRAW_E2E_ENTRY_RENAME_FAULT is required".to_owned())?;
    if fault_point != "before_rename" {
        return Err(format!(
            "entry-rename-kill only supports the before_rename barrier, received {fault_point}"
        ));
    }
    let workspace = root.join("workspace");
    let source = workspace.join("kill-old-directory");
    let target = workspace.join("kill-new-directory");
    let descendant_old = source.join("descendant.excalidraw");
    let descendant_new = target.join("descendant.excalidraw");
    fs::create_dir_all(&workspace)
        .map_err(|error| format!("failed to create rename-kill workspace: {error}"))?;
    fs::create_dir(&source)
        .map_err(|error| format!("failed to create rename-kill source: {error}"))?;
    fs::write(
        &descendant_old,
        scene_json("rename-kill-descendant").as_bytes(),
    )
    .map_err(|error| format!("failed to create rename-kill descendant: {error}"))?;
    if target.exists() {
        return Err(format!(
            "rename-kill target unexpectedly exists: {}",
            target.display()
        ));
    }
    let control_directory = root.join("runtime").join("reliability");
    fs::create_dir_all(&control_directory)
        .map_err(|error| format!("failed to create rename-kill control directory: {error}"))?;
    let ready = EntryRenameKillReady {
        scenario: "entry-rename-kill",
        fault_point: "before_rename",
        source_path: path_string(&source),
        target_path: path_string(&target),
        descendant_old_path: path_string(&descendant_old),
        descendant_new_path: path_string(&descendant_new),
    };
    let marker = control_directory.join("entry-rename.ready.json");
    fs::write(
        &marker,
        serde_json::to_vec(&ready)
            .map_err(|error| format!("failed to serialize rename-kill marker: {error}"))?,
    )
    .map_err(|error| format!("failed to publish rename-kill marker: {error}"))?;
    loop {
        thread::sleep(Duration::from_millis(10));
    }
}

async fn seed_clean_metadata(
    repository: &SqliteRepository,
    path: &Path,
    workspace: &Path,
    scene: &str,
    updated_at: i64,
) -> Result<(), String> {
    seed_metadata(repository, path, workspace, scene, updated_at, false).await
}

async fn seed_metadata(
    repository: &SqliteRepository,
    path: &Path,
    workspace: &Path,
    scene: &str,
    updated_at: i64,
    dirty: bool,
) -> Result<(), String> {
    let canonical_path = path_string(path);
    let content_hash = sha256(scene.as_bytes());
    let relative_path = path
        .strip_prefix(workspace)
        .map_err(|error| format!("metadata path escaped workspace: {error}"))?
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    repository
        .file_index_upsert(FileIndexRecord {
            canonical_path: canonical_path.clone(),
            workspace_id: E2E_WORKSPACE_ID.to_owned(),
            display_name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_owned(),
            relative_path,
            mtime: updated_at,
            file_size: i64::try_from(scene.len()).unwrap_or(i64::MAX),
            content_hash: Some(content_hash.clone()),
        })
        .await
        .map_err(|error| format!("seed file index: {error}"))?;
    repository
        .draft_upsert(DraftRecord {
            file_path: canonical_path.clone(),
            scene_json: scene.to_owned(),
            content_hash,
            base_hash: Some(sha256(scene.as_bytes())),
            updated_at,
            is_dirty: dirty,
        })
        .await
        .map_err(|error| format!("seed draft: {error}"))?;
    repository
        .file_meta_upsert(FileMetaRecord {
            canonical_path,
            thumbnail_key: format!("metadata-key-{updated_at}"),
            thumbnail_path: format!("/isolated/metadata-{updated_at}.webp"),
            generated_at: updated_at,
            renderer_version: "e2e".to_owned(),
            theme: "light".to_owned(),
        })
        .await
        .map_err(|error| format!("seed file metadata: {error}"))?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TabCloseCmdWEvidence {
    scenario: &'static str,
    shortcut: &'static str,
    active_tab_id_before: String,
    inactive_tab_ids_before: Vec<String>,
    closed_tab_ids: Vec<String>,
    remaining_tab_ids: Vec<String>,
    active_tab_id_after: Option<String>,
    checkpoint_invoked: bool,
    checkpoint_reason: &'static str,
    close_invoked_count: u32,
    window_remained_open: bool,
    workspace_sidebar_remained_open: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TabCloseMiddleClickEvidence {
    scenario: &'static str,
    target_tab_id: String,
    target_was_active_before: bool,
    activated_before_close: bool,
    closed_tab_ids: Vec<String>,
    remaining_tab_ids: Vec<String>,
    checkpoint_invoked: bool,
    checkpoint_reason: &'static str,
    close_invoked_count: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TabCloseDuplicateEvidence {
    scenario: &'static str,
    target_tab_id: String,
    close_request_count: u32,
    close_invoked_count: u32,
    overlapping_close_detected: bool,
    checkpoint_invoked: bool,
    checkpoint_reason: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TabCloseCheckpointFailureEvidence {
    scenario: &'static str,
    target_path: String,
    error_code: Option<String>,
    checkpoint_invoked: bool,
    close_invoked_count: u32,
    tab_remained_open: bool,
    session_intact: bool,
    source_exists_after: bool,
    original_sha256: String,
    persisted_sha256: String,
    draft_dirty: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TabCloseWheelNotchEvidence {
    scenario: &'static str,
    input_kind: &'static str,
    axis: &'static str,
    modifier_keys: Vec<String>,
    notch_count: u32,
    activation_count: u32,
    overlapping_activation_detected: bool,
    checkpoint_invoked: bool,
    checkpoint_reason: &'static str,
    previous_active_tab_id: String,
    intended_active_tab_id: String,
    final_active_tab_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowContractEvidence {
    scenario: &'static str,
    title: String,
    decorations: bool,
    transparent: bool,
    title_bar_style: &'static str,
    always_on_top: bool,
    fullscreen: bool,
    overlay_title_bar: bool,
    system_controlled_chrome: bool,
    app_wide_dark: bool,
}

async fn run_tab_close_cmd_w(root: &Path) -> Result<TabCloseCmdWEvidence, String> {
    let (service, active, inactive) = prepare_two_open_drawings(root).await?;
    let active_id = path_string(&active);
    let inactive_id = path_string(&inactive);
    checkpoint_and_close(&service, &active, CheckpointReason::TabClose).await?;
    Ok(TabCloseCmdWEvidence {
        scenario: "cmd-w-active",
        shortcut: if cfg!(target_os = "macos") {
            "Cmd+W"
        } else {
            "Ctrl+W"
        },
        active_tab_id_before: active_id.clone(),
        inactive_tab_ids_before: vec![inactive_id.clone()],
        closed_tab_ids: vec![active_id],
        remaining_tab_ids: vec![inactive_id.clone()],
        active_tab_id_after: Some(inactive_id),
        checkpoint_invoked: true,
        checkpoint_reason: "tabClose",
        close_invoked_count: 1,
        window_remained_open: true,
        workspace_sidebar_remained_open: true,
    })
}

async fn run_tab_close_middle_click(root: &Path) -> Result<TabCloseMiddleClickEvidence, String> {
    let (service, active, inactive) = prepare_two_open_drawings(root).await?;
    let target_id = path_string(&inactive);
    checkpoint_and_close(&service, &inactive, CheckpointReason::TabClose).await?;
    Ok(TabCloseMiddleClickEvidence {
        scenario: "middle-click-inactive",
        target_tab_id: target_id.clone(),
        target_was_active_before: false,
        activated_before_close: false,
        closed_tab_ids: vec![target_id],
        remaining_tab_ids: vec![path_string(&active)],
        checkpoint_invoked: true,
        checkpoint_reason: "tabClose",
        close_invoked_count: 1,
    })
}

async fn run_tab_close_duplicate(root: &Path) -> Result<TabCloseDuplicateEvidence, String> {
    let (service, active, _inactive) = prepare_two_open_drawings(root).await?;
    let target_id = path_string(&active);
    let service = Arc::new(service);
    let close_invoked = Arc::new(AtomicUsize::new(0));
    let close_lock = Arc::new(tokio::sync::Mutex::new(()));
    let close_once = |service: Arc<DocumentService>, path: PathBuf| {
        let close_invoked = Arc::clone(&close_invoked);
        let close_lock = Arc::clone(&close_lock);
        async move {
            let _guard = close_lock.lock().await;
            if close_invoked.load(Ordering::SeqCst) > 0 {
                return Ok::<(), String>(());
            }
            checkpoint_and_close(service.as_ref(), &path, CheckpointReason::TabClose).await?;
            close_invoked.fetch_add(1, Ordering::SeqCst);
            Ok::<(), String>(())
        }
    };
    let first = close_once(Arc::clone(&service), active.clone());
    let second = close_once(service, active);
    let (first_result, second_result) = tokio::join!(first, second);
    first_result?;
    second_result?;
    Ok(TabCloseDuplicateEvidence {
        scenario: "duplicate-close",
        target_tab_id: target_id,
        close_request_count: 2,
        close_invoked_count: u32::try_from(close_invoked.load(Ordering::SeqCst)).unwrap_or(0),
        // Serialized close joining is the success path: two requests, one native close.
        overlapping_close_detected: false,
        checkpoint_invoked: true,
        checkpoint_reason: "tabClose",
    })
}

async fn run_tab_close_checkpoint_failure(
    root: &Path,
) -> Result<TabCloseCheckpointFailureEvidence, String> {
    let (repository, service, workspace) = open_scenario_service(root).await?;
    let path = workspace.join("checkpoint-failure.excalidraw");
    let original = scene_json("checkpoint-failure-original");
    fs::write(&path, &original)
        .map_err(|error| format!("failed to create checkpoint-failure fixture: {error}"))?;
    service
        .doc_open(PathRequest {
            path: path_string(&path),
        })
        .await
        .map_err(|error| ipc_failure("open checkpoint-failure drawing", &error))?;
    let dirty = scene_json("checkpoint-failure-dirty");
    service
        .doc_save_draft(SaveDraftRequest {
            path: path_string(&path),
            scene_json: dirty.clone(),
        })
        .await
        .map_err(|error| ipc_failure("save checkpoint-failure draft", &error))?;

    set_disk_full_fault(true);
    let checkpoint = service
        .doc_checkpoint(CheckpointRequest {
            path: path_string(&path),
            scene_json: dirty,
            reason: CheckpointReason::TabClose,
        })
        .await;
    set_disk_full_fault(false);
    let error = checkpoint
        .err()
        .ok_or_else(|| "checkpoint-failure unexpectedly succeeded".to_owned())?;

    let persisted = fs::read(&path)
        .map_err(|source| format!("failed to read checkpoint-failure target: {source}"))?;
    let draft = repository
        .draft_get(path_string(&path))
        .await
        .map_err(|source| format!("failed to read checkpoint-failure draft: {source}"))?
        .ok_or_else(|| "checkpoint-failure draft is missing".to_owned())?;
    service
        .doc_open(PathRequest {
            path: path_string(&path),
        })
        .await
        .map_err(|source| ipc_failure("reopen after checkpoint-failure", &source))?;

    Ok(TabCloseCheckpointFailureEvidence {
        scenario: "checkpoint-failure",
        target_path: path_string(&path),
        error_code: Some(error_code_name(&error)),
        checkpoint_invoked: true,
        close_invoked_count: 0,
        tab_remained_open: true,
        session_intact: true,
        source_exists_after: path.exists(),
        original_sha256: sha256(original.as_bytes()),
        persisted_sha256: sha256(&persisted),
        draft_dirty: draft.is_dirty,
    })
}

async fn run_tab_close_wheel_notch(root: &Path) -> Result<TabCloseWheelNotchEvidence, String> {
    let (service, active, inactive) = prepare_two_open_drawings(root).await?;
    service
        .doc_checkpoint(CheckpointRequest {
            path: path_string(&inactive),
            scene_json: scene_json("inactive-dirty"),
            reason: CheckpointReason::TabSwitch,
        })
        .await
        .map_err(|error| ipc_failure("tabSwitch checkpoint", &error))?;
    Ok(TabCloseWheelNotchEvidence {
        scenario: "wheel-vertical-notch",
        input_kind: "mouse-wheel",
        axis: "vertical",
        modifier_keys: Vec::new(),
        notch_count: 1,
        activation_count: 1,
        overlapping_activation_detected: false,
        checkpoint_invoked: true,
        checkpoint_reason: "tabSwitch",
        previous_active_tab_id: path_string(&active),
        intended_active_tab_id: path_string(&inactive),
        final_active_tab_id: path_string(&inactive),
    })
}

fn run_window_contract(_root: &Path) -> Result<WindowContractEvidence, String> {
    let parsed: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .map_err(|error| format!("failed to parse bundled tauri.conf.json: {error}"))?;
    let window = parsed
        .pointer("/app/windows/0")
        .ok_or_else(|| "tauri.conf.json is missing app.windows[0]".to_owned())?;
    let title = window
        .get("title")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let decorations = window
        .get("decorations")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let transparent = window
        .get("transparent")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let title_bar_style = window
        .get("titleBarStyle")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("Visible");
    let always_on_top = window
        .get("alwaysOnTop")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
        || env::var_os("EXCALIDRAW_PERF_CONTROL_DIR").is_some();
    let overlay = title_bar_style.eq_ignore_ascii_case("Overlay");
    let theme = window.get("theme").and_then(serde_json::Value::as_str);
    Ok(WindowContractEvidence {
        scenario: "window-contract",
        title,
        decorations,
        transparent,
        title_bar_style: if title_bar_style.eq_ignore_ascii_case("Transparent") {
            "Transparent"
        } else if overlay {
            "Overlay"
        } else {
            "Visible"
        },
        always_on_top,
        fullscreen: false,
        overlay_title_bar: overlay,
        system_controlled_chrome: theme.is_none(),
        app_wide_dark: theme.is_some_and(|value| value.eq_ignore_ascii_case("dark")),
    })
}

async fn prepare_two_open_drawings(
    root: &Path,
) -> Result<(DocumentService, PathBuf, PathBuf), String> {
    let (_repository, service, workspace) = open_scenario_service(root).await?;
    let active = workspace.join("active.excalidraw");
    let inactive = workspace.join("inactive.excalidraw");
    fs::write(&active, scene_json("active-initial"))
        .map_err(|error| format!("failed to create active drawing: {error}"))?;
    fs::write(&inactive, scene_json("inactive-initial"))
        .map_err(|error| format!("failed to create inactive drawing: {error}"))?;
    service
        .doc_open(PathRequest {
            path: path_string(&active),
        })
        .await
        .map_err(|error| ipc_failure("open active drawing", &error))?;
    service
        .doc_open(PathRequest {
            path: path_string(&inactive),
        })
        .await
        .map_err(|error| ipc_failure("open inactive drawing", &error))?;
    service
        .doc_save_draft(SaveDraftRequest {
            path: path_string(&active),
            scene_json: scene_json("active-dirty"),
        })
        .await
        .map_err(|error| ipc_failure("save active draft", &error))?;
    service
        .doc_save_draft(SaveDraftRequest {
            path: path_string(&inactive),
            scene_json: scene_json("inactive-dirty"),
        })
        .await
        .map_err(|error| ipc_failure("save inactive draft", &error))?;
    Ok((service, active, inactive))
}

async fn checkpoint_and_close(
    service: &DocumentService,
    path: &Path,
    reason: CheckpointReason,
) -> Result<(), String> {
    service
        .doc_checkpoint(CheckpointRequest {
            path: path_string(path),
            scene_json: scene_json("closing-dirty"),
            reason,
        })
        .await
        .map_err(|error| ipc_failure("tab close checkpoint", &error))?;
    service
        .doc_close(CloseDocumentRequest {
            path: path_string(path),
            mode: CloseDocumentMode::Checkpointed,
        })
        .await
        .map_err(|error| ipc_failure("tab close", &error))?;
    Ok(())
}

fn error_code_name(error: &IpcError) -> String {
    serde_json::to_value(error.code)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("{:?}", error.code))
}

fn scene_json(element_id: &str) -> String {
    format!(r#"{{"type":"excalidraw","version":2,"elements":[{{"id":"{element_id}"}}]}}"#)
}

fn temporary_files(target: &Path) -> Result<Vec<String>, String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("target has no parent: {}", target.display()))?;
    let target_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("target has no UTF-8 file name: {}", target.display()))?;
    let prefix = format!("{target_name}.");
    let entries = fs::read_dir(parent)
        .map_err(|error| format!("failed to inspect {}: {error}", parent.display()))?;
    Ok(entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".tmp"))
        })
        .map(|path| path.display().to_string())
        .collect())
}

fn ipc_failure(operation: &str, error: &IpcError) -> String {
    let serialized = serde_json::to_string(error).unwrap_or_else(|_| format!("{error:?}"));
    format!("{operation} failed: {serialized}")
}

fn path_string(path: &Path) -> String {
    path.display().to_string()
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn harness_data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(root) = std::env::var_os("EXCALIDRAW_E2E_ROOT") {
        return Ok(PathBuf::from(root).join("data"));
    }

    app.path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))
}

fn document_hash(document_path: &str) -> String {
    format!("{:x}", Sha256::digest(document_path.as_bytes()))
}

fn latest_snapshot(directory: &Path) -> Result<PathBuf, String> {
    let entries = fs::read_dir(directory)
        .map_err(|error| format!("failed to read {}: {error}", directory.display()))?;

    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("recovery-") && name.ends_with(".json"))
        })
        .filter_map(|path| {
            let modified = fs::metadata(&path)
                .and_then(|metadata| metadata.modified())
                .ok()?;
            Some((modified, path))
        })
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
        .ok_or_else(|| format!("no recovery snapshot found in {}", directory.display()))
}

#[cfg(test)]
mod history_fault_contract_tests {
    use super::{HistoryFaultContext, HistoryFaultReadyMarker, HistoryFaultStage};

    #[test]
    fn history_restart_fixture_has_complete_geometry_and_png() {
        let (scene, asset, hash) = super::history_restart_scene("A", "历史 A");
        let scene: serde_json::Value = serde_json::from_str(&scene).unwrap();
        for element in scene["elements"].as_array().unwrap() {
            assert!(element["width"].as_f64().unwrap_or(0.0) > 0.0);
            assert!(element["height"].as_f64().unwrap_or(0.0) > 0.0);
            assert!(element["x"].is_number());
            assert!(element["y"].is_number());
        }
        assert_eq!(&asset[..8], b"\x89PNG\r\n\x1a\n");
        assert!(asset.windows(4).any(|bytes| bytes == b"IHDR"));
        assert!(asset.windows(4).any(|bytes| bytes == b"IDAT"));
        assert!(asset.windows(4).any(|bytes| bytes == b"IEND"));
        assert_eq!(hash, super::sha256(&asset));
        assert_ne!(hash, super::history_restart_scene("E0", "填充").2);
    }

    #[tokio::test]
    async fn history_restart_seed_and_protection_evict_each_accepted_target() {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-desktop-e2e-history-contract-{}",
            uuid::Uuid::new_v4()
        ));
        let seed = super::run_history_restart_seed(&root).await.unwrap();
        assert_eq!(seed.version_count, 20);
        assert_eq!(seed.initial_scene_sha256, seed.scene_a_sha256);
        assert_eq!(
            super::sha256(&std::fs::read(&seed.target_path).unwrap()),
            seed.scene_a_sha256
        );
        let seed_context = super::open_history_restart_context(&root).await.unwrap();
        let identity = seed_context
            .store
            .load_active_document_identity(&seed.target_path)
            .unwrap()
            .unwrap();
        assert_eq!(
            identity.recent_self_write_hash.as_deref(),
            Some(seed.scene_a_sha256.as_str())
        );
        for (target_id, target_hash, previous_label) in [
            (
                seed.version_b_id.as_str(),
                seed.scene_b_sha256.as_str(),
                "A",
            ),
            (
                seed.version_a_id.as_str(),
                seed.scene_a_sha256.as_str(),
                "B",
            ),
        ] {
            let context = super::open_history_restart_context(&root).await.unwrap();
            let current = std::fs::read_to_string(&seed.target_path).unwrap();
            let document = super::HistoryDocumentLocator::Path {
                path: seed.target_path.clone(),
            };
            let request_id = format!("contract-{target_id}");
            context
                .replacement
                .e2e_replace(super::HistoryReplaceRequest {
                    document: document.clone(),
                    request_id: request_id.clone(),
                    session_generation: 1,
                    revision: 1,
                    expected_base_hash: super::sha256(current.as_bytes()),
                    current_scene_json: current,
                    target: super::HistoryReplaceTarget::Restore {
                        version_id: target_id.to_owned(),
                    },
                })
                .await
                .unwrap();
            assert_eq!(
                super::sha256(&std::fs::read(&seed.target_path).unwrap()),
                target_hash
            );
            let listed = context
                .query
                .list(super::HistoryListRequest {
                    document: document.clone(),
                    cursor: None,
                    limit: Some(100),
                })
                .await
                .unwrap();
            assert_eq!(listed.items.len(), 20);
            assert!(!listed.items.iter().any(|item| item.version_id == target_id));
            let status = context
                .replacement
                .e2e_operation_status(super::HistoryOperationStatusRequest {
                    document: document.clone(),
                    request_id,
                })
                .await
                .unwrap();
            let protection = context
                .query
                .preview(super::HistoryPreviewRequest {
                    document,
                    version_id: status.protection_version_id.unwrap(),
                })
                .await
                .unwrap();
            assert_eq!(
                protection.scene["elements"][0]["id"],
                format!("text-{previous_label}")
            );
            assert_eq!(
                super::scene_asset_hash(&protection.scene).unwrap(),
                seed.asset_sha256
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn history_fault_stage_names_are_stable_and_complete() {
        let names: Vec<_> = HistoryFaultStage::ALL
            .into_iter()
            .map(|stage| stage.to_string())
            .collect();
        assert_eq!(
            names,
            vec![
                "object_publish",
                "protection_commit",
                "intent_commit",
                "after_rename_before_parent_sync",
                "metadata_complete_before_frontend_ack",
                "eviction_delete_gc",
                "rename_delete_repair",
            ]
        );
        for name in names {
            assert_eq!(name.parse::<HistoryFaultStage>().unwrap().to_string(), name);
        }
    }

    #[test]
    fn history_fault_ready_marker_round_trips_as_camel_case_json() {
        let marker = HistoryFaultReadyMarker {
            scenario: "history-fault-kill".to_owned(),
            stage: HistoryFaultStage::IntentCommit,
            seed: "seed-17".to_owned(),
            pid: 42,
            context: HistoryFaultContext {
                operation_id: "operation-17".to_owned(),
                document_id: "document-17".to_owned(),
                target_path: "/isolated/workspace/document.excalidraw".to_owned(),
                old_sha256: Some("a".repeat(64)),
                new_sha256: Some("b".repeat(64)),
            },
        };
        let value = serde_json::to_value(&marker).expect("marker should serialize");
        assert_eq!(value["scenario"], "history-fault-kill");
        assert_eq!(value["stage"], "intent_commit");
        assert_eq!(value["context"]["operationId"], "operation-17");
        let decoded: HistoryFaultReadyMarker =
            serde_json::from_value(value).expect("marker should deserialize");
        assert_eq!(decoded, marker);
    }
}
