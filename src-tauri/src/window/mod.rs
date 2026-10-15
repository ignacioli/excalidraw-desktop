#![allow(
    dead_code,
    reason = "the multi-window user stories consume these items as their slices land"
)]

//! Application windows. Every window is created at runtime by
//! [`create_window`], so all windows share one construction path, one chrome
//! contract, and one placement rule.

pub mod events;
pub mod geometry;
pub mod peer_close;
pub mod placement;
pub mod quit;
pub mod registry;
pub mod router;
pub mod session;

use tauri::{
    AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use geometry::{
    initial_rect, logical_work_area, staggered_rect, LogicalRect, MIN_HEIGHT, MIN_WIDTH,
};
use std::path::Path;

use tauri_plugin_fs::FsExt;

use registry::{WindowRegistry, WindowRestore, WindowRole};
use session::{SessionWriter, WindowSessionEntry, WindowSessionRepository};

use crate::database::repository::{SqliteRepository, WorkspaceRecord, WorkspaceRepository};

/// Title of a Welcome window before the frontend sets its own title.
pub const WELCOME_TITLE: &str = "Excalidraw";

/// Native chrome every window uses (titlebar choice A): an ordinary decorated
/// window whose title-bar color and placement the operating system controls.
/// The builder and the test-only window contract both read this value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowChrome {
    pub title: &'static str,
    pub decorations: bool,
    pub transparent: bool,
    /// macOS title bar style; `Visible` is the system title bar.
    pub title_bar_style: &'static str,
    pub always_on_top: bool,
    /// `None` leaves the native appearance to the system.
    pub theme: Option<&'static str>,
}

pub const WINDOW_CHROME: WindowChrome = WindowChrome {
    title: WELCOME_TITLE,
    decorations: true,
    transparent: false,
    title_bar_style: "Visible",
    always_on_top: false,
    theme: None,
};

/// Create, register, and show a new window. The frontend learns its role,
/// Workspace, and restore data from `app_handshake`, never from the URL; the
/// `window` query parameter is diagnostic only.
pub fn create_window<R: Runtime>(
    app: &AppHandle<R>,
    role: WindowRole,
    placement: Option<LogicalRect>,
) -> tauri::Result<WebviewWindow<R>> {
    let (label, rect) = register_window(app, role, placement)?;
    build_window(app, &label, normal_plan(rect))
}

/// A window shown in its normal state at `rect`.
fn normal_plan(rect: LogicalRect) -> placement::PlacementPlan {
    placement::PlacementPlan {
        rect,
        maximized: false,
        fullscreen: false,
    }
}

/// Reserve and register a window without showing it, so its Workspace and
/// startup data can be prepared before its frontend asks for them.
fn register_window<R: Runtime>(
    app: &AppHandle<R>,
    role: WindowRole,
    placement: Option<LogicalRect>,
) -> tauri::Result<(String, LogicalRect)> {
    let registry = app.state::<WindowRegistry>();
    let label = registry.allocate_label();
    let rect = placement.unwrap_or_else(|| default_placement(app, &registry));
    if let Err(error) = registry.register(&label, role) {
        return Err(tauri::Error::Anyhow(error.into()));
    }
    Ok((label, rect))
}

/// Show a registered window. A failure unregisters it.
fn build_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    plan: placement::PlacementPlan,
) -> tauri::Result<WebviewWindow<R>> {
    let registry = app.state::<WindowRegistry>();
    let rect = plan.rect;
    app.state::<placement::PlacementTracker>()
        .set_normal(label, rect);
    let url = WebviewUrl::App(format!("index.html?window={label}").into());
    let builder = WebviewWindowBuilder::new(app, label, url)
        .title(WINDOW_CHROME.title)
        .decorations(WINDOW_CHROME.decorations)
        .always_on_top(WINDOW_CHROME.always_on_top)
        .visible(true)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .inner_size(rect.width, rect.height)
        .position(rect.x, rect.y)
        .maximized(plan.maximized && !plan.fullscreen)
        .fullscreen(plan.fullscreen);
    match builder.build() {
        Ok(window) => Ok(window),
        Err(error) => {
            registry.unregister(label);
            app.state::<placement::PlacementTracker>().forget(label);
            Err(error)
        }
    }
}

/// Open a Welcome window, staggered from the front window, and bring it to
/// the front. New Window in the native menu and `window_new` share this path.
pub fn open_new_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<WebviewWindow<R>> {
    let window = create_window(app, WindowRole::Normal, None)?;
    activate_window(&window);
    Ok(window)
}

/// Open a Welcome window. The window is created in Rust; the frontend gets
/// no window-creation permission.
#[tauri::command]
pub async fn window_new(
    app: AppHandle,
) -> Result<crate::commands::dto::WindowNewResponse, crate::commands::error::IpcError> {
    let window = open_new_window(&app).map_err(|error| {
        crate::commands::error::AppError::Internal(format!("failed to open a new window: {error}"))
    })?;
    Ok(crate::commands::dto::WindowNewResponse {
        label: window.label().to_owned(),
    })
}

