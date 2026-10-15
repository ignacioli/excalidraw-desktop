//! Window placement remembered per Workspace.
//!
//! A Workspace window records its normal-state bounds (logical pixels) and
//! whether it is maximized or full screen. While a window is maximized or full
//! screen its normal bounds stay as they were, so leaving either state returns
//! to them. Writes are coalesced and never sit on the canvas editing path.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, MutexGuard,
    },
};

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, WebviewWindow};

use super::{
    geometry::{restored_rect, LogicalRect},
    registry::WindowRegistry,
    session::{WindowPlacement, WindowSessionRepository, SESSION_WRITE_DELAY},
};
use crate::database::repository::SqliteRepository;

/// What a window reports about its placement.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ObservedWindow {
    pub rect: LogicalRect,
    pub maximized: bool,
    pub fullscreen: bool,
}

/// The placement to remember for an observed window. The normal bounds only
/// follow the window while it is in its normal state; a maximized or full
/// screen window keeps `previous_normal`, or its current bounds when none is
/// known yet.
pub fn remembered_placement(
    previous_normal: Option<LogicalRect>,
    observed: ObservedWindow,
) -> WindowPlacement {
    let normal = if observed.maximized || observed.fullscreen {
        previous_normal.unwrap_or(observed.rect)
    } else {
        observed.rect
    };
    WindowPlacement {
        x: normal.x,
        y: normal.y,
        width: normal.width,
        height: normal.height,
        maximized: observed.maximized,
        fullscreen: observed.fullscreen,
    }
}

/// How to show a window with a remembered placement: its normal bounds moved
/// onto a connected display when needed, then the remembered state on top.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlacementPlan {
    pub rect: LogicalRect,
    pub maximized: bool,
    pub fullscreen: bool,
}

pub fn restore_plan(
    remembered: &WindowPlacement,
    work_areas: &[LogicalRect],
    primary: &LogicalRect,
) -> PlacementPlan {
    let normal = LogicalRect {
        x: remembered.x,
        y: remembered.y,
        width: remembered.width,
        height: remembered.height,
    };
    PlacementPlan {
        rect: restored_rect(&normal, work_areas, primary),
        maximized: remembered.maximized,
        fullscreen: remembered.fullscreen,
    }
}

/// Normal bounds per window and placements waiting to be written.
#[derive(Debug, Default)]
pub struct PlacementTracker {
    normal: Mutex<HashMap<String, LogicalRect>>,
    pending: Mutex<HashMap<String, WindowPlacement>>,
    scheduled: AtomicBool,
}

impl PlacementTracker {
    fn normal(&self) -> MutexGuard<'_, HashMap<String, LogicalRect>> {
        self.normal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn pending(&self) -> MutexGuard<'_, HashMap<String, WindowPlacement>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Fold an observation of window `label` into its normal bounds and
    /// return the placement to remember.
    pub fn observe(&self, label: &str, observed: ObservedWindow) -> WindowPlacement {
        let mut normal = self.normal();
        let placement = remembered_placement(normal.get(label).copied(), observed);
        normal.insert(
            label.to_owned(),
            LogicalRect {
                x: placement.x,
                y: placement.y,
                width: placement.width,
                height: placement.height,
            },
        );
        placement
    }

    /// The normal bounds a window was given, before it is maximized or made
    /// full screen.
    pub fn set_normal(&self, label: &str, rect: LogicalRect) {
        self.normal().insert(label.to_owned(), rect);
    }

    pub fn forget(&self, label: &str) {
        self.normal().remove(label);
    }

    /// Queue `placement` for `workspace_id`; the latest one wins.
    pub fn queue(&self, workspace_id: String, placement: WindowPlacement) {
        self.pending().insert(workspace_id, placement);
    }

    pub fn take_pending(&self) -> Vec<(String, WindowPlacement)> {
        self.pending().drain().collect()
    }

    /// Claim the pending delayed write; `false` when one is already queued.
    fn try_schedule(&self) -> bool {
        !self.scheduled.swap(true, Ordering::SeqCst)
    }

    fn clear_scheduled(&self) {
        self.scheduled.store(false, Ordering::SeqCst);
    }
}

