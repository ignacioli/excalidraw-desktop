use std::{fs, path::PathBuf, sync::Arc};

use serde_json::json;

use crate::{
    database::repository::{SqliteRepository, WorkspaceRepository},
    e2e_performance::{
        PerformanceCommandResult, PerformanceErrorSignal, PerformanceHarnessState,
        PerformanceReadySignal, PerformanceScenario,
    },
};

#[tokio::test]
async fn bootstrap_prepares_document_and_registers_workspace() {
    let fixture = Fixture::new("bootstrap");
    fixture.write_bootstrap(json!({
        "schemaVersion": "1.0.0",
        "scenario": "startup-editable",
        "seed": 42
    }));
    let repository = fixture.repository().await;

    let state = PerformanceHarnessState::initialize(
        &fixture.control,
        &fixture.e2e_root,
        Arc::clone(&repository),
    )
    .await
    .unwrap_or_else(|error| panic!("initialize performance harness: {error}"));
    let response = state
        .bootstrap_response()
        .unwrap_or_else(|error| panic!("read performance bootstrap response: {error}"));

    assert_eq!(response.schema_version, "1.0.0");
    assert_eq!(response.scenario, PerformanceScenario::StartupEditable);
    assert_eq!(response.seed, 42);
    assert_eq!(
        response.document_path,
        fixture
            .e2e_root
            .join("workspace/performance.excalidraw")
            .canonicalize()
            .unwrap_or_else(|error| panic!("canonicalize prepared document: {error}"))
            .display()
            .to_string()
    );
    let scene = fs::read_to_string(&response.document_path)
        .unwrap_or_else(|error| panic!("read prepared scene: {error}"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&scene)
            .unwrap_or_else(|error| panic!("parse prepared scene: {error}"))["elements"],
        json!([])
    );
    let workspaces = repository
        .workspace_list()
        .await
        .unwrap_or_else(|error| panic!("list performance workspaces: {error}"));
    assert_eq!(workspaces.len(), 1);
    assert_eq!(workspaces[0].id, "e2e-performance-workspace");
}

#[tokio::test]
async fn fixture_bootstrap_copies_only_valid_prefixed_fixture() {
    let fixture = Fixture::new("copy");
    let scene_fixture = fixture.create_scene_fixture(10_000);
    fixture.write_bootstrap(json!({
        "schemaVersion": "1.0.0",
        "scenario": "canvas-10k",
        "fixturePath": scene_fixture,
        "seed": 30_000
    }));
    let repository = fixture.repository().await;

    let state =
        PerformanceHarnessState::initialize(&fixture.control, &fixture.e2e_root, repository)
            .await
            .unwrap_or_else(|error| panic!("initialize fixture performance harness: {error}"));
    let response = state
        .bootstrap_response()
        .unwrap_or_else(|error| panic!("read fixture bootstrap response: {error}"));
    assert_eq!(response.scenario, PerformanceScenario::Canvas10k);
    assert_eq!(state.expected_element_count(), 10_000);
    let copied = fs::read_to_string(response.document_path)
        .unwrap_or_else(|error| panic!("read copied fixture: {error}"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&copied)
            .unwrap_or_else(|error| panic!("parse copied fixture: {error}"))["elements"]
            .as_array()
            .map(Vec::len),
        Some(10_000)
    );
}

