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
pub mod thumbnails;
mod watcher;

use std::{path::Path, path::PathBuf, sync::Arc};

use tauri::{Emitter, Manager};
use tauri_plugin_fs::FsExt;

use commands::dto::OpenFileRequestEvent;
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
    thumbnails::{thumb_lookup, thumb_store, ThumbnailService, ThumbnailState},
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

use crate::thumbnails::ThumbnailCache;

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
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths = drawing_paths_from_args(&argv);
            if !paths.is_empty() {
                let _ = app.emit("open-file-request", OpenFileRequestEvent { paths });
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let app_data_directory = resolve_app_data_directory(app)?;
            std::fs::create_dir_all(&app_data_directory)?;

            let pending_open_paths = drawing_paths_from_env_args();
            let repository = tauri::async_runtime::block_on(SqliteRepository::open(
                &app_data_directory.join("excalidraw-desktop.sqlite3"),
            ))?;
            let session = SessionState::initialize(&app_data_directory, pending_open_paths)?;
            let shared_repository = Arc::new(repository.clone());
            let recovery_store = Arc::new(RecoveryStore::new(&app_data_directory));
            let thumbnail_cache = Arc::new(ThumbnailCache::new(&app_data_directory));
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
            app.manage(ThumbnailState::new(ThumbnailService::new(
                Arc::clone(&shared_repository),
                Arc::clone(&thumbnail_cache),
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
        thumb_lookup,
        thumb_store,
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
        doc_export,
        thumb_lookup,
        thumb_store
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
    use super::{drawing_paths_from_args, inferred_linux_ime_module};

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
}