/// Where window `label` is now. `None` when the platform cannot say.
pub fn observe_window<R: Runtime>(window: &tauri::Window<R>) -> Option<ObservedWindow> {
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some(ObservedWindow {
        rect: LogicalRect {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
        maximized: window.is_maximized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
    })
}

/// A window moved, resized, or changed state: remember where its Workspace
/// window is. Windows without a Workspace only update their normal bounds.
pub fn record<R: Runtime>(app: &AppHandle<R>, label: &str, observed: ObservedWindow) {
    let placement = app.state::<PlacementTracker>().observe(label, observed);
    let Some(workspace) = app
        .state::<WindowRegistry>()
        .window(label)
        .and_then(|window| window.workspace)
    else {
        return;
    };
    app.state::<PlacementTracker>()
        .queue(workspace.id, placement);
    schedule_write(app);
}

fn schedule_write<R: Runtime>(app: &AppHandle<R>) {
    if !app.state::<PlacementTracker>().try_schedule() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SESSION_WRITE_DELAY).await;
        app.state::<PlacementTracker>().clear_scheduled();
        flush(&app).await;
    });
}

/// Write every queued placement now. A failure is logged: placement is a
/// convenience and never blocks a window action.
pub async fn flush<R: Runtime>(app: &AppHandle<R>) {
    let pending = app.state::<PlacementTracker>().take_pending();
    if pending.is_empty() {
        return;
    }
    let repository = app.state::<SqliteRepository>().inner().clone();
    for (workspace_id, placement) in pending {
        if let Err(error) = repository
            .workspace_placement_save(workspace_id.clone(), placement)
            .await
        {
            eprintln!("failed to store the window placement of {workspace_id}: {error}");
        }
    }
}

/// The remembered placement of `workspace_id` for the displays connected now.
pub async fn remembered_plan<R: Runtime>(
    app: &AppHandle<R>,
    workspace_id: &str,
) -> Option<PlacementPlan> {
    let repository = app.state::<SqliteRepository>().inner().clone();
    let placement = match repository
        .workspace_window_state_get(workspace_id.to_owned())
        .await
    {
        Ok(state) => state?.placement?,
        Err(error) => {
            eprintln!("failed to read the window placement of {workspace_id}: {error}");
            return None;
        }
    };
    let primary = super::primary_work_area(app);
    let work_areas: Vec<LogicalRect> = app
        .available_monitors()
        .map(|monitors| monitors.iter().map(super::monitor_work_area).collect())
        .unwrap_or_default();
    let work_areas = if work_areas.is_empty() {
        vec![primary]
    } else {
        work_areas
    };
    Some(restore_plan(&placement, &work_areas, &primary))
}

/// A window took a Workspace: show it where that Workspace was last shown,
/// or, when nothing is remembered, remember where it is now.
pub async fn place_for_workspace<R: Runtime>(app: &AppHandle<R>, label: &str, workspace_id: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    match remembered_plan(app, workspace_id).await {
        Some(plan) => apply(app, &window, plan),
        None => {
            if let Some(observed) = observe_window(&window.as_ref().window()) {
                record(app, label, observed);
            }
        }
    }
}

