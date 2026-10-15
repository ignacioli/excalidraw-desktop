//! Window-targeted backend events. Workspace events go to the window that
//! owns the Workspace; document events go to the window that owns the
//! document. An event with no owner is dropped.

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::registry::WindowRegistry;

/// The window a Workspace event goes to, if any window owns the Workspace.
pub fn workspace_event_target(registry: &WindowRegistry, workspace_id: &str) -> Option<String> {
    registry.workspace_owner(workspace_id)
}

/// The window a document event goes to: the window that owns the drawing.
pub fn document_event_target(registry: &WindowRegistry, canonical_path: &Path) -> Option<String> {
    registry.document_owner(canonical_path)
}

/// Send a Workspace event to the window that owns `workspace_id`.
pub fn emit_to_workspace_owner<R: Runtime, S: Serialize + Clone>(
    app: &AppHandle<R>,
    workspace_id: &str,
    event: &str,
    payload: S,
) -> tauri::Result<()> {
    match workspace_event_target(&app.state::<WindowRegistry>(), workspace_id) {
        Some(label) => app.emit_to(label.as_str(), event, payload),
        None => Ok(()),
    }
}

/// Send a document event to the window that owns `path`.
pub fn emit_to_document_owner<R: Runtime, S: Serialize + Clone>(
    app: &AppHandle<R>,
    path: &Path,
    event: &str,
    payload: S,
) -> tauri::Result<()> {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    match document_event_target(&app.state::<WindowRegistry>(), &canonical) {
        Some(label) => app.emit_to(label.as_str(), event, payload),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window::registry::{ClaimDecision, WindowRole, WorkspaceCandidate};
    use std::path::PathBuf;

    fn registry_with(windows: &[(&str, Option<(&str, &str)>)]) -> WindowRegistry {
        let registry = WindowRegistry::new();
        for (label, workspace) in windows {
            registry.register(label, WindowRole::Normal).unwrap();
            if let Some((id, root)) = workspace {
                let decision = registry
                    .claim(
                        label,
                        &WorkspaceCandidate {
                            id: Some((*id).to_owned()),
                            root: PathBuf::from(root),
                        },
                    )
                    .unwrap();
                assert!(matches!(decision.0, ClaimDecision::Claimable { .. }));
            }
        }
        registry
    }

    #[test]
    fn workspace_events_go_only_to_the_owner() {
        let registry = registry_with(&[
            ("window-1", Some(("a", "/a"))),
            ("window-2", Some(("b", "/b"))),
            ("window-3", None),
        ]);

        assert_eq!(
            workspace_event_target(&registry, "b").as_deref(),
            Some("window-2")
        );
        assert_eq!(workspace_event_target(&registry, "missing"), None);
    }

    #[test]
    fn document_events_go_only_to_the_document_owner() {
        let registry = registry_with(&[
            ("window-1", Some(("a", "/a"))),
            ("window-2", Some(("b", "/b"))),
        ]);
        let path = Path::new("/elsewhere/note.excalidraw");
        registry.claim_document("window-2", path).unwrap();

        assert_eq!(
            document_event_target(&registry, path).as_deref(),
            Some("window-2")
        );
    }

    #[test]
    fn document_events_with_no_owner_are_dropped() {
        let registry = registry_with(&[
            ("window-1", Some(("a", "/a"))),
            ("window-2", Some(("b", "/b"))),
            ("window-3", None),
        ]);

        assert_eq!(
            document_event_target(&registry, Path::new("/b/note.excalidraw")),
            None
        );
        assert_eq!(
            document_event_target(&registry, Path::new("/elsewhere/x.excalidraw")),
            None
        );
    }
}
