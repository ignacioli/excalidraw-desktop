[English](README.md) | [简体中文](README.zh.md)

# Excalidraw Desktop

A macOS-first desktop home for the official Excalidraw canvas. Draw offline and keep your work as ordinary `.excalidraw` files on disk—without an account, cloud sync, or collaboration service in the middle.

The editor is the official [@excalidraw/excalidraw](https://www.npmjs.com/package/@excalidraw/excalidraw) package, not a fork. Excalidraw Desktop adds a dependable local file workflow around that canvas: workspace browsing, safe saving, recovery after interruption, and clear handling when another program changes a file.

## Draw with confidence

Your drawing remains portable. Open it in Excalidraw Desktop, copy it into git, or take it to [excalidraw.com](https://excalidraw.com/); the document format remains standard `.excalidraw`. Bundled editor assets include Virgil and Xiaolai CJK hand-drawn fonts, so the app does not need to fetch scripts or typefaces from the network.

The local persistence workflow is designed around the moments that matter:

- **While you draw:** edits stay responsive in the canvas and are coalesced into private draft data instead of rewriting the document on every stroke.
- **When the app is interrupted:** recovery snapshots can restore edits that had not yet reached the drawing file after a crash, force-quit, or power loss.
- **When the drawing is saved:** the destination is validated before the new file replaces the old one, so an interrupted write does not leave a half-written `.excalidraw` file.
- **When another program edits the file:** clean documents can reload; documents with local edits show a conflict choice instead of silently overwriting either version.
- **When you need an earlier state:** local Version History keeps automatic, manual, and before-operation versions with a persistent document identity. Rename keeps that identity, Save As starts a separate history, and deleting a history entry leaves the current drawing unchanged.

## A canvas-first desktop workflow

The Welcome screen gives you **New Drawing**, **Open Workspace**, and **Recent Workspaces**. Recent entries can be reopened when their folder is available, or removed from the app's history without deleting anything from disk.

Each window holds one workspace, and its **Current Workspace** is the single tree shown in that window's sidebar. **File > New Window** (⇧⌘N) opens another window, so different workspaces can be open side by side. Opening a workspace that is already open in another window brings that window to the front instead of opening it twice, and so does opening a folder inside it (the folder is revealed in that window's sidebar). Opening a folder that contains a workspace open elsewhere asks whether to close that window and open the folder here. A drawing can be open in only one window at a time; opening it again, from the sidebar or from Finder, switches to the window that has it. Other workspace records stay available through Welcome and Recent rather than stacking multiple roots into one sidebar. Each window remembers where its workspace was last shown, including size, position, and maximized or full-screen state, and moves back onto a connected display if its old position is no longer reachable. After a normal quit, the next launch reopens the windows, workspaces, and tabs you had. A window with a workspace but no open drawing shows an empty canvas with a hint, **New Drawing**, and **Show Sidebar**. Each workspace remembers its own sidebar pin, width, and expansion; appearance and language apply to every window. Right-click a drawing or folder in the sidebar, or a tab, to **Copy Path** or **Copy Relative Path** (relative to the workspace root). The workspace root offers Copy Path only. Open drawings appear as tabs above the official canvas, and the sidebar starts hidden so the canvas has the room. Open it as an overlay when you need it, or pin it into the layout for longer browsing; **Back** returns to the previous browsing location without closing open drawings.

## What it can do

- Create, edit, and save local drawings fully offline
- Recover unsaved work after an interrupted session
- Browse folders and drawings from one continuous Current Workspace tree
- Open multiple drawings in tabs and reuse the running app when opening files from Finder
- Work in several windows at once, one workspace per window, with window positions remembered per workspace
- Copy a drawing's or folder's path, or its path relative to the workspace, from the sidebar and tabs
- Detect external file changes and resolve conflicts explicitly
- Keep local Version History for automatic checkpoints, manual marks, and protected restore/clear/import operations
- Export drawings as PNG or SVG, with the bundled font embedded in SVG output
- Deduplicate repeated in-drawing images so repeated pastes do not multiply the stored asset data
- Use the interface in English, Simplified Chinese, Spanish, or Japanese, and adjust common canvas preferences from the canvas main menu or the native menu bar

## Language, preferences, and menus

**Interface language.** The app is available in English, Simplified Chinese (简体中文), Spanish (Español), and Japanese (日本語). On first launch it follows the macOS preferred-language list and falls back to English when none of those languages is supported. Change it at any time from the **Language** submenu in the app menu or the **Language** item in the canvas main menu (Follow system, English, 简体中文, Español, 日本語). The choice applies immediately to the app, the canvas editor, and the native menus, and is remembered across restarts. A change to the macOS preferred languages takes effect at the next launch. System-owned dialogs, such as open and save panels, follow macOS. The Spanish and Japanese text is an AI translation that has had an independent AI review. Corrections from native speakers are welcome.

**Canvas preferences.** The canvas main menu has a **Preferences** group with Tool lock, Toggle grid, Snap to objects, Zen mode, and View mode, plus the Language item and the Theme control. The native **View** menu offers the same toggles together with an **Appearance** submenu (System, Light, Dark). Both write the same app preference. When a drawing is forced read-only, Tool lock, Snap to objects, and View mode are unavailable.

**Theme shortcut.** Press `Shift+Option+D` to switch the theme from the keyboard.

**Native menu bar.** The macOS menu bar provides the App, File, Edit, View, Window, and Help menus, and its labels follow the interface language. File contains New Window, Open Workspace, Save, Export Image, and Version History; Save is `Cmd+S` and Export Image is `Cmd+Option+E`.

## Platforms

- **macOS 12+** (Apple Silicon and Intel) is the supported release platform.
- **Ubuntu 24.04 Desktop** is optional community / best-effort validation. Fedora and other Linux distributions are not supported in this version.
- **Windows** is not supported.

## Install from GitHub Releases

Download installers from this repository's [GitHub Releases](https://github.com/ignacioli/excalidraw-desktop/releases).

macOS builds are **unsigned and unnotarized** `.dmg` files. There is no App Store listing, Developer ID signature, or Apple notarization. Linux **AppImage**, **deb**, and **rpm** files may also appear as **best-effort binaries**; their presence does not make Linux a supported platform.

### macOS and Gatekeeper

Because the macOS package has no Developer ID signature or Apple notarization, macOS cannot verify the developer identity or use an Apple notarization ticket to confirm the binary. Gatekeeper may block the first launch. Download only from this repository's GitHub Releases, and allow the app yourself after you understand that risk:

1. Drag the app into Applications, then try to open it once.
2. If it is blocked, open **System Settings → Privacy & Security**, and choose **Open Anyway** for the app in the Security section.
3. Confirm Open Anyway. You perform this override; the project does not ask you to turn Gatekeeper off.

## Learn more

- [DESIGN.md](DESIGN.md) / [DESIGN.zh.md](DESIGN.zh.md) — visual and interaction contract
- [docs/architecture.md](docs/architecture.md) / [docs/architecture.zh.md](docs/architecture.zh.md) — architecture overview
- [docs/contracts/ipc-contracts.md](docs/contracts/ipc-contracts.md) — IPC contract
- [docs/adr/](docs/adr/) — architecture decision records
- [docs/quickstart.md](docs/quickstart.md) / [docs/quickstart.zh.md](docs/quickstart.zh.md) — contributor setup and verification
- [CHANGELOG.md](CHANGELOG.md) — user-visible release notes
- [AGENTS.md](AGENTS.md) / [AGENTS.zh.md](AGENTS.zh.md) — contributor and maintainer rules, workflows, and commands

## License

This project is licensed under the [MIT License](LICENSE).

The bundled CJK hand-drawn font is generated from Virgil and Xiaolai, which remain under the SIL Open Font License. See [public/fonts/README.md](public/fonts/README.md).

For contribution guidance, start with [AGENTS.md](AGENTS.md) (or [AGENTS.zh.md](AGENTS.zh.md)).
