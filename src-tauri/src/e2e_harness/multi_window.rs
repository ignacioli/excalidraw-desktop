//! Test-only multi-window driver.
//!
//! The test process writes one JSON request per file into
//! `runtime/reliability/multi-window/requests/<target>/`, where `<target>` is
//! `app` or a window label, and reads each answer from `results/<id>.json`.
//! App requests run here: an ownership snapshot, a new window, a window close
//! through the normal close request, a quit through the same entry as the
//! Quit menu item, and a checkpoint failure for one window. Window requests
//! are fetched by that window's frontend driver, which answers through
//! [`e2e_multi_window_publish`]. Everything is disabled unless
//! `EXCALIDRAW_E2E_MULTI_WINDOW=1`.

use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use crate::window::registry::{WindowRegistry, WindowRole};

const MULTI_WINDOW_DRIVER_FLAG: &str = "EXCALIDRAW_E2E_MULTI_WINDOW";
const APP_TARGET: &str = "app";
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// The window whose checkpoints fail, if any.
static CHECKPOINT_FAULT_LABEL: Mutex<Option<String>> = Mutex::new(None);

pub(crate) fn enabled() -> bool {
    env::var(MULTI_WINDOW_DRIVER_FLAG).as_deref() == Ok("1")
}

fn control_directory() -> Result<PathBuf, String> {
    Ok(super::process_harness_root()?
        .join("runtime")
        .join("reliability")
        .join("multi-window"))
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DriverRequest {
    pub(crate) id: String,
    pub(crate) action: String,
    #[serde(default)]
    pub(crate) args: Value,
}

/// Take the oldest request queued for `target`. Request files are named so
/// that their names sort in the order they were written.
fn take_request(control: &Path, target: &str) -> Result<Option<DriverRequest>, String> {
    let directory = control.join("requests").join(target);
    let mut names: Vec<PathBuf> = match fs::read_dir(&directory) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to read driver requests: {error}")),
    };
    names.sort();
    let Some(path) = names.into_iter().next() else {
        return Ok(None);
    };
    let bytes = fs::read(&path).map_err(|error| format!("failed to read a request: {error}"))?;
    fs::remove_file(&path).map_err(|error| format!("failed to consume a request: {error}"))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("invalid driver request: {error}"))
}

/// Write one answer atomically, so the test process never reads half of it.
fn write_result(control: &Path, id: &str, result: &Value) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("driver request ids are letters, digits, and dashes".to_owned());
    }
    let directory = control.join("results");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("failed to create the result directory: {error}"))?;
    let temporary = directory.join(format!(".{id}.tmp"));
    let payload = serde_json::to_vec(result)
        .map_err(|error| format!("failed to encode a result: {error}"))?;
    fs::write(&temporary, payload).map_err(|error| format!("failed to write a result: {error}"))?;
    fs::rename(&temporary, directory.join(format!("{id}.json")))
        .map_err(|error| format!("failed to publish a result: {error}"))
}

fn answer(id: &str, target: &str, outcome: Result<Value, String>) -> Value {
    match outcome {
        Ok(result) => json!({ "id": id, "target": target, "ok": true, "result": result }),
        Err(error) => json!({ "id": id, "target": target, "ok": false, "error": error }),
    }
}

/// Fail checkpoints of the window that the driver named.
pub(crate) fn checkpoint_fault(label: &str) -> bool {
    enabled()
        && CHECKPOINT_FAULT_LABEL
            .lock()
            .map(|fault| fault.as_deref() == Some(label))
            .unwrap_or(false)
}

fn set_checkpoint_fault(label: Option<String>) {
    if let Ok(mut fault) = CHECKPOINT_FAULT_LABEL.lock() {
        *fault = label;
    }
}

/// Every window the registry knows, with what it owns.
pub(crate) fn ownership_snapshot(registry: &WindowRegistry) -> Value {
    let windows: Vec<Value> = registry
        .labels()
        .into_iter()
        .filter_map(|label| registry.window(&label))
        .map(|record| {
            json!({
                "label": record.label,
                "recovery": record.role == WindowRole::Recovery,
                "workspaceId": record.workspace.as_ref().map(|workspace| workspace.id.clone()),
                "workspaceRoot": record
                    .workspace
                    .as_ref()
                    .map(|workspace| workspace.root.to_string_lossy().into_owned()),
                "documents": record
                    .documents
                    .iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect::<Vec<_>>(),
                "sessionTabs": record.session_tabs,
                "sessionActivePath": record.session_active_path,
            })
        })
        .collect();
    json!({ "pid": std::process::id(), "windows": windows })
}

