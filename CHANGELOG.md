# Changelog

User-visible changes to Excalidraw Desktop, newest first.

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

[0.3.0]: https://github.com/ignacioli/excalidraw-desktop/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ignacioli/excalidraw-desktop/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/ignacioli/excalidraw-desktop/releases/tag/v0.1.1
