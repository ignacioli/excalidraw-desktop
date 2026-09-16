use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuBuilder, MenuEvent, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter, Listener, Runtime,
};

/// Event delivered to the main webview when an application menu command is
/// activated. The frontend owns the corresponding document/export/theme
/// operation; this module only exposes the native discoverability boundary.
pub const NATIVE_MENU_EVENT: &str = "native-menu-command";
const NATIVE_MENU_VALIDATION_ACK_EVENT: &str = "native-menu-validation-ack";
const NATIVE_MENU_VALIDATION_ENV: &str = "EXCALIDRAW_NATIVE_MENU_VALIDATION";
const NATIVE_MENU_VALIDATION_LOG_PREFIX: &str = "EXCALIDRAW_NATIVE_MENU_VALIDATION ";
static NATIVE_MENU_VALIDATION_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static PENDING_NATIVE_MENU_VALIDATIONS: OnceLock<Mutex<HashMap<u64, NativeMenuCommand>>> =
    OnceLock::new();

pub const SAVE_MENU_ID: &str = "native-menu.save";
pub const EXPORT_IMAGE_MENU_ID: &str = "native-menu.export-image";
pub const APPEARANCE_SYSTEM_MENU_ID: &str = "native-menu.appearance.system";
pub const APPEARANCE_LIGHT_MENU_ID: &str = "native-menu.appearance.light";
pub const APPEARANCE_DARK_MENU_ID: &str = "native-menu.appearance.dark";

const SAVE_MENU_ACCELERATOR: &str = "CmdOrCtrl+S";
const EXPORT_IMAGE_MENU_ACCELERATOR: &str = "CmdOrCtrl+Alt+E";

const FILE_SUBMENU_ID: &str = "native-menu.file";
const EDIT_SUBMENU_ID: &str = "native-menu.edit";
const VIEW_SUBMENU_ID: &str = "native-menu.view";
const APPEARANCE_SUBMENU_ID: &str = "native-menu.appearance";
const WINDOW_SUBMENU_ID: &str = "native-menu.window";
const HELP_SUBMENU_ID: &str = "native-menu.help";
#[cfg(target_os = "macos")]
const APPLICATION_SUBMENU_ID: &str = "native-menu.application";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeMenuCommand {
    Save,
    ExportImage,
    AppearanceSystem,
    AppearanceLight,
    AppearanceDark,
}

