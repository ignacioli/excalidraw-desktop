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
    AppHandle, Emitter, Listener, Manager, Runtime, State, WebviewWindow,
};

use crate::commands::error::{AppError, IpcError};
pub use crate::native_menu_spec::*;

/// Event delivered to the front window's webview when an application menu
/// command is activated. The frontend owns the corresponding document/export/theme
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
    OpenWorkspace,
}

impl NativeMenuCommand {
    const ALL: [Self; 16] = [
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
        Self::OpenWorkspace,
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
            Self::OpenWorkspace => OPEN_WORKSPACE_MENU_ID,
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

/// The menu state one window last reported.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct WindowMenuState {
    state: NativeMenuSyncState,
    version_history_enabled: bool,
}

/// Last valid labels and every window's last state, kept so a label change
/// can rebuild the menu and a state-only change can update items in place.
/// The installed menu shows the state of `active`, the front window (or the
/// most recently focused one); with no window it shows the no-document
/// state.
struct NativeMenuModel {
    labels: NativeMenuLabels,
    windows: BTreeMap<String, WindowMenuState>,
    active: Option<String>,
}

impl NativeMenuModel {
    fn new(labels: NativeMenuLabels) -> Self {
        Self {
            labels,
            windows: BTreeMap::new(),
            active: None,
        }
    }

    /// The state the installed menu should show. History stays disabled
    /// until a window with an active saved document reports otherwise.
    fn applied(&self) -> (WindowMenuState, bool) {
        match self.active.as_ref() {
            Some(label) => (self.windows.get(label).copied().unwrap_or_default(), true),
            None => (WindowMenuState::default(), false),
        }
    }

