#![allow(
    dead_code,
    reason = "the multi-window user stories consume these items as their slices land"
)]

//! The single authority for window, Workspace, and drawing ownership.
//!
//! Every mutation happens inside one lock so concurrent requests are
//! serialized: two windows claiming the same Workspace at the same time get
//! exactly one `Claimed`. Callers must emit events and activate windows only
//! after the call returns, never while holding the lock.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

use crate::database::repository::WorkspaceRecord;

use super::session::WindowSessionEntry;

/// Label prefix of every application window; the capability file grants
/// `window-*`.
pub const WINDOW_LABEL_PREFIX: &str = "window-";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowRole {
    Normal,
    /// The single window that presents Recovery after an abnormal exit.
    Recovery,
}

/// Restorable tabs handed to a window once, through its bootstrap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowRestore {
    pub tabs: Vec<String>,
    pub active_path: Option<String>,
    pub skipped: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedWorkspace {
    pub id: String,
    /// Canonical root path.
    pub root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowRecord {
    pub label: String,
    pub workspace: Option<OwnedWorkspace>,
    pub documents: BTreeSet<PathBuf>,
    pub last_focused_seq: u64,
    pub role: WindowRole,
    pub pending_open_paths: Vec<String>,
    pub restore: Option<WindowRestore>,
    pub unavailable_workspace: Option<WorkspaceRecord>,
    /// The open tabs and active tab the window last reported, saved in the
    /// Window Session.
    pub session_tabs: Vec<String>,
    pub session_active_path: Option<String>,
    /// Whether the window has read its startup data; later launch paths go
    /// to it as events.
    pub bootstrapped: bool,
}

impl WindowRecord {
    fn new(label: String, role: WindowRole) -> Self {
        Self {
            label,
            workspace: None,
            documents: BTreeSet::new(),
            last_focused_seq: 0,
            role,
            pending_open_paths: Vec::new(),
            restore: None,
            unavailable_workspace: None,
            session_tabs: Vec::new(),
            session_active_path: None,
            bootstrapped: false,
        }
    }
}

/// A Workspace a window wants to open. `id` is `None` for a folder that is
/// not in the recent list yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceCandidate {
    pub id: Option<String>,
    /// Canonical root path.
    pub root: PathBuf,
}

/// The ownership decision for opening a Workspace in a window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimDecision {
    /// The window may open the Workspace; `replaced` is the Workspace it
    /// held before, released by the same claim.
    Claimable { replaced: Option<String> },
    /// The same Workspace is open in another window.
    OwnedBy { label: String, workspace_id: String },
    /// The candidate lies inside a Workspace open in another window.
    InsideOpen {
        label: String,
        workspace_id: String,
        relative_path: String,
    },
    /// The candidate contains a Workspace open in another window.
    ContainsOpen { label: String, workspace_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocumentClaim {
    Claimed,
    OwnedElsewhere { label: String },
}

/// Undo record for a committed Workspace claim, used when the matching
/// `mounted` write fails.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimRollback {
    label: String,
    claimed_id: String,
    previous: Option<OwnedWorkspace>,
}

/// What a destroyed window held.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReleasedWindow {
    pub workspace_id: Option<String>,
    pub documents: Vec<PathBuf>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum RegistryError {
    #[error("window {0} is not registered")]
    UnknownWindow(String),
    #[error("window {0} is already registered")]
    DuplicateWindow(String),
    #[error("Workspace {0} has no id")]
    MissingWorkspaceId(String),
}

#[derive(Default)]
struct RegistryState {
    next_label: u64,
    focus_seq: u64,
    windows: BTreeMap<String, WindowRecord>,
    workspace_owner: HashMap<String, String>,
    document_owner: HashMap<PathBuf, String>,
}

#[derive(Default)]
pub struct WindowRegistry {
    state: Mutex<RegistryState>,
}

impl WindowRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, RegistryState> {
        // A panic while holding the lock leaves the indexes as they were
        // before the panicking call; every mutation is a few map operations
        // that cannot panic halfway on reachable input.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reserve the next window label. Labels are never reused.
    pub fn allocate_label(&self) -> String {
        let mut state = self.lock();
        state.next_label += 1;
        format!("{WINDOW_LABEL_PREFIX}{}", state.next_label)
    }

    pub fn register(&self, label: &str, role: WindowRole) -> Result<(), RegistryError> {
        let mut state = self.lock();
        if state.windows.contains_key(label) {
            return Err(RegistryError::DuplicateWindow(label.to_owned()));
        }
        state
            .windows
            .insert(label.to_owned(), WindowRecord::new(label.to_owned(), role));
        state.debug_check();
        Ok(())
    }

