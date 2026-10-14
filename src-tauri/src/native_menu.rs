use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard, OnceLock,
    },
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{
        CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem,
        Submenu,
    },
    AppHandle, Emitter, Listener, Manager, Runtime, State,
};

use crate::commands::error::{AppError, IpcError};
pub use crate::native_menu_spec::*;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NativeMenuCommand {
    Save,
    ExportImage,
    VersionHistory,
    AppearanceSystem,
    AppearanceLight,
    AppearanceDark,
    LanguageSystem,
    LanguageEn,
    LanguageZhCn,
    Help,
    ToggleToolLock,
    ToggleGrid,
    ToggleSnap,
    ToggleZen,
    ToggleViewMode,
}

impl NativeMenuCommand {
    const ALL: [Self; 15] = [
        Self::Save,
        Self::ExportImage,
        Self::VersionHistory,
        Self::AppearanceSystem,
        Self::AppearanceLight,
        Self::AppearanceDark,
        Self::LanguageSystem,
        Self::LanguageEn,
        Self::LanguageZhCn,
        Self::Help,
        Self::ToggleToolLock,
        Self::ToggleGrid,
        Self::ToggleSnap,
        Self::ToggleZen,
        Self::ToggleViewMode,
    ];

    pub fn from_menu_id(id: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|command| command.menu_id() == id)
    }

    fn menu_id(self) -> &'static str {
        match self {
            Self::Save => SAVE_MENU_ID,
            Self::ExportImage => EXPORT_IMAGE_MENU_ID,
            Self::VersionHistory => VERSION_HISTORY_MENU_ID,
            Self::AppearanceSystem => APPEARANCE_SYSTEM_MENU_ID,
            Self::AppearanceLight => APPEARANCE_LIGHT_MENU_ID,
            Self::AppearanceDark => APPEARANCE_DARK_MENU_ID,
            Self::LanguageSystem => LANGUAGE_SYSTEM_MENU_ID,
            Self::LanguageEn => LANGUAGE_EN_MENU_ID,
            Self::LanguageZhCn => LANGUAGE_ZH_CN_MENU_ID,
            Self::Help => HELP_MENU_ID,
            Self::ToggleToolLock => TOOL_LOCK_MENU_ID,
            Self::ToggleGrid => GRID_MENU_ID,
            Self::ToggleSnap => SNAP_MENU_ID,
            Self::ToggleZen => ZEN_MENU_ID,
            Self::ToggleViewMode => VIEW_MODE_MENU_ID,
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

/// Last valid labels and state, kept so a label change can rebuild the menu
/// and a state-only change can update items in place.
struct NativeMenuModel {
    labels: NativeMenuLabels,
    state: NativeMenuSyncState,
    version_history_enabled: bool,
}

pub struct NativeMenuStore(Mutex<NativeMenuModel>);

impl NativeMenuStore {
    fn lock(&self) -> MutexGuard<'_, NativeMenuModel> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Build the English bootstrap menu, install it, and keep its model.
///
/// Every fallible menu construction operation is returned to the caller so a
/// setup failure aborts application setup instead of leaving a partially
/// configured shell running.
pub fn install_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let model = NativeMenuModel {
        labels: NativeMenuLabels::english(&app.package_info().name),
        state: NativeMenuSyncState::default(),
        // History is available only after the frontend has an active saved
        // document. Start disabled so the native menu cannot advertise an
        // operation before the document authority has been established.
        version_history_enabled: false,
    };
    let menu = build_menu(app, &model)?;
    app.manage(NativeMenuStore(Mutex::new(model)));
    app.set_menu(menu)?;
    Ok(())
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, model: &NativeMenuModel) -> tauri::Result<Menu<R>> {
    let items = build_entries(app, &menu_spec(), model)?;
    Menu::with_items(app, &as_item_refs(&items))
}

fn as_item_refs<R: Runtime>(items: &[MenuItemKind<R>]) -> Vec<&dyn IsMenuItem<R>> {
    items
        .iter()
        .map(|item| item as &dyn IsMenuItem<R>)
        .collect()
}

fn build_entries<R: Runtime>(
    app: &AppHandle<R>,
    entries: &[MenuEntry],
    model: &NativeMenuModel,
) -> tauri::Result<Vec<MenuItemKind<R>>> {
    let mut items = Vec::with_capacity(entries.len());
    for entry in entries {
        items.push(match entry {
            MenuEntry::Submenu {
                id,
                label,
                children,
            } => {
                let text = match label {
                    SubmenuLabel::Id(label) => model.labels.get(label).to_owned(),
                    SubmenuLabel::AppName => app.package_info().name.clone(),
                };
                let children = build_entries(app, children, model)?;
                MenuItemKind::Submenu(Submenu::with_id_and_items(
                    app,
                    *id,
                    text,
                    true,
                    &as_item_refs(&children),
                )?)
            }
            MenuEntry::Item {
                id,
                label,
                check,
                accelerator,
            } => {
                let text = model.labels.get(label);
                let state = item_state(id, &model.state, model.version_history_enabled);
                let enabled = state.is_none_or(|state| state.enabled);
                if *check {
                    let checked = state.and_then(|state| state.checked).unwrap_or(false);
                    MenuItemKind::Check(CheckMenuItem::with_id(
                        app,
                        *id,
                        text,
                        enabled,
                        checked,
                        *accelerator,
                    )?)
                } else {
                    MenuItemKind::MenuItem(MenuItem::with_id(
                        app,
                        *id,
                        text,
                        enabled,
                        *accelerator,
                    )?)
                }
            }
            MenuEntry::System { kind, label } => {
                MenuItemKind::Predefined(system_item(app, *kind, model.labels.get(label))?)
            }
            MenuEntry::Separator => MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
        });
    }
    Ok(items)
}

fn system_item<R: Runtime>(
    app: &AppHandle<R>,
    kind: SystemItem,
    text: &str,
) -> tauri::Result<PredefinedMenuItem<R>> {
    let text = Some(text);
    match kind {
        SystemItem::About => PredefinedMenuItem::about(app, text, None),
        SystemItem::Services => PredefinedMenuItem::services(app, text),
        SystemItem::Hide => PredefinedMenuItem::hide(app, text),
        SystemItem::HideOthers => PredefinedMenuItem::hide_others(app, text),
        SystemItem::Quit => PredefinedMenuItem::quit(app, text),
        SystemItem::CloseWindow => PredefinedMenuItem::close_window(app, text),
        SystemItem::Undo => PredefinedMenuItem::undo(app, text),
        SystemItem::Redo => PredefinedMenuItem::redo(app, text),
        SystemItem::Cut => PredefinedMenuItem::cut(app, text),
        SystemItem::Copy => PredefinedMenuItem::copy(app, text),
        SystemItem::Paste => PredefinedMenuItem::paste(app, text),
        SystemItem::SelectAll => PredefinedMenuItem::select_all(app, text),
        SystemItem::Minimize => PredefinedMenuItem::minimize(app, text),
        SystemItem::Zoom => PredefinedMenuItem::maximize(app, text),
        SystemItem::Fullscreen => PredefinedMenuItem::fullscreen(app, text),
    }
}

/// Push the model's enabled/checked flags onto the installed menu items.
fn apply_menu_state<R: Runtime>(
    items: &[MenuItemKind<R>],
    model: &NativeMenuModel,
) -> tauri::Result<()> {
    for item in items {
        let state = item_state(
            item.id().as_ref(),
            &model.state,
            model.version_history_enabled,
        );
        match (item, state) {
            (MenuItemKind::MenuItem(menu_item), Some(state)) => {
                menu_item.set_enabled(state.enabled)?;
            }
            (MenuItemKind::Check(check_item), Some(state)) => {
                check_item.set_enabled(state.enabled)?;
                check_item.set_checked(state.checked.unwrap_or(false))?;
            }
            (MenuItemKind::Submenu(submenu), _) => apply_menu_state(&submenu.items()?, model)?,
            _ => {}
        }
    }
    Ok(())
}

fn reapply_installed_state<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let (Some(menu), Some(store)) = (app.menu(), app.try_state::<NativeMenuStore>()) else {
        return Ok(());
    };
    let model = store.lock();
    apply_menu_state(&menu.items()?, &model)
}

