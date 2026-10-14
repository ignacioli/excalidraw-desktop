#![allow(
    dead_code,
    reason = "the multi-window user stories consume these items as their slices land"
)]

//! Window Session persistence: the windows to restore after a normal quit and
//! the window placement and sidebar state remembered per Workspace.
//!
//! The Window Session is a snapshot. Each write replaces the whole
//! `window_session` table in one transaction, so a reader never observes a
//! partially written set of windows.

use std::{collections::HashSet, path::Path};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::database::repository::{RepositoryFuture, SqliteRepository, WorkspaceRecord};

/// `app_meta` key recording that the legacy localStorage shell preferences
/// were imported once.
pub const SHELL_PREFERENCES_MIGRATED_KEY: &str = "shell_preferences_migrated";

/// One window of the Window Session, in restore order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowSessionEntry {
    pub workspace_id: Option<String>,
    pub tabs: Vec<String>,
    pub active_path: Option<String>,
}

impl WindowSessionEntry {
    /// Empty Welcome windows are not restored, so they are never written.
    fn is_restorable(&self) -> bool {
        self.workspace_id.is_some() || !self.tabs.is_empty()
    }

    fn normalized_active_path(&self) -> Option<String> {
        self.active_path
            .as_ref()
            .filter(|path| self.tabs.contains(path))
            .cloned()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SessionTab {
    path: String,
}

/// Normal-state window bounds in logical pixels plus the state flags.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowPlacement {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
    pub fullscreen: bool,
}

/// Sidebar state remembered per Workspace. The frontend owns the width
/// clamping rule; the backend stores what it reports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceShellState {
    pub sidebar_pinned: bool,
    pub sidebar_width: i64,
    pub expanded: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkspaceWindowState {
    pub workspace_id: String,
    pub placement: Option<WindowPlacement>,
    pub shell: Option<WorkspaceShellState>,
}

pub trait WindowSessionRepository: Send + Sync {
    fn window_session_replace(&self, entries: Vec<WindowSessionEntry>) -> RepositoryFuture<'_, ()>;
    fn window_session_list(&self) -> RepositoryFuture<'_, Vec<WindowSessionEntry>>;
    fn workspace_window_state_get(
        &self,
        workspace_id: String,
    ) -> RepositoryFuture<'_, Option<WorkspaceWindowState>>;
    fn workspace_placement_save(
        &self,
        workspace_id: String,
        placement: WindowPlacement,
    ) -> RepositoryFuture<'_, ()>;
    fn workspace_shell_state_save(
        &self,
        workspace_id: String,
        shell: WorkspaceShellState,
        updated_at: i64,
    ) -> RepositoryFuture<'_, ()>;
    /// The most recently saved sidebar pin and width of any Workspace, used
    /// when a Workspace without its own record is first opened. The expanded
    /// folder list is not carried over.
    fn workspace_shell_state_latest(&self) -> RepositoryFuture<'_, Option<WorkspaceShellState>>;
    fn app_meta_get(&self, key: String) -> RepositoryFuture<'_, Option<String>>;
    fn app_meta_set(&self, key: String, value: String) -> RepositoryFuture<'_, ()>;
}

impl WindowSessionRepository for SqliteRepository {
    fn window_session_replace(&self, entries: Vec<WindowSessionEntry>) -> RepositoryFuture<'_, ()> {
        Box::pin(async move {
            let rows = entries
                .into_iter()
                .filter(WindowSessionEntry::is_restorable)
                .map(|entry| {
                    let active_path = entry.normalized_active_path();
                    let tabs = entry
                        .tabs
                        .into_iter()
                        .map(|path| SessionTab { path })
                        .collect::<Vec<_>>();
                    serde_json::to_string(&tabs).map(|tabs| (entry.workspace_id, tabs, active_path))
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| {
                    crate::database::writer::DatabaseWriterError::Sqlite(
                        rusqlite::Error::ToSqlConversionFailure(Box::new(error)),
                    )
                })?;
            self.writer()
                .execute(move |connection| {
                    let transaction = connection.transaction()?;
                    transaction.execute("DELETE FROM window_session", [])?;
                    for (position, (workspace_id, tabs_json, active_path)) in
                        rows.into_iter().enumerate()
                    {
                        transaction.execute(
                            "INSERT INTO window_session (position, workspace_id, tabs_json, active_path) \
                             VALUES (?1, ?2, ?3, ?4)",
                            params![position as i64, workspace_id, tabs_json, active_path],
                        )?;
                    }
                    transaction.commit()
                })
                .await?;
            Ok(())
        })
    }