    /// Remove a window and release everything it owned.
    pub fn unregister(&self, label: &str) -> ReleasedWindow {
        let mut state = self.lock();
        let Some(record) = state.windows.remove(label) else {
            return ReleasedWindow::default();
        };
        let workspace_id = record.workspace.map(|workspace| workspace.id);
        if let Some(id) = workspace_id.as_ref() {
            state.workspace_owner.remove(id);
        }
        for path in &record.documents {
            state.document_owner.remove(path);
        }
        state.debug_check();
        ReleasedWindow {
            workspace_id,
            documents: record.documents.into_iter().collect(),
        }
    }

    pub fn window(&self, label: &str) -> Option<WindowRecord> {
        self.lock().windows.get(label).cloned()
    }

    pub fn labels(&self) -> Vec<String> {
        self.lock().windows.keys().cloned().collect()
    }

    /// Ids of the Workspaces currently open in any window.
    pub fn owned_workspace_ids(&self) -> BTreeSet<String> {
        self.lock().workspace_owner.keys().cloned().collect()
    }

    /// Decide, without changing anything, whether `label` may open
    /// `candidate`.
    pub fn probe(
        &self,
        label: &str,
        candidate: &WorkspaceCandidate,
    ) -> Result<ClaimDecision, RegistryError> {
        self.lock().decide(label, candidate)
    }

    /// Decide and, when the Workspace is claimable, commit the claim in the
    /// same critical section. The rollback record undoes the claim if the
    /// matching persistence write fails.
    pub fn claim(
        &self,
        label: &str,
        candidate: &WorkspaceCandidate,
    ) -> Result<(ClaimDecision, Option<ClaimRollback>), RegistryError> {
        let mut state = self.lock();
        let decision = state.decide(label, candidate)?;
        let ClaimDecision::Claimable { .. } = decision else {
            return Ok((decision, None));
        };
        let id = candidate.id.clone().ok_or_else(|| {
            RegistryError::MissingWorkspaceId(candidate.root.display().to_string())
        })?;
        let previous = state.set_workspace(
            label,
            Some(OwnedWorkspace {
                id: id.clone(),
                root: candidate.root.clone(),
            }),
        );
        state.debug_check();
        Ok((
            decision,
            Some(ClaimRollback {
                label: label.to_owned(),
                claimed_id: id,
                previous,
            }),
        ))
    }

    /// Undo a claim whose persistence write failed. Does nothing when the
    /// window no longer holds the claimed Workspace.
    pub fn rollback_claim(&self, rollback: ClaimRollback) {
        let mut state = self.lock();
        let still_claimed = state
            .windows
            .get(&rollback.label)
            .and_then(|record| record.workspace.as_ref())
            .is_some_and(|workspace| workspace.id == rollback.claimed_id);
        if !still_claimed {
            return;
        }
        let previous_is_free = rollback
            .previous
            .as_ref()
            .is_none_or(|previous| !state.workspace_owner.contains_key(&previous.id));
        let restored = if previous_is_free {
            rollback.previous
        } else {
            None
        };
        state.set_workspace(&rollback.label, restored);
        state.debug_check();
    }

    /// Release the Workspace held by `label`, returning its id.
    pub fn release_workspace(&self, label: &str) -> Result<Option<String>, RegistryError> {
        let mut state = self.lock();
        if !state.windows.contains_key(label) {
            return Err(RegistryError::UnknownWindow(label.to_owned()));
        }
        let previous = state.set_workspace(label, None);
        state.debug_check();
        Ok(previous.map(|workspace| workspace.id))
    }

    pub fn workspace_owner(&self, workspace_id: &str) -> Option<String> {
        self.lock().workspace_owner.get(workspace_id).cloned()
    }

    /// The window whose Workspace contains `canonical_path`, if any.
    pub fn workspace_owner_of_path(&self, canonical_path: &Path) -> Option<String> {
        self.lock().workspace_containing(canonical_path, None)
    }

    pub fn document_owner(&self, canonical_path: &Path) -> Option<String> {
        self.lock().document_owner.get(canonical_path).cloned()
    }

