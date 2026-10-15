pub mod commands;
pub mod database;
pub mod documents;
#[cfg(feature = "e2e-harness")]
pub(crate) mod e2e_harness;
#[cfg(feature = "e2e-harness")]
mod e2e_performance;
#[cfg(all(test, feature = "e2e-harness"))]
mod e2e_performance_test;
pub mod history;
pub mod indexing;
pub mod locale;
mod native_menu;
mod native_menu_spec;
pub mod security;
mod watcher;
mod window;
pub mod workspace_entries;

use std::{path::Path, path::PathBuf, sync::Arc};

use tauri::Manager;

use database::repository::WorkspaceRepository;
use tauri_plugin_fs::FsExt;
use window::{
    placement::PlacementTracker,
    quit::QuitCoordinator,
    registry::{WindowRegistry, WindowRole},
    session::{SessionWriter, WindowSessionRepository},
};

use commands::{
    documents::{
        doc_checkpoint, doc_close, doc_open, doc_resolve_conflict, doc_save_draft,
        ConflictRegistry, DirectFileGrant, DocumentService, DocumentState,
    },
    entries::{
        workspace_entry_create, workspace_entry_delete, workspace_entry_delete_preflight,
        workspace_entry_list, workspace_entry_rename, workspace_entry_reveal, WorkspaceEntryState,
    },
    export::{doc_export, ExportService, ExportState},
    history::{
        history_delete, history_list, history_mark, history_operation_status, history_preview,
        history_replace, history_set_marked, HistoryReplacementState,
    },
    recovery::{
        recovery_apply, recovery_list, RecoveryService, RecoveryState, TauriRecoveryPathGrant,
    },
    session::{
        app_handshake, app_preferences_broadcast, app_quit_ready, shell_preferences_migrate,
        startup_recovery_done, window_session_update, workspace_shell_state_save, SessionState,
    },
    workspace::{
        window_claim_workspace, window_close_other_and_claim, window_peer_close_failed,
        window_probe_workspace, window_release_workspace, workspace_add, workspace_list,
        workspace_recent_list, workspace_recent_remove, workspace_remount, workspace_remove,
        WorkspaceState,
    },
};
use database::repository::SqliteRepository;
use documents::recovery::RecoveryStore;
#[cfg(feature = "e2e-harness")]
use e2e_performance::{
    e2e_perf_bootstrap, e2e_perf_next_command, e2e_perf_publish_error, e2e_perf_publish_ready,
    e2e_perf_publish_result, PerformanceHarnessState,
};
use history::reconcile::reconcile_incomplete_operations_with_repository;
use history::{query::HistoryState, store::HistoryStore};
use watcher::{WatcherService, WatcherState};
use workspace_entries::WorkspaceMutationGate;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(feature = "e2e-harness")]
    if let Some(result) = e2e_harness::run_process_scenario_if_requested() {
        if let Err(error) = result {
            eprintln!("E2E reliability scenario failed: {error}");
            std::process::exit(2);
        }
        return;
    }

    #[cfg(all(feature = "e2e-harness", target_os = "macos"))]
    e2e_harness::disable_app_nap();

    configure_linux_ime_environment();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init());
    #[cfg(not(feature = "e2e-harness"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        let paths = drawing_paths_from_args(&argv);
        if paths.is_empty() {
            if let Some(label) = crate::window::target_window(app) {
                crate::window::activate_label(app, &label);
            }
            return;
        }
        open_drawing_paths(app, &paths);
    }));
    let builder = builder.setup(|app| {
        let app_data_directory = resolve_app_data_directory(app)?;
        std::fs::create_dir_all(&app_data_directory)?;
        let web_kit_data_directory = app.path().app_local_data_dir()?;
        std::fs::create_dir_all(&web_kit_data_directory)?;
        let pending_open_paths = drawing_paths_from_env_args();
        grant_drawing_paths(&app.fs_scope(), &pending_open_paths)?;
        let repository = tauri::async_runtime::block_on(SqliteRepository::open(
            &app_data_directory.join("excalidraw-desktop.sqlite3"),
        ))?;
        let session = SessionState::initialize(&app_data_directory)?;
        let shared_repository = Arc::new(repository.clone());
        let history_store = match HistoryStore::open(&app_data_directory) {
            Ok(store) => Some(Arc::new(store)),
            Err(error) => {
                eprintln!("version history is unavailable; continuing without history");
                eprintln!("version history initialization error: {error}");
                None
            }
        };
        let history_state = HistoryState::with_direct_file_grant(
            Arc::clone(&shared_repository),
            history_store.clone(),
            Arc::new(TauriFileGrant(app.fs_scope())),
        );
        // Reconcile durable protected replacements before any startup
        // path can publish stale draft or Recovery state. A pending
        // result remains durable and retryable; it must not be reported
        // as a completed replacement.
        if let Some(history_store) = history_store.as_ref() {
            match tauri::async_runtime::block_on(reconcile_incomplete_operations_with_repository(
                history_store,
                &repository,
            )) {
                Ok(report) if report.has_pending() => {
                    eprintln!("version history startup reconciliation remains pending");
                }
                Ok(_) => {}
                Err(error) => {
                    eprintln!("version history startup reconciliation failed: {error}");
                }
            }
        }
        let workspace_mutation_gate = WorkspaceMutationGate::default();
        let recovery_store = Arc::new(RecoveryStore::new(&app_data_directory));
        #[cfg(feature = "e2e-harness")]
        let performance_state = tauri::async_runtime::block_on(
            PerformanceHarnessState::from_environment(Arc::clone(&shared_repository)),
        )
        .map_err(std::io::Error::other)?;
        let conflicts = ConflictRegistry::default();
        let watcher_service =
            WatcherService::new(Arc::clone(&shared_repository), conflicts.clone());
        let mut document_service = DocumentService::with_grant_and_scene_limit_and_recovery(
            Arc::clone(&shared_repository),
            Arc::new(TauriFileGrant(app.fs_scope())),
            DocumentService::DEFAULT_SCENE_LIMIT_BYTES,
            Arc::clone(&recovery_store),
        );
        if let Some(history_store) = history_store.as_ref() {
            document_service.attach_history_store(Arc::clone(history_store));
        }
        document_service
            .attach_external_change_handlers(conflicts, Some(Arc::new(watcher_service.clone())));
        let history_replacement_state = HistoryReplacementState::with_document_service(
            document_service.clone(),
            Arc::clone(&shared_repository),
            history_store.clone(),
            Arc::new(TauriFileGrant(app.fs_scope())),
        );
        let entry_reconciliation = match history_store.as_ref() {
            Some(store) => tauri::async_runtime::block_on(
                crate::workspace_entries::reconcile_pending_mutations_with_history(
                    &shared_repository,
                    recovery_store.as_ref(),
                    crate::workspace_entries::history_replay_for_store(Arc::clone(store)),
                ),
            ),
            None => tauri::async_runtime::block_on(
                crate::workspace_entries::reconcile_pending_mutations(
                    &shared_repository,
                    recovery_store.as_ref(),
                ),
            ),
        };
        if let Err(error) = entry_reconciliation {
            eprintln!("failed to reconcile pending Workspace Entry mutations: {error}");
        }
        let mut recovery_service = RecoveryService::with_path_grant(
            Arc::clone(&shared_repository),
            Arc::clone(&recovery_store),
            Arc::new(TauriRecoveryPathGrant(app.fs_scope())),
        );
        recovery_service.attach_watcher(Arc::new(watcher_service.clone()));
        // `mounted` means "open in a window", so no Workspace is mounted until
        // a window claims it. After an abnormal exit the previous mounted rows
        // stay as Recovery's authorization roots until Recovery finishes. The
        // startup reconciliation above still sees the previous mounted set.
        if !session.abnormal_exit() {
            tauri::async_runtime::block_on(repository.workspace_unmount_all())?;
        }
        let stored_session = match tauri::async_runtime::block_on(repository.window_session_list())
        {
            Ok(entries) => entries,
            Err(error) => {
                eprintln!("failed to read the window session: {error}");
                Vec::new()
            }
        };
        let window_registry = WindowRegistry::new();
        let owned_workspace_ids = window_registry.owned_workspace_ids();
        app.manage(window_registry);
        app.manage(QuitCoordinator::new(window::quit::configured_timeout()));
        app.manage(SessionWriter::default());
        app.manage(PlacementTracker::default());
        app.manage(crate::window::peer_close::PeerCloseRequests::default());
        app.manage(repository);
        app.manage(history_state);
        app.manage(history_replacement_state);
        if let Some(history_store) = history_store.as_ref() {
            app.manage(Arc::clone(history_store));
        }
        #[cfg(feature = "e2e-harness")]
        app.manage(performance_state);
        app.manage(DocumentState::new(document_service));
        app.manage(RecoveryState::new(recovery_service));
        app.manage(WorkspaceState::new(Arc::clone(&shared_repository)));
        app.manage(workspace_mutation_gate.clone());
        let mut workspace_entry_state = WorkspaceEntryState::new(
            Arc::clone(&shared_repository),
            workspace_mutation_gate,
            Arc::clone(&recovery_store),
            watcher_service.clone(),
        );
        if let Some(history_store) = history_store.as_ref() {
            workspace_entry_state =
                workspace_entry_state.with_history_store(Arc::clone(history_store));
        }
        app.manage(workspace_entry_state);
        app.manage(ExportState::new(ExportService::new(
            Arc::clone(&shared_repository),
            Arc::new(TauriFileGrant(app.fs_scope())),
            DocumentService::DEFAULT_SCENE_LIMIT_BYTES,
        )));
        app.manage(session);
        app.manage(WatcherState::new(watcher_service.clone()));
        tauri::async_runtime::block_on(
            watcher_service.start_existing(&owned_workspace_ids, app.handle().clone()),
        )?;
        app.on_menu_event(crate::native_menu::handle_menu_event);
        crate::native_menu::register_validation_listener(app.handle());
        crate::native_menu::install_menu(app.handle())?;
        // The stored windows are recreated first; after an abnormal exit
        // only the Recovery window opens, and the others follow once
        // Recovery is done. Until then the stored session is not replaced.
        let writer = app.state::<SessionWriter>();
        writer.hold();
        if app.state::<SessionState>().abnormal_exit() {
            writer.set_pending_restore(stored_session);
            crate::window::create_window(app.handle(), WindowRole::Recovery, None)?;
        } else {
            let created = tauri::async_runtime::block_on(crate::window::restore_session(
                app.handle(),
                stored_session,
            ));
            writer.release();
            if created == 0 {
                crate::window::create_window(app.handle(), WindowRole::Normal, None)?;
            }
        }
        crate::window::router::route_open_paths(app.handle(), &pending_open_paths);
        #[cfg(feature = "e2e-harness")]
        e2e_harness::multi_window::start_app_driver(app.handle()).map_err(std::io::Error::other)?;
        // rAF-driven performance workloads stall when the window is
        // occluded (WebKit throttles occluded views); keep the test-only
        // measurement window unoccluded on busy diagnostic hosts.
        #[cfg(feature = "e2e-harness")]
        if std::env::var_os("EXCALIDRAW_PERF_CONTROL_DIR").is_some() {
            for window in app.webview_windows().values() {
                let _ = window.set_always_on_top(true);
            }
        }
        Ok(())
    });

    #[cfg(feature = "e2e-harness")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        app_handshake,
        app_preferences_broadcast,
        app_quit_ready,
        shell_preferences_migrate,
        startup_recovery_done,
        window_session_update,
        workspace_shell_state_save,
        crate::native_menu::set_native_menu_enabled,
        crate::native_menu::sync_native_menu,
        crate::window::window_new,
        history_list,
        history_preview,
        history_mark,
        history_set_marked,
        history_delete,
        history_replace,
        history_operation_status,
        doc_open,
        doc_save_draft,
        doc_checkpoint,
        doc_close,
        doc_resolve_conflict,
        recovery_list,
        recovery_apply,
        workspace_add,
        workspace_remove,
        workspace_list,
        workspace_recent_list,
        workspace_remount,
        workspace_recent_remove,
        window_probe_workspace,
        window_claim_workspace,
        window_close_other_and_claim,
        window_peer_close_failed,
        window_release_workspace,
        workspace_entry_list,
        workspace_entry_create,
        workspace_entry_rename,
        workspace_entry_delete_preflight,
        workspace_entry_delete,
        workspace_entry_reveal,
        doc_export,
        e2e_harness::e2e_set_atomic_write_fault,
        e2e_harness::e2e_clear_atomic_write_fault,
        e2e_harness::e2e_corrupt_latest_snapshot,
        e2e_harness::e2e_history_frontend_bootstrap,
        e2e_harness::e2e_history_frontend_publish,
        e2e_harness::e2e_history_frontend_close,
        e2e_harness::multi_window::e2e_multi_window_bootstrap,
        e2e_harness::multi_window::e2e_multi_window_next,
        e2e_harness::multi_window::e2e_multi_window_publish,
        e2e_perf_bootstrap,
        e2e_perf_publish_ready,
        e2e_perf_next_command,
        e2e_perf_publish_result,
        e2e_perf_publish_error,
    ]);

    #[cfg(not(feature = "e2e-harness"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        app_handshake,
        app_preferences_broadcast,
        app_quit_ready,
        shell_preferences_migrate,
        startup_recovery_done,
        window_session_update,
        workspace_shell_state_save,
        crate::native_menu::set_native_menu_enabled,
        crate::native_menu::sync_native_menu,
        crate::window::window_new,
        history_list,
        history_preview,
        history_mark,
        history_set_marked,
        history_delete,
        history_replace,
        history_operation_status,
        doc_open,
        doc_save_draft,
        doc_checkpoint,
        doc_close,
        doc_resolve_conflict,
        recovery_list,
        recovery_apply,
        workspace_add,
        workspace_remove,
        workspace_list,
        workspace_recent_list,
        workspace_remount,
        workspace_recent_remove,
        window_probe_workspace,
        window_claim_workspace,
        window_close_other_and_claim,
        window_peer_close_failed,
        window_release_workspace,
        workspace_entry_list,
        workspace_entry_create,
        workspace_entry_rename,
        workspace_entry_delete_preflight,
        workspace_entry_delete,
        workspace_entry_reveal,
        doc_export,
    ]);

    let builder = builder.on_window_event(handle_window_event);

    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(error) => {
            eprintln!("failed to build Excalidraw Desktop: {error}");
            return;
        }
    };
    app.run(|app_handle, event| match event {
        // Closing the last window keeps the app in the Dock on macOS. An
        // exit with a code (the coordinated quit) is never held.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } if keeps_running_without_windows() => api.prevent_exit(),
        tauri::RunEvent::Exit => {
            // Terminations that skip the coordinated quit (the Dock menu,
            // logging out) still store the windows when possible.
            if app_handle.try_state::<PlacementTracker>().is_some() {
                tauri::async_runtime::block_on(crate::window::placement::flush(app_handle));
            }
            if app_handle.try_state::<SessionWriter>().is_some() {
                tauri::async_runtime::block_on(crate::window::persist_session(app_handle));
                app_handle.state::<SessionWriter>().freeze();
            }
            if let Some(session) = app_handle.try_state::<SessionState>() {
                if let Err(error) = session.release() {
                    eprintln!("failed to release the session lock: {error}");
                }
            }
        }
        // Finder and `open` hand drawings to a running app as Apple Events.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            let arguments: Vec<String> = urls
                .iter()
                .filter_map(|url| url.to_file_path().ok())
                .map(|path| path_string(&path))
                .collect();
            let paths = drawing_paths_from_args(&arguments);
            if !paths.is_empty() {
                open_drawing_paths(app_handle, &paths);
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => crate::window::reopen(app_handle),
        _ => {}
    });
}