    fn window_session_list(&self) -> RepositoryFuture<'_, Vec<WindowSessionEntry>> {
        Box::pin(async move {
            Ok(self
                .writer()
                .execute(|connection| {
                    let mut statement = connection.prepare(
                        "SELECT workspace_id, tabs_json, active_path FROM window_session ORDER BY position",
                    )?;
                    let rows = statement.query_map([], |row| {
                        let tabs_json: String = row.get(1)?;
                        Ok(WindowSessionEntry {
                            workspace_id: row.get(0)?,
                            tabs: decode_tabs(&tabs_json),
                            active_path: row.get(2)?,
                        })
                    })?;
                    rows.collect()
                })
                .await?)
        })
    }

    fn workspace_window_state_get(
        &self,
        workspace_id: String,
    ) -> RepositoryFuture<'_, Option<WorkspaceWindowState>> {
        Box::pin(async move {
            Ok(self
                .writer()
                .execute(move |connection| {
                    connection
                        .query_row(
                            "SELECT workspace_id, x, y, width, height, maximized, fullscreen, \
                             sidebar_pinned, sidebar_width, expanded_json \
                             FROM workspace_window_state WHERE workspace_id=?1",
                            [workspace_id],
                            workspace_window_state_from_row,
                        )
                        .optional()
                })
                .await?)
        })
    }

    fn workspace_placement_save(
        &self,
        workspace_id: String,
        placement: WindowPlacement,
    ) -> RepositoryFuture<'_, ()> {
        Box::pin(async move {
            self.writer()
                .execute(move |connection| {
                    // updated_at tracks sidebar saves only; a placement-only
                    // row starts at 0 so it never supplies sidebar defaults.
                    connection.execute(
                        "INSERT INTO workspace_window_state \
                         (workspace_id, x, y, width, height, maximized, fullscreen, updated_at) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0) \
                         ON CONFLICT(workspace_id) DO UPDATE SET x=excluded.x, y=excluded.y, \
                         width=excluded.width, height=excluded.height, \
                         maximized=excluded.maximized, fullscreen=excluded.fullscreen",
                        params![
                            workspace_id,
                            placement.x,
                            placement.y,
                            placement.width,
                            placement.height,
                            placement.maximized,
                            placement.fullscreen
                        ],
                    )?;
                    Ok(())
                })
                .await?;
            Ok(())
        })
    }

    fn workspace_shell_state_save(
        &self,
        workspace_id: String,
        shell: WorkspaceShellState,
        updated_at: i64,
    ) -> RepositoryFuture<'_, ()> {
        Box::pin(async move {
            let expanded_json = serde_json::to_string(&shell.expanded).map_err(|error| {
                crate::database::writer::DatabaseWriterError::Sqlite(
                    rusqlite::Error::ToSqlConversionFailure(Box::new(error)),
                )
            })?;
            self.writer()
                .execute(move |connection| {
                    connection.execute(
                        "INSERT INTO workspace_window_state \
                         (workspace_id, sidebar_pinned, sidebar_width, expanded_json, updated_at) \
                         VALUES (?1, ?2, ?3, ?4, ?5) \
                         ON CONFLICT(workspace_id) DO UPDATE SET \
                         sidebar_pinned=excluded.sidebar_pinned, sidebar_width=excluded.sidebar_width, \
                         expanded_json=excluded.expanded_json, updated_at=excluded.updated_at",
                        params![
                            workspace_id,
                            shell.sidebar_pinned,
                            shell.sidebar_width,
                            expanded_json,
                            updated_at
                        ],
                    )?;
                    Ok(())
                })
                .await?;
            Ok(())
        })
    }

    fn workspace_shell_state_latest(&self) -> RepositoryFuture<'_, Option<WorkspaceShellState>> {
        Box::pin(async move {
            Ok(self
                .writer()
                .execute(|connection| {
                    connection
                        .query_row(
                            "SELECT sidebar_pinned, sidebar_width FROM workspace_window_state \
                             WHERE sidebar_pinned IS NOT NULL AND sidebar_width IS NOT NULL \
                             ORDER BY updated_at DESC, workspace_id LIMIT 1",
                            [],
                            |row| {
                                Ok(WorkspaceShellState {
                                    sidebar_pinned: row.get(0)?,
                                    sidebar_width: row.get(1)?,
                                    expanded: Vec::new(),
                                })
                            },
                        )
                        .optional()
                })
                .await?)
        })
    }

    fn app_meta_get(&self, key: String) -> RepositoryFuture<'_, Option<String>> {
        Box::pin(async move {
            Ok(self
                .writer()
                .execute(move |connection| {
                    connection
                        .query_row("SELECT value FROM app_meta WHERE key=?1", [key], |row| {
                            row.get(0)
                        })
                        .optional()
                })
                .await?)
        })
    }

    fn app_meta_set(&self, key: String, value: String) -> RepositoryFuture<'_, ()> {
        Box::pin(async move {
            self.writer()
                .execute(move |connection| {
                    connection.execute(
                        "INSERT INTO app_meta (key, value) VALUES (?1, ?2) \
                         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        params![key, value],
                    )?;
                    Ok(())
                })
                .await?;
            Ok(())
        })
    }
}