    /// Register `label` as the owner of a drawing. A drawing already open in
    /// another window, or inside another window's Workspace, stays there.
    pub fn claim_document(
        &self,
        label: &str,
        canonical_path: &Path,
    ) -> Result<DocumentClaim, RegistryError> {
        let mut state = self.lock();
        if !state.windows.contains_key(label) {
            return Err(RegistryError::UnknownWindow(label.to_owned()));
        }
        if let Some(owner) = state.document_owner.get(canonical_path) {
            if owner != label {
                return Ok(DocumentClaim::OwnedElsewhere {
                    label: owner.clone(),
                });
            }
            return Ok(DocumentClaim::Claimed);
        }
        if let Some(owner) = state.workspace_containing(canonical_path, Some(label)) {
            return Ok(DocumentClaim::OwnedElsewhere { label: owner });
        }
        state
            .document_owner
            .insert(canonical_path.to_path_buf(), label.to_owned());
        if let Some(record) = state.windows.get_mut(label) {
            record.documents.insert(canonical_path.to_path_buf());
        }
        state.debug_check();
        Ok(DocumentClaim::Claimed)
    }

    /// Release a drawing. Returns `false` when `label` does not own it.
    pub fn release_document(&self, label: &str, canonical_path: &Path) -> bool {
        let mut state = self.lock();
        if state.document_owner.get(canonical_path).map(String::as_str) != Some(label) {
            return false;
        }
        state.document_owner.remove(canonical_path);
        if let Some(record) = state.windows.get_mut(label) {
            record.documents.remove(canonical_path);
        }
        state.debug_check();
        true
    }

    /// Record that `label` gained focus.
    pub fn focus(&self, label: &str) {
        let mut state = self.lock();
        state.focus_seq += 1;
        let seq = state.focus_seq;
        if let Some(record) = state.windows.get_mut(label) {
            record.last_focused_seq = seq;
        }
    }

    /// The most recently focused window, or the most recently created one
    /// when no window has been focused yet.
    pub fn most_recently_focused(&self) -> Option<String> {
        let state = self.lock();
        state
            .windows
            .values()
            .max_by_key(|record| (record.last_focused_seq, label_number(&record.label)))
            .map(|record| record.label.clone())
    }

    pub fn set_role(&self, label: &str, role: WindowRole) {
        if let Some(record) = self.lock().windows.get_mut(label) {
            record.role = role;
        }
    }

    pub fn recovery_window(&self) -> Option<String> {
        self.lock()
            .windows
            .values()
            .find(|record| record.role == WindowRole::Recovery)
            .map(|record| record.label.clone())
    }

    /// Queue drawing paths for a window's next bootstrap.
    pub fn push_pending_open_paths(&self, label: &str, paths: Vec<String>) {
        if let Some(record) = self.lock().windows.get_mut(label) {
            record.pending_open_paths.extend(paths);
        }
    }

    /// Hand drawing paths to a window: queued for its startup data when it
    /// has not read them yet (returns `None`), otherwise returned for the
    /// caller to send as an event.
    pub fn queue_open_paths(&self, label: &str, paths: Vec<String>) -> Option<Vec<String>> {
        let mut state = self.lock();
        match state.windows.get_mut(label) {
            Some(record) if !record.bootstrapped => {
                record.pending_open_paths.extend(paths);
                None
            }
            _ => Some(paths),
        }
    }

    pub fn set_restore(
        &self,
        label: &str,
        restore: Option<WindowRestore>,
        unavailable_workspace: Option<WorkspaceRecord>,
    ) {
        if let Some(record) = self.lock().windows.get_mut(label) {
            record.restore = restore;
            record.unavailable_workspace = unavailable_workspace;
        }
    }

    /// Record the tabs a window reports for the Window Session.
    pub fn set_session_tabs(&self, label: &str, tabs: Vec<String>, active_path: Option<String>) {
        if let Some(record) = self.lock().windows.get_mut(label) {
            record.session_tabs = tabs;
            record.session_active_path = active_path;
        }
    }

    /// The Window Session snapshot: every window in creation order with its
    /// Workspace and reported tabs. Storing it drops empty Welcome windows.
    pub fn session_snapshot(&self) -> Vec<WindowSessionEntry> {
        let state = self.lock();
        let mut records: Vec<_> = state.windows.values().collect();
        records.sort_by_key(|record| label_number(&record.label));
        records
            .into_iter()
            .map(|record| WindowSessionEntry {
                workspace_id: record
                    .workspace
                    .as_ref()
                    .map(|workspace| workspace.id.clone()),
                tabs: record.session_tabs.clone(),
                active_path: record.session_active_path.clone(),
            })
            .collect()
    }