fn run_app_request<R: Runtime>(
    app: &AppHandle<R>,
    request: &DriverRequest,
) -> Result<Value, String> {
    let label_arg = || {
        request
            .args
            .get("label")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("{} needs a window label", request.action))
    };
    match request.action.as_str() {
        "snapshot" => {
            let mut snapshot = ownership_snapshot(&app.state::<WindowRegistry>());
            let focused: Vec<String> = app
                .webview_windows()
                .into_iter()
                .filter(|(_, window)| window.is_focused().unwrap_or(false))
                .map(|(label, _)| label)
                .collect();
            let mut open: Vec<String> = app.webview_windows().into_keys().collect();
            open.sort();
            snapshot["openWindows"] = json!(open);
            snapshot["focused"] = json!(focused);
            Ok(snapshot)
        }
        "newWindow" => crate::window::open_new_window(app)
            .map(|window| json!({ "label": window.label() }))
            .map_err(|error| error.to_string()),
        // The normal close request: the window checkpoints before it closes.
        "close" => {
            let label = label_arg()?;
            let window = app
                .get_webview_window(&label)
                .ok_or_else(|| format!("no window {label}"))?;
            window.close().map_err(|error| error.to_string())?;
            Ok(json!({ "label": label }))
        }
        // The same entry as the Quit menu item and Cmd+Q.
        "quit" => {
            crate::window::quit::request_quit(app);
            Ok(json!({}))
        }
        "setCheckpointFault" => {
            let label = request
                .args
                .get("label")
                .and_then(Value::as_str)
                .map(str::to_owned);
            set_checkpoint_fault(label.clone());
            Ok(json!({ "label": label }))
        }
        other => Err(format!("unknown app request {other}")),
    }
}

/// Serve app requests until the process exits.
pub(crate) fn start_app_driver<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if !enabled() {
        return Ok(());
    }
    let control = control_directory()?;
    fs::create_dir_all(control.join("requests").join(APP_TARGET))
        .map_err(|error| format!("failed to create the driver directory: {error}"))?;
    let app = app.clone();
    thread::Builder::new()
        .name("e2e-multi-window".to_owned())
        .spawn(move || loop {
            match take_request(&control, APP_TARGET) {
                Ok(Some(request)) => {
                    // Window work runs on the main thread, as for menu events.
                    let (sender, receiver) = std::sync::mpsc::channel();
                    let handle = app.clone();
                    let queued = request.clone();
                    let dispatched = app.run_on_main_thread(move || {
                        let _ = sender.send(run_app_request(&handle, &queued));
                    });
                    let outcome = match dispatched {
                        Ok(()) => receiver
                            .recv_timeout(Duration::from_secs(10))
                            .unwrap_or_else(|_| Err("the app request did not finish".to_owned())),
                        Err(error) => Err(error.to_string()),
                    };
                    if let Err(error) = write_result(
                        &control,
                        &request.id,
                        &answer(&request.id, APP_TARGET, outcome),
                    ) {
                        eprintln!("e2e multi-window driver: {error}");
                    }
                }
                Ok(None) => thread::sleep(POLL_INTERVAL),
                Err(error) => {
                    eprintln!("e2e multi-window driver: {error}");
                    thread::sleep(POLL_INTERVAL);
                }
            }
        })
        .map(|_| ())
        .map_err(|error| format!("failed to start the multi-window driver: {error}"))
}

/// Whether this window runs the frontend driver.
#[tauri::command]
pub(crate) fn e2e_multi_window_bootstrap() -> Result<bool, String> {
    if !enabled() {
        return Ok(false);
    }
    control_directory()?;
    Ok(true)
}