/// Keep the registry and the native menu in step with window focus and
/// window destruction, and remember where Workspace windows are.
fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let label = window.label();
    if !label.starts_with(window::registry::WINDOW_LABEL_PREFIX) {
        return;
    }
    let app = window.app_handle().clone();
    match event {
        tauri::WindowEvent::Focused(true) => {
            app.state::<WindowRegistry>().focus(label);
            crate::native_menu::show_window_state(&app, label);
        }
        // Maximizing and entering full screen also resize the window.
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            if let Some(observed) = crate::window::placement::observe_window(window) {
                crate::window::placement::record(&app, label, observed);
            }
        }
        tauri::WindowEvent::Destroyed => {
            app.state::<PlacementTracker>().forget(label);
            let label = label.to_owned();
            // Its own close checkpointed it, so a quit stops waiting for it.
            crate::window::quit::forget_window(&app, &label);
            tauri::async_runtime::spawn(async move {
                if let Err(error) = commands::workspace::release_for_window(&app, &label).await {
                    eprintln!("failed to release the Workspace of {label}: {error}");
                }
                app.state::<WindowRegistry>().unregister(&label);
                crate::native_menu::forget_window_state(&app, &label);
                commands::workspace::finish_peer_closes(&app, &label).await;
                crate::window::schedule_session_write(&app);
                crate::window::broadcast_open_workspaces(&app).await;
            });
        }
        _ => {}
    }
}

