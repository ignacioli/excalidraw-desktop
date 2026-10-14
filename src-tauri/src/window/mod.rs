#![allow(
    dead_code,
    reason = "the multi-window user stories consume these items as their slices land"
)]

//! Application windows. Every window is created at runtime by
//! [`create_window`], so all windows share one construction path, one chrome
//! contract, and one placement rule.

pub mod events;
pub mod geometry;
pub mod registry;
pub mod session;

use tauri::{
    AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use geometry::{
    initial_rect, logical_work_area, staggered_rect, LogicalRect, MIN_HEIGHT, MIN_WIDTH,
};
use registry::{WindowRegistry, WindowRole};
use session::WindowSessionRepository;

use crate::database::repository::SqliteRepository;

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
    let registry = app.state::<WindowRegistry>();
    let label = registry.allocate_label();
    let rect = placement.unwrap_or_else(|| default_placement(app, &registry));
    if let Err(error) = registry.register(&label, role) {
        return Err(tauri::Error::Anyhow(error.into()));
    }
    let url = WebviewUrl::App(format!("index.html?window={label}").into());
    let builder = WebviewWindowBuilder::new(app, &label, url)
        .title(WINDOW_CHROME.title)
        .decorations(WINDOW_CHROME.decorations)
        .always_on_top(WINDOW_CHROME.always_on_top)
        .visible(true)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .inner_size(rect.width, rect.height)
        .position(rect.x, rect.y);
    match builder.build() {
        Ok(window) => Ok(window),
        Err(error) => {
            registry.unregister(&label);
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
    let snapshot = app.state::<WindowRegistry>().session_snapshot();
    let repository = app.state::<SqliteRepository>().inner().clone();
    if let Err(error) = repository.window_session_replace(snapshot).await {
        eprintln!("failed to store the window session: {error}");
    }
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