/// A malformed tab list restores no tabs rather than failing the session.
fn decode_tabs(tabs_json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<SessionTab>>(tabs_json)
        .map(|tabs| tabs.into_iter().map(|tab| tab.path).collect())
        .unwrap_or_default()
}

fn workspace_window_state_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<WorkspaceWindowState> {
    let x: Option<f64> = row.get(1)?;
    let y: Option<f64> = row.get(2)?;
    let width: Option<f64> = row.get(3)?;
    let height: Option<f64> = row.get(4)?;
    let maximized: bool = row.get(5)?;
    let fullscreen: bool = row.get(6)?;
    let placement = match (x, y, width, height) {
        (Some(x), Some(y), Some(width), Some(height)) => Some(WindowPlacement {
            x,
            y,
            width,
            height,
            maximized,
            fullscreen,
        }),
        _ => None,
    };
    let sidebar_pinned: Option<bool> = row.get(7)?;
    let sidebar_width: Option<i64> = row.get(8)?;
    let expanded_json: String = row.get(9)?;
    let shell = match (sidebar_pinned, sidebar_width) {
        (Some(sidebar_pinned), Some(sidebar_width)) => Some(WorkspaceShellState {
            sidebar_pinned,
            sidebar_width,
            expanded: serde_json::from_str(&expanded_json).unwrap_or_default(),
        }),
        _ => None,
    };
    Ok(WorkspaceWindowState {
        workspace_id: row.get(0)?,
        placement,
        shell,
    })
}

/// A window to recreate at startup, after validating its session entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoredWindow {
    /// The Workspace to claim for this window.
    pub workspace: Option<WorkspaceRecord>,
    /// A session Workspace that is no longer accessible; the window opens on
    /// Welcome and explains that it is unavailable.
    pub unavailable_workspace: Option<WorkspaceRecord>,
    pub tabs: Vec<String>,
    pub active_path: Option<String>,
    /// Tabs dropped because the file is missing, inaccessible, or already
    /// restored in an earlier window.
    pub skipped: usize,
}