/// Whether closing the last window leaves the app running. The test-only
/// history driver ends its process by closing its only window.
#[cfg(target_os = "macos")]
fn keeps_running_without_windows() -> bool {
    #[cfg(feature = "e2e-harness")]
    if e2e_harness::exits_with_last_window() {
        return false;
    }
    true
}

/// Grant drawing paths handed to the running app and route them to windows.
fn open_drawing_paths<R: tauri::Runtime>(app: &tauri::AppHandle<R>, paths: &[String]) {
    match grant_drawing_paths(&app.fs_scope(), paths) {
        Ok(()) => crate::window::router::route_open_paths(app, paths),
        Err(error) => eprintln!("failed to grant opened drawing paths: {error}"),
    }
}

struct TauriFileGrant(tauri::fs::Scope);

fn drawing_paths_from_env_args() -> Vec<String> {
    drawing_paths_from_args(&std::env::args().skip(1).collect::<Vec<_>>())
}

fn drawing_paths_from_args(args: &[String]) -> Vec<String> {
    args.iter()
        .filter(|argument| {
            let path = Path::new(argument);
            is_supported_drawing_path(path)
        })
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.exists())
        .map(|path| path_string(&path))
        .collect()
}

trait ExactFileScope {
    fn allow_exact_file(&self, path: &Path) -> tauri::Result<()>;
}