#[tokio::test]
async fn bootstrap_rejects_untrusted_roots_paths_and_schemas() {
    let fixture = Fixture::new("reject");
    fixture.write_bootstrap(json!({
        "schemaVersion": "1.0.0",
        "scenario": "startup-editable",
        "seed": 1,
        "unexpected": true
    }));
    let repository = fixture.repository().await;
    let malformed = initialization_error(
        PerformanceHarnessState::initialize(
            &fixture.control,
            &fixture.e2e_root,
            Arc::clone(&repository),
        )
        .await,
    );
    assert!(malformed.contains("bootstrap"));

    let wrong_control = fixture.root.join("control-without-required-prefix");
    fs::create_dir_all(&wrong_control)
        .unwrap_or_else(|error| panic!("create wrong control root: {error}"));
    fs::write(
        wrong_control.join("bootstrap.json"),
        r#"{"schemaVersion":"1.0.0","scenario":"startup-editable","seed":1}"#,
    )
    .unwrap_or_else(|error| panic!("write wrong control bootstrap: {error}"));
    let wrong_prefix = initialization_error(
        PerformanceHarnessState::initialize(
            &wrong_control,
            &fixture.e2e_root,
            Arc::clone(&repository),
        )
        .await,
    );
    assert!(wrong_prefix.contains("control"));

    let nested_control = fixture.root.join("excalidraw-desktop-perf-control-nested");
    fs::create_dir_all(&nested_control)
        .unwrap_or_else(|error| panic!("create nested control root: {error}"));
    fs::write(
        nested_control.join("bootstrap.json"),
        r#"{"schemaVersion":"1.0.0","scenario":"startup-editable","seed":1}"#,
    )
    .unwrap_or_else(|error| panic!("write nested control bootstrap: {error}"));
    let nested = initialization_error(
        PerformanceHarnessState::initialize(
            &nested_control,
            &fixture.e2e_root,
            Arc::clone(&repository),
        )
        .await,
    );
    assert!(nested.contains("temporary parent"));

    let outside_root = fixture.root.join("excalidraw-desktop-perf-fixture-nested");
    fs::create_dir_all(&outside_root)
        .unwrap_or_else(|error| panic!("create outside fixture root: {error}"));
    let outside = outside_root.join("outside.excalidraw");
    fs::write(&outside, empty_scene())
        .unwrap_or_else(|error| panic!("write outside fixture: {error}"));
    fixture.write_bootstrap(json!({
        "schemaVersion": "1.0.0",
        "scenario": "canvas-10k",
        "fixturePath": outside,
        "seed": 1
    }));
    let escaped = initialization_error(
        PerformanceHarnessState::initialize(&fixture.control, &fixture.e2e_root, repository).await,
    );
    assert!(escaped.contains("fixture"));
    assert!(!fixture
        .e2e_root
        .join("workspace/performance.excalidraw")
        .exists());
}

#[tokio::test]
async fn ready_and_results_publish_atomically_and_validate_live_contract() {
    let fixture = Fixture::new("publish");
    fixture.write_bootstrap(json!({
        "schemaVersion": "1.0.0",
        "scenario": "startup-editable",
        "seed": 7
    }));
    let state = PerformanceHarnessState::initialize(
        &fixture.control,
        &fixture.e2e_root,
        fixture.repository().await,
    )
    .await
    .unwrap_or_else(|error| panic!("initialize publish harness: {error}"));

    state
        .publish_ready(PerformanceReadySignal {
            schema_version: "1.0.0".to_owned(),
            scenario: PerformanceScenario::StartupEditable,
            editor_ready: true,
            editable: true,
            element_count: 0,
            visibility_state: "visible".to_owned(),
        })
        .await
        .unwrap_or_else(|error| panic!("publish ready: {error}"));
    assert!(fixture.control.join("ready.json").is_file());
    assert_no_temporary_publications(&fixture.control);

    fixture.write_command(json!({
        "schemaVersion": "1.0.0",
        "commandId": "command-1",
        "operation": "pan-zoom",
        "durationMs": 100,
        "seed": 8
    }));
    let command = state
        .next_command()
        .await
        .unwrap_or_else(|error| panic!("read next command: {error}"))
        .unwrap_or_else(|| panic!("expected a performance command"));
    assert_eq!(command.command_id, "command-1");
    assert!(state
        .next_command()
        .await
        .unwrap_or_else(|error| panic!("read duplicate command: {error}"))
        .is_none());

    state
        .publish_result(PerformanceCommandResult {
            schema_version: "1.0.0".to_owned(),
            command_id: "command-1".to_owned(),
            operation: command.operation,
            completed: true,
            duration_ms: 105.0,
            event_count: 20,
            frame_intervals_ms: vec![25.0, 25.0, 25.0, 25.0],
            visibility_state: "visible".to_owned(),
            frame_clock: "requestAnimationFrame-performance.now".to_owned(),
        })
        .await
        .unwrap_or_else(|error| panic!("publish command result: {error}"));
    assert!(fixture.control.join("result.json").is_file());
    assert_no_temporary_publications(&fixture.control);
}

