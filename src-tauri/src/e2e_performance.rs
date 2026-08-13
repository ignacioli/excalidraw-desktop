//! Test-only native performance control bridge.
//!
//! The complete module is excluded unless the e2e-harness feature is enabled.

use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Mutex;

use crate::{
    commands::documents::DocumentService,
    database::repository::{SqliteRepository, WorkspaceRecord, WorkspaceRepository},
    documents::{atomic_write::atomic_write, validation::validate_scene},
};

const CONTRACT_SCHEMA_VERSION: &str = "1.0.0";
const CONTROL_DIRECTORY_PREFIX: &str = "excalidraw-desktop-perf-control-";
const FIXTURE_DIRECTORY_PREFIX: &str = "excalidraw-desktop-perf-fixture-";
const E2E_ROOT_PREFIX: &str = "excalidraw-desktop-e2e-";
const MAXIMUM_CONTROL_FILE_BYTES: usize = 64 * 1024;
const PERFORMANCE_WORKSPACE_ID: &str = "e2e-performance-workspace";
const PERFORMANCE_DOCUMENT_NAME: &str = "performance.excalidraw";
const EMPTY_SCENE: &str =
    r#"{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum PerformanceScenario {
    #[serde(rename = "startup-editable")]
    StartupEditable,
    #[serde(rename = "canvas-10k")]
    Canvas10k,
    #[serde(rename = "edit-soak")]
    EditSoak,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum PerformanceOperation {
    #[serde(rename = "pan-zoom")]
    PanZoom,
    #[serde(rename = "high-frequency-edit")]
    HighFrequencyEdit,
    #[serde(rename = "edit-soak")]
    EditSoak,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PerformanceBootstrap {
    schema_version: String,
    scenario: PerformanceScenario,
    fixture_path: Option<PathBuf>,
    seed: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PerformanceBootstrapResponse {
    pub(crate) schema_version: &'static str,
    pub(crate) scenario: PerformanceScenario,
    pub(crate) seed: u64,
    pub(crate) document_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PerformanceReadySignal {
    pub(crate) schema_version: String,
    pub(crate) scenario: PerformanceScenario,
    pub(crate) editor_ready: bool,
    pub(crate) editable: bool,
    pub(crate) element_count: u64,
    pub(crate) visibility_state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PerformanceCommand {
    pub(crate) schema_version: String,
    pub(crate) command_id: String,
    pub(crate) operation: PerformanceOperation,
    pub(crate) duration_ms: f64,
    pub(crate) seed: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) target_events: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PerformanceCommandResult {
    pub(crate) schema_version: String,
    pub(crate) command_id: String,
    pub(crate) operation: PerformanceOperation,
    pub(crate) completed: bool,
    pub(crate) duration_ms: f64,
    pub(crate) event_count: u64,
    pub(crate) frame_intervals_ms: Vec<f64>,
    pub(crate) visibility_state: String,
    pub(crate) frame_clock: String,
}

#[derive(Default)]
struct CommandLedger {
    processed: HashSet<String>,
    issued: HashMap<String, PerformanceCommand>,
}

struct ActivePerformanceHarness {
    control_directory: PathBuf,
    bootstrap: PerformanceBootstrapResponse,
    expected_element_count: u64,
    commands: Mutex<CommandLedger>,
}

#[derive(Clone)]
pub(crate) struct PerformanceHarnessState {
    active: Option<Arc<ActivePerformanceHarness>>,
}

impl PerformanceHarnessState {
    pub(crate) fn inactive() -> Self {
        Self { active: None }
    }

    pub(crate) async fn from_environment(
        repository: Arc<SqliteRepository>,
    ) -> Result<Self, String> {
        let Some(control_directory) = env::var_os("EXCALIDRAW_PERF_CONTROL_DIR").map(PathBuf::from)
        else {
            return Ok(Self::inactive());
        };
        let e2e_root = env::var_os("EXCALIDRAW_E2E_ROOT")
            .map(PathBuf::from)
            .ok_or_else(|| {
                "EXCALIDRAW_E2E_ROOT is required when native performance control is enabled"
                    .to_owned()
            })?;
        Self::initialize(&control_directory, &e2e_root, repository).await
    }

    pub(crate) async fn initialize(
        control_directory: &Path,
        e2e_root: &Path,
        repository: Arc<SqliteRepository>,
    ) -> Result<Self, String> {
        let control_directory =
            canonical_prefixed_directory(control_directory, CONTROL_DIRECTORY_PREFIX, "control")?;
        let e2e_root = canonical_prefixed_directory(e2e_root, E2E_ROOT_PREFIX, "E2E")?;
        let trusted_temporary_parent = e2e_root
            .parent()
            .ok_or_else(|| "E2E root has no temporary parent".to_owned())?;
        if control_directory.parent() != Some(trusted_temporary_parent) {
            return Err(
                "performance control directory is outside the isolated temporary parent".to_owned(),
            );
        }
        let bootstrap_path = control_directory.join("bootstrap.json");
        let bootstrap: PerformanceBootstrap =
            read_json_file(&bootstrap_path, "performance bootstrap")?;
        validate_schema_version(&bootstrap.schema_version, "bootstrap")?;

        let workspace = e2e_root.join("workspace");
        fs::create_dir_all(&workspace)
            .map_err(|error| format!("failed to create performance workspace: {error}"))?;
        let workspace = workspace
            .canonicalize()
            .map_err(|error| format!("failed to resolve performance workspace: {error}"))?;
        let document_path = workspace.join(PERFORMANCE_DOCUMENT_NAME);
        let scene_bytes = scene_for_bootstrap(&bootstrap, trusted_temporary_parent)?;
        let scene = validate_scene(&scene_bytes, DocumentService::DEFAULT_SCENE_LIMIT_BYTES)
            .map_err(|error| format!("performance fixture is not a valid scene: {error}"))?;
        let element_count = scene
            .get("elements")
            .and_then(serde_json::Value::as_array)
            .map(Vec::len)
            .ok_or_else(|| "performance fixture elements are missing".to_owned())?;
        let expected_element_count = u64::try_from(element_count)
            .map_err(|_| "performance fixture element count is too large".to_owned())?;
        validate_scenario_element_count(bootstrap.scenario, expected_element_count)?;
        atomic_write(&document_path, &scene_bytes)
            .map_err(|error| format!("failed to prepare performance document: {error}"))?;
        let document_path = document_path
            .canonicalize()
            .map_err(|error| format!("failed to resolve performance document: {error}"))?;

        repository
            .workspace_upsert(WorkspaceRecord {
                id: PERFORMANCE_WORKSPACE_ID.to_owned(),
                name: "E2E Performance".to_owned(),
                root_path: workspace.display().to_string(),
                created_at: 1,
            })
            .await
            .map_err(|error| format!("failed to register performance workspace: {error}"))?;

        Ok(Self {
            active: Some(Arc::new(ActivePerformanceHarness {
                control_directory,
                bootstrap: PerformanceBootstrapResponse {
                    schema_version: CONTRACT_SCHEMA_VERSION,
                    scenario: bootstrap.scenario,
                    seed: bootstrap.seed,
                    document_path: document_path.display().to_string(),
                },
                expected_element_count,
                commands: Mutex::new(CommandLedger::default()),
            })),
        })
    }

    pub(crate) fn bootstrap_response(&self) -> Result<PerformanceBootstrapResponse, String> {
        Ok(self.active()?.bootstrap.clone())
    }

    #[cfg(test)]
    pub(crate) fn expected_element_count(&self) -> u64 {
        self.active
            .as_ref()
            .map_or(0, |active| active.expected_element_count)
    }

    pub(crate) async fn publish_ready(&self, signal: PerformanceReadySignal) -> Result<(), String> {
        let active = Arc::clone(self.active()?);
        validate_ready_signal(
            &signal,
            active.bootstrap.scenario,
            active.expected_element_count,
        )?;
        let path = active.control_directory.join("ready.json");
        publish_json(path, signal).await
    }

    pub(crate) async fn next_command(&self) -> Result<Option<PerformanceCommand>, String> {
        let active = Arc::clone(self.active()?);
        let path = active.control_directory.join("command.json");
        let command = read_optional_json_file(path, "performance command").await?;
        let Some(command): Option<PerformanceCommand> = command else {
            return Ok(None);
        };
        validate_command(&command)?;
        let mut commands = active.commands.lock().await;
        if !commands.processed.insert(command.command_id.clone()) {
            return Ok(None);
        }
        commands
            .issued
            .insert(command.command_id.clone(), command.clone());
        Ok(Some(command))
    }

    pub(crate) async fn publish_result(
        &self,
        result: PerformanceCommandResult,
    ) -> Result<(), String> {
        let active = Arc::clone(self.active()?);
        let expected = {
            let commands = active.commands.lock().await;
            commands
                .issued
                .get(&result.command_id)
                .cloned()
                .ok_or_else(|| {
                    format!(
                        "performance command {} was not issued or was already completed",
                        result.command_id
                    )
                })?
        };
        validate_result(&result, &expected)?;
        {
            let mut commands = active.commands.lock().await;
            if commands.issued.remove(&result.command_id).is_none() {
                return Err(format!(
                    "performance command {} was not issued or was already completed",
                    result.command_id
                ));
            }
        }
        let path = active.control_directory.join("result.json");
        if let Err(error) = publish_json(path, result).await {
            let mut commands = active.commands.lock().await;
            commands
                .issued
                .insert(expected.command_id.clone(), expected);
            return Err(error);
        }
        Ok(())
    }

    fn active(&self) -> Result<&Arc<ActivePerformanceHarness>, String> {
        self.active
            .as_ref()
            .ok_or_else(|| "native performance control is not configured".to_owned())
    }
}

#[tauri::command]
pub(crate) fn e2e_perf_bootstrap(
    state: State<'_, PerformanceHarnessState>,
) -> Result<PerformanceBootstrapResponse, String> {
    state.bootstrap_response()
}

#[tauri::command]
pub(crate) async fn e2e_perf_publish_ready(
    ready: PerformanceReadySignal,
    state: State<'_, PerformanceHarnessState>,
) -> Result<(), String> {
    state.publish_ready(ready).await
}

#[tauri::command]
pub(crate) async fn e2e_perf_next_command(
    state: State<'_, PerformanceHarnessState>,
) -> Result<Option<PerformanceCommand>, String> {
    state.next_command().await
}

#[tauri::command]
pub(crate) async fn e2e_perf_publish_result(
    result: PerformanceCommandResult,
    state: State<'_, PerformanceHarnessState>,
) -> Result<(), String> {
    state.publish_result(result).await
}

fn canonical_prefixed_directory(
    path: &Path,
    expected_prefix: &str,
    label: &str,
) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(format!("{label} directory must be absolute"));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("failed to resolve {label} directory: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("{label} path is not a directory"));
    }
    let has_expected_prefix = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(expected_prefix));
    if !has_expected_prefix {
        return Err(format!(
            "refusing {label} directory without {expected_prefix} prefix"
        ));
    }
    Ok(canonical)
}

fn scene_for_bootstrap(
    bootstrap: &PerformanceBootstrap,
    trusted_temporary_parent: &Path,
) -> Result<Vec<u8>, String> {
    match (bootstrap.scenario, bootstrap.fixture_path.as_deref()) {
        (PerformanceScenario::StartupEditable, None) => Ok(EMPTY_SCENE.as_bytes().to_vec()),
        (PerformanceScenario::StartupEditable, Some(_)) => {
            Err("startup-editable bootstrap must not include fixturePath".to_owned())
        }
        (PerformanceScenario::Canvas10k | PerformanceScenario::EditSoak, Some(path)) => {
            let fixture_parent = path
                .parent()
                .ok_or_else(|| "performance fixture has no parent".to_owned())?;
            let fixture_parent =
                canonical_prefixed_directory(fixture_parent, FIXTURE_DIRECTORY_PREFIX, "fixture")?;
            if fixture_parent.parent() != Some(trusted_temporary_parent) {
                return Err(
                    "performance fixture is outside the isolated temporary parent".to_owned(),
                );
            }
            let file_name = path
                .file_name()
                .ok_or_else(|| "performance fixture has no file name".to_owned())?;
            let fixture_path = fixture_parent
                .join(file_name)
                .canonicalize()
                .map_err(|error| format!("failed to resolve performance fixture: {error}"))?;
            if !fixture_path.starts_with(&fixture_parent)
                || fixture_path.extension().and_then(|value| value.to_str()) != Some("excalidraw")
            {
                return Err("performance fixture path is not authorized".to_owned());
            }
            read_bounded_file(
                &fixture_path,
                DocumentService::DEFAULT_SCENE_LIMIT_BYTES,
                "performance fixture",
            )
        }
        (PerformanceScenario::Canvas10k | PerformanceScenario::EditSoak, None) => {
            Err("canvas-10k and edit-soak bootstrap require fixturePath".to_owned())
        }
    }
}

fn validate_scenario_element_count(
    scenario: PerformanceScenario,
    element_count: u64,
) -> Result<(), String> {
    let valid = match scenario {
        PerformanceScenario::StartupEditable => element_count == 0,
        PerformanceScenario::Canvas10k | PerformanceScenario::EditSoak => element_count == 10_000,
    };
    if valid {
        Ok(())
    } else {
        Err(format!(
            "performance scenario {scenario:?} received {element_count} elements"
        ))
    }
}

fn validate_ready_signal(
    signal: &PerformanceReadySignal,
    scenario: PerformanceScenario,
    expected_element_count: u64,
) -> Result<(), String> {
    validate_schema_version(&signal.schema_version, "ready signal")?;
    if signal.scenario != scenario
        || !signal.editor_ready
        || !signal.editable
        || signal.element_count != expected_element_count
        || signal.visibility_state != "visible"
    {
        return Err(
            "performance ready signal does not prove the requested visible editable scene"
                .to_owned(),
        );
    }
    Ok(())
}

fn validate_command(command: &PerformanceCommand) -> Result<(), String> {
    validate_schema_version(&command.schema_version, "command")?;
    if !valid_command_id(&command.command_id) {
        return Err("performance commandId is invalid".to_owned());
    }
    if !command.duration_ms.is_finite() || command.duration_ms <= 0.0 {
        return Err("performance command durationMs must be positive and finite".to_owned());
    }
    if command.target_events == Some(0) {
        return Err("performance command targetEvents must be positive".to_owned());
    }
    Ok(())
}

fn validate_result(
    result: &PerformanceCommandResult,
    command: &PerformanceCommand,
) -> Result<(), String> {
    validate_schema_version(&result.schema_version, "result")?;
    if result.command_id != command.command_id
        || result.operation != command.operation
        || !result.completed
        || !result.duration_ms.is_finite()
        || result.duration_ms < command.duration_ms
        || result.visibility_state != "visible"
        || result.frame_clock != "requestAnimationFrame-performance.now"
        || result
            .frame_intervals_ms
            .iter()
            .any(|interval| !interval.is_finite() || *interval < 0.0)
    {
        return Err("performance command result is invalid or incomplete".to_owned());
    }
    if command.operation != PerformanceOperation::EditSoak {
        let covered_duration: f64 = result.frame_intervals_ms.iter().sum();
        if covered_duration < command.duration_ms * 0.95
            || covered_duration > result.duration_ms + 1_000.0
        {
            return Err(
                "performance frame intervals do not cover the requested visible window".to_owned(),
            );
        }
    }
    Ok(())
}

fn validate_schema_version(version: &str, label: &str) -> Result<(), String> {
    if version == CONTRACT_SCHEMA_VERSION {
        Ok(())
    } else {
        Err(format!(
            "performance {label} schemaVersion must equal {CONTRACT_SCHEMA_VERSION}"
        ))
    }
}

fn valid_command_id(command_id: &str) -> bool {
    !command_id.is_empty()
        && command_id.len() <= 128
        && command_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn read_json_file<T>(path: &Path, label: &str) -> Result<T, String>
where
    T: for<'de> Deserialize<'de>,
{
    let bytes = read_bounded_file(path, MAXIMUM_CONTROL_FILE_BYTES, label)?;
    serde_json::from_slice(&bytes).map_err(|error| format!("invalid {label} JSON: {error}"))
}

async fn read_optional_json_file<T>(path: PathBuf, label: &'static str) -> Result<Option<T>, String>
where
    T: for<'de> Deserialize<'de> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        if !path.exists() {
            return Ok(None);
        }
        read_json_file(&path, label).map(Some)
    })
    .await
    .map_err(|error| format!("failed to join {label} read: {error}"))?
}

fn read_bounded_file(path: &Path, maximum_bytes: usize, label: &str) -> Result<Vec<u8>, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("failed to inspect {label}: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{label} path is not a file"));
    }
    if metadata.len() > maximum_bytes as u64 {
        return Err(format!("{label} exceeds the supported size limit"));
    }
    let read_limit = maximum_bytes
        .checked_add(1)
        .ok_or_else(|| format!("{label} size limit overflowed"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)
        .map_err(|error| format!("failed to open {label}: {error}"))?
        .take(read_limit as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read {label}: {error}"))?;
    if bytes.len() > maximum_bytes {
        return Err(format!("{label} exceeds the supported size limit"));
    }
    Ok(bytes)
}

async fn publish_json<T>(path: PathBuf, value: T) -> Result<(), String>
where
    T: Serialize + Send + 'static,
{
    let mut bytes = serde_json::to_vec_pretty(&value)
        .map_err(|error| format!("failed to serialize performance publication: {error}"))?;
    bytes.push(b'\n');
    tokio::task::spawn_blocking(move || {
        atomic_write(&path, &bytes)
            .map_err(|error| format!("failed to publish {}: {error}", path.display()))
    })
    .await
    .map_err(|error| format!("failed to join performance publication: {error}"))?
}