    fn item_state(&self, id: &str) -> Option<ItemState> {
        let (window, has_window) = self.applied();
        item_state(
            id,
            &window.state,
            window.version_history_enabled,
            has_window,
        )
    }
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
    // History is available only after a window's frontend has an active
    // saved document, so the bootstrap state keeps it disabled.
    let model = NativeMenuModel::new(NativeMenuLabels::english(&app.package_info().name));
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
                let state = model.item_state(id);
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
        let state = model.item_state(item.id().as_ref());
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

/// Apply the frontend's localized labels and the calling window's state. A
/// label change rebuilds the menu; a state change updates the existing items
/// only when the caller is the window the menu currently shows. Invalid
/// labels are rejected and the last valid menu stays installed.
#[tauri::command(rename = "native_menu_sync")]
pub fn sync_native_menu<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    store: State<'_, NativeMenuStore>,
    labels: BTreeMap<String, String>,
    state: NativeMenuSyncState,
) -> Result<(), IpcError> {
    let labels = NativeMenuLabels::validate(labels).map_err(AppError::Internal)?;
    let target = crate::window::target_window(&app);
    let mut model = store.lock();
    let label = window.label().to_owned();
    let previous_labels = model.labels.clone();
    let previous_window = model.windows.get(&label).copied();
    let previous_active = model.active.clone();
    let rebuild = labels != model.labels;
    model.labels = labels;
    model.windows.entry(label.clone()).or_default().state = state;
    let shows_caller = target.as_deref() == Some(label.as_str());
    if shows_caller {
        model.active = Some(label.clone());
    }
    let result = if rebuild {
        build_menu(&app, &model).and_then(|menu| app.set_menu(menu).map(|_| ()))
    } else if shows_caller {
        apply_installed(&app, &model)
    } else {
        Ok(())
    };
    if let Err(error) = result {
        model.labels = previous_labels;
        match previous_window {
            Some(previous) => {
                model.windows.insert(label, previous);
            }
            None => {
                model.windows.remove(&label);
            }
        }
        model.active = previous_active;
        return Err(
            AppError::Internal(format!("failed to update the native menu: {error}")).into(),
        );
    }
    Ok(())
}

fn apply_installed<R: Runtime>(app: &AppHandle<R>, model: &NativeMenuModel) -> tauri::Result<()> {
    match app.menu() {
        Some(menu) => apply_menu_state(&menu.items()?, model),
        None => Ok(()),
    }
}

/// Synchronize the discoverability state of the history entry with the
/// calling window's active document authority. This is UX state only; the
/// event route still rechecks the active document before opening the panel.
#[tauri::command(rename = "native_menu_set_enabled")]
pub fn set_native_menu_enabled<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
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
    let target = crate::window::target_window(&app);
    let label = window.label();
    if let Some(store) = app.try_state::<NativeMenuStore>() {
        let mut model = store.lock();
        model
            .windows
            .entry(label.to_owned())
            .or_default()
            .version_history_enabled = enabled;
        if target.as_deref() == Some(label) {
            model.active = Some(label.to_owned());
        } else {
            return Ok(());
        }
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

/// Show `label`'s last reported state; called when the window gains focus.
pub fn show_window_state<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(store) = app.try_state::<NativeMenuStore>() else {
        return;
    };
    let mut model = store.lock();
    if model.active.as_deref() == Some(label) {
        return;
    }
    model.active = Some(label.to_owned());
    if let Err(error) = apply_installed(app, &model) {
        eprintln!("failed to apply the native menu state of {label}: {error}");
    }
}

/// Drop a destroyed window's state and show the next window's, or the
/// no-document state when no window is left. The registry must already have
/// unregistered `label`.
pub fn forget_window_state<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(store) = app.try_state::<NativeMenuStore>() else {
        return;
    };
    let next = crate::window::target_window(app);
    let mut model = store.lock();
    model.windows.remove(label);
    if model.active.as_deref() != Some(label) && model.active.is_some() {
        return;
    }
    model.active = next;
    if let Err(error) = apply_installed(app, &model) {
        eprintln!("failed to apply the native menu state after closing {label}: {error}");
    }
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

/// Handle New Window in Rust and forward every other recognized native menu
/// command to the front window, falling back to the most recently focused
/// one.
pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id().as_ref() == NEW_WINDOW_MENU_ID {
        if let Err(error) = crate::window::open_new_window(app) {
            eprintln!("failed to open a new window: {error}");
        }
        return;
    }
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
            (OPEN_WORKSPACE_MENU_ID, NativeMenuCommand::OpenWorkspace),
        ];

        for (id, command) in cases {
            assert_eq!(NativeMenuCommand::from_menu_id(id), Some(command));
        }
        assert_eq!(NativeMenuCommand::from_menu_id("close-window"), None);
        assert_eq!(
            NativeMenuCommand::from_menu_id(NEW_WINDOW_MENU_ID),
            None,
            "New Window is handled in Rust, never forwarded to a webview"
        );
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

    fn english_model() -> NativeMenuModel {
        NativeMenuModel::new(NativeMenuLabels::english("Excalidraw"))
    }

    #[test]
    fn shows_the_no_document_state_without_a_window() {
        let mut model = english_model();
        model.windows.insert(
            "window-1".to_owned(),
            WindowMenuState {
                state: NativeMenuSyncState {
                    has_document: true,
                    ..NativeMenuSyncState::default()
                },
                version_history_enabled: true,
            },
        );
        let enabled = |model: &NativeMenuModel, id| model.item_state(id).map(|item| item.enabled);
        assert_eq!(enabled(&model, SAVE_MENU_ID), Some(false));
        assert_eq!(enabled(&model, VERSION_HISTORY_MENU_ID), Some(false));
        assert_eq!(enabled(&model, OPEN_WORKSPACE_MENU_ID), Some(false));
        assert_eq!(enabled(&model, NEW_WINDOW_MENU_ID), Some(true));
    }

    #[test]
    fn shows_only_the_active_window_state() {
        let mut model = english_model();
        let with_document = WindowMenuState {
            state: NativeMenuSyncState {
                has_document: true,
                grid: true,
                ..NativeMenuSyncState::default()
            },
            version_history_enabled: true,
        };
        model.windows.insert("window-1".to_owned(), with_document);
        model
            .windows
            .insert("window-2".to_owned(), WindowMenuState::default());

        model.active = Some("window-1".to_owned());
        assert_eq!(
            model.item_state(SAVE_MENU_ID).map(|item| item.enabled),
            Some(true)
        );
        assert_eq!(
            model.item_state(GRID_MENU_ID).and_then(|item| item.checked),
            Some(true)
        );
        assert_eq!(
            model
                .item_state(VERSION_HISTORY_MENU_ID)
                .map(|item| item.enabled),
            Some(true)
        );

        model.active = Some("window-2".to_owned());
        assert_eq!(
            model.item_state(SAVE_MENU_ID).map(|item| item.enabled),
            Some(false)
        );
        assert_eq!(
            model.item_state(GRID_MENU_ID).and_then(|item| item.checked),
            Some(false)
        );
        assert_eq!(
            model
                .item_state(OPEN_WORKSPACE_MENU_ID)
                .map(|item| item.enabled),
            Some(true)
        );

        // A window that has not reported yet shows the no-document state.
        model.active = Some("window-3".to_owned());
        assert_eq!(
            model.item_state(SAVE_MENU_ID).map(|item| item.enabled),
            Some(false)
        );
        assert_eq!(
            model
                .item_state(OPEN_WORKSPACE_MENU_ID)
                .map(|item| item.enabled),
            Some(true)
        );
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