#[tokio::test]
async fn command_serialization_omits_absent_target_events() {
    let fixture = Fixture::new("serialize-command");
    fixture.write_bootstrap(json!({
        "schemaVersion": "1.0.0",
        "scenario": "startup-editable",
        "seed": 7
    }));
    let state = PerformanceHarnessState::initialize(
        &fixture.control,
        &fixture.e2e_root,
        fixture.repository().await,
    )
    .await
    .unwrap_or_else(|error| panic!("initialize serialize harness: {error}"));

    fixture.write_command(json!({
        "schemaVersion": "1.0.0",
        "commandId": "pan-1",
        "operation": "pan-zoom",
        "durationMs": 100,
        "seed": 8
    }));
    let command = state
        .next_command()
        .await
        .unwrap_or_else(|error| panic!("read next command: {error}"))
        .unwrap_or_else(|| panic!("expected a performance command"));
    let serialized =
        serde_json::to_value(&command).unwrap_or_else(|error| panic!("serialize command: {error}"));
    assert!(
        serialized.get("targetEvents").is_none(),
        "pan-zoom command must omit targetEvents when absent, got {serialized}"
    );
}

#[tokio::test]
async fn driver_errors_publish_atomically_and_validate_bounds() {
    let fixture = Fixture::new("error");
    fixture.write_bootstrap(json!({
        "schemaVersion": "1.0.0",
        "scenario": "startup-editable",
        "seed": 5
    }));
    let state = PerformanceHarnessState::initialize(
        &fixture.control,
        &fixture.e2e_root,
        fixture.repository().await,
    )
    .await
    .unwrap_or_else(|error| panic!("initialize error harness: {error}"));

    state
        .publish_error(PerformanceErrorSignal {
            schema_version: "1.0.0".to_owned(),
            message: "driver failed: no editable scene element".to_owned(),
        })
        .await
        .unwrap_or_else(|error| panic!("publish driver error: {error}"));
    let published = fs::read_to_string(fixture.control.join("error.json"))
        .unwrap_or_else(|error| panic!("read published error: {error}"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&published)
            .unwrap_or_else(|error| panic!("parse published error: {error}"))["message"],
        json!("driver failed: no editable scene element")
    );
    assert_no_temporary_publications(&fixture.control);

    assert!(state
        .publish_error(PerformanceErrorSignal {
            schema_version: "1.0.0".to_owned(),
            message: "   ".to_owned(),
        })
        .await
        .expect_err("empty error message must fail")
        .contains("empty"));
    assert!(state
        .publish_error(PerformanceErrorSignal {
            schema_version: "1.0.0".to_owned(),
            message: "x".repeat(32 * 1024 + 1),
        })
        .await
        .expect_err("oversized error message must fail")
        .contains("size"));
    assert!(state
        .publish_error(PerformanceErrorSignal {
            schema_version: "0.9.0".to_owned(),
            message: "wrong schema".to_owned(),
        })
        .await
        .expect_err("wrong schema version must fail")
        .contains("schemaVersion"));
}

#[tokio::test]
async fn malformed_commands_and_unissued_results_are_rejected() {
    let fixture = Fixture::new("commands");
    fixture.write_bootstrap(json!({
        "schemaVersion": "1.0.0",
        "scenario": "startup-editable",
        "seed": 9
    }));
    let state = PerformanceHarnessState::initialize(
        &fixture.control,
        &fixture.e2e_root,
        fixture.repository().await,
    )
    .await
    .unwrap_or_else(|error| panic!("initialize command harness: {error}"));
    fixture.write_command(json!({
        "schemaVersion": "1.0.0",
        "commandId": "../escape",
        "operation": "pan-zoom",
        "durationMs": -1,
        "seed": 1
    }));
    assert!(state
        .next_command()
        .await
        .expect_err("malformed command must fail")
        .contains("command"));

    let result = PerformanceCommandResult {
        schema_version: "1.0.0".to_owned(),
        command_id: "not-issued".to_owned(),
        operation: crate::e2e_performance::PerformanceOperation::EditSoak,
        completed: true,
        duration_ms: 1.0,
        event_count: 1,
        frame_intervals_ms: Vec::new(),
        visibility_state: "visible".to_owned(),
        frame_clock: "requestAnimationFrame-performance.now".to_owned(),
    };
    assert!(state
        .publish_result(result)
        .await
        .expect_err("unissued result must fail")
        .contains("not issued"));
    assert!(!fixture.control.join("result.json").exists());
}

