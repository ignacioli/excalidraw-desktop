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

## A canvas-first desktop workflow

The Welcome screen gives you **New Drawing**, **Open Workspace**, and **Recent Workspaces**. Recent entries can be reopened when their folder is available, or removed from the app's history without deleting anything from disk.

Inside a workspace, **Current Workspace** is the single tree shown in the sidebar. Other workspace records stay available through Welcome and Recent rather than stacking multiple roots into one sidebar. Open drawings appear as tabs above the official canvas, and the sidebar starts hidden so the canvas has the room. Open it as an overlay when you need it, or pin it into the layout for longer browsing; **Back** returns to the previous browsing location without closing open drawings.

## What it can do

- Create, edit, and save local drawings fully offline
- Recover unsaved work after an interrupted session
- Browse folders and drawings from one continuous Current Workspace tree
- Open multiple drawings in tabs and reuse the running app when opening files from Finder
- Detect external file changes and resolve conflicts explicitly
- Export drawings as PNG or SVG, with the bundled font embedded in SVG output
- Deduplicate repeated in-drawing images so repeated pastes do not multiply the stored asset data

The desktop shell UI is English in this release. The Chinese README is a documentation translation; it does not indicate a localized application interface.

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
