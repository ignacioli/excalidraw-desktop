//! Pure description of the native menu: its tree, the localized label set the
//! frontend supplies, and the enabled/checked state derived from the
//! frontend snapshot. Building real Tauri menu objects lives in
//! `native_menu`; keeping this data-only makes the contract unit-testable.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const NEW_WINDOW_MENU_ID: &str = "native-menu.new-window";
pub const OPEN_WORKSPACE_MENU_ID: &str = "native-menu.open-workspace";
pub const SAVE_MENU_ID: &str = "native-menu.save";
pub const EXPORT_IMAGE_MENU_ID: &str = "native-menu.export-image";
pub const VERSION_HISTORY_MENU_ID: &str = "native-menu.version-history";
pub const APPEARANCE_SYSTEM_MENU_ID: &str = "native-menu.appearance.system";
pub const APPEARANCE_LIGHT_MENU_ID: &str = "native-menu.appearance.light";
pub const APPEARANCE_DARK_MENU_ID: &str = "native-menu.appearance.dark";
pub const LANGUAGE_SYSTEM_MENU_ID: &str = "native-menu.language.system";
pub const LANGUAGE_EN_MENU_ID: &str = "native-menu.language.en";
pub const LANGUAGE_ZH_CN_MENU_ID: &str = "native-menu.language.zh-CN";
pub const LANGUAGE_ES_MENU_ID: &str = "native-menu.language.es";
pub const LANGUAGE_JA_MENU_ID: &str = "native-menu.language.ja";
pub const TOOL_LOCK_MENU_ID: &str = "native-menu.pref.tool-lock";
pub const GRID_MENU_ID: &str = "native-menu.pref.grid";
pub const SNAP_MENU_ID: &str = "native-menu.pref.snap";
pub const ZEN_MENU_ID: &str = "native-menu.pref.zen";
pub const VIEW_MODE_MENU_ID: &str = "native-menu.pref.view-mode";
pub const HELP_MENU_ID: &str = "native-menu.help";
/// The app's own Quit, so every window checkpoints before the app exits.
pub const QUIT_MENU_ID: &str = "native-menu.quit";

pub const SAVE_MENU_ACCELERATOR: &str = "CmdOrCtrl+S";
/// The SDK has no `N` shortcut and tool shortcuts never use Cmd/Ctrl.
pub const NEW_WINDOW_MENU_ACCELERATOR: &str = "CmdOrCtrl+Shift+N";
/// Plain Cmd+O belongs to the protected import shortcut; the Shift variant is
/// free in both the shell and the SDK.
pub const OPEN_WORKSPACE_MENU_ACCELERATOR: &str = "CmdOrCtrl+Shift+O";
pub const EXPORT_IMAGE_MENU_ACCELERATOR: &str = "CmdOrCtrl+Alt+E";
pub const QUIT_MENU_ACCELERATOR: &str = "CmdOrCtrl+Q";

#[cfg(target_os = "macos")]
const APPLICATION_SUBMENU_ID: &str = "native-menu.application";
const LANGUAGE_SUBMENU_ID: &str = "native-menu.language";
const FILE_SUBMENU_ID: &str = "native-menu.file";
const EDIT_SUBMENU_ID: &str = "native-menu.edit";
const VIEW_SUBMENU_ID: &str = "native-menu.view";
const APPEARANCE_SUBMENU_ID: &str = "native-menu.appearance";
/// The submenu registered as AppKit's `NSApp.windowsMenu`, so macOS lists every
/// open window by title in it.
pub const WINDOW_SUBMENU_ID: &str = "native-menu.window";
const HELP_SUBMENU_ID: &str = "native-menu.help-menu";

