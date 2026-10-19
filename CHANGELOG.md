# Changelog

User-visible changes to Excalidraw Desktop, newest first.

## [0.7.0] - 2026-10-19

### Added

- Spanish (Español) and Japanese (日本語) interface. First launch follows the macOS preferred languages and falls back to English. The Language choice (Follow system, English, 简体中文, Español, 日本語) is available from the app menu and the canvas main menu, applies immediately to the app, the canvas editor, and the native menus, and is remembered across restarts.

### Fixed

- `?` opens the canvas help dialog when focus has left the editor, including from the page and the Workspace Sidebar. It still does not fire from a text field or while a dialog or menu is open.

## [0.6.0] - 2026-10-15

### Added

- Multiple windows, one Workspace each. File > New Window opens a Welcome window. Opening a Workspace that is already open in another window brings that window forward, including when it is minimized or on another desktop space, instead of opening it twice.
- Opening a folder inside an open Workspace reveals it in that Workspace's window; opening a folder that contains an open Workspace asks whether to switch to that window or close it and open here.
- Drawings opened from Finder go to the window whose Workspace holds them; a drawing in no Workspace opens in the most recent window, and a drawing already open is brought forward on its tab.
- Quitting with unsaved edits in several windows exits promptly, and relaunching restores each window with its Workspace, tabs, active tab, size and position. Closing every window keeps the app running; clicking the Dock icon opens Welcome. The Window menu lists every open window.
- A Workspace window with no open drawing shows an empty state with New Drawing and Show Sidebar. Its New Drawing creates `Untitled` in the folder selected in the sidebar, or at the Workspace root, and the sidebar shows it at once.
- Copy Path and Copy Relative Path for drawings and folders, from the sidebar and from tabs.

### Changed

- Welcome's New Drawing asks for a folder, opens it as a Workspace and saves the drawing there as a real `.excalidraw` file, so it is protected by drafts, recovery and version history from the start.
- New windows open at a size that suits the screen.
- Naming, delete, folder-not-empty, remove-Workspace and nested-folder dialogs share one layout, with the name field's `.excalidraw` suffix shown inside the field.
- Appearance and language changes apply to every open window at once.

### Fixed

- A drawing whose file was moved to the Trash and then saved back to its own path can be closed again.

## [0.5.0] - 2026-10-11

### Added

- English and Simplified Chinese (简体中文) interface. First launch follows the macOS preferred languages and falls back to English; the Language choice (Follow system, English, 简体中文) is available from the app menu and the canvas main menu, applies immediately to the app, canvas editor, and native menus, and is remembered across restarts.
- A Preferences group in the canvas main menu with Tool lock, Toggle grid, Snap to objects, Zen mode, and View mode, mirrored by the native View menu and its Appearance submenu.
- A full macOS menu bar (App, File, Edit, View, Window, Help) whose labels follow the interface language; File provides Save, Export Image, and Version History.
- `Shift+Option+D` switches the theme from the keyboard.
- Close All in the tab context menu, and hovering a workspace tree row shows the item's full path.

### Changed

- Workspace and tab context menus and the version history row menu now share the canvas editor's dropdown menu style, with destructive actions separated at the end.
- The unpinned (overlay) sidebar no longer casts a shadow.

## [0.4.0] - 2026-10-05

### Added

- Local Version History for automatic checkpoints, manual marks, and protected restore, clear, and import operations.
- A resizable history drawer with read-only previews, explicit restore confirmation, and per-version Mark, Unmark, and Delete actions.
- Persistent document history across renames, with separate history for Save As copies and explicit feedback when a stored version is unavailable.

### Fixed

- Repeatedly marking unchanged content reuses its existing marked version and shows feedback on that row.
- History selection, scrolling, and keyboard focus remain stable during marking and preview/confirmation flows.

### Known limitations

- Physical large-drawing benchmarks showed increased memory use and editing latency; startup and sustained-editing memory-growth targets were also exceeded. These diagnostic results remain under investigation and are not reported as passing performance budgets.

## [0.3.0] - 2026-09-16

### Added

- A Welcome screen for creating a drawing, opening a workspace, and returning to recent workspaces. Removing an item from Recents clears only app history, not files on disk.

### Changed

- The sidebar now shows one Current Workspace tree at a time; other workspaces remain accessible through Welcome and Recent Workspaces.
- Refined workspace navigation with a consistent custom icon set for Sidebar, Back, Collapse/Expand All, and Refresh, alongside compact actions and a resizable pinned sidebar.
- Native application menus provide Save, Export Image, and System, Light, or Dark appearance choices.
- Added a custom app icon and changed the name shown in the macOS Dock and application menus to Excalidraw.

### Fixed

- Fixed the macOS window close button so pending work is checkpointed before the window closes.

## [0.2.0] - 2026-08-25

Canvas-first desktop shell. Implemented in [#1](https://github.com/ignacioli/excalidraw-desktop/pull/1).

### Added

- Workspace sidebar starts hidden, opens as an overlay over the canvas, and can be pinned into the layout.
- One continuous virtualized tree for several workspaces on a single scroll surface.

### Changed

- The window title is `Excalidraw Whiteboard`. The title bar stays under system control and is not tinted by the canvas theme.
- Naming, delete confirmation, and blockers use in-app dialogs instead of the WebView `prompt` / `confirm`.
- Production listing no longer shows canvas-content thumbnails.

### Fixed

- Keyboard use of the workspace tree, overlay sidebar, menus, and dialogs.

## [0.1.1] - 2026-08-18

### Added

- GitHub Releases for unsigned, unnotarized macOS universal `.dmg` and best-effort Linux AppImage, deb, and rpm.

[0.4.0]: https://github.com/ignacioli/excalidraw-desktop/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ignacioli/excalidraw-desktop/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ignacioli/excalidraw-desktop/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/ignacioli/excalidraw-desktop/releases/tag/v0.1.1