/// Store the Window Session snapshot. A failure is logged: the session is a
/// convenience for the next launch and never blocks the window action.
pub async fn persist_session<R: Runtime>(app: &AppHandle<R>) {
    if !app.state::<SessionWriter>().can_write() {
        return;
    }
    let snapshot = app.state::<WindowRegistry>().session_snapshot();
    let repository = app.state::<SqliteRepository>().inner().clone();
    if let Err(error) = repository.window_session_replace(snapshot).await {
        eprintln!("failed to store the window session: {error}");
    }
}

/// Store the Window Session after [`session::SESSION_WRITE_DELAY`], once for
/// every change requested in the meantime.
pub fn schedule_session_write<R: Runtime>(app: &AppHandle<R>) {
    if !app.state::<SessionWriter>().try_schedule() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(session::SESSION_WRITE_DELAY).await;
        app.state::<SessionWriter>().clear_scheduled();
        persist_session(&app).await;
    });
}

/// Recreate the windows of a stored Window Session. Each Workspace is claimed
/// before its window is shown, so the window's startup data already names
/// it; a Workspace that cannot be opened leaves its window on Welcome with an
/// explanation. Workspaces and drawings already open in a window (opened
/// during Recovery) are left where they are. Returns the number of windows
/// created.
pub async fn restore_session(app: &AppHandle, entries: Vec<WindowSessionEntry>) -> usize {
    let registry = app.state::<WindowRegistry>();
    let repository = app.state::<SqliteRepository>().inner().clone();
    let workspaces = match repository.workspace_recent_list().await {
        Ok(workspaces) => workspaces,
        Err(error) => {
            eprintln!("failed to read the Workspaces to restore: {error}");
            Vec::new()
        }
    };
    let owned = registry.owned_workspace_ids();
    let entries: Vec<_> = entries
        .into_iter()
        .map(|mut entry| {
            if entry
                .workspace_id
                .as_ref()
                .is_some_and(|id| owned.contains(id))
            {
                entry.workspace_id = None;
            }
            entry.tabs.retain(|tab| {
                let canonical = crate::commands::documents::canonical_document_path(Path::new(tab));
                registry.document_owner(&canonical).is_none()
            });
            entry
        })
        .collect();
    let plan = session::plan_restore(
        &entries,
        &workspaces,
        |root| root.is_dir(),
        |file| file.is_file(),
    );
    let mut created = 0;
    for window in plan {
        if window.workspace.is_none()
            && window.tabs.is_empty()
            && window.unavailable_workspace.is_none()
        {
            continue;
        }
        let (label, rect) = match register_window(app, WindowRole::Normal, None) {
            Ok(registered) => registered,
            Err(error) => {
                eprintln!("failed to register a restored window: {error}");
                continue;
            }
        };
        let mut unavailable = window.unavailable_workspace;
        let mut plan = normal_plan(rect);
        if let Some(workspace) = window.workspace {
            if claim_restored_workspace(app, &label, workspace.clone()).await {
                if let Some(remembered) = placement::remembered_plan(app, &workspace.id).await {
                    plan = remembered;
                }
            } else {
                unavailable = Some(workspace);
            }
        }
        for tab in &window.tabs {
            // The stored tabs were opened in an earlier run; grant the exact
            // files again so drawings outside the Workspace can reopen.
            if let Err(error) = app.fs_scope().allow_file(Path::new(tab)) {
                eprintln!("failed to grant a restored drawing: {error}");
            }
        }
        let restore = (!window.tabs.is_empty() || window.skipped > 0).then_some(WindowRestore {
            tabs: window.tabs,
            active_path: window.active_path,
            skipped: window.skipped,
        });
        registry.set_restore(&label, restore, unavailable);
        match build_window(app, &label, plan) {
            Ok(_) => created += 1,
            Err(error) => {
                eprintln!("failed to show a restored window: {error}");
                if let Err(error) =
                    crate::commands::workspace::release_for_window(app, &label).await
                {
                    eprintln!("failed to release the Workspace of {label}: {error}");
                }
            }
        }
    }
    created
}

async fn claim_restored_workspace(
    app: &AppHandle,
    label: &str,
    workspace: WorkspaceRecord,
) -> bool {
    let Ok(root) = std::fs::canonicalize(&workspace.root_path) else {
        return false;
    };
    match crate::commands::workspace::claim_for_window(app, label, root, Some(workspace), None)
        .await
    {
        Ok(crate::commands::workspace::WindowClaim::Claimed { .. }) => true,
        Ok(crate::commands::workspace::WindowClaim::Declined(_)) => false,
        Err(error) => {
            eprintln!("failed to reopen a Workspace in {label}: {error}");
            false
        }
    }
}

