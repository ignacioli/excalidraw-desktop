pub mod commands;
pub mod database;
pub mod documents;
#[cfg(feature = "e2e-harness")]
mod e2e_harness;
#[cfg(feature = "e2e-harness")]
mod e2e_performance;
#[cfg(all(test, feature = "e2e-harness"))]
mod e2e_performance_test;
pub mod indexing;
pub mod security;
mod thumbnails;
mod watcher;

use std::{path::Path, path::PathBuf, sync::Arc};

use tauri::Manager;
use tauri_plugin_fs::FsExt;

use commands::{
    documents::{
        doc_checkpoint, doc_close, doc_open, doc_resolve_conflict, doc_save_draft,
        ConflictRegistry, DirectFileGrant, DocumentService, DocumentState,
    },
    export::{doc_export, ExportService, ExportState},
    files::{file_create, file_delete, file_rename, FileState},
    recovery::{
        recovery_apply, recovery_list, RecoveryService, RecoveryState, TauriRecoveryPathGrant,
    },
    session::{app_handshake, SessionState},
    workspace::{dir_list, workspace_add, workspace_list, workspace_remove, WorkspaceState},
};
use database::repository::SqliteRepository;
use documents::recovery::RecoveryStore;
#[cfg(feature = "e2e-harness")]
use e2e_performance::{
    e2e_perf_bootstrap, e2e_perf_next_command, e2e_perf_publish_ready, e2e_perf_publish_result,
    PerformanceHarnessState,
};
use watcher::{WatcherService, WatcherState};

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

    configure_linux_ime_environment();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_directory = resolve_app_data_directory(app)?;
            std::fs::create_dir_all(&app_data_directory)?;

            let repository = tauri::async_runtime::block_on(SqliteRepository::open(
                &app_data_directory.join("excalidraw-desktop.sqlite3"),
            ))?;
            let session = SessionState::initialize(&app_data_directory)?;
            let shared_repository = Arc::new(repository.clone());
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
            document_service.attach_external_change_handlers(
                conflicts,
                Some(Arc::new(watcher_service.clone())),
            );
            let recovery_service = RecoveryService::with_path_grant(
                Arc::clone(&shared_repository),
                recovery_store,
                Arc::new(TauriRecoveryPathGrant(app.fs_scope())),
            );
            app.manage(repository);
            #[cfg(feature = "e2e-harness")]
            app.manage(performance_state);
            app.manage(DocumentState::new(document_service));
            app.manage(RecoveryState::new(recovery_service));
            app.manage(WorkspaceState::new(Arc::clone(&shared_repository)));
            app.manage(ExportState::new(ExportService::new(
                Arc::clone(&shared_repository),
                Arc::new(TauriFileGrant(app.fs_scope())),
                DocumentService::DEFAULT_SCENE_LIMIT_BYTES,
            )));
            app.manage(FileState::new(shared_repository));
            app.manage(session);
            app.manage(WatcherState::new(watcher_service.clone()));
            tauri::async_runtime::block_on(watcher_service.start_existing(app.handle().clone()))?;
            Ok(())
        });

    #[cfg(feature = "e2e-harness")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        app_handshake,
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
        dir_list,
        file_create,
        file_rename,
        file_delete,
        doc_export,
        e2e_harness::e2e_set_atomic_write_fault,
        e2e_harness::e2e_clear_atomic_write_fault,
        e2e_harness::e2e_corrupt_latest_snapshot,
        e2e_perf_bootstrap,
        e2e_perf_publish_ready,
        e2e_perf_next_command,
        e2e_perf_publish_result,
    ]);

    #[cfg(not(feature = "e2e-harness"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        app_handshake,
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
        dir_list,
        file_create,
        file_rename,
        file_delete,
        doc_export
    ]);

    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(error) => {
            eprintln!("failed to build Excalidraw Desktop: {error}");
            return;
        }
    };
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(session) = app_handle.try_state::<SessionState>() {
                if let Err(error) = session.release() {
                    eprintln!("failed to release the session lock: {error}");
                }
            }
        }
    });
}

struct TauriFileGrant(tauri::fs::Scope);

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
    use super::inferred_linux_ime_module;

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
}
