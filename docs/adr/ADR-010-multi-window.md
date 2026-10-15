# ADR-010 Multi-window: Rust owns Workspace ownership, focused-window routing, coordinated quit, per-Workspace placement

**Status**: Accepted

**Date**: 2026-10-14

## Context

The application used to be a single window with one Current Workspace. Several parts of the backend assumed that: `workspace_list` returned every mounted Workspace, events were broadcast to the one window, `doc_open` did not record who held a drawing, and the window was declared in `tauri.conf.json`.

Opening more than one window breaks those assumptions in ways that threaten the ADR-002 persistence contract:

- Drafts, recovery snapshots, conflict state, and history leases are keyed by drawing path. Two windows editing the same path would race on them, and `doc_close` in one window would delete the draft the other still needs.
- A Workspace watched or indexed by two windows would produce duplicate events and duplicate work.
- Native menu commands, backend events, and quit must reach the right window, and only that window.
- Closing a window must keep ADR-002's guarantee: the window checkpoints its drawings first and stays open if that fails.

This decision does not change the ADR-002 write pipeline, draft window, or recovery snapshots, and it keeps the ADR-009 window chrome (ordinary decorated window, system title bar, never always-on-top).

## Decision

### 1. Rust is the single authority for window, Workspace, and drawing ownership

- A process-wide `WindowRegistry` (`src-tauri/src/window/registry.rs`) records, per window label, the Workspace it holds and the canonical paths of the drawings it has open. Two indexes (`workspace_owner`, `document_owner`) are updated in the same critical section as the window record. One lock serializes every change, so two windows that claim the same Workspace at the same moment get exactly one `Claimed`.
- At most one window holds a Workspace, and at most one window holds a drawing. A drawing inside another window's Workspace counts as held by that window.
- Claiming a Workspace (`window_claim_workspace`, shared by the restore path through `claim_for_window`) decides in this order, ignoring the calling window's own current Workspace because the claim replaces it:
  1. The same Workspace (same id or same canonical root) is held by another window: `ownedBy`.
  2. The candidate folder lies inside another window's Workspace: `insideOpen`, with the relative path.
  3. The candidate folder contains another window's Workspace: `containsOpen`.
  4. Otherwise `claimed`, which also releases the caller's previous Workspace.
- For `ownedBy` and `insideOpen` the backend activates the owning window (`insideOpen` also sends it `workspace-reveal-entry`). For `containsOpen` the frontend asks the user; "close it and open here" goes through `window_close_other_and_claim`, which re-checks that the target window still holds a Workspace inside the folder before it asks that window to close.
- `window_probe_workspace` runs the same decision without changing anything, so the frontend can ask before it closes the caller's tabs.
- `workspaces.mounted` now means "open in a window". The registry commit and the `mounted` write happen together; a failed write rolls the claim back. At startup every row is set to unmounted, except after an abnormal exit, when the previous rows stay until Recovery finishes because Recovery needs them as authorization roots. A watcher runs only for a claimed Workspace.
- Windows are created only in Rust (`create_window`) with labels `window-<n>`. `tauri.conf.json` declares no window, the capability applies to `window-*`, and the frontend gets no window-creation permission. Each window learns its Workspace, restored tabs, and Recovery role from `app_handshake`, never from the URL.
- Ownership is runtime state and is not persisted. What persists across launches is the Window Session (decision 3).

### 2. Events and native-menu commands go to one window

- Workspace events (`workspace-entries-changed`, `index-progress`) go to the window that holds the Workspace. Document events (`file-changed`, `conflict-detected`, `draft-saved`, `history-issue`) go to the window that holds the drawing. An event with no owner is dropped. Nothing is broadcast except `open-workspaces-changed` and `app-quit-cancelled`; `app-preferences-changed` goes to every window except the sender.
- The backend uses `emit_to(label, ...)`. Tauri delivers such an event to listeners whose target is `Any` as well, so the frontend registers every listener with `{ kind: "WebviewWindow", label }` (`src/ipc/events.ts`).
- Drawings handed to the running app (Finder, a second launch, launch arguments) are routed by `window/router.rs`: the window that already has the drawing, else the window whose Workspace contains it, else the most recently focused window, else a new window. A drawing already open elsewhere is shown there through `window-activate-document` instead of being opened again. A window that has not read its startup data yet receives its paths through the handshake.
- `native-menu-command` goes to the focused window, or to the most recently focused window when none is focused. Menu state (checked and enabled flags) is stored per window and applied when a window gains focus. New Window and Quit are handled in Rust and never reach a window as `native-menu-command`.
- Appearance and language are app-wide. The window that changes them calls `app_preferences_broadcast`; the others apply the change without writing it back.

### 3. Close, quit, and Window Session

