//! Coordinated quit: every window checkpoints its drawings before the app
//! exits, and a single failure or silence cancels the quit.
//!
//! [`QuitCoordinator`] is the state machine; it takes the clock as an
//! argument so every transition is testable without a runtime. The functions
//! below it drive the real windows.

use std::{
    collections::BTreeSet,
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::registry::WindowRegistry;
use crate::commands::dto::{AppQuitCancelledEvent, AppQuitRequestedEvent};

/// How long a window may take to report its checkpoint before the quit is
/// cancelled.
pub const DEFAULT_QUIT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
enum QuitState {
    Idle,
    Collecting {
        request_id: String,
        pending: BTreeSet<String>,
        deadline: Instant,
    },
    Exiting,
}

/// What the caller must do after a transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuitStep {
    /// Ask `labels` to checkpoint and check again at `deadline`.
    Ask {
        request_id: String,
        labels: Vec<String>,
        deadline: Instant,
    },
    /// Every window is ready: store the Window Session and exit.
    Exit,
    /// Cancel the quit: bring `failed_label` to the front and tell every
    /// window.
    Cancel {
        request_id: String,
        failed_label: String,
    },
    /// Nothing to do.
    Wait,
}

pub struct QuitCoordinator {
    timeout: Duration,
    state: Mutex<QuitState>,
    next_request: Mutex<u64>,
}

impl QuitCoordinator {
    pub fn new(timeout: Duration) -> Self {
        Self {
            timeout,
            state: Mutex::new(QuitState::Idle),
            next_request: Mutex::new(0),
        }
    }

    fn lock(&self) -> MutexGuard<'_, QuitState> {
        // Every transition replaces the whole state, so a poisoned lock
        // still holds a consistent value.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn allocate_request_id(&self) -> String {
        let mut next = self
            .next_request
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *next += 1;
        format!("quit-{}", *next)
    }

    /// Quit was chosen. A quit already collecting keeps its request; once
    /// exiting, nothing more happens.
    pub fn request(&self, labels: Vec<String>, now: Instant) -> QuitStep {
        let mut state = self.lock();
        match &*state {
            QuitState::Collecting { .. } | QuitState::Exiting => QuitStep::Wait,
            QuitState::Idle if labels.is_empty() => {
                *state = QuitState::Exiting;
                QuitStep::Exit
            }
            QuitState::Idle => {
                let request_id = self.allocate_request_id();
                let deadline = now + self.timeout;
                *state = QuitState::Collecting {
                    request_id: request_id.clone(),
                    pending: labels.iter().cloned().collect(),
                    deadline,
                };
                QuitStep::Ask {
                    request_id,
                    labels,
                    deadline,
                }
            }
        }
    }

    /// Window `label` finished its checkpoint for `request_id`.
    pub fn ready(&self, request_id: &str, label: &str, ok: bool) -> QuitStep {
        let mut state = self.lock();
        let QuitState::Collecting {
            request_id: current,
            pending,
            ..
        } = &mut *state
        else {
            return QuitStep::Wait;
        };
        if current != request_id || !pending.remove(label) {
            return QuitStep::Wait;
        }
        if !ok {
            let step = QuitStep::Cancel {
                request_id: current.clone(),
                failed_label: label.to_owned(),
            };
            *state = QuitState::Idle;
            return step;
        }
        Self::finish_if_done(&mut state)
    }

    /// A destroyed window checkpointed through its own close, so it no
    /// longer holds up the quit.
    pub fn window_destroyed(&self, label: &str) -> QuitStep {
        let mut state = self.lock();
        let QuitState::Collecting { pending, .. } = &mut *state else {
            return QuitStep::Wait;
        };
        if !pending.remove(label) {
            return QuitStep::Wait;
        }
        Self::finish_if_done(&mut state)
    }

    /// The deadline of `request_id` may have passed: cancel when a window is
    /// still silent.
    pub fn check_deadline(&self, request_id: &str, now: Instant) -> QuitStep {
        let mut state = self.lock();
        let QuitState::Collecting {
            request_id: current,
            pending,
            deadline,
        } = &*state
        else {
            return QuitStep::Wait;
        };
        if current != request_id || now < *deadline {
            return QuitStep::Wait;
        }
        let Some(failed_label) = pending.iter().next().cloned() else {
            return QuitStep::Wait;
        };
        let step = QuitStep::Cancel {
            request_id: current.clone(),
            failed_label,
        };
        *state = QuitState::Idle;
        step
    }

    /// Whether the app is exiting after a successful quit.
    pub fn is_exiting(&self) -> bool {
        matches!(*self.lock(), QuitState::Exiting)
    }

    fn finish_if_done(state: &mut QuitState) -> QuitStep {
        match state {
            QuitState::Collecting { pending, .. } if pending.is_empty() => {
                *state = QuitState::Exiting;
                QuitStep::Exit
            }
            _ => QuitStep::Wait,
        }
    }
}

