//! Observation-only bridge for exact-package native screen capture.
//!
//! The production binary remains inert unless the launcher supplies a complete
//! nonce-bound capture plan. This module never provisions state, accepts paths
//! from the WebView, or changes application behavior; it only validates an
//! observed shell fingerprint and atomically publishes a ready candidate.

use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use tauri::State;

const SCHEMA_VERSION: u8 = 1;
const STATE_FINGERPRINT_VERSION: &str = "shell-state-v2";
const MAX_PLAN_BYTES: u64 = 1024 * 1024;
const PLAN_ENV: &str = "EXCALIDRAW_NATIVE_CAPTURE_PLAN";
const GATE_ENV: &str = "EXCALIDRAW_NATIVE_CAPTURE_GATE";
const NONCE_ENV: &str = "EXCALIDRAW_NATIVE_CAPTURE_NONCE";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapturePlan {
    schema_version: u8,
    run_id: String,
    run_nonce: String,
    product_commit: String,
    package_manifest: PackageManifestBinding,
    state_fingerprint_version: String,
    control_dir: PathBuf,
    fixture: FixtureBinding,
    native_entrypoint_request: ScreenRequest,
    screens: Vec<ScreenRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageManifestBinding {
    artifact_sha256: String,
}

#[derive(Debug, Deserialize)]
struct FixtureBinding {
    digest: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenRequest {
    gate_id: String,
    profile_root: PathBuf,
    expected_state_fingerprint: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Viewport {
    width: u32,
    height: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeCaptureBootstrap {
    schema_version: u8,
    run_id: String,
    run_nonce: String,
    gate_id: String,
    product_commit: String,
    package_artifact_sha256: String,
    fixture_digest: String,
    expected_state_fingerprint: String,
    state_fingerprint_version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeCaptureReadyInput {
    schema_version: u8,
    run_id: String,
    run_nonce: String,
    gate_id: String,
    product_commit: String,
    package_artifact_sha256: String,
    state_fingerprint: String,
    state_fingerprint_version: String,
    font_ready: bool,
    remote_font_requests: u32,
    stable_frames: u8,
    pending_operations: u32,
    logical_window: Viewport,
    frontmost: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeCaptureDiagnosticInput {
    schema_version: u8,
    run_id: String,
    #[serde(skip_serializing)]
    run_nonce: String,
    gate_id: String,
    product_commit: String,
    package_artifact_sha256: String,
    projection: NativeCaptureStateProjection,
    state_fingerprint: String,
    expected_state_fingerprint: String,
    stable_frames: u8,
    pending_operations: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeCaptureStateProjection {
    gate_id: String,
    theme: String,
    session_state: String,
    sidebar_state: String,
    sidebar_width: u32,
    workspace_name: Option<String>,
    selected_directory: Option<String>,
    expanded_directories: Vec<String>,
    tabs: Vec<String>,
    active_document: Option<String>,
    unsaved: bool,
    fixture_digest: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCaptureReadyCandidate {
    schema_version: u8,
    run_id: String,
    run_nonce: String,
    pid: u32,
    gate_id: String,
    product_commit: String,
    package_artifact_sha256: String,
    resolved_paths: ResolvedPaths,
    state_fingerprint: String,
    state_fingerprint_version: String,
    font_ready: bool,
    remote_font_requests: u32,
    pending_operations: u32,
    stable_frames: u8,
    logical_window: ViewportOutput,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedPaths {
    app_data: String,
    web_kit_data: String,
}

#[derive(Debug, Serialize)]
struct ViewportOutput {
    width: u32,
    height: u32,
    frontmost: bool,
}

struct ActiveCapture {
    bootstrap: NativeCaptureBootstrap,
    control_dir: PathBuf,
    profile_root: PathBuf,
    app_data: PathBuf,
    web_kit_data: PathBuf,
}

#[derive(Clone)]
pub(crate) struct NativeCaptureState {
    active: Option<Arc<ActiveCapture>>,
}

impl NativeCaptureState {
    pub(crate) fn from_environment(app_data: &Path, web_kit_data: &Path) -> Result<Self, String> {
        let plan = env::var_os(PLAN_ENV);
        let gate = env::var_os(GATE_ENV);
        let nonce = env::var_os(NONCE_ENV);
        if plan.is_none() && gate.is_none() && nonce.is_none() {
            return Ok(Self { active: None });
        }
        let plan_path = plan
            .map(PathBuf::from)
            .ok_or_else(|| format!("{PLAN_ENV} is required for native capture"))?;
        let gate_id = gate
            .and_then(|value| value.into_string().ok())
            .ok_or_else(|| format!("{GATE_ENV} must be valid UTF-8"))?;
        let launcher_nonce = nonce
            .and_then(|value| value.into_string().ok())
            .ok_or_else(|| format!("{NONCE_ENV} must be valid UTF-8"))?;
        let plan_path = canonical_file(&plan_path, "capture plan")?;
        let metadata = fs::metadata(&plan_path)
            .map_err(|error| format!("failed to inspect capture plan: {error}"))?;
        if metadata.len() > MAX_PLAN_BYTES {
            return Err("capture plan exceeds the 1 MiB limit".to_owned());
        }
        let bytes = fs::read(&plan_path)
            .map_err(|error| format!("failed to read capture plan: {error}"))?;
        let plan: CapturePlan = serde_json::from_slice(&bytes)
            .map_err(|error| format!("capture plan is invalid: {error}"))?;
        validate_plan_identity(&plan, &launcher_nonce)?;
        let screen = if gate_id == "T023b" {
            plan.native_entrypoint_request.clone()
        } else {
            plan.screens
                .iter()
                .find(|screen| screen.gate_id == gate_id)
                .cloned()
                .ok_or_else(|| "requested gate is absent from the capture plan".to_owned())?
        };
        if screen.gate_id != gate_id {
            return Err("native entrypoint request gate does not match T023b".to_owned());
        }
        let control_dir = canonical_directory(&plan.control_dir, "control directory")?;
        let profile_root = canonical_directory(&screen.profile_root, "profile root")?;
        let app_data = canonical_directory(app_data, "application data directory")?;
        let web_kit_data = canonical_directory(web_kit_data, "WebKit data directory")?;
        ensure_descendant(&profile_root, &app_data, "application data directory")?;
        ensure_descendant(&profile_root, &web_kit_data, "WebKit data directory")?;
        ensure_descendant(
            plan_path
                .parent()
                .ok_or_else(|| "capture plan has no parent".to_owned())?,
            &control_dir,
            "control directory",
        )?;
        let bootstrap = NativeCaptureBootstrap {
            schema_version: SCHEMA_VERSION,
            run_id: plan.run_id,
            run_nonce: plan.run_nonce,
            gate_id,
            product_commit: plan.product_commit,
            package_artifact_sha256: plan.package_manifest.artifact_sha256,
            fixture_digest: plan.fixture.digest,
            expected_state_fingerprint: screen.expected_state_fingerprint,
            state_fingerprint_version: plan.state_fingerprint_version,
        };
        Ok(Self {
            active: Some(Arc::new(ActiveCapture {
                bootstrap,
                control_dir,
                profile_root,
                app_data,
                web_kit_data,
            })),
        })
    }

    fn bootstrap(&self) -> Option<NativeCaptureBootstrap> {
        self.active.as_ref().map(|active| active.bootstrap.clone())
    }

    fn publish_ready(&self, ready: NativeCaptureReadyInput) -> Result<(), String> {
        let active = self
            .active
            .as_ref()
            .ok_or_else(|| "native capture is inactive".to_owned())?;
        validate_ready(active, &ready)?;
        ensure_descendant(
            &active.profile_root,
            &active.app_data,
            "application data directory",
        )?;
        ensure_descendant(
            &active.profile_root,
            &active.web_kit_data,
            "WebKit data directory",
        )?;
        let candidate = NativeCaptureReadyCandidate {
            schema_version: SCHEMA_VERSION,
            run_id: ready.run_id,
            run_nonce: ready.run_nonce,
            pid: std::process::id(),
            gate_id: ready.gate_id,
            product_commit: ready.product_commit,
            package_artifact_sha256: ready.package_artifact_sha256,
            resolved_paths: ResolvedPaths {
                app_data: path_string(&active.app_data),
                web_kit_data: path_string(&active.web_kit_data),
            },
            state_fingerprint: ready.state_fingerprint,
            state_fingerprint_version: ready.state_fingerprint_version,
            font_ready: ready.font_ready,
            remote_font_requests: ready.remote_font_requests,
            pending_operations: ready.pending_operations,
            stable_frames: ready.stable_frames,
            logical_window: ViewportOutput {
                width: ready.logical_window.width,
                height: ready.logical_window.height,
                frontmost: ready.frontmost,
            },
        };
        atomic_write_new_json(
            &active
                .control_dir
                .join(format!("{}.ready-candidate.json", active.bootstrap.gate_id)),
            &candidate,
        )
    }

    fn publish_diagnostic(&self, diagnostic: NativeCaptureDiagnosticInput) -> Result<(), String> {
        let active = self
            .active
            .as_ref()
            .ok_or_else(|| "native capture is inactive".to_owned())?;
        validate_diagnostic(active, &diagnostic)?;
        atomic_write_replace_json(
            &active.control_dir.join(format!(
                "{}.observation-diagnostic.json",
                active.bootstrap.gate_id
            )),
            &diagnostic,
        )
    }
}

#[tauri::command]
pub(crate) fn native_capture_bootstrap(
    state: State<'_, NativeCaptureState>,
) -> Option<NativeCaptureBootstrap> {
    state.bootstrap()
}

#[tauri::command]
pub(crate) fn native_capture_publish_ready(
    state: State<'_, NativeCaptureState>,
    ready: NativeCaptureReadyInput,
) -> Result<(), String> {
    state.publish_ready(ready)
}

#[tauri::command]
pub(crate) fn native_capture_publish_diagnostic(
    state: State<'_, NativeCaptureState>,
    diagnostic: NativeCaptureDiagnosticInput,
) -> Result<(), String> {
    state.publish_diagnostic(diagnostic)
}

fn validate_plan_identity(plan: &CapturePlan, launcher_nonce: &str) -> Result<(), String> {
    if plan.schema_version != SCHEMA_VERSION
        || plan.state_fingerprint_version != STATE_FINGERPRINT_VERSION
        || plan.run_nonce != launcher_nonce
        || !is_hex(&plan.run_nonce, 64)
        || !is_hex(&plan.product_commit, 40)
        || !is_hex(&plan.package_manifest.artifact_sha256, 64)
        || !is_hex(&plan.fixture.digest, 64)
    {
        return Err("capture plan identity or nonce is invalid".to_owned());
    }
    Ok(())
}

fn validate_ready(active: &ActiveCapture, ready: &NativeCaptureReadyInput) -> Result<(), String> {
    let expected = &active.bootstrap;
    if ready.schema_version != SCHEMA_VERSION
        || ready.run_id != expected.run_id
        || ready.run_nonce != expected.run_nonce
        || ready.gate_id != expected.gate_id
        || ready.product_commit != expected.product_commit
        || ready.package_artifact_sha256 != expected.package_artifact_sha256
        || ready.state_fingerprint != expected.expected_state_fingerprint
        || ready.state_fingerprint_version != STATE_FINGERPRINT_VERSION
    {
        return Err("ready observation does not match the immutable capture binding".to_owned());
    }
    if !ready.font_ready
        || ready.remote_font_requests != 0
        || ready.pending_operations != 0
        || ready.stable_frames < 2
        || !ready.frontmost
        || !has_valid_webview_dimensions(&ready.logical_window)
    {
        return Err("ready observation does not prove a stable capture state".to_owned());
    }
    Ok(())
}

fn validate_diagnostic(
    active: &ActiveCapture,
    diagnostic: &NativeCaptureDiagnosticInput,
) -> Result<(), String> {
    let expected = &active.bootstrap;
    if diagnostic.schema_version != SCHEMA_VERSION
        || diagnostic.run_id != expected.run_id
        || diagnostic.run_nonce != expected.run_nonce
        || diagnostic.gate_id != expected.gate_id
        || diagnostic.product_commit != expected.product_commit
        || diagnostic.package_artifact_sha256 != expected.package_artifact_sha256
        || diagnostic.expected_state_fingerprint != expected.expected_state_fingerprint
        || !is_hex(&diagnostic.state_fingerprint, 64)
    {
        return Err(
            "diagnostic observation does not match the immutable capture binding".to_owned(),
        );
    }
    Ok(())
}

fn has_valid_webview_dimensions(viewport: &Viewport) -> bool {
    viewport.width > 0 && viewport.height > 0
}

fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn canonical_file(path: &Path, label: &str) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("failed to resolve {label}: {error}"))?;
    if !canonical.is_file() {
        return Err(format!("{label} must be a file"));
    }
    Ok(canonical)
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("failed to resolve {label}: {error}"))?;
    if !canonical.is_dir() {
        return Err(format!("{label} must be a directory"));
    }
    Ok(canonical)
}

fn ensure_descendant(root: &Path, target: &Path, label: &str) -> Result<(), String> {
    if target == root || !target.starts_with(root) {
        return Err(format!("{label} escapes the disposable profile"));
    }
    Ok(())
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn atomic_write_new_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if path.exists() {
        return Err("ready candidate already exists".to_owned());
    }
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("failed to serialize ready candidate: {error}"))?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("failed to create ready candidate temporary file: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("failed to persist ready candidate: {error}"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("failed to publish ready candidate atomically: {error}"))
}

fn atomic_write_replace_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("failed to serialize capture diagnostic: {error}"))?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temporary)
        .map_err(|error| format!("failed to create capture diagnostic temporary file: {error}"))?;
    file.write_all(&bytes)
        .and_then(|_| file.write_all(b"\n"))
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("failed to persist capture diagnostic: {error}"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("failed to publish capture diagnostic atomically: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        has_valid_webview_dimensions, is_hex, validate_plan_identity, CapturePlan, FixtureBinding,
        NativeCaptureDiagnosticInput, NativeCaptureStateProjection, PackageManifestBinding,
        Viewport,
    };
    use std::path::PathBuf;

    #[test]
    fn rejects_nonce_and_digest_mismatches() {
        let plan = CapturePlan {
            schema_version: 1,
            run_id: "run".to_owned(),
            run_nonce: "ab".repeat(32),
            product_commit: "cd".repeat(20),
            package_manifest: PackageManifestBinding {
                artifact_sha256: "ef".repeat(32),
            },
            state_fingerprint_version: "shell-state-v2".to_owned(),
            control_dir: PathBuf::from("/tmp/control"),
            fixture: FixtureBinding {
                digest: "12".repeat(32),
            },
            native_entrypoint_request: super::ScreenRequest {
                gate_id: "T023b".to_owned(),
                profile_root: PathBuf::from("/tmp/profile"),
                expected_state_fingerprint: "34".repeat(32),
            },
            screens: Vec::new(),
        };
        assert!(validate_plan_identity(&plan, &"ab".repeat(32)).is_ok());
        assert!(validate_plan_identity(&plan, &"34".repeat(32)).is_err());
        assert!(is_hex(&"ab".repeat(32), 64));
        assert!(!is_hex("not-a-digest", 64));
    }

    #[test]
    fn accepts_positive_webview_content_dimensions_without_equating_them_to_window_bounds() {
        assert!(has_valid_webview_dimensions(&Viewport {
            width: 1280,
            height: 730,
        }));
        assert!(!has_valid_webview_dimensions(&Viewport {
            width: 1280,
            height: 0,
        }));
    }

    #[test]
    fn diagnostic_serialization_excludes_the_run_nonce() {
        let diagnostic = NativeCaptureDiagnosticInput {
            schema_version: 1,
            run_id: "run".to_owned(),
            run_nonce: "ab".repeat(32),
            gate_id: "VSL-001".to_owned(),
            product_commit: "cd".repeat(20),
            package_artifact_sha256: "ef".repeat(32),
            projection: NativeCaptureStateProjection {
                gate_id: "VSL-001".to_owned(),
                theme: "light".to_owned(),
                session_state: "workspace".to_owned(),
                sidebar_state: "pinned".to_owned(),
                sidebar_width: 360,
                workspace_name: Some("Design Workspace".to_owned()),
                selected_directory: Some("flows".to_owned()),
                expanded_directories: vec!["flows".to_owned()],
                tabs: vec!["Architecture.excalidraw".to_owned()],
                active_document: Some("Architecture.excalidraw".to_owned()),
                unsaved: false,
                fixture_digest: "12".repeat(32),
            },
            state_fingerprint: "34".repeat(32),
            expected_state_fingerprint: "56".repeat(32),
            stable_frames: 2,
            pending_operations: 0,
        };
        let serialized = serde_json::to_string(&diagnostic).expect("serialize diagnostic");
        assert!(!serialized.contains("runNonce"));
        assert!(!serialized.contains(&"ab".repeat(32)));
    }
}
