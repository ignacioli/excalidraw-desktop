[English](README.md) | [简体中文](README.zh.md)

# Excalidraw Desktop

A local-first Excalidraw desktop app for macOS. Drawings are ordinary `.excalidraw` files on disk. There is no account, cloud sync, or collaboration.

The canvas is the official [`@excalidraw/excalidraw`](https://www.npmjs.com/package/@excalidraw/excalidraw) package, not a fork. What this project adds is how that canvas meets the filesystem: frequent edits, crashes, Finder, and other programs that touch the same files.

## Why it exists

Open-source Excalidraw desktops are easy to ship as a thin window around the editor. A common pattern is to overwrite the whole drawing in place on a timer (on the order of tens of seconds). That is a small program. It also means a crash can lose that whole interval, and a kill in the middle of a write can leave truncated JSON.

This app is built for a different contract.

**Draw without beating the disk.** Excalidraw can emit changes at 60 fps. Those updates stay in memory. After about 300 ms of quiet, a private draft is written. The `.excalidraw` file is not rewritten on every stroke or on a 30-second clock. On Apple Silicon, a 10,000-element scene still pans and edits at about 60 fps.

**Don't lose the file, or the last few seconds.** Drafts and a few rotating snapshots live in the app data directory. They are not `.excalidraw` files. After a crash, force-quit, or power loss they restore work that had not yet landed in the drawing. When the drawing *is* written, the app writes a temp file, checks that the JSON is complete, then `rename`s it into place.

**Keep a file you can take elsewhere.** The document you copy, put in git, or open on [excalidraw.com](https://excalidraw.com/) is still standard `.excalidraw`. Fonts and editor assets are bundled, including a Virgil + Xiaolai CJK hand-drawn font, so the app does not fetch scripts or typefaces from the network.

What this is **not**: a lightweight process. A WKWebView running Excalidraw uses hundreds of megabytes. Idle memory here sits between an empty Tauri window and Safari opening the same canvas. The work that paid off is coalesced writes and a usable 10k canvas, not a 50 MB RAM headline.

## How saving works

- **While you draw:** memory first, then a private draft after ~300 ms of quiet.
- **If the app dies:** restore from those drafts and snapshots.
- **The `.excalidraw` file:** written on idle, tab switch, save, or quit, only through temp + validate + `rename`.

## Compared with a timer-save shell

| | Overwrite on a clock | This app |
| --- | --- | --- |
| While drawing | Whole file, in place, every few tens of seconds | Memory → coalesced draft; `.excalidraw` stays still |
| Crash or power loss | That whole interval can be lost; the file can be truncated | Drafts + snapshots; destination file is complete old or complete new |
| External edit (git, iCloud, another editor) | Often ignored | Reload, or a conflict dialog — never a silent overwrite |
| Folders | Typically one tree | Several workspaces, with lazy thumbnails |

## What it can do

- Create, edit, and save drawings locally, fully offline, including Chinese hand-drawn text
- Recover work after a crash, force-quit, or power loss
- Browse drawings in a workspace sidebar; mount more than one workspace
- Detect external file changes and resolve conflicts
- Export PNG or SVG (SVG keeps the bundled font)
- Open `.excalidraw` from Finder; reuse one app instance for more files
- Deduplicate repeated images inside a drawing so the file does not grow with every paste

## Platforms

- **macOS 12+** (Apple Silicon and Intel) is the supported release platform.
- **Ubuntu 24.04 Desktop** is optional community / best-effort validation. Fedora and other Linux distributions are not supported in this version.
- **Windows** is not supported.

## Install from GitHub Releases

Download installers from this repository's GitHub Releases. The intended repository path is [ignacioli/excalidraw-desktop](https://github.com/ignacioli/excalidraw-desktop).

macOS builds are **unsigned and unnotarized** `.dmg` files. There is no App Store listing, Developer ID signature, or Apple notarization.

Linux **AppImage**, **deb**, and **rpm** files may also appear on the Releases page as **best-effort binaries**. That does not mean Linux is verified or supported in this version.

### macOS and Gatekeeper

Because the macOS package has no Developer ID signature or Apple notarization, macOS cannot verify the developer identity and cannot use an Apple notarization ticket to confirm the binary was not tampered with. Gatekeeper may block the first launch. Download only from this repository's GitHub Releases, and allow the app yourself after you understand that risk:

1. Drag the app into Applications, then try to open it once.
2. If it is blocked, open **System Settings → Privacy & Security**, and choose **Open Anyway** for the app in the Security section.
3. Confirm Open Anyway. You perform this override; the project does not ask you to turn Gatekeeper off.

## Build from source

### Prerequisites

- Node.js 20+
- pnpm (the repo declares `packageManager: pnpm@11.20.0`)
- Rust stable 1.80+
- macOS: Xcode Command Line Tools
- Linux: WebKitGTK system dependencies (only if you choose to build there)
- Python 3.10+ and uv (font build only, via `pnpm fonts:build`; the interpreter is pinned to 3.14 by `.python-version`; dependencies are managed with `pyproject.toml` + `uv.lock`; `uv run` creates `.venv`)

### Develop and package

```sh
pnpm install
pnpm dev            # Vite development server
pnpm fonts:build    # bundled CJK hand-drawn font (uv manages fonttools/brotli; output in public/fonts/)
pnpm tauri dev      # Tauri development app
pnpm tauri build    # current Tauri bundle
```

### Quality gates

```sh
pnpm lint                                            # frontend ESLint
pnpm typecheck                                       # strict TypeScript check
pnpm test                                            # Vitest unit tests
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
APP_E2E=1 pnpm e2e                                   # Playwright E2E
```

`APP_E2E=1 pnpm e2e` covers browser-visible flows. Native-shell and fault-injection cases need the test-only Tauri build described by the E2E fixture.

## Documentation

- [DESIGN.md](DESIGN.md) / [DESIGN.zh.md](DESIGN.zh.md) — visual and interaction contract
- [docs/architecture.md](docs/architecture.md) — architecture overview
- [docs/contracts/ipc-contracts.md](docs/contracts/ipc-contracts.md) — IPC contract
- [docs/adr/](docs/adr/) — architecture decision records
- [docs/quickstart.md](docs/quickstart.md) — contributor validation guide (not an end-user manual)
- [AGENTS.md](AGENTS.md) / [AGENTS.zh.md](AGENTS.zh.md) — constraints, commands, and contribution rules for contributors and maintainers

## License

This project is licensed under the [MIT License](LICENSE).

The bundled CJK hand-drawn font is generated from Virgil and Xiaolai, which remain under the SIL Open Font License. See [public/fonts/README.md](public/fonts/README.md).

## Contributing

Read [AGENTS.md](AGENTS.md) before changing the project. When you change behavior or contracts, update the related design, contract, and validation docs.