- **Closing one window** keeps the existing path: the window checkpoints every drawing, then destroys itself (`core:window:allow-destroy`). If the checkpoint fails the window stays open. When the window is destroyed, Rust releases its Workspace and drawings, stops the watcher, and rewrites the Window Session. Closing the last window on macOS does not exit the app; the Dock icon opens a Welcome window again.
- **Quit** (Cmd+Q) is an application-owned menu item, not the system predefined one. `QuitCoordinator` (`window/quit.rs`) sends `app-quit-requested { requestId }` to every window. Each window checkpoints and calls `app_quit_ready`. When all windows answer `ok`, Rust writes the Window Session, freezes further session writes, and exits. If any window answers `ok: false`, or does not answer within 10 seconds, the quit is cancelled: the failing window comes to the front and every window gets `app-quit-cancelled`. A second Cmd+Q while one is collecting reuses the request.
- **Terminations Rust cannot intercept** (Dock menu Quit, logout) still run the `RunEvent::Exit` handler, which flushes pending placement and writes the Window Session on a best-effort basis. Draft and recovery guarantees are the same as before.
- **Window Session** is a snapshot in SQLite: per window, its Workspace and its tab paths with the active tab. Each write replaces the whole table in one transaction. Windows report tabs through `window_session_update`; writes are coalesced for 500 ms. Welcome windows with no tabs are not stored. At launch Rust recreates the stored windows, claiming each Workspace before the window is shown. A Workspace that cannot be reopened leaves its window on Welcome with an explanation, and missing files are skipped and counted.
- After an abnormal exit only one Recovery window opens. The session is held, not overwritten, until that window calls `startup_recovery_done`; then the stored windows are recreated and the Recovery window closes if it is left empty.

### 4. Window placement is remembered per Workspace

- Each Workspace stores the normal-state bounds of its window in logical pixels, plus maximized and full-screen flags. A maximized or full-screen window keeps its previous normal bounds, so leaving that state returns to them.
- Placement is observed from window move and resize events, coalesced for 500 ms, and written off the editing path. A claim applies the remembered placement; a Workspace without one records where its window is now.
- Restoring checks the saved bounds against the connected displays' work areas. A window whose title bar would not be reachable moves to the primary display, centered, and is shrunk if it is larger than that display. The size never drops below 960 by 640.
- A window with no remembered placement is 90 percent of the work area, capped at 1680 by 1050, centered. A new window is offset 28 logical pixels from the front window.
- Sidebar pin, width, and expanded folders are also stored per Workspace (`workspace_shell_state_save`).

## Consequences

**Positive**

- One place decides ownership, so the ADR-002 rule "one owner per draft and checkpoint" holds with several windows, and the check is atomic.
- Event routing is deterministic. A window never reacts to another window's file change, conflict, or menu command.
- A quit that cannot checkpoint every window is cancelled rather than losing edits, and the window that failed is shown to the user.
- The next launch can restore the windows, tabs, and positions of a normal quit.
- The frontend holds no ownership rules to keep in sync with Rust.

**Negative**

- Every event emitted from Rust must pick a target. A new event without a target decision would be dropped or sent to everyone by mistake.
- Frontend listeners must always use the window target. A plain listener hears other windows' events.
- The IPC contract grows to version 5, with new commands, events, and error codes (`WORKSPACE_NOT_OWNED`, `DOCUMENT_NOT_OWNED`, `WINDOW_OWNERSHIP_CHANGED`, `QUIT_CHECKPOINT_FAILED`). `workspace_add` and `workspace_remount` stay only as deprecated.
- The ownership and routing logic needs real windows. Registry, router, quit, session, and geometry rules have Rust unit tests, but focus, Window menu, Dock, Finder, and multi-display behavior need native macOS evidence.
- A forced termination can lose the newest Window Session. Drafts and recovery snapshots are unaffected.
- The window title is no longer a fixed string; the frontend sets it from the Workspace and the active drawing. This replaces the single configured title mentioned in ADR-009.

## Alternatives

- **Let the windows negotiate ownership through frontend events.** Not atomic: two windows can both believe they claimed a Workspace. Rejected.
- **Persist ownership in SQLite.** Ownership describes live windows and is meaningless after a crash; persisting it adds cleanup. The Window Session covers what a restart needs. Rejected.
- **Keep broadcasting events and filter by focus in the frontend.** A window losing focus at the wrong moment could handle a menu command twice or not at all. Rejected.
- **Allow the same Workspace in two windows.** Duplicates watchers and indexing and breaks single ownership of drafts. Rejected.
- **Allow nested Workspaces in different windows.** A drawing would be reachable through two Workspaces, so a single owner per path could not be shown clearly. Rejected; the user can close the inner window and open the outer folder instead.
- **Keep the system predefined Quit item.** It exits without asking the windows to checkpoint. Rejected.
- **Use `tauri-plugin-window-state`.** It keys by label, so dynamic labels are never cleaned up, writes only at exit, stores physical pixels, and does not cover tabs or sidebar state. Rejected.
- **Store the Window Session in a JSON file.** It would need its own atomic write and locking, which SQLite already provides. Rejected.
- **Create windows from the frontend.** Needs `core:webview:allow-create-webview-window` and widens the frontend's permissions. Rejected.
- **Keep the first window in `tauri.conf.json`.** Needs a second creation path and cannot size the first window from the display or the Window Session. Rejected.
