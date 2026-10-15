//! Where a drawing opened from Finder, a second launch, or the launch
//! arguments goes. In order: the window that already has it open; the window
//! whose Workspace contains it; the most recently used window; a new window.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::registry::{WindowRegistry, WindowRole};
use crate::commands::dto::{OpenFileRequestEvent, WindowActivateDocumentEvent};

/// Where one batch of paths goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// The drawing is open in `label`: bring that window and its tab to the
    /// front.
    ActivateDocument { label: String, path: String },
    /// Open the paths as tabs in `label`.
    Open { label: String, paths: Vec<String> },
    /// No window is left: open a new window with the paths.
    NewWindow { paths: Vec<String> },
}

/// Route canonical drawing paths. Paths sent to the same window stay in one
/// batch, in the order given.
pub fn plan_routes(registry: &WindowRegistry, paths: &[PathBuf]) -> Vec<Route> {
    let mut routes: Vec<Route> = Vec::new();
    for path in paths {
        let text = path.to_string_lossy().into_owned();
        if let Some(label) = registry.document_owner(path) {
            routes.push(Route::ActivateDocument { label, path: text });
            continue;
        }
        let target = registry
            .workspace_owner_of_path(path)
            .or_else(|| registry.most_recently_focused());
        match target {
            Some(label) => match routes.iter_mut().find(
                |route| matches!(route, Route::Open { label: existing, .. } if *existing == label),
            ) {
                Some(Route::Open { paths, .. }) => paths.push(text),
                _ => routes.push(Route::Open {
                    label,
                    paths: vec![text],
                }),
            },
            None => match routes
                .iter_mut()
                .find(|route| matches!(route, Route::NewWindow { .. }))
            {
                Some(Route::NewWindow { paths }) => paths.push(text),
                _ => routes.push(Route::NewWindow { paths: vec![text] }),
            },
        }
    }
    routes
}

fn canonical(path: &str) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| Path::new(path).to_path_buf())
}