/// Recovery finished in the Recovery window: clear the `mounted` rows kept
/// for Recovery, recreate the stored windows, and close the Recovery window
/// when it was left empty and other windows took over. Later calls do
/// nothing.
pub async fn finish_recovery(
    app: &AppHandle,
    label: &str,
) -> Result<(), crate::commands::error::AppError> {
    let registry = app.state::<WindowRegistry>();
    let Some(record) = registry.window(label) else {
        return Ok(());
    };
    if record.role != WindowRole::Recovery {
        return Ok(());
    }
    registry.set_role(label, WindowRole::Normal);
    let repository = app.state::<SqliteRepository>().inner().clone();
    let owned = registry.owned_workspace_ids();
    for workspace in repository.workspace_list().await? {
        if workspace.mounted && !owned.contains(&workspace.id) {
            repository
                .workspace_set_mounted(workspace.id, false)
                .await?;
        }
    }
    let writer = app.state::<SessionWriter>();
    let entries = writer.take_pending_restore().unwrap_or_default();
    let created = restore_session(app, entries).await;
    writer.release();
    persist_session(app).await;
    broadcast_open_workspaces(app).await;
    let left_empty = registry
        .window(label)
        .is_some_and(|record| record.workspace.is_none() && record.documents.is_empty());
    if created > 0 && left_empty {
        if let Some(window) = app.get_webview_window(label) {
            // The normal close request, so the window checkpoints first.
            if let Err(error) = window.close() {
                eprintln!("failed to close the empty Recovery window: {error}");
            }
        }
    }
    Ok(())
}

/// Tell every window which Workspaces are open, so each can tell apart
/// Workspaces with the same name in its title. A failure is logged.
pub async fn broadcast_open_workspaces<R: Runtime>(app: &AppHandle<R>) {
    let ids = app.state::<WindowRegistry>().owned_workspace_ids();
    let repository = app.state::<SqliteRepository>().inner().clone();
    let workspaces = match crate::commands::session::open_workspace_names(&repository, ids).await {
        Ok(workspaces) => workspaces,
        Err(error) => {
            eprintln!("failed to read the open Workspaces: {error}");
            return;
        }
    };
    if let Err(error) = app.emit(
        "open-workspaces-changed",
        crate::commands::dto::OpenWorkspacesChangedEvent { workspaces },
    ) {
        eprintln!("failed to announce the open Workspaces: {error}");
    }
}

/// When the Dock icon is clicked: bring back the most recently focused
/// window, or open a Welcome window when none is left.
pub fn reopen<R: Runtime>(app: &AppHandle<R>) {
    match app.state::<WindowRegistry>().most_recently_focused() {
        Some(label) => activate_label(app, &label),
        None => {
            if let Err(error) = open_new_window(app) {
                eprintln!("failed to open a window on reopen: {error}");
            }
        }
    }
}

/// Bring a window to the front. `set_focus` only takes effect on a visible,
/// unminimized window, so the order matters.
pub fn activate_window<R: Runtime>(window: &WebviewWindow<R>) {
    if let Err(error) = window.unminimize() {
        eprintln!("failed to unminimize window {}: {error}", window.label());
    }
    if let Err(error) = window.show() {
        eprintln!("failed to show window {}: {error}", window.label());
    }
    if let Err(error) = window.set_focus() {
        eprintln!("failed to focus window {}: {error}", window.label());
    }
}

/// Activate the window with `label`, if it still exists.
pub fn activate_label<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        activate_window(&window);
    }
}

/// The window menu commands go to: the key window, else the most recently
/// focused registered window.
pub fn target_window<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let registry = app.state::<WindowRegistry>();
    let focused = registry.labels().into_iter().find(|label| {
        app.get_webview_window(label)
            .and_then(|window| window.is_focused().ok())
            .unwrap_or(false)
    });
    focused.or_else(|| registry.most_recently_focused())
}

/// Stagger from the front window when there is one; otherwise center on the
/// primary display.
fn default_placement<R: Runtime>(app: &AppHandle<R>, registry: &WindowRegistry) -> LogicalRect {
    let front = registry
        .most_recently_focused()
        .and_then(|label| app.get_webview_window(&label));
    if let Some(front) = front {
        if let (Some(front_rect), Some(work_area)) = (window_rect(&front), window_work_area(&front))
        {
            return staggered_rect(&front_rect, &work_area);
        }
    }
    initial_rect(&primary_work_area(app))
}

fn window_rect<R: Runtime>(window: &WebviewWindow<R>) -> Option<LogicalRect> {
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some(LogicalRect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

fn window_work_area<R: Runtime>(window: &WebviewWindow<R>) -> Option<LogicalRect> {
    window
        .current_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor_work_area(&monitor))
}

pub(crate) fn monitor_work_area(monitor: &tauri::Monitor) -> LogicalRect {
    let area = monitor.work_area();
    logical_work_area(
        area.position.x,
        area.position.y,
        area.size.width,
        area.size.height,
        monitor.scale_factor(),
    )
}

/// The primary display's work area, falling back to a 1440×900 area when the
/// platform reports no monitor (headless test hosts).
pub(crate) fn primary_work_area<R: Runtime>(app: &AppHandle<R>) -> LogicalRect {
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor_work_area(&monitor))
        .unwrap_or(LogicalRect {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
        })
}