    /// Hand a window its one-time bootstrap data. Later calls return empty
    /// pending paths and no restore data.
    pub fn take_bootstrap(&self, label: &str) -> Option<WindowRecord> {
        let mut state = self.lock();
        let record = state.windows.get_mut(label)?;
        let snapshot = record.clone();
        record.bootstrapped = true;
        record.pending_open_paths.clear();
        record.restore = None;
        record.unavailable_workspace = None;
        Some(snapshot)
    }

    #[cfg(test)]
    pub(crate) fn check_invariants(&self) -> Result<(), String> {
        self.lock().invariant_violation().map_or(Ok(()), Err)
    }
}

impl RegistryState {
    fn decide(
        &self,
        label: &str,
        candidate: &WorkspaceCandidate,
    ) -> Result<ClaimDecision, RegistryError> {
        let caller = self
            .windows
            .get(label)
            .ok_or_else(|| RegistryError::UnknownWindow(label.to_owned()))?;
        let replaced = caller
            .workspace
            .as_ref()
            .map(|workspace| workspace.id.clone());
        for record in self.windows.values() {
            // The caller's own Workspace is the one being replaced, so it
            // never conflicts with the candidate.
            if record.label == label {
                continue;
            }
            let Some(owned) = record.workspace.as_ref() else {
                continue;
            };
            let same_id = candidate.id.as_ref() == Some(&owned.id);
            if same_id || candidate.root == owned.root {
                return Ok(ClaimDecision::OwnedBy {
                    label: record.label.clone(),
                    workspace_id: owned.id.clone(),
                });
            }
            if candidate.root.starts_with(&owned.root) {
                return Ok(ClaimDecision::InsideOpen {
                    label: record.label.clone(),
                    workspace_id: owned.id.clone(),
                    relative_path: relative_path(&owned.root, &candidate.root),
                });
            }
            if owned.root.starts_with(&candidate.root) {
                return Ok(ClaimDecision::ContainsOpen {
                    label: record.label.clone(),
                    workspace_id: owned.id.clone(),
                });
            }
        }
        let replaced = replaced.filter(|id| candidate.id.as_ref() != Some(id));
        Ok(ClaimDecision::Claimable { replaced })
    }

    /// Replace the Workspace held by `label`, keeping both indexes in step.
    fn set_workspace(
        &mut self,
        label: &str,
        workspace: Option<OwnedWorkspace>,
    ) -> Option<OwnedWorkspace> {
        let record = self.windows.get_mut(label)?;
        let previous = std::mem::replace(&mut record.workspace, workspace.clone());
        if let Some(previous) = previous.as_ref() {
            self.workspace_owner.remove(&previous.id);
        }
        if let Some(workspace) = workspace {
            self.workspace_owner.insert(workspace.id, label.to_owned());
        }
        previous
    }

    fn workspace_containing(&self, path: &Path, except: Option<&str>) -> Option<String> {
        self.windows
            .values()
            .filter(|record| Some(record.label.as_str()) != except)
            .find(|record| {
                record
                    .workspace
                    .as_ref()
                    .is_some_and(|workspace| path.starts_with(&workspace.root))
            })
            .map(|record| record.label.clone())
    }

    fn debug_check(&self) {
        debug_assert_eq!(self.invariant_violation(), None);
    }

    fn invariant_violation(&self) -> Option<String> {
        for (id, label) in &self.workspace_owner {
            let held = self
                .windows
                .get(label)
                .and_then(|record| record.workspace.as_ref())
                .map(|workspace| &workspace.id);
            if held != Some(id) {
                return Some(format!("workspace owner {id} -> {label} is not held"));
            }
        }
        let mut roots = Vec::new();
        for record in self.windows.values() {
            if let Some(workspace) = record.workspace.as_ref() {
                if self.workspace_owner.get(&workspace.id) != Some(&record.label) {
                    return Some(format!("{} holds unindexed {}", record.label, workspace.id));
                }
                roots.push(&workspace.root);
            }
            for path in &record.documents {
                if self.document_owner.get(path) != Some(&record.label) {
                    return Some(format!(
                        "{} holds unindexed {}",
                        record.label,
                        path.display()
                    ));
                }
            }
        }
        for (path, label) in &self.document_owner {
            let held = self
                .windows
                .get(label)
                .is_some_and(|record| record.documents.contains(path));
            if !held {
                return Some(format!(
                    "document owner {} -> {label} is not held",
                    path.display()
                ));
            }
        }
        for (index, first) in roots.iter().enumerate() {
            for second in roots.iter().skip(index + 1) {
                if first.starts_with(second) || second.starts_with(first) {
                    return Some(format!(
                        "owned roots {} and {} overlap",
                        first.display(),
                        second.display()
                    ));
                }
            }
        }
        None
    }
}