/// Route granted drawing paths and deliver them. A window that has not read
/// its startup data yet gets the paths through it; any other window gets an
/// `open-file-request` event. Every target window is brought to the front.
pub fn route_open_paths<R: Runtime>(app: &AppHandle<R>, paths: &[String]) {
    let registry = app.state::<WindowRegistry>();
    let canonical_paths: Vec<PathBuf> = paths.iter().map(|path| canonical(path)).collect();
    for route in plan_routes(&registry, &canonical_paths) {
        match route {
            Route::ActivateDocument { label, path } => {
                super::activate_label(app, &label);
                if let Err(error) = app.emit_to(
                    label.as_str(),
                    "window-activate-document",
                    WindowActivateDocumentEvent { path },
                ) {
                    eprintln!("failed to ask {label} to show a drawing: {error}");
                }
            }
            Route::Open { label, paths } => {
                if let Some(paths) = registry.queue_open_paths(&label, paths) {
                    if let Err(error) = app.emit_to(
                        label.as_str(),
                        "open-file-request",
                        OpenFileRequestEvent { paths },
                    ) {
                        eprintln!("failed to send drawings to {label}: {error}");
                    }
                }
                super::activate_label(app, &label);
            }
            Route::NewWindow { paths } => {
                match super::create_window(app, WindowRole::Normal, None) {
                    Ok(window) => {
                        registry.push_pending_open_paths(window.label(), paths);
                        super::activate_window(&window);
                    }
                    Err(error) => eprintln!("failed to open a window for drawings: {error}"),
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window::registry::{ClaimDecision, WindowRole, WorkspaceCandidate};

    fn registry_with(windows: &[(&str, Option<(&str, &str)>)]) -> WindowRegistry {
        let registry = WindowRegistry::new();
        for (label, workspace) in windows {
            registry.register(label, WindowRole::Normal).unwrap();
            if let Some((id, root)) = workspace {
                let (decision, _) = registry
                    .claim(
                        label,
                        &WorkspaceCandidate {
                            id: Some((*id).to_owned()),
                            root: PathBuf::from(root),
                        },
                    )
                    .unwrap();
                assert!(matches!(decision, ClaimDecision::Claimable { .. }));
            }
        }
        registry
    }

    fn paths(list: &[&str]) -> Vec<PathBuf> {
        list.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn a_drawing_open_in_a_window_activates_that_window() {
        let registry = registry_with(&[("window-1", Some(("a", "/a"))), ("window-2", None)]);
        registry
            .claim_document("window-2", Path::new("/x/note.excalidraw"))
            .unwrap();
        registry.focus("window-1");

        assert_eq!(
            plan_routes(&registry, &paths(&["/x/note.excalidraw"])),
            vec![Route::ActivateDocument {
                label: "window-2".to_owned(),
                path: "/x/note.excalidraw".to_owned()
            }]
        );
    }

    #[test]
    fn the_open_owner_wins_over_the_containing_workspace() {
        // Opened outside any Workspace in window 2, then window 1 opened the
        // folder that contains it.
        let registry = registry_with(&[("window-1", None), ("window-2", None)]);
        registry
            .claim_document("window-2", Path::new("/a/note.excalidraw"))
            .unwrap();
        let (decision, _) = registry
            .claim(
                "window-1",
                &WorkspaceCandidate {
                    id: Some("a".to_owned()),
                    root: PathBuf::from("/a"),
                },
            )
            .unwrap();
        assert!(matches!(decision, ClaimDecision::Claimable { .. }));

        assert_eq!(
            plan_routes(&registry, &paths(&["/a/note.excalidraw"])),
            vec![Route::ActivateDocument {
                label: "window-2".to_owned(),
                path: "/a/note.excalidraw".to_owned()
            }]
        );
    }

    #[test]
    fn a_drawing_inside_a_workspace_goes_to_its_window() {
        let registry = registry_with(&[
            ("window-1", Some(("a", "/a"))),
            ("window-2", Some(("b", "/b"))),
        ]);
        registry.focus("window-2");

        assert_eq!(
            plan_routes(&registry, &paths(&["/a/sub/x.excalidraw"])),
            vec![Route::Open {
                label: "window-1".to_owned(),
                paths: vec!["/a/sub/x.excalidraw".to_owned()]
            }]
        );
    }

    #[test]
    fn any_other_drawing_goes_to_the_most_recently_used_window() {
        let registry = registry_with(&[
            ("window-1", Some(("a", "/a"))),
            ("window-2", None),
            ("window-3", Some(("c", "/c"))),
        ]);
        registry.focus("window-3");
        registry.focus("window-2");

        assert_eq!(
            plan_routes(&registry, &paths(&["/elsewhere/y.excalidraw"])),
            vec![Route::Open {
                label: "window-2".to_owned(),
                paths: vec!["/elsewhere/y.excalidraw".to_owned()]
            }]
        );
    }

    #[test]
    fn with_no_window_one_new_window_gets_every_path() {
        let registry = WindowRegistry::new();

        assert_eq!(
            plan_routes(&registry, &paths(&["/x/1.excalidraw", "/y/2.excalidraw"])),
            vec![Route::NewWindow {
                paths: vec!["/x/1.excalidraw".to_owned(), "/y/2.excalidraw".to_owned()]
            }]
        );
    }

    #[test]
    fn paths_for_the_same_window_stay_in_one_batch_in_order() {
        let registry = registry_with(&[("window-1", Some(("a", "/a"))), ("window-2", None)]);
        registry.focus("window-2");
        registry
            .claim_document("window-2", Path::new("/x/open.excalidraw"))
            .unwrap();

        assert_eq!(
            plan_routes(
                &registry,
                &paths(&[
                    "/elsewhere/1.excalidraw",
                    "/a/2.excalidraw",
                    "/x/open.excalidraw",
                    "/elsewhere/3.excalidraw",
                    "/a/4.excalidraw",
                ])
            ),
            vec![
                Route::Open {
                    label: "window-2".to_owned(),
                    paths: vec![
                        "/elsewhere/1.excalidraw".to_owned(),
                        "/elsewhere/3.excalidraw".to_owned()
                    ]
                },
                Route::Open {
                    label: "window-1".to_owned(),
                    paths: vec!["/a/2.excalidraw".to_owned(), "/a/4.excalidraw".to_owned()]
                },
                Route::ActivateDocument {
                    label: "window-2".to_owned(),
                    path: "/x/open.excalidraw".to_owned()
                },
            ]
        );
    }

    #[test]
    fn a_window_that_has_not_started_gets_paths_through_its_startup_data() {
        let registry = registry_with(&[("window-1", None)]);

        assert_eq!(
            registry.queue_open_paths("window-1", vec!["/x/1.excalidraw".to_owned()]),
            None
        );
        let bootstrap = registry.take_bootstrap("window-1").unwrap();
        assert_eq!(
            bootstrap.pending_open_paths,
            vec!["/x/1.excalidraw".to_owned()]
        );
        assert_eq!(
            registry.queue_open_paths("window-1", vec!["/x/2.excalidraw".to_owned()]),
            Some(vec!["/x/2.excalidraw".to_owned()]),
            "a started window gets later paths as an event"
        );
        assert!(registry
            .take_bootstrap("window-1")
            .unwrap()
            .pending_open_paths
            .is_empty());
    }
}