impl ExactFileScope for tauri::fs::Scope {
    fn allow_exact_file(&self, path: &Path) -> tauri::Result<()> {
        self.allow_file(path)
    }
}

fn grant_drawing_paths<S: ExactFileScope>(scope: &S, paths: &[String]) -> tauri::Result<()> {
    for path in paths {
        scope.allow_exact_file(Path::new(path))?;
    }
    Ok(())
}

fn is_supported_drawing_path(path: &Path) -> bool {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("excalidraw") => true,
        Some("json") => path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".excalidraw.json")),
        _ => false,
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

impl DirectFileGrant for TauriFileGrant {
    fn is_allowed(&self, path: &Path) -> bool {
        self.0.is_allowed(path)
    }
}

#[cfg(target_os = "linux")]
fn configure_linux_ime_environment() {
    if std::env::var_os("GTK_IM_MODULE").is_some() {
        return;
    }
    let xmodifiers = std::env::var("XMODIFIERS").ok();
    let qt_module = std::env::var("QT_IM_MODULE").ok();
    let ibus_address = std::env::var_os("IBUS_ADDRESS").is_some();
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
    if let Some(module) = inferred_linux_ime_module(
        xmodifiers.as_deref(),
        qt_module.as_deref(),
        ibus_address,
        wayland,
    ) {
        std::env::set_var("GTK_IM_MODULE", module);
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_ime_environment() {}

#[cfg(any(target_os = "linux", test))]
fn inferred_linux_ime_module(
    xmodifiers: Option<&str>,
    qt_module: Option<&str>,
    ibus_address_present: bool,
    wayland: bool,
) -> Option<&'static str> {
    let xmodifiers = xmodifiers.unwrap_or_default().to_ascii_lowercase();
    if xmodifiers.contains("@im=fcitx") {
        return Some("fcitx");
    }
    if xmodifiers.contains("@im=ibus") {
        return Some("ibus");
    }

    // Native Wayland sessions commonly omit XMODIFIERS. Reuse the already selected
    // toolkit module instead of overriding a user's explicit desktop configuration.
    if wayland {
        let qt_module = qt_module.unwrap_or_default().to_ascii_lowercase();
        if qt_module.starts_with("fcitx") {
            return Some("fcitx");
        }
        if qt_module == "ibus" || ibus_address_present {
            return Some("ibus");
        }
    }
    None
}

#[cfg(feature = "e2e-harness")]
fn resolve_app_data_directory(_app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(root) = std::env::var_os("EXCALIDRAW_E2E_ROOT") {
        return Ok(PathBuf::from(root).join("data"));
    }
    Err("EXCALIDRAW_E2E_ROOT is required for an e2e-harness build".into())
}

#[cfg(not(feature = "e2e-harness"))]
fn resolve_app_data_directory(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    Ok(app.path().app_data_dir()?)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{drawing_paths_from_args, grant_drawing_paths, inferred_linux_ime_module};

    #[test]
    fn infers_linux_ime_without_replacing_an_explicit_gtk_choice() {
        assert_eq!(
            inferred_linux_ime_module(Some("@im=fcitx"), None, false, false),
            Some("fcitx")
        );
        assert_eq!(
            inferred_linux_ime_module(None, Some("fcitx5"), false, true),
            Some("fcitx")
        );
        assert_eq!(
            inferred_linux_ime_module(None, None, true, true),
            Some("ibus")
        );
        assert_eq!(inferred_linux_ime_module(None, None, false, false), None);
    }

    #[test]
    fn filters_second_instance_arguments_to_drawing_files() {
        let existing = std::env::temp_dir().join(format!(
            "excalidraw-open-arg-{}.excalidraw.json",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&existing, b"{}").expect("write fixture file");
        let args = vec![
            "excalidraw-desktop".to_owned(),
            "/not/a/file.excalidraw".to_owned(),
            "relative.excalidraw".to_owned(),
            existing.display().to_string(),
            "/tmp/notes.json".to_owned(),
        ];
        let paths = drawing_paths_from_args(&args);

        assert_eq!(paths, vec![existing.display().to_string()]);
        let _ = std::fs::remove_file(existing);
    }

    #[test]
    fn grants_only_the_validated_exact_drawing_file() {
        let scope = RecordingExactFileScope::default();
        let directory = tempfile_directory("exact-grant");
        let target = directory.join("target.excalidraw");
        let neighbor = directory.join("neighbor.excalidraw");
        std::fs::write(&target, b"{}").expect("write target fixture");
        std::fs::write(&neighbor, b"{}").expect("write neighbor fixture");

        let args = vec![
            "excalidraw-desktop".to_owned(),
            target.display().to_string(),
        ];
        let paths = drawing_paths_from_args(&args);
        grant_drawing_paths(&scope, &paths).expect("grant exact drawing file paths");

        assert!(scope.is_allowed(&target));
        assert!(!scope.is_allowed(&neighbor));
        remove_directory(directory);
    }

    #[test]
    fn invalid_nonexistent_and_unsupported_arguments_receive_no_grant() {
        let scope = RecordingExactFileScope::default();
        let directory = tempfile_directory("invalid-grant");
        let unsupported = directory.join("notes.txt");
        let nonexistent = directory.join("missing.excalidraw");
        std::fs::write(&unsupported, b"{}").expect("write unsupported fixture");
        let args = vec![
            "excalidraw-desktop".to_owned(),
            "relative.excalidraw".to_owned(),
            nonexistent.display().to_string(),
            unsupported.display().to_string(),
        ];

        let paths = drawing_paths_from_args(&args);
        grant_drawing_paths(&scope, &paths).expect("grant filtered paths");

        assert!(paths.is_empty());
        assert!(!scope.is_allowed(&unsupported));
        assert!(!scope.is_allowed(&nonexistent));
        remove_directory(directory);
    }

    #[derive(Default)]
    struct RecordingExactFileScope {
        allowed: std::sync::Mutex<Vec<PathBuf>>,
    }

    impl super::ExactFileScope for RecordingExactFileScope {
        fn allow_exact_file(&self, path: &std::path::Path) -> tauri::Result<()> {
            self.allowed
                .lock()
                .expect("recording scope mutex")
                .push(path.to_path_buf());
            Ok(())
        }
    }

    impl RecordingExactFileScope {
        fn is_allowed(&self, path: &std::path::Path) -> bool {
            self.allowed
                .lock()
                .expect("recording scope mutex")
                .iter()
                .any(|allowed| allowed == path)
        }
    }

    fn tempfile_directory(label: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("excalidraw-open-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("create temp fixture directory");
        directory
    }

    fn remove_directory(directory: PathBuf) {
        std::fs::remove_dir_all(directory).expect("remove temp fixture directory");
    }

    /// The production build registers its own command list, which names no
    /// test-only driver command.
    #[test]
    fn the_production_command_list_has_no_test_only_commands() {
        let source = include_str!("lib.rs");
        let marker = concat!(
            "#[cfg(not(feature = \"e2e-harness\"))]\n",
            "    let builder = builder.invoke_handler("
        );
        let start = source.find(marker).expect("production command list");
        let list = &source[start..];
        let list = &list[..list.find("]);").expect("end of the command list")];

        assert!(list.contains("app_quit_ready"));
        for token in ["e2e_", "multi_window", "history_frontend", "perf_"] {
            assert!(
                !list.contains(token),
                "production command list names {token}"
            );
        }
    }
}