/// Show an existing window with `plan`. The normal bounds are set while the
/// window is in its normal state, so leaving maximized or full screen later
/// returns to them.
pub fn apply<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>, plan: PlacementPlan) {
    let label = window.label();
    app.state::<PlacementTracker>().set_normal(label, plan.rect);
    let log = |what: &str, result: tauri::Result<()>| {
        if let Err(error) = result {
            eprintln!("failed to {what} window {label}: {error}");
        }
    };
    if window.is_fullscreen().unwrap_or(false) && !plan.fullscreen {
        log("leave full screen in", window.set_fullscreen(false));
    }
    if window.is_maximized().unwrap_or(false) && !plan.maximized {
        log("unmaximize", window.unmaximize());
    }
    log(
        "resize",
        window.set_size(LogicalSize::new(plan.rect.width, plan.rect.height)),
    );
    log(
        "move",
        window.set_position(LogicalPosition::new(plan.rect.x, plan.rect.y)),
    );
    if plan.maximized && !plan.fullscreen {
        log("maximize", window.maximize());
    }
    if plan.fullscreen {
        log("enter full screen in", window.set_fullscreen(true));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, width: f64, height: f64) -> LogicalRect {
        LogicalRect {
            x,
            y,
            width,
            height,
        }
    }

    fn observed(rect: LogicalRect, maximized: bool, fullscreen: bool) -> ObservedWindow {
        ObservedWindow {
            rect,
            maximized,
            fullscreen,
        }
    }

    const NORMAL: LogicalRect = LogicalRect {
        x: 120.0,
        y: 80.0,
        width: 1100.0,
        height: 720.0,
    };
    const FILLED: LogicalRect = LogicalRect {
        x: 0.0,
        y: 25.0,
        width: 1440.0,
        height: 847.0,
    };

    #[test]
    fn a_normal_window_remembers_its_current_bounds() {
        let placement = remembered_placement(
            Some(rect(0.0, 0.0, 960.0, 640.0)),
            observed(NORMAL, false, false),
        );
        assert_eq!(
            placement,
            WindowPlacement {
                x: 120.0,
                y: 80.0,
                width: 1100.0,
                height: 720.0,
                maximized: false,
                fullscreen: false,
            }
        );
    }

    #[test]
    fn maximized_and_full_screen_windows_keep_their_normal_bounds() {
        for (maximized, fullscreen) in [(true, false), (false, true), (true, true)] {
            let placement =
                remembered_placement(Some(NORMAL), observed(FILLED, maximized, fullscreen));
            assert_eq!(
                (placement.x, placement.y, placement.width, placement.height),
                (NORMAL.x, NORMAL.y, NORMAL.width, NORMAL.height)
            );
            assert_eq!(
                (placement.maximized, placement.fullscreen),
                (maximized, fullscreen)
            );
        }
    }

    #[test]
    fn a_window_first_seen_maximized_falls_back_to_its_current_bounds() {
        let placement = remembered_placement(None, observed(FILLED, true, false));
        assert_eq!(
            (placement.width, placement.height),
            (FILLED.width, FILLED.height)
        );
        assert!(placement.maximized);
    }

    #[test]
    fn the_tracker_returns_to_the_normal_bounds_after_maximize_and_full_screen() {
        let tracker = PlacementTracker::default();
        tracker.observe("window-1", observed(NORMAL, false, false));
        let maximized = tracker.observe("window-1", observed(FILLED, true, false));
        assert_eq!(
            (maximized.width, maximized.height),
            (NORMAL.width, NORMAL.height)
        );
        let fullscreen = tracker.observe("window-1", observed(FILLED, false, true));
        assert_eq!((fullscreen.x, fullscreen.y), (NORMAL.x, NORMAL.y));
        let back = tracker.observe("window-1", observed(NORMAL, false, false));
        assert_eq!(
            back,
            remembered_placement(None, observed(NORMAL, false, false))
        );
    }

    #[test]
    fn bounds_given_before_maximizing_are_the_normal_bounds() {
        let tracker = PlacementTracker::default();
        tracker.set_normal("window-1", NORMAL);
        let placement = tracker.observe("window-1", observed(FILLED, true, false));
        assert_eq!((placement.x, placement.width), (NORMAL.x, NORMAL.width));
        tracker.forget("window-1");
        let fresh = tracker.observe("window-1", observed(FILLED, true, false));
        assert_eq!(fresh.width, FILLED.width);
    }

    #[test]
    fn queued_placements_coalesce_per_workspace() {
        let tracker = PlacementTracker::default();
        let first = remembered_placement(None, observed(NORMAL, false, false));
        let second = remembered_placement(Some(NORMAL), observed(FILLED, true, false));
        tracker.queue("a".to_owned(), first);
        tracker.queue("a".to_owned(), second);
        tracker.queue("b".to_owned(), first);
        let mut pending = tracker.take_pending();
        pending.sort_by(|left, right| left.0.cmp(&right.0));
        assert_eq!(
            pending,
            vec![("a".to_owned(), second), ("b".to_owned(), first)]
        );
        assert!(tracker.take_pending().is_empty());
        assert!(tracker.try_schedule());
        assert!(!tracker.try_schedule());
        tracker.clear_scheduled();
        assert!(tracker.try_schedule());
    }

    #[test]
    fn a_restored_maximized_or_full_screen_window_starts_from_its_normal_bounds() {
        let main = rect(0.0, 25.0, 1440.0, 875.0);
        for (maximized, fullscreen) in [(true, false), (false, true)] {
            let remembered = WindowPlacement {
                x: NORMAL.x,
                y: NORMAL.y,
                width: NORMAL.width,
                height: NORMAL.height,
                maximized,
                fullscreen,
            };
            let plan = restore_plan(&remembered, &[main], &main);
            assert_eq!(plan.rect, NORMAL);
            assert_eq!((plan.maximized, plan.fullscreen), (maximized, fullscreen));
        }
    }

    #[test]
    fn a_restored_placement_on_a_disconnected_display_moves_to_the_primary_display() {
        let main = rect(0.0, 25.0, 1440.0, 875.0);
        let remembered = WindowPlacement {
            x: 1600.0,
            y: 100.0,
            width: 1100.0,
            height: 720.0,
            maximized: true,
            fullscreen: false,
        };
        let plan = restore_plan(&remembered, &[main], &main);
        assert!(plan.rect.x >= main.x && plan.rect.right() <= main.right());
        assert!(plan.rect.y >= main.y && plan.rect.bottom() <= main.bottom());
        assert!(plan.maximized);
    }
}