/// Every label the frontend must supply, including predefined item text.
/// Each id `x` corresponds to the message key `menu.native.x`, except the
/// language autonyms, which come from `language.autonym.*`.
pub const LABEL_IDS: [&str; 41] = [
    "app.about",
    "app.language",
    "app.languageSystem",
    "app.languageEn",
    "app.languageZhCn",
    "app.languageEs",
    "app.languageJa",
    "app.services",
    "app.hide",
    "app.hideOthers",
    "app.quit",
    "file",
    "file.newWindow",
    "file.openWorkspace",
    "file.save",
    "file.exportImage",
    "file.versionHistory",
    "file.closeWindow",
    "edit",
    "edit.undo",
    "edit.redo",
    "edit.cut",
    "edit.copy",
    "edit.paste",
    "edit.selectAll",
    "view",
    "view.appearance",
    "view.appearanceSystem",
    "view.appearanceLight",
    "view.appearanceDark",
    "view.toolLock",
    "view.grid",
    "view.snap",
    "view.zen",
    "view.viewMode",
    "view.fullscreen",
    "window",
    "window.minimize",
    "window.zoom",
    "help",
    "help.excalidrawHelp",
];

const MAX_LABEL_CHARS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeMenuLabels(BTreeMap<String, String>);

impl NativeMenuLabels {
    /// Accept exactly the required ids, each non-empty, at most 64
    /// characters, and free of control characters.
    pub fn validate(labels: BTreeMap<String, String>) -> Result<Self, String> {
        if let Some(missing) = LABEL_IDS.iter().find(|id| !labels.contains_key(**id)) {
            return Err(format!("native menu label is missing: {missing}"));
        }
        if let Some(extra) = labels.keys().find(|id| !LABEL_IDS.contains(&id.as_str())) {
            return Err(format!("native menu label is unknown: {extra}"));
        }
        for (id, text) in &labels {
            if text.trim().is_empty() {
                return Err(format!("native menu label is empty: {id}"));
            }
            if text.chars().count() > MAX_LABEL_CHARS {
                return Err(format!("native menu label is too long: {id}"));
            }
            if text.chars().any(char::is_control) {
                return Err(format!("native menu label has a control character: {id}"));
            }
        }
        Ok(Self(labels))
    }

    /// Built-in English labels used until the frontend sends its first set.
    pub fn english(app_name: &str) -> Self {
        let pairs: [(&str, String); 41] = [
            ("app.about", format!("About {app_name}")),
            ("app.language", "Language".to_owned()),
            ("app.languageSystem", "Follow System".to_owned()),
            ("app.languageEn", "English".to_owned()),
            ("app.languageZhCn", "简体中文".to_owned()),
            ("app.languageEs", "Español".to_owned()),
            ("app.languageJa", "日本語".to_owned()),
            ("app.services", "Services".to_owned()),
            ("app.hide", format!("Hide {app_name}")),
            ("app.hideOthers", "Hide Others".to_owned()),
            ("app.quit", format!("Quit {app_name}")),
            ("file", "File".to_owned()),
            ("file.newWindow", "New Window".to_owned()),
            ("file.openWorkspace", "Open Workspace…".to_owned()),
            ("file.save", "Save".to_owned()),
            ("file.exportImage", "Export Image".to_owned()),
            ("file.versionHistory", "Version History…".to_owned()),
            ("file.closeWindow", "Close Window".to_owned()),
            ("edit", "Edit".to_owned()),
            ("edit.undo", "Undo".to_owned()),
            ("edit.redo", "Redo".to_owned()),
            ("edit.cut", "Cut".to_owned()),
            ("edit.copy", "Copy".to_owned()),
            ("edit.paste", "Paste".to_owned()),
            ("edit.selectAll", "Select All".to_owned()),
            ("view", "View".to_owned()),
            ("view.appearance", "Appearance".to_owned()),
            ("view.appearanceSystem", "System".to_owned()),
            ("view.appearanceLight", "Light".to_owned()),
            ("view.appearanceDark", "Dark".to_owned()),
            ("view.toolLock", "Tool Lock".to_owned()),
            ("view.grid", "Toggle Grid".to_owned()),
            ("view.snap", "Snap to Objects".to_owned()),
            ("view.zen", "Zen Mode".to_owned()),
            ("view.viewMode", "View Mode".to_owned()),
            ("view.fullscreen", "Enter Full Screen".to_owned()),
            ("window", "Window".to_owned()),
            ("window.minimize", "Minimize".to_owned()),
            ("window.zoom", "Zoom".to_owned()),
            ("help", "Help".to_owned()),
            ("help.excalidrawHelp", "Excalidraw Help".to_owned()),
        ];
        Self(
            pairs
                .into_iter()
                .map(|(id, text)| (id.to_owned(), text))
                .collect(),
        )
    }