/// The oldest request queued for the calling window.
#[tauri::command]
pub(crate) fn e2e_multi_window_next(
    window: WebviewWindow,
) -> Result<Option<DriverRequest>, String> {
    if !enabled() {
        return Err("multi-window driver is disabled".to_owned());
    }
    take_request(&control_directory()?, window.label())
}

/// The calling window's answer to one request.
#[tauri::command]
pub(crate) fn e2e_multi_window_publish(
    window: WebviewWindow,
    id: String,
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    if !enabled() {
        return Err("multi-window driver is disabled".to_owned());
    }
    let outcome = if ok {
        Ok(result.unwrap_or(Value::Null))
    } else {
        Err(error.unwrap_or_else(|| "the window request failed".to_owned()))
    };
    write_result(
        &control_directory()?,
        &id,
        &answer(&id, window.label(), outcome),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window::registry::{ClaimDecision, WorkspaceCandidate};

    fn scratch() -> PathBuf {
        let directory = env::temp_dir().join(format!(
            "excalidraw-multi-window-driver-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn requests_are_taken_oldest_first_and_only_once() {
        let control = scratch();
        let queue = control.join("requests").join("window-2");
        fs::create_dir_all(&queue).unwrap();
        fs::write(queue.join("0002-b.json"), r#"{"id":"b","action":"report"}"#).unwrap();
        fs::write(
            queue.join("0001-a.json"),
            r#"{"id":"a","action":"edit","args":{"path":"/w/a.excalidraw"}}"#,
        )
        .unwrap();

        let first = take_request(&control, "window-2").unwrap().unwrap();
        let second = take_request(&control, "window-2").unwrap().unwrap();

        assert_eq!(first.id, "a");
        assert_eq!(first.args["path"], "/w/a.excalidraw");
        assert_eq!(second.id, "b");
        assert_eq!(take_request(&control, "window-2").unwrap(), None);
        assert_eq!(take_request(&control, "window-3").unwrap(), None);
        fs::remove_dir_all(control).unwrap();
    }

    #[test]
    fn results_are_published_whole_and_ids_cannot_leave_the_directory() {
        let control = scratch();

        write_result(
            &control,
            "req-1",
            &answer("req-1", "app", Ok(json!({ "n": 1 }))),
        )
        .unwrap();
        let written: Value =
            serde_json::from_slice(&fs::read(control.join("results/req-1.json")).unwrap()).unwrap();

        assert_eq!(written["ok"], true);
        assert_eq!(written["result"]["n"], 1);
        assert!(write_result(&control, "../escape", &json!({})).is_err());
        assert!(write_result(&control, "", &json!({})).is_err());
        fs::remove_dir_all(control).unwrap();
    }

    #[test]
    fn the_snapshot_names_each_window_and_what_it_owns() {
        let registry = WindowRegistry::new();
        registry.register("window-1", WindowRole::Recovery).unwrap();
        registry.register("window-2", WindowRole::Normal).unwrap();
        let (decision, _) = registry
            .claim(
                "window-2",
                &WorkspaceCandidate {
                    id: Some("ws-b".to_owned()),
                    root: PathBuf::from("/w/b"),
                },
            )
            .unwrap();
        assert!(matches!(decision, ClaimDecision::Claimable { .. }));
        registry
            .claim_document("window-2", Path::new("/w/b/one.excalidraw"))
            .unwrap();

        let snapshot = ownership_snapshot(&registry);
        let windows = snapshot["windows"].as_array().unwrap();

        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0]["label"], "window-1");
        assert_eq!(windows[0]["recovery"], true);
        assert_eq!(windows[0]["workspaceRoot"], Value::Null);
        assert_eq!(windows[1]["recovery"], false);
        assert_eq!(windows[1]["workspaceId"], "ws-b");
        assert_eq!(windows[1]["workspaceRoot"], "/w/b");
        assert_eq!(windows[1]["documents"], json!(["/w/b/one.excalidraw"]));
    }

    #[test]
    fn the_window_commands_refuse_to_run_without_the_driver_flag() {
        // The test process never sets the flag.
        assert!(!enabled());
        assert_eq!(e2e_multi_window_bootstrap(), Ok(false));
        set_checkpoint_fault(Some("window-1".to_owned()));
        assert!(!checkpoint_fault("window-1"));
        set_checkpoint_fault(None);
    }
}