struct Fixture {
    root: PathBuf,
    control: PathBuf,
    e2e_root: PathBuf,
    scene_fixture_roots: std::sync::Mutex<Vec<PathBuf>>,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let suffix = format!("{label}-{}-{}", std::process::id(), uuid::Uuid::new_v4());
        let root = std::env::temp_dir().join(format!("performance-harness-test-{suffix}"));
        let control =
            std::env::temp_dir().join(format!("excalidraw-desktop-perf-control-{suffix}"));
        let e2e_root = std::env::temp_dir().join(format!("excalidraw-desktop-e2e-{suffix}"));
        fs::create_dir_all(&root).unwrap_or_else(|error| panic!("create test root: {error}"));
        fs::create_dir_all(&control).unwrap_or_else(|error| panic!("create control root: {error}"));
        fs::create_dir_all(&e2e_root).unwrap_or_else(|error| panic!("create E2E root: {error}"));
        Self {
            root,
            control,
            e2e_root,
            scene_fixture_roots: std::sync::Mutex::new(Vec::new()),
        }
    }

    async fn repository(&self) -> Arc<SqliteRepository> {
        Arc::new(
            SqliteRepository::open(&self.root.join("state.sqlite3"))
                .await
                .unwrap_or_else(|error| panic!("open test repository: {error}")),
        )
    }

    fn write_bootstrap(&self, value: serde_json::Value) {
        fs::write(
            self.control.join("bootstrap.json"),
            serde_json::to_vec(&value)
                .unwrap_or_else(|error| panic!("serialize bootstrap: {error}")),
        )
        .unwrap_or_else(|error| panic!("write bootstrap: {error}"));
    }

    fn write_command(&self, value: serde_json::Value) {
        fs::write(
            self.control.join("command.json"),
            serde_json::to_vec(&value).unwrap_or_else(|error| panic!("serialize command: {error}")),
        )
        .unwrap_or_else(|error| panic!("write command: {error}"));
    }

    fn create_scene_fixture(&self, element_count: usize) -> PathBuf {
        let fixture_root = std::env::temp_dir().join(format!(
            "excalidraw-desktop-perf-fixture-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&fixture_root)
            .unwrap_or_else(|error| panic!("create scene fixture root: {error}"));
        self.scene_fixture_roots
            .lock()
            .unwrap_or_else(|error| panic!("lock scene fixture roots: {error}"))
            .push(fixture_root.clone());
        let path = fixture_root.join("scene.excalidraw");
        let elements = (0..element_count)
            .map(|index| json!({"id": format!("element-{index}"), "type": "rectangle"}))
            .collect::<Vec<_>>();
        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "type": "excalidraw",
                "version": 2,
                "elements": elements,
                "appState": {},
                "files": {}
            }))
            .unwrap_or_else(|error| panic!("serialize scene fixture: {error}")),
        )
        .unwrap_or_else(|error| panic!("write scene fixture: {error}"));
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
        let _ = fs::remove_dir_all(&self.control);
        let _ = fs::remove_dir_all(&self.e2e_root);
        if let Ok(roots) = self.scene_fixture_roots.get_mut() {
            for root in roots {
                let _ = fs::remove_dir_all(root);
            }
        }
    }
}

fn empty_scene() -> &'static str {
    r#"{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}"#
}

fn assert_no_temporary_publications(control: &std::path::Path) {
    let temporary = fs::read_dir(control)
        .unwrap_or_else(|error| panic!("read control directory: {error}"))
        .filter_map(Result::ok)
        .any(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.ends_with(".tmp"))
        });
    assert!(!temporary, "atomic publication left a temporary file");
}

fn initialization_error(result: Result<PerformanceHarnessState, String>) -> String {
    match result {
        Ok(_) => panic!("performance harness initialization unexpectedly succeeded"),
        Err(error) => error,
    }
}
