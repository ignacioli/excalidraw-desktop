use std::{path::Path, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::{
    database::repository::{SqliteRepository, WorkspaceRepository},
    documents::session_lock::{SessionLock, SessionLockError},
    window::{
        registry::{WindowRecord, WindowRegistry, WindowRole},
        session::{WindowSessionRepository, WorkspaceShellState},
    },
};

use super::{
    dto::{
        AppHandshakeResponse, AppPreferencesChangedEvent, EmptyResponse, OpenWorkspaceName,
        ShellPreferencesMigrateResponse, WindowBootstrap, WindowRestoreBootstrap,
        IPC_CONTRACT_VERSION,
    },
    error::{AppError, IpcError},
};

pub struct SessionState {
    abnormal_exit: bool,
    preferred_languages: Vec<String>,
    lock: Mutex<Option<SessionLock>>,
}

impl SessionState {
    pub fn initialize(app_data_directory: &Path) -> Result<Self, AppError> {
        let lock = SessionLock::acquire(app_data_directory).map_err(session_lock_error)?;
        Ok(Self {
            abnormal_exit: lock.abnormal_exit(),
            preferred_languages: crate::locale::preferred_languages(),
            lock: Mutex::new(Some(lock)),
        })
    }

    /// Whether the previous run ended without releasing the session lock.
    pub fn abnormal_exit(&self) -> bool {
        self.abnormal_exit
    }

    /// Build the handshake for one window from its one-time bootstrap data.
    pub async fn handshake(
        &self,
        record: WindowRecord,
        repository: &SqliteRepository,
        open_workspace_ids: impl IntoIterator<Item = String>,
    ) -> Result<AppHandshakeResponse, AppError> {
        let workspace = match record.workspace.as_ref() {
            Some(owned) => repository.workspace_get(owned.id.clone()).await?,
            None => None,
        };
        let shell = match workspace.as_ref() {
            Some(workspace) => workspace_shell_state_for(repository, &workspace.id).await?,
            None => None,
        };
        let open_workspace_names = open_workspace_names(repository, open_workspace_ids).await?;
        Ok(AppHandshakeResponse {
            contract_version: IPC_CONTRACT_VERSION,
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            abnormal_exit: self.abnormal_exit && record.role == WindowRole::Recovery,
            pending_open_paths: record.pending_open_paths,
            preferred_languages: self.preferred_languages.clone(),
            window: WindowBootstrap {
                label: record.label,
                workspace: workspace.map(Into::into),
                unavailable_workspace: record.unavailable_workspace.map(Into::into),
                restore: record.restore.map(|restore| WindowRestoreBootstrap {
                    tabs: restore.tabs,
                    active_path: restore.active_path,
                    skipped: restore.skipped,
                }),
                shell,
                open_workspace_names,
            },
        })
    }

    pub fn release(&self) -> Result<(), AppError> {
        let lock = self
            .lock
            .lock()
            .map_err(|_| AppError::Internal("session lock mutex is poisoned".to_owned()))?
            .take();
        if let Some(lock) = lock {
            lock.release().map_err(session_lock_error)?;
        }
        Ok(())
    }
}

/// `app_meta` key holding the sidebar pin and width imported from the
/// legacy localStorage shell preferences, the most recent values until a
/// Workspace saves its own.
pub const LEGACY_SHELL_STATE_KEY: &str = "legacy_shell_state";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyShellState {
    sidebar_pinned: bool,
    sidebar_width: i64,
}

/// The sidebar state to show for a Workspace: its own record; else, for a
/// Workspace opened for the first time, the most recent pin and width with
/// the Workspace row expanded. `None` when nothing was ever saved.
pub async fn workspace_shell_state_for(
    repository: &SqliteRepository,
    workspace_id: &str,
) -> Result<Option<WorkspaceShellState>, AppError> {
    if let Some(shell) = repository
        .workspace_window_state_get(workspace_id.to_owned())
        .await?
        .and_then(|state| state.shell)
    {
        return Ok(Some(shell));
    }
    let latest = match repository.workspace_shell_state_latest().await? {
        Some(latest) => Some((latest.sidebar_pinned, latest.sidebar_width)),
        None => repository
            .app_meta_get(LEGACY_SHELL_STATE_KEY.to_owned())
            .await?
            .and_then(|stored| serde_json::from_str::<LegacyShellState>(&stored).ok())
            .map(|legacy| (legacy.sidebar_pinned, legacy.sidebar_width)),
    };
    Ok(
        latest.map(|(sidebar_pinned, sidebar_width)| WorkspaceShellState {
            sidebar_pinned,
            sidebar_width,
            // A Workspace's own row is its root folder, relative path "".
            expanded: vec![String::new()],
        }),
    )
}

/// Save the calling window's sidebar state for its Workspace.
#[tauri::command]
pub async fn workspace_shell_state_save(
    sidebar_pinned: bool,
    sidebar_width: i64,
    expanded: Vec<String>,
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
    repository: State<'_, SqliteRepository>,
) -> Result<EmptyResponse, IpcError> {
    let workspace_id = registry
        .window(window.label())
        .and_then(|record| record.workspace)
        .map(|owned| owned.id)
        .ok_or_else(|| AppError::WorkspaceNotOwned(window.label().to_owned()))?;
    repository
        .workspace_shell_state_save(
            workspace_id,
            WorkspaceShellState {
                sidebar_pinned,
                sidebar_width,
                expanded,
            },
            unix_millis(),
        )
        .await
        .map_err(AppError::from)?;
    Ok(EmptyResponse {})
}

/// Import the legacy localStorage sidebar pin and width once. Returns
/// `migrated: true` only to the first call, which may then use the legacy
/// Current Workspace for the first window.
#[tauri::command]
pub async fn shell_preferences_migrate(
    sidebar_pinned: bool,
    sidebar_width: i64,
    repository: State<'_, SqliteRepository>,
) -> Result<ShellPreferencesMigrateResponse, IpcError> {
    Ok(ShellPreferencesMigrateResponse {
        migrated: migrate_shell_preferences(
            &repository,
            LegacyShellState {
                sidebar_pinned,
                sidebar_width,
            },
        )
        .await?,
    })
}

async fn migrate_shell_preferences(
    repository: &SqliteRepository,
    legacy: LegacyShellState,
) -> Result<bool, AppError> {
    let key = crate::window::session::SHELL_PREFERENCES_MIGRATED_KEY.to_owned();
    if repository.app_meta_get(key.clone()).await?.is_some() {
        return Ok(false);
    }
    let stored = serde_json::to_string(&legacy)
        .map_err(|error| AppError::Internal(format!("legacy shell state: {error}")))?;
    repository
        .app_meta_set(LEGACY_SHELL_STATE_KEY.to_owned(), stored)
        .await?;
    repository.app_meta_set(key, "1".to_owned()).await?;
    Ok(true)
}

fn unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// The names of the Workspaces open in any window, for window titles.
pub async fn open_workspace_names(
    repository: &SqliteRepository,
    open_workspace_ids: impl IntoIterator<Item = String>,
) -> Result<Vec<OpenWorkspaceName>, AppError> {
    let mut names = Vec::new();
    for id in open_workspace_ids {
        if let Some(open) = repository.workspace_get(id).await? {
            names.push(OpenWorkspaceName {
                workspace_id: open.id,
                name: open.name,
                root_path: open.root_path,
            });
        }
    }
    Ok(names)
}

/// Answer the calling window's startup handshake. Launch files and restore
/// data are handed out once; a second handshake from the same window gets
/// none.
#[tauri::command]
pub async fn app_handshake(
    window: WebviewWindow,
    state: State<'_, SessionState>,
    registry: State<'_, WindowRegistry>,
    repository: State<'_, SqliteRepository>,
) -> Result<AppHandshakeResponse, IpcError> {
    let record = registry.take_bootstrap(window.label()).ok_or_else(|| {
        AppError::Internal(format!("window {} is not registered", window.label()))
    })?;
    let open_workspace_ids = registry.owned_workspace_ids();
    state
        .handshake(record, &repository, open_workspace_ids)
        .await
        .map_err(Into::into)
}

/// A window finished (or failed) its checkpoint for a coordinated quit.
#[tauri::command]
pub async fn app_quit_ready(
    request_id: String,
    ok: bool,
    message: Option<String>,
    app: AppHandle,
    window: WebviewWindow,
) -> Result<EmptyResponse, IpcError> {
    if !ok {
        eprintln!(
            "{} could not checkpoint before quitting: {}",
            window.label(),
            message.as_deref().unwrap_or("no reason given")
        );
    }
    crate::window::quit::report_ready(&app, &request_id, window.label(), ok);
    Ok(EmptyResponse {})
}

/// The Recovery window finished Recovery: recreate the other windows.
#[tauri::command]
pub async fn startup_recovery_done(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<EmptyResponse, IpcError> {
    crate::window::finish_recovery(&app, window.label()).await?;
    Ok(EmptyResponse {})
}

/// The tabs of `label` that the Window Session may store: drawings the
/// window owns or that lie in its Workspace, as canonical paths. The active
/// tab is kept only when it is one of them. Returns the number ignored.
pub fn accepted_session_tabs(
    registry: &WindowRegistry,
    label: &str,
    tabs: Vec<String>,
    active_path: Option<String>,
) -> (Vec<String>, Option<String>, usize) {
    let record = registry.window(label);
    let root = record
        .as_ref()
        .and_then(|record| record.workspace.as_ref())
        .map(|workspace| workspace.root.clone());
    let mut ignored = 0;
    let mut accepted = Vec::new();
    let mut active = None;
    for tab in tabs {
        let canonical = crate::commands::documents::canonical_document_path(Path::new(&tab));
        let owner = registry.document_owner(&canonical);
        let inside = root
            .as_ref()
            .is_some_and(|root| canonical.starts_with(root));
        let allowed = match owner.as_deref() {
            Some(owner) => owner == label,
            // Not opened yet (a new drawing before its first write).
            None => inside,
        };
        let canonical = canonical.to_string_lossy().into_owned();
        if !allowed || accepted.contains(&canonical) {
            ignored += 1;
            continue;
        }
        if active_path.as_deref() == Some(tab.as_str()) {
            active = Some(canonical.clone());
        }
        accepted.push(canonical);
    }
    (accepted, active, ignored)
}

/// Record the calling window's tabs for the Window Session; the store is
/// written after a short delay so bursts of tab changes write once.
#[tauri::command]
pub async fn window_session_update(
    tabs: Vec<String>,
    active_path: Option<String>,
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
) -> Result<EmptyResponse, IpcError> {
    let (tabs, active_path, ignored) =
        accepted_session_tabs(&registry, window.label(), tabs, active_path);
    if ignored > 0 {
        eprintln!(
            "ignored {ignored} Window Session tabs {} does not own",
            window.label()
        );
    }
    registry.set_session_tabs(window.label(), tabs, active_path);
    crate::window::schedule_session_write(&app);
    Ok(EmptyResponse {})
}

fn session_lock_error(error: SessionLockError) -> AppError {
    match error {
        SessionLockError::CreateDirectory { path, source }
        | SessionLockError::Remove { path, source }
        | SessionLockError::SyncDirectory { path, source } => AppError::Io {
            path: Some(path),
            source,
        },
        SessionLockError::AtomicWrite(source) => source.into(),
        SessionLockError::InvalidSystemTime => {
            AppError::Internal("system clock is before Unix epoch".to_owned())
        }
        SessionLockError::Serialize(source) => AppError::Internal(source.to_string()),
    }
}

/// The windows an app-wide preference change goes to: every registered
/// window except the one that made the change.
pub fn preference_broadcast_targets(labels: Vec<String>, caller: &str) -> Vec<String> {
    labels.into_iter().filter(|label| label != caller).collect()
}

/// Tell the other windows that the appearance or language changed here.
/// They apply it without storing or broadcasting it again.
#[tauri::command]
pub async fn app_preferences_broadcast(
    appearance: Option<crate::native_menu_spec::AppearancePreference>,
    language: Option<crate::native_menu_spec::LanguagePreference>,
    app: AppHandle,
    window: WebviewWindow,
    registry: State<'_, WindowRegistry>,
) -> Result<EmptyResponse, IpcError> {
    let event = AppPreferencesChangedEvent {
        appearance,
        language,
    };
    for label in preference_broadcast_targets(registry.labels(), window.label()) {
        app.emit_to(label.as_str(), "app-preferences-changed", event)
            .map_err(|error| AppError::Internal(error.to_string()))?;
    }
    Ok(EmptyResponse {})
}

#[cfg(test)]
mod tests {
    #[test]
    fn preference_changes_go_to_every_other_window() {
        let labels = vec![
            "window-1".to_owned(),
            "window-2".to_owned(),
            "window-3".to_owned(),
        ];

        assert_eq!(
            super::preference_broadcast_targets(labels, "window-2"),
            vec!["window-1".to_owned(), "window-3".to_owned()]
        );
    }

    #[test]
    fn preference_event_omits_unchanged_fields() {
        let event = super::AppPreferencesChangedEvent {
            appearance: Some(crate::native_menu_spec::AppearancePreference::Dark),
            language: None,
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({ "appearance": "dark" })
        );
    }

    use super::*;
    use crate::database::repository::WorkspaceRecord;
    use crate::window::{
        registry::{WindowRestore, WorkspaceCandidate},
        session::WorkspaceShellState,
    };

    #[test]
    fn the_session_keeps_only_tabs_the_window_owns_or_holds_in_its_workspace() {
        let base = std::env::temp_dir().join(format!("session-tabs-{}", uuid::Uuid::new_v4()));
        let mine = base.join("mine");
        let theirs = base.join("theirs");
        std::fs::create_dir_all(&mine).unwrap_or_else(|error| panic!("create mine: {error}"));
        std::fs::create_dir_all(&theirs).unwrap_or_else(|error| panic!("create theirs: {error}"));
        let mine = std::fs::canonicalize(&mine).unwrap_or_else(|error| panic!("{error}"));
        let theirs = std::fs::canonicalize(&theirs).unwrap_or_else(|error| panic!("{error}"));
        let outside = base.join("outside.excalidraw");
        for file in [
            mine.join("a.excalidraw"),
            theirs.join("b.excalidraw"),
            outside.clone(),
        ] {
            std::fs::write(&file, b"{}").unwrap_or_else(|error| panic!("write: {error}"));
        }
        let outside = std::fs::canonicalize(&outside).unwrap_or_else(|error| panic!("{error}"));
        let registry = WindowRegistry::new();
        for (label, id, root) in [("window-1", "mine", &mine), ("window-2", "theirs", &theirs)] {
            registry
                .register(label, WindowRole::Normal)
                .unwrap_or_else(|error| panic!("register: {error}"));
            registry
                .claim(
                    label,
                    &WorkspaceCandidate {
                        id: Some(id.to_owned()),
                        root: root.clone(),
                    },
                )
                .unwrap_or_else(|error| panic!("claim: {error}"));
        }
        registry
            .claim_document("window-1", &outside)
            .unwrap_or_else(|error| panic!("claim drawing: {error}"));
        let path = |path: &std::path::Path| path.to_string_lossy().into_owned();

        let (tabs, active, ignored) = accepted_session_tabs(
            &registry,
            "window-1",
            vec![
                path(&mine.join("a.excalidraw")),
                path(&theirs.join("b.excalidraw")),
                path(&outside),
                path(&mine.join("new.excalidraw")),
                path(&mine.join("a.excalidraw")),
            ],
            Some(path(&theirs.join("b.excalidraw"))),
        );

        assert_eq!(
            tabs,
            vec![
                path(&mine.join("a.excalidraw")),
                path(&outside),
                path(&mine.join("new.excalidraw")),
            ]
        );
        assert_eq!(active, None, "an ignored tab cannot be the active one");
        assert_eq!(ignored, 2);
        let (_, active, _) = accepted_session_tabs(
            &registry,
            "window-1",
            vec![path(&outside)],
            Some(path(&outside)),
        );
        assert_eq!(active, Some(path(&outside)));
        let _ = std::fs::remove_dir_all(base);
    }

    fn session(abnormal_exit: bool) -> SessionState {
        SessionState {
            abnormal_exit,
            preferred_languages: vec!["en-US".to_owned()],
            lock: Mutex::new(None),
        }
    }

    async fn repository() -> (SqliteRepository, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "excalidraw-handshake-{}-{}.sqlite3",
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

    #[tokio::test]
    async fn launch_files_and_restore_data_are_delivered_once_per_window() {
        let (repository, path) = repository().await;
        let registry = WindowRegistry::new();
        for label in ["window-1", "window-2"] {
            registry
                .register(label, WindowRole::Normal)
                .unwrap_or_else(|error| panic!("register: {error}"));
        }
        registry.push_pending_open_paths("window-1", vec!["/a.excalidraw".to_owned()]);
        registry.set_restore(
            "window-1",
            Some(WindowRestore {
                tabs: vec!["/a.excalidraw".to_owned()],
                active_path: Some("/a.excalidraw".to_owned()),
                skipped: 1,
            }),
            None,
        );
        let state = session(false);

        let take = |label: &str| {
            registry
                .take_bootstrap(label)
                .unwrap_or_else(|| panic!("{label} is registered"))
        };
        let first = state
            .handshake(take("window-1"), &repository, Vec::new())
            .await
            .unwrap_or_else(|error| panic!("first handshake: {error}"));
        assert_eq!(first.contract_version, 5);
        assert_eq!(first.pending_open_paths, vec!["/a.excalidraw".to_owned()]);
        assert_eq!(first.window.restore.map(|restore| restore.skipped), Some(1));

        let again = state
            .handshake(take("window-1"), &repository, Vec::new())
            .await
            .unwrap_or_else(|error| panic!("second handshake: {error}"));
        assert!(again.pending_open_paths.is_empty());
        assert_eq!(again.window.restore, None);

        let other = state
            .handshake(take("window-2"), &repository, Vec::new())
            .await
            .unwrap_or_else(|error| panic!("other window handshake: {error}"));
        assert!(other.pending_open_paths.is_empty());
        assert_eq!(other.window.label, "window-2");
        remove_database(path);
    }

    #[tokio::test]
    async fn abnormal_exit_is_reported_only_to_the_recovery_window() {
        let (repository, path) = repository().await;
        let registry = WindowRegistry::new();
        registry
            .register("window-1", WindowRole::Recovery)
            .unwrap_or_else(|error| panic!("register recovery: {error}"));
        registry
            .register("window-2", WindowRole::Normal)
            .unwrap_or_else(|error| panic!("register normal: {error}"));
        let state = session(true);

        for (label, expected) in [("window-1", true), ("window-2", false)] {
            let record = registry
                .take_bootstrap(label)
                .unwrap_or_else(|| panic!("{label} is registered"));
            let response = state
                .handshake(record, &repository, Vec::new())
                .await
                .unwrap_or_else(|error| panic!("handshake: {error}"));
            assert_eq!(response.abnormal_exit, expected, "{label}");
        }
        remove_database(path);
    }

    #[tokio::test]
    async fn the_bootstrap_carries_the_owned_workspace_and_its_shell_state() {
        let (repository, path) = repository().await;
        let workspace = WorkspaceRecord {
            id: "a".to_owned(),
            name: "Notes".to_owned(),
            root_path: "/w/notes".to_owned(),
            created_at: 1,
            mounted: true,
        };
        repository
            .workspace_upsert(workspace.clone())
            .await
            .unwrap_or_else(|error| panic!("upsert: {error}"));
        let registry = WindowRegistry::new();
        registry
            .register("window-1", WindowRole::Normal)
            .unwrap_or_else(|error| panic!("register: {error}"));
        registry
            .claim("window-1", &WorkspaceCandidate::from_record(&workspace))
            .unwrap_or_else(|error| panic!("claim: {error}"));
        let state = session(false);

        // No record yet: no shell state either.
        let record = registry
            .take_bootstrap("window-1")
            .unwrap_or_else(|| panic!("registered"));
        let response = state
            .handshake(record, &repository, registry.owned_workspace_ids())
            .await
            .unwrap_or_else(|error| panic!("handshake: {error}"));
        assert_eq!(
            response.window.workspace.map(|w| w.id),
            Some("a".to_owned())
        );
        assert_eq!(response.window.shell, None);
        assert_eq!(
            response.window.open_workspace_names,
            vec![OpenWorkspaceName {
                workspace_id: "a".to_owned(),
                name: "Notes".to_owned(),
                root_path: "/w/notes".to_owned(),
            }]
        );

        let shell = WorkspaceShellState {
            sidebar_pinned: true,
            sidebar_width: 320,
            expanded: vec!["drafts".to_owned()],
        };
        repository
            .workspace_shell_state_save("a".to_owned(), shell.clone(), 3)
            .await
            .unwrap_or_else(|error| panic!("save shell: {error}"));
        let record = registry
            .take_bootstrap("window-1")
            .unwrap_or_else(|| panic!("registered"));
        let response = state
            .handshake(record, &repository, Vec::new())
            .await
            .unwrap_or_else(|error| panic!("handshake with shell: {error}"));
        assert_eq!(response.window.shell, Some(shell));
        remove_database(path);
    }

    async fn upsert(repository: &SqliteRepository, id: &str) {
        repository
            .workspace_upsert(WorkspaceRecord {
                id: id.to_owned(),
                name: id.to_owned(),
                root_path: format!("/w/{id}"),
                created_at: 1,
                mounted: false,
            })
            .await
            .unwrap_or_else(|error| panic!("upsert: {error}"));
    }

    #[tokio::test]
    async fn legacy_shell_preferences_are_imported_once() {
        let (repository, path) = repository().await;
        let legacy = LegacyShellState {
            sidebar_pinned: true,
            sidebar_width: 300,
        };

        assert!(migrate_shell_preferences(&repository, legacy)
            .await
            .unwrap_or_else(|error| panic!("migrate: {error}")));
        assert!(!migrate_shell_preferences(
            &repository,
            LegacyShellState {
                sidebar_pinned: false,
                sidebar_width: 400,
            },
        )
        .await
        .unwrap_or_else(|error| panic!("migrate again: {error}")));

        upsert(&repository, "a").await;
        assert_eq!(
            workspace_shell_state_for(&repository, "a")
                .await
                .unwrap_or_else(|error| panic!("shell: {error}")),
            Some(WorkspaceShellState {
                sidebar_pinned: true,
                sidebar_width: 300,
                expanded: vec![String::new()],
            })
        );
        remove_database(path);
    }

    #[tokio::test]
    async fn a_first_opened_workspace_takes_the_most_recent_pin_and_width() {
        let (repository, path) = repository().await;
        assert_eq!(
            workspace_shell_state_for(&repository, "a")
                .await
                .unwrap_or_else(|error| panic!("shell: {error}")),
            None
        );
        migrate_shell_preferences(
            &repository,
            LegacyShellState {
                sidebar_pinned: false,
                sidebar_width: 300,
            },
        )
        .await
        .unwrap_or_else(|error| panic!("migrate: {error}"));
        upsert(&repository, "a").await;
        upsert(&repository, "b").await;
        let own = WorkspaceShellState {
            sidebar_pinned: true,
            sidebar_width: 420,
            expanded: vec![String::new(), "drafts".to_owned()],
        };
        repository
            .workspace_shell_state_save("a".to_owned(), own.clone(), 5)
            .await
            .unwrap_or_else(|error| panic!("save: {error}"));

        assert_eq!(
            workspace_shell_state_for(&repository, "a")
                .await
                .unwrap_or_else(|error| panic!("own shell: {error}")),
            Some(own)
        );
        assert_eq!(
            workspace_shell_state_for(&repository, "b")
                .await
                .unwrap_or_else(|error| panic!("first-open shell: {error}")),
            Some(WorkspaceShellState {
                sidebar_pinned: true,
                sidebar_width: 420,
                expanded: vec![String::new()],
            })
        );
        remove_database(path);
    }
}