    pub fn get<'a>(&'a self, id: &'a str) -> &'a str {
        self.0.get(id).map(String::as_str).unwrap_or(id)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LanguagePreference {
    #[default]
    System,
    En,
    #[serde(rename = "zh-CN")]
    ZhCn,
    Es,
    Ja,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AppearancePreference {
    #[default]
    System,
    Light,
    Dark,
}

/// Frontend snapshot that drives every checked/enabled flag.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeMenuSyncState {
    pub language: LanguagePreference,
    pub appearance: AppearancePreference,
    pub has_document: bool,
    pub forced_read_only: bool,
    pub tool_lock: bool,
    pub grid: bool,
    pub snap: bool,
    pub zen: bool,
    /// The user's View mode, excluding forced read-only.
    pub view_mode: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ItemState {
    pub enabled: bool,
    /// `Some` only for check items.
    pub checked: Option<bool>,
}

/// Derive the state of an owned menu item; `None` for ids the frontend
/// snapshot does not govern. `has_window` is false when no window exists;
/// New Window stays available so the app can always open one.
pub fn item_state(
    id: &str,
    state: &NativeMenuSyncState,
    version_history_enabled: bool,
    has_window: bool,
) -> Option<ItemState> {
    let document = state.has_document;
    let editable = document && !state.forced_read_only;
    let plain = |enabled| ItemState {
        enabled,
        checked: None,
    };
    let check = |enabled, checked| ItemState {
        enabled,
        checked: Some(checked),
    };
    Some(match id {
        NEW_WINDOW_MENU_ID | QUIT_MENU_ID => plain(true),
        OPEN_WORKSPACE_MENU_ID => plain(has_window),
        SAVE_MENU_ID => plain(document),
        EXPORT_IMAGE_MENU_ID => plain(true),
        VERSION_HISTORY_MENU_ID => plain(version_history_enabled),
        HELP_MENU_ID => plain(document),
        APPEARANCE_SYSTEM_MENU_ID => check(true, state.appearance == AppearancePreference::System),
        APPEARANCE_LIGHT_MENU_ID => check(true, state.appearance == AppearancePreference::Light),
        APPEARANCE_DARK_MENU_ID => check(true, state.appearance == AppearancePreference::Dark),
        LANGUAGE_SYSTEM_MENU_ID => check(true, state.language == LanguagePreference::System),
        LANGUAGE_EN_MENU_ID => check(true, state.language == LanguagePreference::En),
        LANGUAGE_ZH_CN_MENU_ID => check(true, state.language == LanguagePreference::ZhCn),
        LANGUAGE_ES_MENU_ID => check(true, state.language == LanguagePreference::Es),
        LANGUAGE_JA_MENU_ID => check(true, state.language == LanguagePreference::Ja),
        TOOL_LOCK_MENU_ID => check(editable, state.tool_lock),
        GRID_MENU_ID => check(document, state.grid),
        SNAP_MENU_ID => check(editable, state.snap),
        ZEN_MENU_ID => check(document, state.zen),
        VIEW_MODE_MENU_ID => check(editable, state.forced_read_only || state.view_mode),
        _ => return None,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SystemItem {
    About,
    Services,
    Hide,
    HideOthers,
    CloseWindow,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Zoom,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Fullscreen,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmenuLabel {
    Id(&'static str),
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    AppName,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuEntry {
    Submenu {
        id: &'static str,
        label: SubmenuLabel,
        children: Vec<MenuEntry>,
    },
    Item {
        id: &'static str,
        label: &'static str,
        check: bool,
        accelerator: Option<&'static str>,
    },
    System {
        kind: SystemItem,
        label: &'static str,
    },
    Separator,
}

fn item(id: &'static str, label: &'static str) -> MenuEntry {
    MenuEntry::Item {
        id,
        label,
        check: false,
        accelerator: None,
    }
}

fn check(id: &'static str, label: &'static str) -> MenuEntry {
    MenuEntry::Item {
        id,
        label,
        check: true,
        accelerator: None,
    }
}

fn system(kind: SystemItem, label: &'static str) -> MenuEntry {
    MenuEntry::System { kind, label }
}

fn quit_item() -> MenuEntry {
    MenuEntry::Item {
        id: QUIT_MENU_ID,
        label: "app.quit",
        check: false,
        accelerator: Some(QUIT_MENU_ACCELERATOR),
    }
}

fn submenu(id: &'static str, label: &'static str, children: Vec<MenuEntry>) -> MenuEntry {
    MenuEntry::Submenu {
        id,
        label: SubmenuLabel::Id(label),
        children,
    }
}

fn language_submenu() -> MenuEntry {
    submenu(
        LANGUAGE_SUBMENU_ID,
        "app.language",
        vec![
            check(LANGUAGE_SYSTEM_MENU_ID, "app.languageSystem"),
            check(LANGUAGE_EN_MENU_ID, "app.languageEn"),
            check(LANGUAGE_ZH_CN_MENU_ID, "app.languageZhCn"),
            check(LANGUAGE_ES_MENU_ID, "app.languageEs"),
            check(LANGUAGE_JA_MENU_ID, "app.languageJa"),
        ],
    )
}

/// The whole menu tree. Only New Window, Open Workspace, Save, Export Image,
/// and Quit register accelerators; keys the SDK already handles (Q, Cmd+',
/// Alt+S, Alt+Z, Alt+R, ?) are not registered so each key keeps a single
/// owner.
pub fn menu_spec() -> Vec<MenuEntry> {
    let mut file = vec![
        MenuEntry::Item {
            id: NEW_WINDOW_MENU_ID,
            label: "file.newWindow",
            check: false,
            accelerator: Some(NEW_WINDOW_MENU_ACCELERATOR),
        },
        MenuEntry::Item {
            id: OPEN_WORKSPACE_MENU_ID,
            label: "file.openWorkspace",
            check: false,
            accelerator: Some(OPEN_WORKSPACE_MENU_ACCELERATOR),
        },
        MenuEntry::Separator,
        MenuEntry::Item {
            id: SAVE_MENU_ID,
            label: "file.save",
            check: false,
            accelerator: Some(SAVE_MENU_ACCELERATOR),
        },
        MenuEntry::Item {
            id: EXPORT_IMAGE_MENU_ID,
            label: "file.exportImage",
            check: false,
            accelerator: Some(EXPORT_IMAGE_MENU_ACCELERATOR),
        },
        item(VERSION_HISTORY_MENU_ID, "file.versionHistory"),
    ];
    if cfg!(not(target_os = "macos")) {
        file.extend([
            MenuEntry::Separator,
            system(SystemItem::CloseWindow, "file.closeWindow"),
            quit_item(),
        ]);
    }

    let edit = vec![
        system(SystemItem::Undo, "edit.undo"),
        system(SystemItem::Redo, "edit.redo"),
        MenuEntry::Separator,
        system(SystemItem::Cut, "edit.cut"),
        system(SystemItem::Copy, "edit.copy"),
        system(SystemItem::Paste, "edit.paste"),
        system(SystemItem::SelectAll, "edit.selectAll"),
    ];

    let mut view = Vec::new();
    if cfg!(not(target_os = "macos")) {
        // Without an application menu, Language lives at the top of View.
        view.extend([language_submenu(), MenuEntry::Separator]);
    }
    view.extend([
        submenu(
            APPEARANCE_SUBMENU_ID,
            "view.appearance",
            vec![
                check(APPEARANCE_SYSTEM_MENU_ID, "view.appearanceSystem"),
                check(APPEARANCE_LIGHT_MENU_ID, "view.appearanceLight"),
                check(APPEARANCE_DARK_MENU_ID, "view.appearanceDark"),
            ],
        ),
        MenuEntry::Separator,
        check(TOOL_LOCK_MENU_ID, "view.toolLock"),
        check(GRID_MENU_ID, "view.grid"),
        check(SNAP_MENU_ID, "view.snap"),
        check(ZEN_MENU_ID, "view.zen"),
        check(VIEW_MODE_MENU_ID, "view.viewMode"),
    ]);
    #[cfg(target_os = "macos")]
    view.extend([
        MenuEntry::Separator,
        system(SystemItem::Fullscreen, "view.fullscreen"),
    ]);

    let window = vec![
        system(SystemItem::Minimize, "window.minimize"),
        system(SystemItem::Zoom, "window.zoom"),
        MenuEntry::Separator,
        system(SystemItem::CloseWindow, "file.closeWindow"),
    ];

    let mut help = vec![item(HELP_MENU_ID, "help.excalidrawHelp")];
    if cfg!(not(target_os = "macos")) {
        help.push(system(SystemItem::About, "app.about"));
    }

    #[allow(unused_mut)]
    let mut menu = Vec::new();
    #[cfg(target_os = "macos")]
    menu.push(MenuEntry::Submenu {
        id: APPLICATION_SUBMENU_ID,
        label: SubmenuLabel::AppName,
        children: vec![
            system(SystemItem::About, "app.about"),
            MenuEntry::Separator,
            language_submenu(),
            MenuEntry::Separator,
            system(SystemItem::Services, "app.services"),
            MenuEntry::Separator,
            system(SystemItem::Hide, "app.hide"),
            system(SystemItem::HideOthers, "app.hideOthers"),
            MenuEntry::Separator,
            quit_item(),
        ],
    });
    menu.extend([
        submenu(FILE_SUBMENU_ID, "file", file),
        submenu(EDIT_SUBMENU_ID, "edit", edit),
        submenu(VIEW_SUBMENU_ID, "view", view),
        submenu(WINDOW_SUBMENU_ID, "window", window),
        submenu(HELP_SUBMENU_ID, "help", help),
    ]);
    menu
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    fn walk<'a>(entries: &'a [MenuEntry], visit: &mut dyn FnMut(&'a MenuEntry)) {
        for entry in entries {
            visit(entry);
            if let MenuEntry::Submenu { children, .. } = entry {
                walk(children, visit);
            }
        }
    }

    fn owned_items() -> Vec<(&'static str, bool)> {
        let spec = menu_spec();
        let mut items = Vec::new();
        walk(&spec, &mut |entry| {
            if let MenuEntry::Item { id, check, .. } = entry {
                items.push((*id, *check));
            }
        });
        items
    }

    #[test]
    fn exposes_exactly_one_top_level_window_submenu() {
        let spec = menu_spec();
        let mut matches = 0;
        walk(&spec, &mut |entry| {
            if matches!(entry, MenuEntry::Submenu { id, .. } if *id == WINDOW_SUBMENU_ID) {
                matches += 1;
            }
        });
        assert_eq!(matches, 1);
        assert!(spec.iter().any(
            |entry| matches!(entry, MenuEntry::Submenu { id, .. } if *id == WINDOW_SUBMENU_ID)
        ));
    }

    #[test]
    fn owns_exactly_the_contract_item_ids() {
        let ids: BTreeSet<_> = owned_items().into_iter().map(|(id, _)| id).collect();
        let expected: BTreeSet<_> = [
            NEW_WINDOW_MENU_ID,
            OPEN_WORKSPACE_MENU_ID,
            SAVE_MENU_ID,
            EXPORT_IMAGE_MENU_ID,
            VERSION_HISTORY_MENU_ID,
            APPEARANCE_SYSTEM_MENU_ID,
            APPEARANCE_LIGHT_MENU_ID,
            APPEARANCE_DARK_MENU_ID,
            LANGUAGE_SYSTEM_MENU_ID,
            LANGUAGE_EN_MENU_ID,
            LANGUAGE_ZH_CN_MENU_ID,
            LANGUAGE_ES_MENU_ID,
            LANGUAGE_JA_MENU_ID,
            TOOL_LOCK_MENU_ID,
            GRID_MENU_ID,
            SNAP_MENU_ID,
            ZEN_MENU_ID,
            VIEW_MODE_MENU_ID,
            HELP_MENU_ID,
            QUIT_MENU_ID,
        ]
        .into_iter()
        .collect();
        assert_eq!(ids, expected);
        assert_eq!(owned_items().len(), expected.len(), "ids must be unique");
    }

    #[test]
    fn uses_check_items_for_languages_appearance_and_preferences() {
        let checks: BTreeSet<_> = owned_items()
            .into_iter()
            .filter(|(_, check)| *check)
            .map(|(id, _)| id)
            .collect();
        assert_eq!(checks.len(), 13);
        for id in [
            LANGUAGE_SYSTEM_MENU_ID,
            LANGUAGE_ES_MENU_ID,
            LANGUAGE_JA_MENU_ID,
            APPEARANCE_DARK_MENU_ID,
            TOOL_LOCK_MENU_ID,
            VIEW_MODE_MENU_ID,
        ] {
            assert!(checks.contains(id), "{id} must be a check item");
        }
        assert!(!checks.contains(SAVE_MENU_ID));
        assert!(!checks.contains(HELP_MENU_ID));
    }

    #[test]
    fn registers_only_the_owned_accelerators() {
        let spec = menu_spec();
        let mut accelerators = BTreeSet::new();
        walk(&spec, &mut |entry| {
            if let MenuEntry::Item {
                accelerator: Some(accelerator),
                ..
            } = entry
            {
                accelerators.insert(*accelerator);
            }
        });
        assert_eq!(
            accelerators,
            BTreeSet::from([
                "CmdOrCtrl+S",
                "CmdOrCtrl+Alt+E",
                "CmdOrCtrl+Shift+N",
                "CmdOrCtrl+Shift+O",
                "CmdOrCtrl+Q",
            ])
        );
        assert!(
            !accelerators.contains("CmdOrCtrl+O"),
            "plain Cmd+O belongs to the protected import shortcut"
        );
    }

    #[test]
    fn file_menu_starts_with_window_commands() {
        let spec = menu_spec();
        let file = spec
            .iter()
            .find_map(|entry| match entry {
                MenuEntry::Submenu { id, children, .. } if *id == FILE_SUBMENU_ID => Some(children),
                _ => None,
            })
            .unwrap_or_else(|| panic!("the File menu is missing"));
        let ids: Vec<_> = file
            .iter()
            .take(4)
            .map(|entry| match entry {
                MenuEntry::Item { id, .. } => *id,
                MenuEntry::Separator => "separator",
                _ => "other",
            })
            .collect();
        assert_eq!(
            ids,
            [
                NEW_WINDOW_MENU_ID,
                OPEN_WORKSPACE_MENU_ID,
                "separator",
                SAVE_MENU_ID
            ]
        );
    }

    #[test]
    fn new_window_stays_available_without_a_window() {
        let state = NativeMenuSyncState::default();
        let enabled =
            |id, has_window| item_state(id, &state, false, has_window).map(|item| item.enabled);
        assert_eq!(enabled(NEW_WINDOW_MENU_ID, false), Some(true));
        assert_eq!(enabled(NEW_WINDOW_MENU_ID, true), Some(true));
        assert_eq!(enabled(OPEN_WORKSPACE_MENU_ID, false), Some(false));
        assert_eq!(enabled(OPEN_WORKSPACE_MENU_ID, true), Some(true));
        assert_eq!(enabled(SAVE_MENU_ID, false), Some(false));
    }

    #[test]
    fn every_label_reference_is_a_required_label() {
        let spec = menu_spec();
        let mut used = BTreeSet::new();
        walk(&spec, &mut |entry| match entry {
            MenuEntry::Submenu {
                label: SubmenuLabel::Id(label),
                ..
            }
            | MenuEntry::Item { label, .. }
            | MenuEntry::System { label, .. } => {
                used.insert(*label);
            }
            _ => {}
        });
        let required: BTreeSet<_> = LABEL_IDS.into_iter().collect();
        assert!(
            used.is_subset(&required),
            "{:?}",
            used.difference(&required)
        );
        #[cfg(target_os = "macos")]
        assert_eq!(used, required);
    }

    #[test]
    fn frontend_catalog_supplies_every_label() {
        let catalog = include_str!("../../src/i18n/messages/en.ts");
        for id in LABEL_IDS {
            let key = match id {
                "app.languageEn" => "language.autonym.en".to_owned(),
                "app.languageZhCn" => "language.autonym.zhCN".to_owned(),
                "app.languageEs" => "language.autonym.es".to_owned(),
                "app.languageJa" => "language.autonym.ja".to_owned(),
                other => format!("menu.native.{other}"),
            };
            assert!(catalog.contains(&format!("\"{key}\":")), "missing {key}");
        }
    }

    fn labels_with(id: &str, text: &str) -> BTreeMap<String, String> {
        let mut labels = NativeMenuLabels::english("Excalidraw").0;
        labels.insert(id.to_owned(), text.to_owned());
        labels
    }

    #[test]
    fn accepts_the_english_label_set() {
        let labels = NativeMenuLabels::english("Excalidraw");
        assert_eq!(
            NativeMenuLabels::validate(labels.0.clone()),
            Ok(labels.clone())
        );
        assert_eq!(labels.get("app.quit"), "Quit Excalidraw");
    }

    #[test]
    fn rejects_incomplete_or_invalid_label_sets() {
        let mut missing = NativeMenuLabels::english("Excalidraw").0;
        missing.remove("edit.undo");
        let cases = [
            missing,
            labels_with("extra.id", "Extra"),
            labels_with("file.save", " "),
            labels_with("file.save", &"x".repeat(65)),
            labels_with("file.save", "Save\nAll"),
        ];
        for labels in cases {
            assert!(NativeMenuLabels::validate(labels).is_err());
        }
        assert!(NativeMenuLabels::validate(labels_with("file.save", &"保".repeat(64))).is_ok());
    }

    #[test]
    fn deserializes_the_frontend_state_contract() {
        let state: NativeMenuSyncState = serde_json::from_value(serde_json::json!({
            "language": "zh-CN",
            "appearance": "dark",
            "hasDocument": true,
            "forcedReadOnly": false,
            "toolLock": true,
            "grid": false,
            "snap": true,
            "zen": false,
            "viewMode": false
        }))
        .unwrap_or_else(|error| panic!("parse sync state: {error}"));
        assert_eq!(state.language, LanguagePreference::ZhCn);
        for (value, expected) in [
            ("es", LanguagePreference::Es),
            ("ja", LanguagePreference::Ja),
        ] {
            let mut payload = serde_json::json!({
                "language": "zh-CN",
                "appearance": "dark",
                "hasDocument": true,
                "forcedReadOnly": false,
                "toolLock": true,
                "grid": false,
                "snap": true,
                "zen": false,
                "viewMode": false
            });
            payload["language"] = serde_json::Value::String(value.to_owned());
            let parsed: NativeMenuSyncState = serde_json::from_value(payload)
                .unwrap_or_else(|error| panic!("parse {value} sync state: {error}"));
            assert_eq!(parsed.language, expected);
        }
        assert_eq!(state.appearance, AppearancePreference::Dark);
        assert!(state.tool_lock && state.snap);
        assert!(
            serde_json::from_value::<NativeMenuSyncState>(serde_json::json!({
                "language": "fr"
            }))
            .is_err()
        );
    }

    #[test]
    fn derives_enabled_and_checked_for_every_document_state() {
        let preferences = [GRID_MENU_ID, ZEN_MENU_ID];
        let editable_only = [TOOL_LOCK_MENU_ID, SNAP_MENU_ID, VIEW_MODE_MENU_ID];
        for has_document in [false, true] {
            for forced_read_only in [false, true] {
                for on in [false, true] {
                    let state = NativeMenuSyncState {
                        has_document,
                        forced_read_only,
                        tool_lock: on,
                        grid: on,
                        snap: on,
                        zen: on,
                        view_mode: on,
                        ..NativeMenuSyncState::default()
                    };
                    let get = |id| {
                        item_state(id, &state, false, true)
                            .unwrap_or_else(|| panic!("{id} has no derived state"))
                    };
                    let context = format!("doc={has_document} forced={forced_read_only} on={on}");
                    assert_eq!(get(SAVE_MENU_ID).enabled, has_document, "{context}");
                    assert_eq!(get(HELP_MENU_ID).enabled, has_document, "{context}");
                    assert!(get(EXPORT_IMAGE_MENU_ID).enabled, "{context}");
                    for id in preferences {
                        assert_eq!(get(id).enabled, has_document, "{id} {context}");
                        assert_eq!(get(id).checked, Some(on), "{id} {context}");
                    }
                    for id in editable_only {
                        assert_eq!(
                            get(id).enabled,
                            has_document && !forced_read_only,
                            "{id} {context}"
                        );
                    }
                    assert_eq!(get(TOOL_LOCK_MENU_ID).checked, Some(on), "{context}");
                    assert_eq!(get(SNAP_MENU_ID).checked, Some(on), "{context}");
                    assert_eq!(
                        get(VIEW_MODE_MENU_ID).checked,
                        Some(forced_read_only || on),
                        "{context}"
                    );
                }
            }
        }
    }

    #[test]
    fn checks_exactly_the_current_language_and_appearance() {
        let state = NativeMenuSyncState {
            language: LanguagePreference::En,
            appearance: AppearancePreference::Light,
            ..NativeMenuSyncState::default()
        };
        let checked = |id| item_state(id, &state, false, true).and_then(|item| item.checked);
        assert_eq!(checked(LANGUAGE_SYSTEM_MENU_ID), Some(false));
        assert_eq!(checked(LANGUAGE_EN_MENU_ID), Some(true));
        assert_eq!(checked(LANGUAGE_ZH_CN_MENU_ID), Some(false));
        assert_eq!(checked(LANGUAGE_ES_MENU_ID), Some(false));
        assert_eq!(checked(LANGUAGE_JA_MENU_ID), Some(false));
        assert_eq!(checked(APPEARANCE_SYSTEM_MENU_ID), Some(false));
        assert_eq!(checked(APPEARANCE_LIGHT_MENU_ID), Some(true));
        assert_eq!(checked(APPEARANCE_DARK_MENU_ID), Some(false));
        assert_eq!(
            item_state(VERSION_HISTORY_MENU_ID, &state, true, true).map(|item| item.enabled),
            Some(true)
        );
        assert_eq!(item_state("native-menu.file", &state, false, true), None);
    }
}