/// Apply the frontend's localized labels and state. A label change rebuilds
/// the menu; a state-only change updates the existing items. Invalid labels
/// are rejected and the last valid menu stays installed.
#[tauri::command(rename = "native_menu_sync")]
pub fn sync_native_menu<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, NativeMenuStore>,
    labels: BTreeMap<String, String>,
    state: NativeMenuSyncState,
) -> Result<(), IpcError> {
    let labels = NativeMenuLabels::validate(labels).map_err(AppError::Internal)?;
    let mut model = store.lock();
    let rebuild = labels != model.labels;
    let previous = (model.labels.clone(), model.state);
    model.labels = labels;
    model.state = state;
    let result = if rebuild {
        build_menu(&app, &model).and_then(|menu| app.set_menu(menu).map(|_| ()))
    } else {
        match app.menu() {
            Some(menu) => menu
                .items()
                .and_then(|items| apply_menu_state(&items, &model)),
            None => Ok(()),
        }
    };
    if let Err(error) = result {
        (model.labels, model.state) = previous;
        return Err(
            AppError::Internal(format!("failed to update the native menu: {error}")).into(),
        );
    }
    Ok(())
}

/// Synchronize the discoverability state of the history entry with the
/// frontend's active document authority. This is UX state only; the event
/// route still rechecks the active document before opening the panel.
#[tauri::command(rename = "native_menu_set_enabled")]
pub fn set_native_menu_enabled<R: Runtime>(
    app: AppHandle<R>,
    command: NativeMenuCommand,
    enabled: bool,
) -> tauri::Result<()> {
    if command != NativeMenuCommand::VersionHistory {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "only Version History supports dynamic menu state",
        )
        .into());
    }
    let menu = app.menu().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "native menu is not installed")
    })?;
    if let Some(store) = app.try_state::<NativeMenuStore>() {
        store.lock().version_history_enabled = enabled;
    }
    if !set_menu_item_enabled(&menu.items()?, command.menu_id(), enabled)? {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("native menu item is not installed: {}", command.menu_id()),
        )
        .into());
    }
    Ok(())
}

