# Changelog

User-visible changes to Excalidraw Desktop, newest first. Ordinary feature work does not edit this file; append a section only in the version-bump pull request that ships a release.

GitHub Release notes for a tag are this section plus the Gatekeeper footer in [`docs/release-notes-footer.md`](docs/release-notes-footer.md).

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

[0.2.0]: https://github.com/ignacioli/excalidraw-desktop/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/ignacioli/excalidraw-desktop/releases/tag/v0.1.1
