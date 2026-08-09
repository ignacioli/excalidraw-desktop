//! Test-only commands for deterministic desktop reliability scenarios.
//!
//! This module is compiled only with the `e2e-harness` Cargo feature. None of
//! these commands are present in a production build.

use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::{
    commands::{
        documents::DocumentService,
        dto::{CheckpointReason, CheckpointRequest, PathRequest, SaveDraftRequest},
        error::IpcError,
    },
    database::repository::{
        DraftRepository, SqliteRepository, WorkspaceRecord, WorkspaceRepository,
    },
    documents::atomic_write::{
        clear_fault_point, set_before_rename_barrier, set_disk_full_fault, set_fault_point,
        AtomicWriteFaultPoint,
    },
};

pub(crate) const RELIABILITY_SCENARIO_FLAG: &str = "--e2e-reliability-scenario";
const E2E_ROOT_PREFIX: &str = "excalidraw-desktop-e2e-";

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
        other => Err(format!("unknown E2E reliability scenario: {other}")),
    }
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