impl WorkspaceCandidate {
    pub fn from_record(record: &WorkspaceRecord) -> Self {
        Self {
            id: Some(record.id.clone()),
            root: PathBuf::from(&record.root_path),
        }
    }
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|relative| {
            relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

fn label_number(label: &str) -> u64 {
    label
        .strip_prefix(WINDOW_LABEL_PREFIX)
        .and_then(|number| number.parse().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    #[test]
    fn session_snapshot_follows_creation_order() {
        let registry = WindowRegistry::new();
        let labels: Vec<_> = (0..11).map(|_| registry.allocate_label()).collect();
        for label in &labels {
            registry
                .register(label, WindowRole::Normal)
                .unwrap_or_else(|error| panic!("register: {error}"));
        }
        let root = std::env::temp_dir().join(format!("snapshot-{}", uuid::Uuid::new_v4()));
        let candidate = WorkspaceCandidate {
            id: Some("w-10".to_owned()),
            root,
        };
        let (decision, _) = registry
            .claim(&labels[10], &candidate)
            .unwrap_or_else(|error| panic!("claim: {error}"));
        assert!(matches!(
            decision,
            ClaimDecision::Claimable { replaced: None }
        ));
        registry.set_session_tabs(
            &labels[10],
            vec!["/a.excalidraw".to_owned()],
            Some("/a.excalidraw".to_owned()),
        );

        let snapshot = registry.session_snapshot();
        assert_eq!(snapshot.len(), 11);
        // window-10 sorts after window-9, not after window-1.
        assert_eq!(snapshot[10].workspace_id.as_deref(), Some("w-10"));
        assert_eq!(snapshot[10].tabs, ["/a.excalidraw"]);
        assert!(snapshot[..10]
            .iter()
            .all(|entry| entry.workspace_id.is_none()));
    }

    fn candidate(id: &str, root: &str) -> WorkspaceCandidate {
        WorkspaceCandidate {
            id: Some(id.to_owned()),
            root: PathBuf::from(root),
        }
    }

    fn registry_with(labels: &[&str]) -> WindowRegistry {
        let registry = WindowRegistry::new();
        for label in labels {
            registry
                .register(label, WindowRole::Normal)
                .unwrap_or_else(|error| panic!("register {label}: {error}"));
        }
        registry
    }

    fn claim(
        registry: &WindowRegistry,
        label: &str,
        workspace: &WorkspaceCandidate,
    ) -> ClaimDecision {
        let (decision, _) = registry
            .claim(label, workspace)
            .unwrap_or_else(|error| panic!("claim for {label}: {error}"));
        registry
            .check_invariants()
            .unwrap_or_else(|error| panic!("invariants after claim: {error}"));
        decision
    }

    #[test]
    fn labels_are_monotonic_and_never_reused() {
        let registry = WindowRegistry::new();
        let first = registry.allocate_label();
        let second = registry.allocate_label();
        assert_eq!(first, "window-1");
        assert_eq!(second, "window-2");
        registry
            .register(&first, WindowRole::Normal)
            .unwrap_or_else(|error| panic!("register: {error}"));
        registry.unregister(&first);
        assert_eq!(registry.allocate_label(), "window-3");
        assert_eq!(registry.register("window-2", WindowRole::Normal), Ok(()));
        assert_eq!(
            registry.register("window-2", WindowRole::Normal),
            Err(RegistryError::DuplicateWindow("window-2".to_owned()))
        );
    }

    #[test]
    fn a_workspace_has_at_most_one_owner_window() {
        let registry = registry_with(&["window-1", "window-2"]);
        let a = candidate("a", "/w/a");
        assert_eq!(
            claim(&registry, "window-1", &a),
            ClaimDecision::Claimable { replaced: None }
        );
        assert_eq!(
            claim(&registry, "window-2", &a),
            ClaimDecision::OwnedBy {
                label: "window-1".to_owned(),
                workspace_id: "a".to_owned()
            }
        );
        // A folder that is not in the recent list yet but has the same root.
        assert_eq!(
            claim(
                &registry,
                "window-2",
                &WorkspaceCandidate {
                    id: None,
                    root: PathBuf::from("/w/a")
                }
            ),
            ClaimDecision::OwnedBy {
                label: "window-1".to_owned(),
                workspace_id: "a".to_owned()
            }
        );
        assert_eq!(registry.workspace_owner("a").as_deref(), Some("window-1"));
        assert_eq!(registry.window("window-2").and_then(|w| w.workspace), None);
    }

    #[test]
    fn nested_candidates_are_reported_against_other_windows() {
        let registry = registry_with(&["window-1", "window-2"]);
        claim(&registry, "window-1", &candidate("a", "/w/a"));

        assert_eq!(
            registry.probe("window-2", &candidate("child", "/w/a/notes/2026")),
            Ok(ClaimDecision::InsideOpen {
                label: "window-1".to_owned(),
                workspace_id: "a".to_owned(),
                relative_path: "notes/2026".to_owned()
            })
        );
        assert_eq!(
            registry.probe("window-2", &candidate("parent", "/w")),
            Ok(ClaimDecision::ContainsOpen {
                label: "window-1".to_owned(),
                workspace_id: "a".to_owned()
            })
        );
        // A shared name prefix is not nesting.
        assert_eq!(
            registry.probe("window-2", &candidate("sibling", "/w/ab")),
            Ok(ClaimDecision::Claimable { replaced: None })
        );
        registry
            .check_invariants()
            .unwrap_or_else(|error| panic!("invariants: {error}"));
    }

    #[test]
    fn probing_changes_nothing() {
        let registry = registry_with(&["window-1"]);
        assert_eq!(
            registry.probe("window-1", &candidate("a", "/w/a")),
            Ok(ClaimDecision::Claimable { replaced: None })
        );
        assert_eq!(registry.workspace_owner("a"), None);
        assert!(registry.owned_workspace_ids().is_empty());
    }

    #[test]
    fn the_callers_own_workspace_never_conflicts_when_replacing() {
        let registry = registry_with(&["window-1"]);
        claim(&registry, "window-1", &candidate("a", "/w/a"));

        assert_eq!(
            claim(&registry, "window-1", &candidate("child", "/w/a/sub")),
            ClaimDecision::Claimable {
                replaced: Some("a".to_owned())
            }
        );
        assert_eq!(registry.workspace_owner("a"), None);
        assert_eq!(
            registry.workspace_owner("child").as_deref(),
            Some("window-1")
        );

        assert_eq!(
            claim(&registry, "window-1", &candidate("parent", "/w")),
            ClaimDecision::Claimable {
                replaced: Some("child".to_owned())
            }
        );
        // Claiming the Workspace the window already holds replaces nothing.
        assert_eq!(
            claim(&registry, "window-1", &candidate("parent", "/w")),
            ClaimDecision::Claimable { replaced: None }
        );
        assert_eq!(
            registry
                .owned_workspace_ids()
                .into_iter()
                .collect::<Vec<_>>(),
            vec!["parent".to_owned()]
        );
    }

    #[test]
    fn rollback_restores_the_previous_workspace_when_it_is_still_free() {
        let registry = registry_with(&["window-1"]);
        claim(&registry, "window-1", &candidate("a", "/w/a"));
        let (_, rollback) = registry
            .claim("window-1", &candidate("b", "/w/b"))
            .unwrap_or_else(|error| panic!("claim b: {error}"));
        registry.rollback_claim(rollback.unwrap_or_else(|| panic!("rollback record")));

        assert_eq!(registry.workspace_owner("a").as_deref(), Some("window-1"));
        assert_eq!(registry.workspace_owner("b"), None);
        registry
            .check_invariants()
            .unwrap_or_else(|error| panic!("invariants: {error}"));
    }

    #[test]
    fn rollback_does_not_steal_a_workspace_another_window_claimed_meanwhile() {
        let registry = registry_with(&["window-1", "window-2"]);
        claim(&registry, "window-1", &candidate("a", "/w/a"));
        let (_, rollback) = registry
            .claim("window-1", &candidate("b", "/w/b"))
            .unwrap_or_else(|error| panic!("claim b: {error}"));
        claim(&registry, "window-2", &candidate("a", "/w/a"));
        registry.rollback_claim(rollback.unwrap_or_else(|| panic!("rollback record")));

        assert_eq!(registry.workspace_owner("a").as_deref(), Some("window-2"));
        assert_eq!(registry.window("window-1").and_then(|w| w.workspace), None);
        registry
            .check_invariants()
            .unwrap_or_else(|error| panic!("invariants: {error}"));
    }

    #[test]
    fn concurrent_claims_of_one_workspace_produce_exactly_one_claim() {
        let labels = (1..=16).map(|n| format!("window-{n}")).collect::<Vec<_>>();
        let registry = Arc::new(WindowRegistry::new());
        for label in &labels {
            registry
                .register(label, WindowRole::Normal)
                .unwrap_or_else(|error| panic!("register: {error}"));
        }
        let barrier = Arc::new(std::sync::Barrier::new(labels.len()));
        let handles = labels
            .iter()
            .cloned()
            .map(|label| {
                let registry = Arc::clone(&registry);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    registry
                        .claim(&label, &candidate("shared", "/w/shared"))
                        .map(|(decision, _)| decision)
                })
            })
            .collect::<Vec<_>>();
        let decisions = handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .unwrap_or_else(|_| panic!("claim thread panicked"))
                    .unwrap_or_else(|error| panic!("claim: {error}"))
            })
            .collect::<Vec<_>>();