fn set_menu_item_enabled<R: Runtime>(
    items: &[MenuItemKind<R>],
    id: &str,
    enabled: bool,
) -> tauri::Result<bool> {
    for item in items {
        if item.id().as_ref() == id {
            let Some(menu_item) = item.as_menuitem() else {
                return Ok(false);
            };
            menu_item.set_enabled(enabled)?;
            return Ok(true);
        }
        if let Some(submenu) = item.as_submenu() {
            if set_menu_item_enabled(&submenu.items()?, id, enabled)? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Forward a recognized native menu command to the main webview.
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let Some(command) = NativeMenuCommand::from_menu_id(event.id().as_ref()) else {
        return;
    };

    // AppKit toggles a check item when it is clicked. The frontend decides
    // the new state and syncs it back, so restore the last synced flags first
    // (otherwise clicking the already-selected language would clear it).
    if let Err(error) = reapply_installed_state(app) {
        eprintln!("failed to restore native menu state: {error}");
    }

    let validation_id = register_pending_validation(command);
    if let Some(validation_id) = validation_id {
        log_validation_observation("nativeEntry", validation_id, command);
    }
    let payload = NativeMenuCommandEvent {
        command,
        validation_id,
    };
    let Some(target) = crate::window::target_window(app) else {
        if let Some(validation_id) = validation_id {
            discard_pending_validation(validation_id);
        }
        return;
    };
    if let Err(error) = app.emit_to(target.as_str(), NATIVE_MENU_EVENT, payload) {
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
    fn registered_enable_command_matches_frontend_invoke() {
        // Use the same generated command name that Tauri's handler dispatches,
        // rather than a mock that accepts an unregistered frontend command.
        let registered_name = __tauri_command_name_set_native_menu_enabled!();
        let frontend = include_str!("../../src/app/nativeMenu.ts");
        assert!(
            frontend.contains(&format!(".invoke(\"{registered_name}\",")),
            "frontend invoke must match registered Tauri command {registered_name}"
        );
    }

    #[test]
    fn registered_sync_command_matches_frontend_invoke() {
        let registered_name = __tauri_command_name_sync_native_menu!();
        let frontend = include_str!("../../src/app/nativeMenuSync.ts");
        assert!(
            frontend.contains(&format!(".invoke(\"{registered_name}\",")),
            "frontend invoke must match registered Tauri command {registered_name}"
        );
    }

    #[test]
    fn maps_only_owned_menu_ids_to_commands() {
        let cases = [
            (SAVE_MENU_ID, NativeMenuCommand::Save),
            (EXPORT_IMAGE_MENU_ID, NativeMenuCommand::ExportImage),
            (VERSION_HISTORY_MENU_ID, NativeMenuCommand::VersionHistory),
            (
                APPEARANCE_SYSTEM_MENU_ID,
                NativeMenuCommand::AppearanceSystem,
            ),
            (APPEARANCE_LIGHT_MENU_ID, NativeMenuCommand::AppearanceLight),
            (APPEARANCE_DARK_MENU_ID, NativeMenuCommand::AppearanceDark),
            (LANGUAGE_SYSTEM_MENU_ID, NativeMenuCommand::LanguageSystem),
            (LANGUAGE_EN_MENU_ID, NativeMenuCommand::LanguageEn),
            (LANGUAGE_ZH_CN_MENU_ID, NativeMenuCommand::LanguageZhCn),
            (HELP_MENU_ID, NativeMenuCommand::Help),
            (TOOL_LOCK_MENU_ID, NativeMenuCommand::ToggleToolLock),
            (GRID_MENU_ID, NativeMenuCommand::ToggleGrid),
            (SNAP_MENU_ID, NativeMenuCommand::ToggleSnap),
            (ZEN_MENU_ID, NativeMenuCommand::ToggleZen),
            (VIEW_MODE_MENU_ID, NativeMenuCommand::ToggleViewMode),
        ];

        for (id, command) in cases {
            assert_eq!(NativeMenuCommand::from_menu_id(id), Some(command));
        }
        assert_eq!(NativeMenuCommand::from_menu_id("close-window"), None);
        assert_eq!(
            NativeMenuCommand::from_menu_id("native-menu.help-menu"),
            None
        );
        assert_eq!(
            serde_json::to_value(NativeMenuCommand::LanguageZhCn)
                .unwrap_or_else(|error| panic!("serialize command: {error}")),
            serde_json::json!("languageZhCn")
        );
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
