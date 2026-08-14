//! Test-only commands for deterministic desktop reliability scenarios.
//!
//! This module is compiled only with the `e2e-harness` Cargo feature. None of
//! these commands are present in a production build.

use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::{
    commands::{
        documents::DocumentService,
        dto::{
            CheckpointReason, CheckpointRequest, PathRequest, RecoveryAction, RecoveryApplyRequest,
            SaveDraftRequest,
        },
        error::IpcError,
        recovery::RecoveryService,
    },
    database::repository::{
        DraftRepository, SqliteRepository, WorkspaceRecord, WorkspaceRepository,
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
};

pub(crate) const RELIABILITY_SCENARIO_FLAG: &str = "--e2e-reliability-scenario";
const E2E_ROOT_PREFIX: &str = "excalidraw-desktop-e2e-";

/// Prevents macOS App Nap from suspending the harness process.
///
/// Performance workloads are driven by `requestAnimationFrame`; when the test
/// window is occluded on a busy host, App Nap suspends the process and the
/// driver silently stalls mid-command. The activity assertion is held for the
/// whole process lifetime of the test-only build.
#[cfg(target_os = "macos")]
pub(crate) fn disable_app_nap() {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    let reason = NSString::from_str(
        "excalidraw-desktop e2e harness keeps rAF-driven measurements running",
    );
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
        "concurrent-checkpoints" => serialize_evidence(run_concurrent_checkpoints(root).await?),
        "disk-full-checkpoint" => serialize_evidence(run_disk_full_checkpoint(root).await?),
        "atomic-write-kill" => serialize_evidence(run_atomic_write_kill(root)?),
        "snapshot-corruption" => serialize_evidence(run_snapshot_corruption(root).await?),
        "recovery-window" => serialize_evidence(run_recovery_window(root).await?),
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