        let claimed = decisions
            .iter()
            .filter(|decision| matches!(decision, ClaimDecision::Claimable { .. }))
            .count();
        assert_eq!(claimed, 1);
        assert_eq!(registry.owned_workspace_ids().len(), 1);
        registry
            .check_invariants()
            .unwrap_or_else(|error| panic!("invariants: {error}"));
    }

    #[test]
    fn documents_are_owned_by_one_window_and_respect_workspace_ownership() {
        let registry = registry_with(&["window-1", "window-2"]);
        claim(&registry, "window-1", &candidate("a", "/w/a"));
        let inside = Path::new("/w/a/plan.excalidraw");
        let outside = Path::new("/elsewhere/sketch.excalidraw");

        assert_eq!(
            registry.claim_document("window-2", inside),
            Ok(DocumentClaim::OwnedElsewhere {
                label: "window-1".to_owned()
            })
        );
        assert_eq!(
            registry.claim_document("window-1", inside),
            Ok(DocumentClaim::Claimed)
        );
        assert_eq!(
            registry.claim_document("window-2", outside),
            Ok(DocumentClaim::Claimed)
        );
        assert_eq!(
            registry.claim_document("window-1", outside),
            Ok(DocumentClaim::OwnedElsewhere {
                label: "window-2".to_owned()
            })
        );
        // Re-opening a drawing in its owner window stays claimed.
        assert_eq!(
            registry.claim_document("window-2", outside),
            Ok(DocumentClaim::Claimed)
        );
        registry
            .check_invariants()
            .unwrap_or_else(|error| panic!("invariants: {error}"));

        assert!(!registry.release_document("window-1", outside));
        assert_eq!(
            registry.document_owner(outside).as_deref(),
            Some("window-2")
        );
        assert!(registry.release_document("window-2", outside));
        assert_eq!(registry.document_owner(outside), None);
        registry
            .check_invariants()
            .unwrap_or_else(|error| panic!("invariants: {error}"));
    }

    #[test]
    fn unregistering_releases_the_workspace_and_documents() {
        let registry = registry_with(&["window-1", "window-2"]);
        claim(&registry, "window-1", &candidate("a", "/w/a"));
        let drawing = Path::new("/w/a/plan.excalidraw");
        registry
            .claim_document("window-1", drawing)
            .unwrap_or_else(|error| panic!("claim document: {error}"));

        let released = registry.unregister("window-1");

        assert_eq!(
            released,
            ReleasedWindow {
                workspace_id: Some("a".to_owned()),
                documents: vec![drawing.to_path_buf()]
            }
        );
        assert_eq!(
            claim(&registry, "window-2", &candidate("a", "/w/a")),
            ClaimDecision::Claimable { replaced: None }
        );
        assert_eq!(
            registry.claim_document("window-2", drawing),
            Ok(DocumentClaim::Claimed)
        );
        assert_eq!(registry.unregister("window-404"), ReleasedWindow::default());
    }

    #[test]
    fn releasing_a_workspace_returns_the_window_to_welcome() {
        let registry = registry_with(&["window-1"]);
        claim(&registry, "window-1", &candidate("a", "/w/a"));
        assert_eq!(
            registry.release_workspace("window-1"),
            Ok(Some("a".to_owned()))
        );
        assert_eq!(registry.release_workspace("window-1"), Ok(None));
        assert_eq!(
            registry.release_workspace("window-9"),
            Err(RegistryError::UnknownWindow("window-9".to_owned()))
        );
        assert!(registry.owned_workspace_ids().is_empty());
    }

    #[test]
    fn focus_order_tracks_the_most_recent_window() {
        let registry = registry_with(&["window-1", "window-2", "window-3"]);
        assert_eq!(
            registry.most_recently_focused().as_deref(),
            Some("window-3")
        );
        registry.focus("window-1");
        assert_eq!(
            registry.most_recently_focused().as_deref(),
            Some("window-1")
        );
        registry.focus("window-2");
        registry.focus("window-1");
        assert_eq!(
            registry.most_recently_focused().as_deref(),
            Some("window-1")
        );
        registry.unregister("window-1");
        assert_eq!(
            registry.most_recently_focused().as_deref(),
            Some("window-2")
        );
        assert_eq!(WindowRegistry::new().most_recently_focused(), None);
    }

    #[test]
    fn bootstrap_data_is_handed_out_once() {
        let registry = registry_with(&["window-1"]);
        registry.push_pending_open_paths("window-1", vec!["/a.excalidraw".to_owned()]);
        registry.set_restore(
            "window-1",
            Some(WindowRestore {
                tabs: vec!["/a.excalidraw".to_owned()],
                active_path: None,
                skipped: 2,
            }),
            None,
        );

        let first = registry
            .take_bootstrap("window-1")
            .unwrap_or_else(|| panic!("first bootstrap"));
        assert_eq!(first.pending_open_paths, vec!["/a.excalidraw".to_owned()]);
        assert_eq!(first.restore.map(|restore| restore.skipped), Some(2));

        let second = registry
            .take_bootstrap("window-1")
            .unwrap_or_else(|| panic!("second bootstrap"));
        assert!(second.pending_open_paths.is_empty());
        assert_eq!(second.restore, None);
        assert_eq!(registry.take_bootstrap("window-2"), None);
    }

    #[test]
    fn canonical_roots_resolve_symlink_case_and_parent_variants() {
        let base = std::env::temp_dir()
            .join(format!("excalidraw-registry-{}", uuid::Uuid::new_v4()))
            .join("Root");
        let nested = base.join("Projects").join("Board");
        std::fs::create_dir_all(&nested).unwrap_or_else(|error| panic!("create fixture: {error}"));
        let link = base
            .parent()
            .unwrap_or_else(|| panic!("fixture parent"))
            .join("link-to-root");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&base, &link)
            .unwrap_or_else(|error| panic!("create symlink: {error}"));

        let root = crate::commands::workspace::canonical_directory(&base)
            .unwrap_or_else(|error| panic!("root: {error}"));
        let registry = registry_with(&["window-1", "window-2"]);
        claim(
            &registry,
            "window-1",
            &WorkspaceCandidate {
                id: Some("root".to_owned()),
                root: root.clone(),
            },
        );

        let mut variants = vec![
            // `..` segments
            (base.join("Projects").join(".."), "same"),
            (nested.join("..").join(".."), "same"),
            (base.join("Projects").join("..").join("Projects"), "inside"),
        ];
        #[cfg(unix)]
        {
            variants.push((link.clone(), "same"));
            variants.push((link.join("Projects"), "inside"));
        }
        // Letter-case variants resolve only on case-insensitive volumes.
        let upper = PathBuf::from(base.to_string_lossy().replace("Root", "ROOT"));
        let case_insensitive = upper.exists();
        if case_insensitive {
            variants.push((upper.clone(), "same"));
            variants.push((upper.join("projects"), "inside"));
        }

        for (variant, expected) in variants {
            let resolved = crate::commands::workspace::canonical_directory(&variant)
                .unwrap_or_else(|error| panic!("canonicalize {}: {error}", variant.display()));
            let decision = registry
                .probe(
                    "window-2",
                    &WorkspaceCandidate {
                        id: None,
                        root: resolved,
                    },
                )
                .unwrap_or_else(|error| panic!("probe: {error}"));
            match expected {
                "same" => assert!(
                    matches!(decision, ClaimDecision::OwnedBy { .. }),
                    "{} should match the open root, got {decision:?}",
                    variant.display()
                ),
                _ => assert!(
                    matches!(
                        &decision,
                        ClaimDecision::InsideOpen { relative_path, .. } if relative_path == "Projects"
                    ),
                    "{} should be inside the open root, got {decision:?}",
                    variant.display()
                ),
            }
        }

        let file = base.join("note.txt");
        std::fs::write(&file, b"x").unwrap_or_else(|error| panic!("write file: {error}"));
        assert!(crate::commands::workspace::canonical_directory(&file).is_err());
        let _ = std::fs::remove_dir_all(base.parent().unwrap_or(&base));
    }
}