/// The quit timeout. Test-only builds may shorten it so a silent window is
/// detected quickly.
pub fn configured_timeout() -> Duration {
    #[cfg(feature = "e2e-harness")]
    if let Some(milliseconds) = std::env::var("EXCALIDRAW_E2E_QUIT_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
    {
        return Duration::from_millis(milliseconds);
    }
    DEFAULT_QUIT_TIMEOUT
}

/// Quit from the menu (or the test-only driver): ask every window to
/// checkpoint.
pub fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let labels = app.state::<WindowRegistry>().labels();
    let step = app
        .state::<QuitCoordinator>()
        .request(labels, Instant::now());
    apply(app, step);
}

/// A window reported its checkpoint result.
pub fn report_ready<R: Runtime>(app: &AppHandle<R>, request_id: &str, label: &str, ok: bool) {
    let step = app.state::<QuitCoordinator>().ready(request_id, label, ok);
    apply(app, step);
}

/// A window was destroyed while a quit may be collecting.
pub fn forget_window<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let step = app.state::<QuitCoordinator>().window_destroyed(label);
    apply(app, step);
}

fn apply<R: Runtime>(app: &AppHandle<R>, step: QuitStep) {
    match step {
        QuitStep::Wait => {}
        QuitStep::Ask {
            request_id,
            labels,
            deadline,
        } => {
            eprintln!("app-quit-requested {request_id} to {}", labels.join(","));
            for label in &labels {
                if let Err(error) = app.emit_to(
                    label.as_str(),
                    "app-quit-requested",
                    AppQuitRequestedEvent {
                        request_id: request_id.clone(),
                    },
                ) {
                    eprintln!("failed to ask {label} to checkpoint before quitting: {error}");
                }
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(deadline.saturating_duration_since(Instant::now())).await;
                let step = app
                    .state::<QuitCoordinator>()
                    .check_deadline(&request_id, Instant::now());
                apply(&app, step);
            });
        }
        QuitStep::Exit => {
            eprintln!("app-quit-exit");
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                super::persist_session(&app).await;
                // The windows destroyed by the exit must not overwrite the
                // session just stored.
                app.state::<super::session::SessionWriter>().freeze();
                app.exit(0);
            });
        }
        QuitStep::Cancel {
            request_id,
            failed_label,
        } => {
            eprintln!("app-quit-cancelled {request_id} by {failed_label}");
            super::activate_label(app, &failed_label);
            if let Err(error) = app.emit(
                "app-quit-cancelled",
                AppQuitCancelledEvent {
                    request_id,
                    failed_label,
                },
            ) {
                eprintln!("failed to announce the cancelled quit: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn start(coordinator: &QuitCoordinator, now: Instant) -> String {
        match coordinator.request(labels(&["window-1", "window-2"]), now) {
            QuitStep::Ask {
                request_id,
                labels: asked,
                deadline,
            } => {
                assert_eq!(asked, labels(&["window-1", "window-2"]));
                assert_eq!(deadline, now + Duration::from_secs(10));
                request_id
            }
            other => panic!("expected Ask, got {other:?}"),
        }
    }

    #[test]
    fn exits_once_every_window_is_ready() {
        let coordinator = QuitCoordinator::new(DEFAULT_QUIT_TIMEOUT);
        let id = start(&coordinator, Instant::now());

        assert_eq!(coordinator.ready(&id, "window-1", true), QuitStep::Wait);
        assert!(!coordinator.is_exiting());
        assert_eq!(coordinator.ready(&id, "window-2", true), QuitStep::Exit);
        assert!(coordinator.is_exiting());
    }

    #[test]
    fn exits_at_once_without_windows() {
        let coordinator = QuitCoordinator::new(DEFAULT_QUIT_TIMEOUT);

        assert_eq!(
            coordinator.request(Vec::new(), Instant::now()),
            QuitStep::Exit
        );
        assert!(coordinator.is_exiting());
    }

    #[test]
    fn one_failure_cancels_and_names_the_window() {
        let coordinator = QuitCoordinator::new(DEFAULT_QUIT_TIMEOUT);
        let id = start(&coordinator, Instant::now());

        assert_eq!(coordinator.ready(&id, "window-1", true), QuitStep::Wait);
        assert_eq!(
            coordinator.ready(&id, "window-2", false),
            QuitStep::Cancel {
                request_id: id.clone(),
                failed_label: "window-2".to_owned(),
            }
        );
        assert!(!coordinator.is_exiting());
        // A late answer to the cancelled request changes nothing.
        assert_eq!(coordinator.ready(&id, "window-1", true), QuitStep::Wait);
    }

    #[test]
    fn a_silent_window_cancels_at_the_deadline() {
        let coordinator = QuitCoordinator::new(DEFAULT_QUIT_TIMEOUT);
        let now = Instant::now();
        let id = start(&coordinator, now);
        assert_eq!(coordinator.ready(&id, "window-1", true), QuitStep::Wait);

        assert_eq!(
            coordinator.check_deadline(&id, now + Duration::from_secs(9)),
            QuitStep::Wait
        );
        assert_eq!(
            coordinator.check_deadline(&id, now + Duration::from_secs(10)),
            QuitStep::Cancel {
                request_id: id.clone(),
                failed_label: "window-2".to_owned(),
            }
        );
        assert_eq!(
            coordinator.check_deadline(&id, now + Duration::from_secs(11)),
            QuitStep::Wait
        );
    }

    #[test]
    fn a_destroyed_window_counts_as_ready() {
        let coordinator = QuitCoordinator::new(DEFAULT_QUIT_TIMEOUT);
        let id = start(&coordinator, Instant::now());

        assert_eq!(coordinator.window_destroyed("window-1"), QuitStep::Wait);
        assert_eq!(coordinator.window_destroyed("window-1"), QuitStep::Wait);
        assert_eq!(coordinator.ready(&id, "window-2", true), QuitStep::Exit);
    }

    #[test]
    fn destroying_the_last_pending_window_exits() {
        let coordinator = QuitCoordinator::new(DEFAULT_QUIT_TIMEOUT);
        let id = start(&coordinator, Instant::now());
        assert_eq!(coordinator.ready(&id, "window-1", true), QuitStep::Wait);

        assert_eq!(coordinator.window_destroyed("window-2"), QuitStep::Exit);
    }

    #[test]
    fn quitting_again_while_collecting_keeps_the_request() {
        let coordinator = QuitCoordinator::new(DEFAULT_QUIT_TIMEOUT);
        let id = start(&coordinator, Instant::now());

        assert_eq!(
            coordinator.request(labels(&["window-1", "window-2"]), Instant::now()),
            QuitStep::Wait
        );
        assert_eq!(coordinator.ready(&id, "window-1", true), QuitStep::Wait);
        assert_eq!(coordinator.ready(&id, "window-2", true), QuitStep::Exit);
        assert_eq!(
            coordinator.request(labels(&["window-1"]), Instant::now()),
            QuitStep::Wait,
            "nothing restarts once exiting"
        );
    }

    #[test]
    fn quitting_after_a_cancel_starts_a_new_request() {
        let coordinator = QuitCoordinator::new(DEFAULT_QUIT_TIMEOUT);
        let first = start(&coordinator, Instant::now());
        assert!(matches!(
            coordinator.ready(&first, "window-1", false),
            QuitStep::Cancel { .. }
        ));

        let second = start(&coordinator, Instant::now());
        assert_ne!(first, second);
        assert_eq!(coordinator.ready(&first, "window-1", true), QuitStep::Wait);
        assert_eq!(coordinator.ready(&second, "window-1", true), QuitStep::Wait);
        assert_eq!(coordinator.ready(&second, "window-2", true), QuitStep::Exit);
    }

    #[test]
    fn answers_from_unknown_windows_are_ignored() {
        let coordinator = QuitCoordinator::new(DEFAULT_QUIT_TIMEOUT);
        let id = start(&coordinator, Instant::now());

        assert_eq!(coordinator.ready(&id, "window-9", false), QuitStep::Wait);
        assert_eq!(
            coordinator.ready("quit-0", "window-1", false),
            QuitStep::Wait
        );
        assert_eq!(coordinator.ready(&id, "window-1", true), QuitStep::Wait);
        assert_eq!(coordinator.ready(&id, "window-2", true), QuitStep::Exit);
    }
}