impl NativeMenuCommand {
    pub fn from_menu_id(id: &str) -> Option<Self> {
        match id {
            SAVE_MENU_ID => Some(Self::Save),
            EXPORT_IMAGE_MENU_ID => Some(Self::ExportImage),
            APPEARANCE_SYSTEM_MENU_ID => Some(Self::AppearanceSystem),
            APPEARANCE_LIGHT_MENU_ID => Some(Self::AppearanceLight),
            APPEARANCE_DARK_MENU_ID => Some(Self::AppearanceDark),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMenuCommandEvent {
    pub command: NativeMenuCommand,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation_id: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeMenuValidationAck {
    validation_id: u64,
    command: NativeMenuCommand,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeMenuValidationObservation {
    stage: &'static str,
    validation_id: u64,
    command: NativeMenuCommand,
}

/// Build the app-wide menu using Tauri's native menu APIs.
///
/// Every fallible menu construction operation is returned to the caller so a
/// setup failure aborts application setup instead of leaving a partially
/// configured shell running.
pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let save = MenuItem::with_id(app, SAVE_MENU_ID, "Save", true, Some(SAVE_MENU_ACCELERATOR))?;
    let export_image = MenuItem::with_id(
        app,
        EXPORT_IMAGE_MENU_ID,
        "Export Image",
        true,
        Some(EXPORT_IMAGE_MENU_ACCELERATOR),
    )?;

    let appearance_system =
        MenuItem::with_id(app, APPEARANCE_SYSTEM_MENU_ID, "System", true, None::<&str>)?;
    let appearance_light =
        MenuItem::with_id(app, APPEARANCE_LIGHT_MENU_ID, "Light", true, None::<&str>)?;
    let appearance_dark =
        MenuItem::with_id(app, APPEARANCE_DARK_MENU_ID, "Dark", true, None::<&str>)?;
    let appearance = SubmenuBuilder::with_id(app, APPEARANCE_SUBMENU_ID, "Appearance")
        .items(&[&appearance_system, &appearance_light, &appearance_dark])
        .build()?;

    #[allow(unused_mut)]
    let mut file =
        SubmenuBuilder::with_id(app, FILE_SUBMENU_ID, "File").items(&[&save, &export_image]);
    #[cfg(not(target_os = "macos"))]
    {
        file = file
            .separator()
            .item(&PredefinedMenuItem::close_window(app, None)?)
            .item(&PredefinedMenuItem::quit(app, None)?);
    }
    let file = file.build()?;
    let edit = SubmenuBuilder::with_id(app, EDIT_SUBMENU_ID, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let mut view = SubmenuBuilder::with_id(app, VIEW_SUBMENU_ID, "View").item(&appearance);
    #[cfg(target_os = "macos")]
    {
        view = view
            .separator()
            .item(&PredefinedMenuItem::fullscreen(app, None)?);
    }
    let view = view.build()?;

    let window = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, "Window")
        .minimize()
        .maximize()
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    #[cfg(target_os = "macos")]
    let application =
        SubmenuBuilder::with_id(app, APPLICATION_SUBMENU_ID, app.package_info().name.clone())
            .item(&PredefinedMenuItem::about(app, None, None)?)
            .separator()
            .item(&PredefinedMenuItem::services(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::quit(app, None)?)
            .build()?;

    #[cfg(not(target_os = "macos"))]
    let help = SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, "Help")
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .build()?;
    #[cfg(target_os = "macos")]
    let help = SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, "Help").build()?;

    let mut menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    {
        menu = menu.item(&application);
    }
    menu = menu
        .item(&file)
        .item(&edit)
        .item(&view)
        .item(&window)
        .item(&help);
    menu.build()
}

/// Forward a recognized native menu command to the main webview.
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let Some(command) = NativeMenuCommand::from_menu_id(event.id().as_ref()) else {
        return;
    };

    let validation_id = register_pending_validation(command);
    if let Some(validation_id) = validation_id {
        log_validation_observation("nativeEntry", validation_id, command);
    }
    let payload = NativeMenuCommandEvent {
        command,
        validation_id,
    };
    if let Err(error) = app.emit_to("main", NATIVE_MENU_EVENT, payload) {
        if let Some(validation_id) = validation_id {
            discard_pending_validation(validation_id);
        }
        eprintln!("failed to forward native menu command: {error}");
    }
}

/// Install the dormant validation acknowledgement listener only when the exact
/// packaged process was launched by the terminal native-menu harness.
///
/// This is an observation channel, not a second command path: the frontend can
/// acknowledge only the validation id carried by the real native menu event.
pub fn register_validation_listener<R: Runtime>(app: &AppHandle<R>) {
    if !native_menu_validation_enabled() {
        return;
    }

    app.listen_any(NATIVE_MENU_VALIDATION_ACK_EVENT, |event| {
        let ack = match serde_json::from_str::<NativeMenuValidationAck>(event.payload()) {
            Ok(ack) if ack.validation_id > 0 => ack,
            Ok(_) => {
                eprintln!("native menu validation acknowledgement used an invalid id");
                return;
            }
            Err(error) => {
                eprintln!("failed to parse native menu validation acknowledgement: {error}");
                return;
            }
        };

        let result = {
            let mut pending = pending_native_menu_validations()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            consume_pending_validation(&mut pending, ack.validation_id, ack.command)
        };
        match result {
            Ok(()) => {
                log_validation_observation("applicationRoute", ack.validation_id, ack.command)
            }
            Err(error) => eprintln!("rejected native menu validation acknowledgement: {error}"),
        }
    });
}

fn native_menu_validation_enabled() -> bool {
    std::env::var(NATIVE_MENU_VALIDATION_ENV).as_deref() == Ok("1")
}

fn pending_native_menu_validations() -> &'static Mutex<HashMap<u64, NativeMenuCommand>> {
    PENDING_NATIVE_MENU_VALIDATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_pending_validation(command: NativeMenuCommand) -> Option<u64> {
    if !native_menu_validation_enabled() {
        return None;
    }
    let validation_id = NATIVE_MENU_VALIDATION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    pending_native_menu_validations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(validation_id, command);
    Some(validation_id)
}

fn discard_pending_validation(validation_id: u64) {
    pending_native_menu_validations()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&validation_id);
}

fn consume_pending_validation(
    pending: &mut HashMap<u64, NativeMenuCommand>,
    validation_id: u64,
    command: NativeMenuCommand,
) -> Result<(), String> {
    let Some(expected) = pending.get(&validation_id).copied() else {
        return Err(format!("unknown validation id {validation_id}"));
    };
    if expected != command {
        return Err(format!(
            "command mismatch for validation id {validation_id}: expected {expected:?}, got {command:?}"
        ));
    }
    pending.remove(&validation_id);
    Ok(())
}

fn log_validation_observation(stage: &'static str, validation_id: u64, command: NativeMenuCommand) {
    let observation = NativeMenuValidationObservation {
        stage,
        validation_id,
        command,
    };
    match serde_json::to_string(&observation) {
        Ok(serialized) => eprintln!("{NATIVE_MENU_VALIDATION_LOG_PREFIX}{serialized}"),
        Err(error) => eprintln!("failed to serialize native menu validation observation: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_only_owned_menu_ids_to_commands() {
        let cases = [
            (SAVE_MENU_ID, NativeMenuCommand::Save),
            (EXPORT_IMAGE_MENU_ID, NativeMenuCommand::ExportImage),
            (
                APPEARANCE_SYSTEM_MENU_ID,
                NativeMenuCommand::AppearanceSystem,
            ),
            (APPEARANCE_LIGHT_MENU_ID, NativeMenuCommand::AppearanceLight),
            (APPEARANCE_DARK_MENU_ID, NativeMenuCommand::AppearanceDark),
        ];

        for (id, command) in cases {
            assert_eq!(NativeMenuCommand::from_menu_id(id), Some(command));
        }
        assert_eq!(NativeMenuCommand::from_menu_id("close-window"), None);
    }

    #[test]
    fn serializes_the_narrow_frontend_event_contract() {
        let payload = NativeMenuCommandEvent {
            command: NativeMenuCommand::ExportImage,
            validation_id: None,
        };
        assert_eq!(
            serde_json::to_value(payload)
                .unwrap_or_else(|error| panic!("serialize event: {error}")),
            serde_json::json!({ "command": "exportImage" })
        );
    }

    #[test]
    fn serializes_validation_correlation_only_when_enabled() {
        let payload = NativeMenuCommandEvent {
            command: NativeMenuCommand::Save,
            validation_id: Some(7),
        };
        assert_eq!(
            serde_json::to_value(payload)
                .unwrap_or_else(|error| panic!("serialize validation event: {error}")),
            serde_json::json!({ "command": "save", "validationId": 7 })
        );
    }

    #[test]
    fn parses_frontend_validation_acknowledgement() {
        let ack: NativeMenuValidationAck = serde_json::from_value(serde_json::json!({
            "validationId": 9,
            "command": "appearanceDark"
        }))
        .unwrap_or_else(|error| panic!("parse validation acknowledgement: {error}"));
        assert_eq!(ack.validation_id, 9);
        assert_eq!(ack.command, NativeMenuCommand::AppearanceDark);
    }

    #[test]
    fn consumes_only_matching_issued_validation_acknowledgements_once() {
        let mut pending = HashMap::from([(12, NativeMenuCommand::Save)]);

        assert!(consume_pending_validation(&mut pending, 11, NativeMenuCommand::Save).is_err());
        assert!(
            consume_pending_validation(&mut pending, 12, NativeMenuCommand::ExportImage).is_err()
        );
        assert_eq!(pending.get(&12), Some(&NativeMenuCommand::Save));
        assert_eq!(
            consume_pending_validation(&mut pending, 12, NativeMenuCommand::Save),
            Ok(())
        );
        assert!(consume_pending_validation(&mut pending, 12, NativeMenuCommand::Save).is_err());
    }

    #[test]
    fn keeps_export_image_accelerator_outside_the_sdk_shortcut() {
        assert_eq!(EXPORT_IMAGE_MENU_ACCELERATOR, "CmdOrCtrl+Alt+E");
        assert_ne!(
            EXPORT_IMAGE_MENU_ACCELERATOR, "CmdOrCtrl+Shift+E",
            "the SDK owns CmdOrCtrl+Shift+E; the native menu must not intercept it"
        );
        assert_eq!(SAVE_MENU_ACCELERATOR, "CmdOrCtrl+S");
    }
}