/// Validate the stored Window Session against the current Workspaces and
/// filesystem. The checks are injected so the rules can be tested without
/// touching the real filesystem.
pub fn plan_restore<D, F>(
    entries: &[WindowSessionEntry],
    workspaces: &[WorkspaceRecord],
    is_available_workspace: D,
    is_available_file: F,
) -> Vec<RestoredWindow>
where
    D: Fn(&Path) -> bool,
    F: Fn(&Path) -> bool,
{
    let mut claimed_workspaces = HashSet::new();
    let mut restored_paths = HashSet::new();
    entries
        .iter()
        .map(|entry| {
            let record = entry.workspace_id.as_ref().and_then(|id| {
                workspaces
                    .iter()
                    .find(|workspace| &workspace.id == id)
                    .cloned()
            });
            let (workspace, unavailable_workspace) = match record {
                Some(record) if !claimed_workspaces.insert(record.id.clone()) => (None, None),
                Some(record) if is_available_workspace(Path::new(&record.root_path)) => {
                    (Some(record), None)
                }
                Some(record) => (None, Some(record)),
                None => (None, None),
            };
            let mut skipped = 0;
            let tabs = entry
                .tabs
                .iter()
                .filter(|path| {
                    let keep = is_available_file(Path::new(path.as_str()))
                        && restored_paths.insert((*path).clone());
                    if !keep {
                        skipped += 1;
                    }
                    keep
                })
                .cloned()
                .collect::<Vec<_>>();
            let active_path = entry
                .active_path
                .as_ref()
                .filter(|path| tabs.contains(path))
                .cloned()
                .or_else(|| tabs.first().cloned());
            RestoredWindow {
                workspace,
                unavailable_workspace,
                tabs,
                active_path,
                skipped,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::repository::WorkspaceRepository;

    async fn open_repository() -> (SqliteRepository, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "excalidraw-window-session-{}-{}.sqlite3",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let repository = SqliteRepository::open(&path)
            .await
            .unwrap_or_else(|error| panic!("open repository: {error}"));
        (repository, path)
    }

    fn remove_database(path: std::path::PathBuf) {
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
        let _ = std::fs::remove_file(path);
    }

    fn workspace(id: &str, root: &str) -> WorkspaceRecord {
        WorkspaceRecord {
            id: id.to_owned(),
            name: id.to_owned(),
            root_path: root.to_owned(),
            created_at: 1,
            mounted: false,
        }
    }

    fn entry(
        workspace_id: Option<&str>,
        tabs: &[&str],
        active: Option<&str>,
    ) -> WindowSessionEntry {
        WindowSessionEntry {
            workspace_id: workspace_id.map(str::to_owned),
            tabs: tabs.iter().map(|tab| (*tab).to_owned()).collect(),
            active_path: active.map(str::to_owned),
        }
    }

    #[tokio::test]
    async fn window_session_round_trips_as_a_snapshot_without_empty_welcome_windows() {
        let (repository, path) = open_repository().await;
        repository
            .workspace_upsert(workspace("a", "/a"))
            .await
            .unwrap_or_else(|error| panic!("upsert workspace: {error}"));

        repository
            .window_session_replace(vec![
                entry(
                    Some("a"),
                    &["/a/one.excalidraw", "/a/two.excalidraw"],
                    Some("/a/two.excalidraw"),
                ),
                entry(None, &[], None),
                entry(
                    None,
                    &["/outside.excalidraw"],
                    Some("/not-a-tab.excalidraw"),
                ),
            ])
            .await
            .unwrap_or_else(|error| panic!("write session: {error}"));
        let stored = repository
            .window_session_list()
            .await
            .unwrap_or_else(|error| panic!("read session: {error}"));
        assert_eq!(
            stored,
            vec![
                entry(
                    Some("a"),
                    &["/a/one.excalidraw", "/a/two.excalidraw"],
                    Some("/a/two.excalidraw")
                ),
                entry(None, &["/outside.excalidraw"], None),
            ]
        );

        repository
            .window_session_replace(vec![entry(None, &["/b.excalidraw"], None)])
            .await
            .unwrap_or_else(|error| panic!("replace session: {error}"));
        assert_eq!(
            repository
                .window_session_list()
                .await
                .unwrap_or_else(|error| panic!("read replaced session: {error}")),
            vec![entry(None, &["/b.excalidraw"], None)]
        );
        remove_database(path);
    }

    #[tokio::test]
    async fn deleting_a_workspace_clears_its_session_reference_and_window_state() {
        let (repository, path) = open_repository().await;
        repository
            .workspace_upsert(workspace("a", "/a"))
            .await
            .unwrap_or_else(|error| panic!("upsert workspace: {error}"));
        repository
            .window_session_replace(vec![entry(Some("a"), &["/a/one.excalidraw"], None)])
            .await
            .unwrap_or_else(|error| panic!("write session: {error}"));
        repository
            .workspace_shell_state_save(
                "a".to_owned(),
                WorkspaceShellState {
                    sidebar_pinned: true,
                    sidebar_width: 320,
                    expanded: vec!["notes".to_owned()],
                },
                10,
            )
            .await
            .unwrap_or_else(|error| panic!("save shell state: {error}"));

        repository
            .workspace_delete("a".to_owned())
            .await
            .unwrap_or_else(|error| panic!("delete workspace: {error}"));

        assert_eq!(
            repository
                .window_session_list()
                .await
                .unwrap_or_else(|error| panic!("read session: {error}")),
            vec![entry(None, &["/a/one.excalidraw"], None)]
        );
        assert_eq!(
            repository
                .workspace_window_state_get("a".to_owned())
                .await
                .unwrap_or_else(|error| panic!("read window state: {error}")),
            None
        );
        remove_database(path);
    }

    #[tokio::test]
    async fn placement_and_shell_state_are_saved_independently_per_workspace() {
        let (repository, path) = open_repository().await;
        for (id, root) in [("a", "/a"), ("b", "/b")] {
            repository
                .workspace_upsert(workspace(id, root))
                .await
                .unwrap_or_else(|error| panic!("upsert workspace: {error}"));
        }
        let placement = WindowPlacement {
            x: 10.0,
            y: 20.0,
            width: 1296.0,
            height: 810.0,
            maximized: false,
            fullscreen: true,
        };
        repository
            .workspace_placement_save("a".to_owned(), placement)
            .await
            .unwrap_or_else(|error| panic!("save placement: {error}"));
        assert_eq!(
            repository
                .workspace_shell_state_latest()
                .await
                .unwrap_or_else(|error| panic!("latest shell: {error}")),
            None,
            "a placement-only row must not supply sidebar defaults"
        );

        let shell_a = WorkspaceShellState {
            sidebar_pinned: true,
            sidebar_width: 300,
            expanded: vec!["a/b".to_owned()],
        };
        let shell_b = WorkspaceShellState {
            sidebar_pinned: false,
            sidebar_width: 420,
            expanded: Vec::new(),
        };
        repository
            .workspace_shell_state_save("a".to_owned(), shell_a.clone(), 5)
            .await
            .unwrap_or_else(|error| panic!("save shell a: {error}"));
        repository
            .workspace_shell_state_save("b".to_owned(), shell_b, 7)
            .await
            .unwrap_or_else(|error| panic!("save shell b: {error}"));

        let state_a = repository
            .workspace_window_state_get("a".to_owned())
            .await
            .unwrap_or_else(|error| panic!("read a: {error}"))
            .unwrap_or_else(|| panic!("state a exists"));
        assert_eq!(state_a.placement, Some(placement));
        assert_eq!(state_a.shell, Some(shell_a));
        assert_eq!(
            repository
                .workspace_shell_state_latest()
                .await
                .unwrap_or_else(|error| panic!("latest shell: {error}")),
            Some(WorkspaceShellState {
                sidebar_pinned: false,
                sidebar_width: 420,
                expanded: Vec::new(),
            })
        );

        // A later placement save must not reset the remembered sidebar state.
        repository
            .workspace_placement_save(
                "a".to_owned(),
                WindowPlacement {
                    x: 0.0,
                    ..placement
                },
            )
            .await
            .unwrap_or_else(|error| panic!("save placement again: {error}"));
        let state_a = repository
            .workspace_window_state_get("a".to_owned())
            .await
            .unwrap_or_else(|error| panic!("read a again: {error}"))
            .unwrap_or_else(|| panic!("state a still exists"));
        assert_eq!(state_a.shell.map(|shell| shell.sidebar_width), Some(300));
        remove_database(path);
    }

    #[tokio::test]
    async fn app_meta_markers_are_upserted() {
        let (repository, path) = open_repository().await;
        let key = SHELL_PREFERENCES_MIGRATED_KEY.to_owned();
        assert_eq!(
            repository
                .app_meta_get(key.clone())
                .await
                .unwrap_or_else(|error| panic!("read marker: {error}")),
            None
        );
        repository
            .app_meta_set(key.clone(), "1".to_owned())
            .await
            .unwrap_or_else(|error| panic!("set marker: {error}"));
        repository
            .app_meta_set(key.clone(), "1".to_owned())
            .await
            .unwrap_or_else(|error| panic!("set marker twice: {error}"));
        assert_eq!(
            repository
                .app_meta_get(key)
                .await
                .unwrap_or_else(|error| panic!("read marker again: {error}")),
            Some("1".to_owned())
        );
        remove_database(path);
    }

    #[test]
    fn malformed_tab_lists_restore_no_tabs() {
        assert!(decode_tabs("not json").is_empty());
        assert_eq!(
            decode_tabs(r#"[{"path":"/a.excalidraw"}]"#),
            vec!["/a.excalidraw"]
        );
    }

    #[test]
    fn plan_restore_marks_unavailable_workspaces_and_counts_skipped_tabs() {
        let workspaces = vec![workspace("a", "/a"), workspace("gone", "/gone")];
        let entries = vec![
            entry(
                Some("a"),
                &[
                    "/a/one.excalidraw",
                    "/a/missing.excalidraw",
                    "/a/two.excalidraw",
                ],
                Some("/a/missing.excalidraw"),
            ),
            entry(Some("gone"), &["/gone/x.excalidraw"], None),
            entry(
                Some("deleted"),
                &["/outside.excalidraw"],
                Some("/outside.excalidraw"),
            ),
        ];

        let plan = plan_restore(
            &entries,
            &workspaces,
            |root| root == Path::new("/a"),
            |file| !file.ends_with("missing.excalidraw") && !file.starts_with("/gone"),
        );

        assert_eq!(plan.len(), 3);
        assert_eq!(plan[0].workspace.as_ref().map(|w| w.id.as_str()), Some("a"));
        assert_eq!(plan[0].tabs, vec!["/a/one.excalidraw", "/a/two.excalidraw"]);
        assert_eq!(plan[0].active_path.as_deref(), Some("/a/one.excalidraw"));
        assert_eq!(plan[0].skipped, 1);

        assert_eq!(plan[1].workspace, None);
        assert_eq!(
            plan[1]
                .unavailable_workspace
                .as_ref()
                .map(|w| w.id.as_str()),
            Some("gone")
        );
        assert!(plan[1].tabs.is_empty());
        assert_eq!(plan[1].skipped, 1);

        assert_eq!(plan[2].workspace, None);
        assert_eq!(plan[2].unavailable_workspace, None);
        assert_eq!(plan[2].tabs, vec!["/outside.excalidraw"]);
        assert_eq!(plan[2].active_path.as_deref(), Some("/outside.excalidraw"));
        assert_eq!(plan[2].skipped, 0);
    }

    #[test]
    fn plan_restore_never_restores_a_workspace_or_drawing_twice() {
        let workspaces = vec![workspace("a", "/a")];
        let entries = vec![
            entry(Some("a"), &["/shared.excalidraw"], None),
            entry(
                Some("a"),
                &["/shared.excalidraw", "/other.excalidraw"],
                None,
            ),
        ];

        let plan = plan_restore(&entries, &workspaces, |_| true, |_| true);

        assert_eq!(plan[0].workspace.as_ref().map(|w| w.id.as_str()), Some("a"));
        assert_eq!(plan[1].workspace, None);
        assert_eq!(plan[1].unavailable_workspace, None);
        assert_eq!(plan[1].tabs, vec!["/other.excalidraw"]);
        assert_eq!(plan[1].skipped, 1);
    }
}
