# Multi-window checkpoints

Execution record for the multi-window work: one window per Workspace, window
lifecycle and restore, default window size, the empty Workspace state, sidebar
dialogs, and copying paths.

Each section records the candidate commit, the commands that ran, the result
(PASS, FAIL, or BLOCKED), and the gaps that the run did not cover. Automated
results and product-owner conclusions are recorded separately; neither stands
in for the other. Screenshots are not used as evidence for structural facts
such as window counts, titles, menu items, routing, or filesystem outcomes.

## Foundation

Window ownership authority, runtime window creation, the per-window startup
handshake, the window session schema, and the shared dialog and feedback
components. Behavior with a single window must not regress.

- Candidate: the commit that adds this section (parent `ad385a8`), on macOS
  (Darwin 25.6.0), 2026-10-14.
- Result: PASS, with one intermittent browser failure recorded below.

| Command                                                                                                    | Result                                   |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check`                                                   | PASS                                     |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`                           | PASS                                     |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features e2e-harness -- -D warnings`    | PASS                                     |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib window::` (registry, geometry, session)             | PASS, 31 tests                           |
| `pnpm typecheck`                                                                                           | PASS                                     |
| `pnpm lint`                                                                                                | PASS, 0 warnings                         |
| `pnpm test` (whole Vitest suite, including startup route, launch files, Recovery, dialog, and toast tests) | PASS, 76 files / 613 tests               |
| `APP_E2E=1 pnpm e2e`, first run                                                                            | FAIL, 160 passed / 1 failed / 80 skipped |
| `APP_E2E=1 pnpm e2e e2e/tests/us5-export-fidelity.spec.ts`                                                 | PASS, 2 passed                           |
| `APP_E2E=1 pnpm e2e`, second run                                                                           | PASS, 161 passed / 80 skipped            |

What the checks cover:

- Ownership registry: at most one window per Workspace and one owner window
  per drawing; nested, equal, symlinked, differently cased, and `..` roots are
  detected through the same canonical path rule; 16 concurrent claims of one
  Workspace produce exactly one owner; failed persistence rolls a claim back.
- Window geometry: 90% of the work area within the 960×640 minimum and the
  1680×1050 maximum, centered; 28-point stagger that restarts at the work
  area's top-left; remembered bounds that are no longer grabbable move to the
  primary display. Retina (2×) and 1.5× work areas convert to logical points.
- Window session: snapshot replace and list, empty Welcome windows are not
  stored, restore never opens one Workspace or drawing twice.
- Startup handshake: contract version 5; launch files and restore data are
  handed out once per window; only the Recovery window reports an abnormal
  exit; the frontend makes one handshake call per window and shares it among
  system languages, Recovery, and launch files; a failed call is retried.
- Window chrome contract: no windows in `tauri.conf.json`; the capability
  covers `window-*`; the static chrome checks read the shared chrome value
  that the window builder uses.
- Shared sidebar dialog anatomy: the optional sidebar variant renders title,
  description, object path, fields, dialog error, and action row in that
  order; the name field has its label above, a fixed suffix in the same box,
  and an error below that keeps the input; button kinds are secondary,
  primary, danger, and link; the default dialog layout used by History,
  Recovery, Conflict, Export, and other dialogs is unchanged.
- Feedback toast: at most one toast; a new toast replaces the current one and
  restarts its timer; success uses a polite status for about 2 seconds, the
  reveal hint 3 seconds, and failure an alert for 6 seconds with a dismiss
  button.

Gaps and open items:

- The first full browser run failed once in the PNG export fidelity test: the
  export dialog did not appear within 15 seconds after the export menu event,
  and the page showed "The requested file operation could not be completed."
  The isolated rerun and the second full run passed. The cause was not
  determined; watch this test in later checkpoints.
- The live native window check in `native-window-contract.spec.ts` needs the
  test-only native build and was skipped; only its static checks ran. No
  native window, menu, or packaging behavior is claimed for this checkpoint.
- After an abnormal exit, the previous Workspaces stay recorded as open so
  Recovery can still write drafts back to their original files. Until the
  Recovery completion step lands, such a Workspace is selected without a
  window claim and has no file watcher.
- The frontend still reopens the last Workspace through the remount command
  until the per-Workspace shell state and the restore order land.
- No component is used by a screen yet; the visual comparison with the
  approved boards is left to the owner walkthrough.

## Windows and Workspace ownership

New Window, opening a Workspace in its own window, fronting the window that
already owns a Workspace, replacing and removing a window's Workspace, window
titles, per-window events and menus, per-Workspace sidebar state, and
appearance and language changes shared across windows.

- Candidate: the commit that adds this section (parent `03857f4`), on macOS
  (Darwin 25.6.0), 2026-10-14.
- Result: PASS for the automated and native checks below; the items under
  "Verified later" are not claimed here.

| Command                                                                                                  | Result                                          |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check`                                                 | PASS                                            |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`                         | PASS                                            |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features e2e-harness -- -D warnings`  | PASS                                            |
| `cargo test --manifest-path src-tauri/Cargo.toml`                                                        | PASS, 303 tests                                 |
| `cargo test ... --lib` filtered to `window::`, `commands::workspace`, `native_menu`, `commands::session` | PASS, 35 / 5 / 22 / 7 tests                     |
| `pnpm typecheck`                                                                                         | PASS                                            |
| `pnpm lint`                                                                                              | PASS                                            |
| `pnpm build`                                                                                             | PASS (chunk-size warnings only)                 |
| `pnpm test` (whole Vitest suite)                                                                         | PASS, 80 files / 638 tests                      |
| `APP_E2E=1 pnpm e2e e2e/tests/multi-window-ownership.spec.ts`                                            | PASS, 10 tests                                  |
| `APP_E2E=1 pnpm e2e`, first run                                                                          | FAIL, 1 failure in the PNG export fidelity test |
| `APP_E2E=1 pnpm e2e e2e/tests/us5-export-fidelity.spec.ts`                                               | PASS, 2 passed                                  |
| `APP_E2E=1 pnpm e2e`, second run                                                                         | PASS, 167 passed / 84 skipped                   |
| `APP_E2E=1 pnpm e2e e2e/tests/ui-sidebar-modes.spec.ts`, after the sidebar assertion change              | PASS, 9 passed / 2 skipped                      |
| `pnpm native:window:test`                                                                                | PASS, 7 tests                                   |
| `pnpm tauri build --debug --no-bundle`, then `pnpm native:window:check`                                  | PASS, 4 checks                                  |
| `pnpm native:menu:check -- --languages "(en-US, zh-Hans)"` on the same debug binary                      | PASS, 99 checks                                 |

What the checks cover:

- Native, through Accessibility and System Events on the debug binary: File >
  New Window adds exactly one window, which shows Welcome and is in front;
  with Workspaces A and B in two windows, opening A from B's window 20 times
  keeps two windows and fronts A every time; opening A while it is minimized
  restores and fronts it. The File menu command runs in the front window in
  every one of these attempts. Window names read through Accessibility are
  the Workspace folder names.
- Native menu: labels, enabled and checked state, and routing of each menu
  item and Command-S in English and Simplified Chinese, including New Window
  and Open Workspace.
- Rust: claim, probe, and release outcomes; one owner per Workspace; a
  repeated open of an owned Workspace changes no window; Workspace events go
  only to the owning window; menu state is kept per window and applied when a
  window gains focus, and menu commands go to the front window or the most
  recently focused one; an appearance or language change is sent to every
  other window (three windows, two targets); per-Workspace sidebar state
  falls back to the most recent pin and width, then to the imported legacy
  values; the legacy import happens once.
- Frontend unit tests: replacing a Workspace closes every tab first and keeps
  the old Workspace when a close is cancelled or fails, or when the target is
  not claimable; Welcome New Drawing handles all four claim outcomes; window
  titles name the Workspace and the active drawing, tell same-name
  Workspaces apart, and follow the language; an external appearance or
  language change is applied without being written back or sent again; the
  sidebar shows only the window's Workspace; pin and width are saved per
  Workspace.
- Browser: the replacement flow, Welcome New Drawing, title de-duplication,
  and an appearance and language change from another window reaching the DOM
  in under one second.

Verified later (not covered by this checkpoint):

- Drawing events (external change, conflict, draft saved, history issue) are
  not yet limited to the drawing's owner window. Until drawings are claimed
  per window, an event for a drawing with no owner goes to the calling
  window, then to the window whose Workspace contains the path, then to every
  window; the frontend filters by path. This is checked with drawing
  ownership in "Nested folders and file routing".
- Clicking the Dock icon with no windows, and whether the Window menu lists
  each window, are checked in "Closing, quitting and restoring". The Dock
  menu and restoring a window from another desktop space are left to the
  owner walkthrough.
- After a restart, the last Workspace is not reopened automatically until
  window restore lands. Four browser tests that depend on it are marked
  `test.fixme`, and the offline edit-and-save test reopens its Workspace
  from Recent after a reload. These are re-enabled in "Closing, quitting and
  restoring".

Gaps and owner decisions:

- Owner decisions on 2026-10-14: the sidebar shows only the window's own
  Workspace (listing several Workspaces in one sidebar is removed); only the
  Workspace root row's expansion is saved, not nested folders.
- Choosing a folder that contains another window's Workspace shows an error
  instead of the three-choice dialog, which lands with nested folder routing.
- When a window is destroyed, its claims are released, but the full close
  and quit coordination is not in place yet.
- The window session does not record tabs yet.
- The legacy sidebar preference key is read on every launch and ignored after
  the first import; it is never deleted.
- The native checks ran against a debug binary, not a `.app` bundle, so no
  LaunchServices path (Finder open, Dock reopen) is claimed.
- The browser harnesses were rewritten for window-scoped Workspace lists, a
  separate recent list, and per-Workspace sidebar state. The sidebar tests
  now assert the sidebar state the app sends, not the harness's own fallback
  rule; the fallback rule is owned by the Rust tests.
- The PNG export fidelity test failed once again with the export dialog not
  appearing within 15 seconds; the isolated rerun and the next full run
  passed. The cause is still not determined.
- No new app-owned UI; window titles are native.

## Nested folders and file routing

Opening a folder that is inside, or contains, another window's Workspace;
where drawings opened from Finder, `open -a`, a second launch, or the launch
arguments go; and one window per drawing.

- Candidate: the commit that adds this section (parent `4ae652d`), on macOS
  (Darwin 25.6.0), 2026-10-14.
- Result: PASS for the automated and native checks below; the items under
  "Verified later" are not claimed here.

| Command                                                                                                        | Result                          |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check`                                                       | PASS                            |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`                               | PASS                            |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features e2e-harness -- -D warnings`        | PASS                            |
| `cargo test --manifest-path src-tauri/Cargo.toml`                                                              | PASS, 325 tests                 |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib -- window::router window::registry commands::documents` | PASS, 33 tests                  |
| `pnpm typecheck`                                                                                               | PASS                            |
| `pnpm lint`                                                                                                    | PASS                            |
| `pnpm format`                                                                                                  | PASS                            |
| `pnpm build`                                                                                                   | PASS (chunk-size warnings only) |
| `pnpm test` (whole Vitest suite)                                                                               | PASS, 82 files / 663 tests      |
| `APP_E2E=1 pnpm e2e e2e/tests/multi-window-nesting.spec.ts`                                                    | PASS, 9 tests                   |
| `APP_E2E=1 pnpm e2e`                                                                                           | PASS, 176 passed / 84 skipped   |
| `pnpm native:window:test`                                                                                      | PASS, 9 tests                   |
| `pnpm tauri build --debug --bundles app`, then `pnpm native:window:check -- --app <debug .app>`                | PASS, 11 checks                 |
| `pnpm native:window:check -- --binary src-tauri/target/debug/excalidraw-desktop` (same build)                  | PASS, 11 checks                 |

What the checks cover:

- Native, through Accessibility and System Events: with Workspace A in one
  window and B in another, opening a folder inside A from B's window fronts
  A's window and opens no window; opening A's parent folder from B keeps two
  windows, keeps B in front, and shows the nested-Workspace dialog, whose
  three buttons (Close it and open here, Cancel, Switch to that window) are
  read by name; Escape closes it. Drawings handed over with `open -a` (with
  the `.app`) and with a second launch of the binary (without it) go to the
  right place each time: a drawing inside A opens in A's window, a second one
  opens as another tab there, a drawing outside every Workspace opens in the
  most recently used window, and a drawing already open fronts its window and
  switches to its tab. Window titles name the active tab.
- Rust: the routing order (the window that has the drawing, the window whose
  Workspace contains it, the most recently used window, a new window) and
  batching per window; a window that has not read its startup data gets the
  paths through it; a drawing open in, or inside the Workspace of, another
  window is answered without reading the file; a symlink, a `..` path, and a
  different letter case on a case-insensitive volume are the same drawing;
  a failed open or write gives back the claim it made; a close by another
  window keeps the draft and recovery data; writes to another window's
  drawing are refused; drawing events go only to the drawing's window; a
  "Close it and open here" request is answered only by the window it asked,
  and a request from a destroyed window is dropped; the request and result
  name their request.
- Frontend unit tests: the sidebar reveals a nested folder by expanding down
  to it and selecting it; the nested-Workspace dialog's names, path, focus,
  button order, busy and failure states, and language; "Close it and open
  here" closes this window's tabs first, then waits for its own result, and
  keeps a result that arrives before the request id; Open Workspace, Recent,
  the sidebar's mount button, and Welcome New Drawing all open the dialog,
  and New Drawing continues once the folder opened; a window asked by another
  closes the normal way and reports a failed close back.
- Browser: reveal with the sidebar opened, the folder selected and the
  toast; the dialog's three actions; a cancelled close opens nothing; this
  window's tabs close before the other window is asked; a drawing another
  window asks for switches to its tab without reading it again; a drawing
  open in another window does not open here.

Verified later (not covered by this checkpoint):

- What happens when the window asked to close has unsaved edits that cannot
  be saved is checked with the close coordination in "Closing, quitting and
  restoring".
- The toast and dialog in four themes and both languages, against the
  approved boards, are left to the owner walkthrough.

Gaps and owner decisions:

- Before this checkpoint, Finder and `open -a` with the app running opened
  nothing: the macOS "open file" event was not handled. It is now routed.
- The routing check does not tell which path a drawing arrived by (the macOS
  open event or the second-instance hand-off); both end in the same router.
- `history_replace` checks ownership only for a drawing named by path; a
  history handle is not checked.
- After "save as new" from a conflict, the new path is claimed and the old one
  released. Saving a drawing whose file is gone under a new path claims the
  new path, but the missing old path stays claimed by that window until the
  window closes.
- Within one window, a drawing opened again under a different spelling of its
  path can open a second tab; across windows the spellings are treated as one
  drawing.
- The nested-Workspace dialog names the Workspace inside from the Recent
  list; when it is not there the overlap error is shown instead.
- If the asked window never answers, the dialog stays busy; there is no
  timeout.
- The `native:menu:check` was not re-run; this checkpoint changes no menu.
- App-owned UI: the nested-Workspace dialog and the folder-located toast,
  both from the approved designs.

## Closing, quitting and restoring

Quit (the app's own menu item and Cmd+Q) checkpoints every window before the
app exits; closing one window; the last window closing while the app keeps
running; and what the next launch restores: one Recovery window after a
crash, then the windows, tabs and active tab of the last session.

- Candidate: the commit that adds this section (parent `bcd512f`), on macOS
  26.6.2 (Darwin 25.6.0, arm64), 2026-10-14.
- Result: PASS for the automated and native checks below. A suspected loss
  of a pasted element on Cmd+Q was a fault in the reproduction, not in the
  app (see "Follow-up: paste, then quit").

| Command                                                                                                 | Result                        |
| ------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check`                                                | PASS                          |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`                        | PASS                          |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features e2e-harness -- -D warnings` | PASS                          |
| `cargo test --manifest-path src-tauri/Cargo.toml`                                                       | PASS, 336 tests               |
| `pnpm typecheck`                                                                                        | PASS                          |
| `pnpm lint`                                                                                             | PASS                          |
| `pnpm format`                                                                                           | PASS                          |
| `pnpm test` (whole Vitest suite)                                                                        | PASS, 84 files / 692 tests    |
| `APP_E2E=1 pnpm e2e`                                                                                    | PASS, 180 passed / 85 skipped |
| `pnpm native:window:test`                                                                               | PASS, 13 tests                |
| `APP_E2E=1 EXCALIDRAW_E2E_BINARY=<harness build> pnpm e2e e2e/tests/multi-window-reliability.spec.ts`   | PASS, 4 scenarios × 10 runs   |
| `pnpm tauri build --debug --bundles app`, then `pnpm native:window:check -- --app <debug .app>`         | PASS                          |

The process-level runs used the test-only build
`VITE_E2E_HARNESS=1 pnpm tauri build --features e2e-harness --no-bundle`,
sha256 `73af0e016dd568664b524298897da0bb578ef0c054e514ad3edcaab50d912fd1`,
built from the working tree on top of `bcd512f`. Later changes in this
checkpoint touch only the native check script, documents and formatting, not
the built app. Each run wrote one JSON record of its checks; the 40 records
were read back and contain no failed check. They are kept outside the
repository.

What the checks cover:

- Process level, two windows with unsaved edits, each scenario 10 times:
  - Crash (the process group killed): the next launch shows exactly one
    Recovery window, covering both drawings; no other window opens and the
    files are unchanged before Recovery; the restored content is the edited
    content; after Recovery the windows of the last session open.
  - Quit while one window cannot checkpoint: the app keeps running, the
    failing window comes to the front with the error, the edits and drafts
    are kept, and a second Quit exits with code 0 and saves both drawings.
  - Quit and restart: the window count, tab order and active tab come back;
    a deleted drawing is skipped with a notice; a Workspace whose folder was
    moved opens Welcome with a notice.
  - Closing one window saves its drawings and leaves the other window as it
    was; a close that cannot checkpoint keeps the window open with the error,
    the edit and the draft.
- Native, through Accessibility and System Events on the debug `.app`:
  closing every window leaves the app running; reopening it with `open -a`
  shows Welcome; Cmd+Q goes through the coordinated quit (the app log shows
  the request to every window and then the exit), exits with code 0, and a
  keyboard edit made before it is on disk.
- Rust: every transition of the quit coordinator (all ready, one failure,
  timeout, a destroyed window, Quit again while collecting, Quit after a
  cancel, answers from unknown windows); Quit is the app's own menu item with
  Cmd+Q, and the menu registers only its own accelerators; the Window Session
  keeps only tabs the window owns or holds in its Workspace; the startup
  order (Recovery first, then the session); the test-only multi-window
  commands are not in the production command list.
- Frontend unit tests: a window answers the quit request after checkpointing
  and shows the error when it cannot; Recovery reports itself finished only
  after every result is open in a tab, and a result that cannot be opened
  stays undecided; restored tabs and launch files open once, also when the
  handler is registered twice; the skipped-tab and unavailable-Workspace
  notices.
- Browser: the four restart tests that waited for this checkpoint run again
  and pass (sidebar modes, appearance after restart, the workspace tree
  scroll anchor, and revisiting folders); after a reload the last tab comes
  back without reopening the Workspace through Recent.

Defects found and fixed by these checks:

- Recovery reported itself finished after the first decision. The session
  restore then claimed the second drawing first, and restoring it failed
  with "This drawing is open in another window".
- Under React StrictMode the restored tabs were opened twice.

Gaps and owner decisions:

- The Window menu listed none of the open windows; it had Minimize, Zoom,
  Close Window and Close All. Owner decision: a defect, fixed separately as
  a small fix ahead of the remaining work; fixed (see "Follow-up: the Window
  menu").
- A failed checkpoint leaves the drawing's save status at "checkpointing"
  rather than an error state; the error is shown by the shell. Owner
  decision: fixed with the final polish.
- The test driver turns structured IPC errors into "[object Object]" in its
  answers. This affects only test diagnostics. Owner decision: fixed when
  the driver is next changed.
- When Recovery leaves its window empty and the session opens other
  windows, the Recovery window closes.
- In the test-only build started by the history driver, closing the last
  window ends the process; every other build keeps running.
- The `native:menu:check` was not re-run; the Quit item is checked by the
  Rust menu tests and by the native window check.
- No new app-owned UI beyond the existing notices and error text.

Follow-up: paste, then quit (2026-10-14):

- The first two reproductions pasted with the canvas not focused and the
  pointer at the editor's default position. The editor ignores such a paste
  without an error, so the drawing stayed empty and the quit had nothing new
  to save. A draft saved right after opening an empty drawing had been read
  as evidence that the paste had landed; it was not.
- A process-level scenario now pastes into an empty drawing with the editor
  focused and quits: the file holds the pasted element (3 of 3 runs on the
  test-only build, commit `ae1438d`).
- The owner checked the real path by hand on the debug `.app`: copy a
  rectangle from one drawing, click the canvas of an empty drawing, Cmd+V,
  Cmd+Q. The empty drawing's file then held one rectangle with a new id, and
  the source file was unchanged.
- Owner review: no defect in this case; the Window menu is fixed separately;
  the save status and driver error items are scheduled as noted above.

Follow-up: the Window menu (2026-10-14):

- Fix: every time the app menu is installed (at startup and on each rebuild,
  such as a language change) the Window submenu is registered again as the
  macOS window menu (commits `549d5f4`, merged in `1118068`).
- `pnpm native:window:check -- --app <debug .app>` on a debug build of the
  fix: exit 0, 17 checks PASS. The Window menu check is now PASS/FAIL instead
  of an observation: it listed 2 of 2 windows by title. The script now also
  accepts a relative `--app` path.
- `pnpm native:menu:check -- --languages "(en-US, zh-Hans)"`: exit 0, 100
  checks PASS. The first run crashed reading a log line split across two
  output chunks; the script now reads whole lines (`a0ab44a`) and the rerun
  passed.
- After the merge: `cargo fmt --check`, both clippy runs, `cargo test` (337
  tests), `pnpm lint`, `pnpm typecheck`, `pnpm format`, `pnpm test` (693
  tests), `pnpm native:window:test` (17) and `pnpm native:menu:test` (1)
  PASS. The native checks ran on the fix's own build, not re-run on the
  merged build; the merge adds only test-driver code and documents.
- Gap: no native check reads the Window menu after a language switch; the
  rebuild uses the same install path, but this is not natively proven.

## Window size and placement

The first window's size on the display it opens on, the placement each
Workspace window remembers (position, size, maximized and full screen), the
correction of a placement that is no longer on screen, and the shell at the
minimum window size.

- Candidate: the commit that adds this section, on a branch that also
  carries the Window menu fix, on macOS
  26.6.2 (Darwin 25.6.0, arm64), 2026-10-14. Display: one built-in panel,
  work area 1352×848 points below the menu bar.
- Result: PASS for the automated and native checks below. Maximized and full
  screen placement and a disconnected display are covered by Rust tests
  only; see the gaps.

| Command                                                                                         | Result                                              |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check`                                        | PASS                                                |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`                | PASS                                                |
| `cargo test --manifest-path src-tauri/Cargo.toml`                                               | PASS                                                |
| `pnpm typecheck`                                                                                | PASS                                                |
| `pnpm lint`                                                                                     | PASS                                                |
| `APP_E2E=1 pnpm e2e e2e/tests/multi-window-geometry.spec.ts`                                    | PASS, 2 tests                                       |
| `pnpm native:window:test`                                                                       | PASS, 24 tests                                      |
| `pnpm tauri build --debug --bundles app`, then `pnpm native:window:check -- --app <debug .app>` | PASS, 20 checks; 1 of 3 runs interrupted (see gaps) |

What the checks cover:

- Native, through Accessibility and System Events on the debug `.app` with a
  fresh home folder:
  - The first window's content is 90% of the work area (1216×763 here),
    centered, with its frame inside the work area.
  - A Workspace window moved and resized, closed, and opened again in a new
    window comes back with the same frame.
  - After Cmd+Q and a relaunch, a Workspace window comes back with the frame
    it had when the app quit.
  - The checks that were already in the script still pass with placement
    applied (ownership, nested folders, file routing, the Window menu
    listing every window by title, closing, Reopen, Cmd+Q): 20 checks.
- Rust: placement follows a window only in its normal state, so leaving
  maximized or full screen returns to the remembered size; a restored
  maximized or full screen window is first given its normal bounds; a
  placement whose title bar is not reachable on any display moves to the
  primary display; queued placements are written once per Workspace; the
  existing geometry rules (90% with limits, staggering, minimum size).
- Browser, at the 960×640 minimum: no horizontal overflow; the sidebar
  toggle, the tab and the drawing tools are visible inside the window, with
  the sidebar hidden and pinned; with the pinned sidebar at its narrowest
  (280) the canvas is at least 680 wide.

Behavior worth knowing:

- Placement is written 500 ms after the last move or resize, outside the
  editing path, and once more when the app exits.
- A Workspace opened for the first time keeps the window where it is and
  remembers that placement; a Workspace with a remembered placement moves
  the window that opens it there.
- Welcome windows have no remembered placement; a restored Welcome window
  with drawings opens at the default position.

Defect found and fixed by these checks:

- At the minimum width the page was 1 point wider than the window: the
  hidden save status sat at the right edge of the header. The hidden-text
  style now offsets its 1-point box, as the usual screen-reader-only pattern
  does.

Gaps:

- Maximized and full screen restore, and a placement on a display that was
  disconnected, were not exercised natively: entering those states and
  changing displays cannot be driven reliably from System Events here. They
  are in the owner walkthrough list.
- The 1280×760 target for a work area of at least 1440×900 is checked by the
  geometry rules; this display is smaller, where the 90% rule applies.
- One of three native runs ended right after the nested-folder dialog with
  an uncaught System Events error ("Invalid index") and left the app
  running; the run before it and the run after it passed every check. The
  script now stops the app it started when it ends on an error. The cause
  of the error was not found.
- No new app-owned UI.

## Empty Workspace state

What a Workspace window shows when no drawing is open: the canvas
background and grid, a handwritten hint, New Drawing and Show Sidebar, and
a pointer to the sidebar toggle; with the sidebar pinned, only New Drawing.

- Candidate: the commit that adds this section, on macOS 26.6.2 (Darwin
  25.6.0, arm64), 2026-10-14.
- Result: PASS for the automated checks below. The look of the screen is
  not judged from screenshots; it is in the owner walkthrough list.
- Components: `MW-EMPTY-STATE` in Light and Dark, English and Simplified
  Chinese, sidebar hidden and pinned.

| Command                                                         | Result                                      |
| --------------------------------------------------------------- | ------------------------------------------- |
| `pnpm test src/app/CanvasEmptyState.test.tsx`                   | PASS, 7 tests                               |
| `pnpm test` (whole Vitest suite)                                | PASS, 85 files / 700 tests                  |
| `pnpm typecheck`                                                | PASS                                        |
| `pnpm lint`                                                     | PASS                                        |
| `pnpm format`                                                   | PASS                                        |
| `APP_E2E=1 pnpm e2e e2e/tests/multi-window-empty-state.spec.ts` | PASS, 7 tests                               |
| `APP_E2E=1 pnpm e2e` (whole browser suite)                      | 188 passed, 86 skipped, 1 timed out (below) |

What the checks cover:

- Component: the area is named "Empty canvas area"; the hint and actions
  are plain text and buttons, New Drawing before Show Sidebar; no editor or
  canvas element is mounted; the pointer and its note are hidden from
  assistive technology; with the sidebar pinned there is one action and no
  pointer; New Drawing is disabled while one is being created; a language
  change updates every text.
- Browser, in Light and Dark with English and Simplified Chinese: the area
  has the canvas background color, shows the texts of the chosen language
  only, and does not overflow horizontally; Tab reaches New Drawing, then
  Show Sidebar; Show Sidebar opens the sidebar as an overlay; New Drawing
  opens a new drawing in a tab; dragging and pressing a tool key on the
  empty area changes nothing and calls no document command; the pinned
  variant has one action and no pointer.

Behavior worth knowing:

- New Drawing creates the next free "Untitled" at the root of the window's
  Workspace and opens it, as Welcome New Drawing does once it has a folder.
- The handwriting uses the editor's Latin font subset; Chinese text uses the
  bundled CJK handwriting font loaded at startup.
- The approved design shows keyboard shortcut hints next to the actions.
  The app has no such shortcuts yet, so the hints are not shown (owner
  decision, 2026-10-14).

Test changes:

- Three browser tests clicked "New Drawing" anywhere on the page; the empty
  area now has its own New Drawing, so they click the sidebar toolbar's
  button, which is what they meant. One test that checked the old empty
  text now checks the named area.

Gaps:

- In one whole-suite run the Simplified Chinese export-dialog accessibility
  test timed out; run alone twice it passed (3 of 3 each time), and it
  passed in the earlier whole-suite run. It does not touch the empty area.
- The arrow, handwriting and spacing are not compared with the approved
  boards; they are in the owner walkthrough list.

## Sidebar dialogs

The dialogs opened from the Workspace sidebar share one layout: title,
consequence text, the object's path, the name field with a fixed
extension, the error, and the actions on the right with Cancel first.
Seven dialogs use it: New drawing, New folder, Rename drawing, Rename
folder, Delete, Folder isn't empty and Remove Workspace.

- Candidate: the commit that adds this section, on macOS 26.6.2 (Darwin
  25.6.0, arm64), 2026-10-14.
- Result: PASS for the automated checks below. The look of the dialogs is
  not judged from screenshots; it is in the owner walkthrough list.
- Components: `DSC-DIALOG-001` sidebar variant. Naming dialogs: default,
  error and submitting. Confirmation dialogs: Delete, Folder isn't empty
  and Remove Workspace.

| Command                                        | Result                                   |
| ---------------------------------------------- | ---------------------------------------- |
| `pnpm test src/app/interaction src/workspaces` | PASS, 10 files / 91 tests                |
| `pnpm test` (whole Vitest suite)               | PASS, 85 files / 709 tests               |
| `pnpm typecheck`                               | PASS                                     |
| `pnpm lint`                                    | PASS                                     |
| `pnpm format`                                  | PASS                                     |
| `APP_E2E=1 pnpm e2e ui-entry-dialogs`          | PASS, 8 tests                            |
| `APP_E2E=1 pnpm e2e` (whole browser suite)     | 192 passed, 86 skipped, 1 failed (below) |

What the checks cover:

- Naming dialogs: the field is labeled "Name", its value is selected
  without the extension, and the extension is announced as "Fixed
  extension .excalidraw" while its visible text is hidden from assistive
  technology; folders have no extension; Enter submits and Escape cancels;
  while submitting the field and both buttons are disabled; a failure
  shows its message under the field as an alert, keeps the typed name and
  puts focus back in the field; the actions are Cancel, then Create or
  Rename in the primary style.
- Confirmation dialogs: each shows the consequence and the object's path
  with the home folder shortened to `~`; Cancel comes first and has the
  initial focus; Delete is the only danger-styled action; Open in Finder
  and Remove Workspace use the primary style; busy disables both actions.
- Browser, at 1280 × 760 in Light and Dark with English and Simplified
  Chinese, for each of the seven dialogs: it uses the sidebar layout, lies
  inside the window, nothing in it sticks out or is clipped, the page does
  not scroll sideways; the actions are in the planned order in the chosen
  language; initial focus is on the field or on Cancel; Escape closes it
  and focus goes back to what opened it; no file, folder or Workspace
  command is sent.

Fixes made while checking:

- The extension's spoken label was set on a plain text element, where
  assistive technology ignores it. The field now points to a hidden text
  that says "Fixed extension …".
- New Drawing and New Folder in the sidebar toolbar did not tell the dialog
  where to send focus back, so focus was lost when it closed. They now do.
- Dialogs opened from a row's menu sent focus back to the row's actions
  button, which is hidden unless the row is hovered or focused, so focus
  fell to the page. Focus now goes back to the row itself; one existing
  test that expected the button was changed to expect the row.

Gaps:

- In the whole-suite run the PNG export fidelity test failed waiting for
  the Export dialog to appear; run alone three times it passed each time
  (6 of 6 across both browser projects). It does not open a sidebar
  dialog. The export dialog was also the one that timed out in the
  previous section's whole-suite run.
- The spacing, colors and fonts are not compared with the approved
  boards; they are in the owner walkthrough list.

## Copy path

Copy Path and Copy Relative Path in the sidebar row menus and the tab
context menu. The app may write text to the clipboard and has no
permission to read it.

- Candidate: the commit that adds this section, on macOS 26.6.2 (Darwin
  25.6.0, arm64), 2026-10-14.
- Result: PASS for the automated checks below. Copying in the packaged app
  was not run; it is in the owner walkthrough list.
- Components: `DSC-MENU-001` copy items (drawing, folder and Workspace
  rows; tabs inside and outside the Workspace) and `MW-COPY-FEEDBACK`
  success and failure.
- Dependency: the official clipboard plugin, version 2.3.3 for both Rust
  and npm, pinned exactly. It was published on 2026-08-31 and is the
  newest release that works with Tauri 2.11; 2.4 and later need Tauri
  2.12.

| Command                                                                                              | Result                                   |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `cargo test --manifest-path src-tauri/Cargo.toml --test capabilities`                                | PASS, 1 test                             |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check`                                             | PASS                                     |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`                     | PASS                                     |
| `cargo test --manifest-path src-tauri/Cargo.toml`                                                    | PASS, 346 tests in 12 targets            |
| `pnpm test src/app/clipboard.test.ts src/app/TabBar.test.tsx src/workspaces/WorkspacePanel.test.tsx` | PASS                                     |
| `pnpm test` (whole Vitest suite)                                                                     | PASS, 86 files / 720 tests               |
| `pnpm typecheck` / `pnpm lint` / `pnpm format`                                                       | PASS                                     |
| `APP_E2E=1 pnpm e2e multi-window-copy-path`                                                          | PASS, 6 tests                            |
| `APP_E2E=1 pnpm e2e` (whole browser suite)                                                           | 198 passed, 86 skipped, 1 failed (below) |

What the checks cover:

- Permissions: across every capability file the only clipboard
  permission is writing text. Building the app checks that the permission
  name exists in the plugin.
- Copying: the whole path is written in one call, with spaces and Chinese
  kept; the path is read when the item is chosen, so a renamed tab copies
  its new path; an item that no longer exists, or a failed write, copies
  nothing and shows a failure.
- Menus, in order: drawing row Rename, Copy Path, Copy Relative Path,
  Delete; folder row New Drawing, New Folder, Copy Path, Copy Relative
  Path, Rename, Delete; Workspace row New Drawing, New Folder, Copy Path,
  Remove Workspace; tabs end with Copy Path and, for a drawing in the
  Workspace, Copy Relative Path. Separators split the groups as designed.
- Browser: Copy Path on a drawing or folder writes its full path (not
  shortened to `~`) and shows "Path copied"; Copy Relative Path writes the
  `/`-separated path below the Workspace root, with no leading `/`, and
  shows "Relative path copied"; the Workspace row copies its root; a tab
  copies what its row copies; a drawing opened from outside the Workspace
  has only Copy Path; a failed write shows "Couldn't copy path" and leaves
  the earlier clipboard text in place.

Test changes:

- The menu keyboard test in the continuous Workspace tree spec counted four
  items in a folder's menu; the folder menu now has six (the two copy
  items). That is the whole-suite failure counted above; with the count
  updated the spec passes (3 tests) and the menu still fits a 420 × 260
  window. The Tab menu unit test that lists the items now expects Copy
  Path at the end.

Gaps:

- The browser tests answer the clipboard command themselves; the plugin
  writing to the macOS clipboard in the packaged app is in the owner
  walkthrough list.
- The toast's look is not compared with the approved boards.

## Final regression

The whole gate on the final candidate, plus the last fixes and checks of
the multi-window work.

- Candidate: the commit that adds this section, on macOS 26.6.2 (Darwin
  25.6.0, arm64), 2026-10-14. Debug `.app` main binary SHA-256
  `db5e054c…21ac86`; test-harness release binary SHA-256 `e2381185…413d0`.
- Result: PASS for every command below.

| Command                                                                                  | Result                                 |
| ---------------------------------------------------------------------------------------- | -------------------------------------- |
| `pnpm typecheck` / `pnpm lint` / `pnpm format`                                           | PASS                                   |
| `pnpm test`                                                                              | PASS, 86 files / 725 tests             |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check`                                 | PASS                                   |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`         | PASS                                   |
| The same with `--features e2e-harness`                                                   | PASS                                   |
| `cargo test --manifest-path src-tauri/Cargo.toml`                                        | PASS, 346 tests                        |
| `APP_E2E=1 EXCALIDRAW_E2E_BINARY=<harness> pnpm e2e` (browser and native process suites) | PASS, 283 passed, 11 skipped, 0 failed |
| Three-window edit and save in `e2e/tests/multi-window-reliability.spec.ts`, 10 runs      | PASS, 10 of 10                         |
| `APP_E2E=1 pnpm e2e a11y-audit` (multi-window surfaces)                                  | PASS, 8 tests, 32 scans, 0 violations  |
| `pnpm native:window:test`                                                                | PASS, 24 tests                         |
| `pnpm native:menu:check -- --languages "(en-US, zh-Hans)"`                               | PASS, 99 checks                        |
| `pnpm native:window:check -- --app <debug .app>`                                         | PASS, 20 checks                        |

What changed and what the checks cover:

- A drawing whose checkpoint fails while its window closes or the app
  quits now shows a save error with the reason instead of staying in
  "saving"; a drawing whose file disappeared at the same time stays
  orphaned. Unit tests cover the close and quit paths.
- Three windows each edit and save their own drawing: each save changes
  only its own file, every save ends clean, and each window keeps its own
  drawing. The test driver now reports a refused request as its error code
  and message.
- Accessibility: the empty state, the "inside" toast, the nested-folder
  dialog, the delete, folder-not-empty and remove-Workspace dialogs, and
  the copy toasts, in Light and Dark and both languages; see
  `docs/evidence/a11y-audit.md`.
- Documents: the multi-window decision record (ADR-010), the architecture
  overview, the IPC contract, README, CONTEXT and the contributor guide.
- The eleven skipped end-to-end tests skip themselves by their own
  environment conditions; they were not listed one by one.
- The two foreground native checks ran with nobody using the mouse or
  keyboard.

## Performance

Cold start, idle memory and writes on `main` and on the candidate, and
process-tree memory with one, two and three windows. Measured on a
physical Mac; the declared reference VM was not available.

- Machine: Mac17,9 (Apple M5 Pro), 48 GiB, macOS 26.6.2 (25G83), WebKit
  21624.5.1.11.3, 2026-10-14. Not virtualized; nothing else was launched
  during the runs.
- Binaries: test-harness release builds
  (`VITE_E2E_HARNESS=1 pnpm tauri build --features e2e-harness --no-bundle`).
  `main` at `854cc4e`, SHA-256 `546d4632…cb368`; candidate at the commit
  that adds this section, SHA-256 `e2381185…413d0`.
- Result: no regression found. Both binaries fail the 2 s cold-start
  budget the same way (below); idle memory passes; idle writes are zero.

| Command                                                                                                                 | Result          |
| ----------------------------------------------------------------------------------------------------------------------- | --------------- |
| `PERF_TEST=1 APP_E2E=1 EXCALIDRAW_E2E_BINARY=<main> pnpm exec playwright test … e2e/perf/startup-idle.spec.ts`          | PASS (recorded) |
| The same with `EXCALIDRAW_E2E_BINARY=<candidate>`                                                                       | PASS (recorded) |
| `PERF_TEST=1 APP_E2E=1 EXCALIDRAW_E2E_BINARY=<candidate> pnpm exec playwright test … e2e/perf/multi-window-rss.spec.ts` | PASS (recorded) |

Cold start to an editable canvas, 10 launches each, each with a new data
root:

| Binary    | Launches (ms)                                     | Median | P95 (nearest rank) | Budget 2000 ms |
| --------- | ------------------------------------------------- | ------ | ------------------ | -------------- |
| main      | 2667, 623, 616, 594, 595, 621, 597, 592, 598, 590 | 597    | 2667               | fail           |
| candidate | 2463, 622, 622, 625, 628, 624, 625, 621, 623, 623 | 623    | 2463               | fail           |

- With ten launches the nearest-rank P95 is the slowest launch. On both
  binaries that is the first launch after the build, about 2.5 s; the
  other nine are 0.59–0.63 s. The budget fails on `main` too, so it is not
  caused by this work.
- The candidate's median is 26 ms (4%) slower than `main`'s. The spec
  expects up to 20% launch-to-launch variation; this is within it.

Idle, 30 s after the canvas is ready, sampled once a second for 60 s:

| Binary    | Process-tree RSS P95 | Budget 500 MB | Persistent writes (events / changed paths) |
| --------- | -------------------- | ------------- | ------------------------------------------ |
| main      | 314.9 MiB            | pass          | 0 / 0                                      |
| candidate | 317.5 MiB            | pass          | 0 / 0                                      |

Windows, each holding one Workspace and one drawing with one rectangle;
15 s to settle after each window opens, then 20 samples a second apart.
There is no budget; the numbers are recorded only.

| Windows | RSS P50   | RSS P95   | Processes | P95 added by this window |
| ------- | --------- | --------- | --------- | ------------------------ |
| 1       | 318.0 MiB | 318.9 MiB | 4         | —                        |
| 2       | 454.2 MiB | 454.4 MiB | 5         | 135.5 MiB                |
| 3       | 586.8 MiB | 587.7 MiB | 6         | 133.2 MiB                |

- Each window adds one WebKit content process and about 135 MiB. With
  three windows the process tree passes the 500 MB single-window idle
  budget; that budget is for one window and is not applied here.

Fix found by this run:

- On the first candidate build the performance driver could not open its
  drawing: the harness registered its Workspace as mounted before the
  startup step that unmounts every Workspace, so the open was refused
  (`main` has no such step). The harness now registers after that step.
  The driver also reported the refused open as `[object Object]`; it now
  reports the error code and message, with a unit test. The harness
  Workspace is not claimed by a window, so no watcher runs for it on the
  candidate, as for any Workspace not open in a window.

Gaps:

- The declared reference VM was not available; this is physical-Mac
  evidence only.
- RSS counts shared pages in each process, so the per-window figure is an
  upper bound on new memory.

## Owner walkthrough

One pass by the product owner on the final candidate `.app`, about 25
minutes. It covers what the automated checks cannot: real macOS
interaction, the real clipboard, the approved boards, and desktop spaces.
The owner's conclusion is recorded below on its own and is not inferred
from the automated results.

- Build: the debug `.app` of the final candidate
  (`pnpm tauri build --debug --bundles app`), the same build the native
  window check runs on.
- Seed folders, under `~/Documents/excalidraw-walkthrough-2026-10-14/`:
  `Alpha Space/` (a space in the name) with `Plan.excalidraw`,
  `设计 草图/流程图.excalidraw` (Chinese and a space) and a non-empty
  `Notes/`; `工作区 B/看板.excalidraw`; and `Outside/loose.excalidraw`,
  which is in no Workspace.
- The walkthrough uses the owner's own app data, so both Workspaces join the
  Recent list.

| #   | Area                        | Pass when                                                                                                                                                                                                                    |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | New window, two Workspaces  | File > New Window adds a Welcome window; each window shows only its own Workspace; opening `Alpha Space` again from the other window, several times and once while minimized, opens no window and brings the owner to front. |
| 2   | Subfolder and parent folder | Opening `设计 草图` brings the owner to front, reveals the folder and shows the "inside" toast; opening the parent shows the nested dialog; both of its actions work.                                                        |
| 3   | Finder                      | A drawing in a Workspace opens in its owner; `loose.excalidraw` opens in the most recent window; a drawing already open is not opened twice.                                                                                 |
| 4   | Theme and language          | A change in one window applies to every window and to the native menus; the Window menu still lists every window.                                                                                                            |
| 5   | Empty state and dialogs     | Against boards 01–03 and 07–13, in English and Simplified Chinese (Dark once): parts, order, placement and styles match. The shortcut hints are left out by an earlier owner decision and are not a failure.                 |
| 6   | Copy path (real clipboard)  | Pasting gives the full path with Chinese and spaces kept, or the path below the Workspace root; the Workspace row and a drawing outside the Workspace offer only Copy Path; the toasts read as designed in both languages.   |
| 7   | Size and placement          | A Workspace reopened after a move and resize comes back where it was; maximized, full screen and a disconnected display are observed and recorded.                                                                           |
| 8   | Quit and restore            | Cmd+Q with unsaved edits in two windows quits within seconds; relaunching restores the windows, tabs, placement and the edits; closing every window and clicking the Dock icon opens Welcome; the Dock menu is observed.     |
| 9   | Another desktop space       | Opening a Workspace whose window is on another space brings that window forward and opens no new one.                                                                                                                        |

First pass by the owner, 2026-10-15, on the debug `.app` of `fdb6456`.
Passed: new window and two Workspaces, subfolder and parent folder, theme
and language, size and placement, quit and restore, another desktop space,
and the remaining dialog, empty-state and copy-path items. Findings and
follow-up:

- Finder: double-clicking a drawing did nothing. The Mac's default app for
  `.excalidraw` was an old 0.3.0 copy with the same bundle identifier, so
  Finder launched that copy, which handed its launch arguments (without the
  file) to the running candidate and quit. Not a candidate defect; `open -a`
  with the candidate passes in the native window check. To be repeated with
  the candidate as the default app.
- A drawing whose file went to the Trash, then "Save As" onto its own path,
  could no longer be closed: the file was written back, then discarding the
  old path was refused because the file existed again, so the tab, deleting
  the file and removing the Workspace all failed until the window closed.
  The defect predates the multi-window work. Fixed: saving back to the
  drawing's own path no longer discards it; a unit test and a backend
  contract test cover it. To be repeated.
- The empty state's New Drawing creates `Untitled` without a naming
  dialog, by design; the sidebar's New Drawing shows the dialog. On the
  owner's request it now creates in the folder selected in the sidebar,
  or at the Workspace root when none is selected; when the selected folder
  is deleted the selection moves to its parent, and a renamed one stays
  selected. Unit tests and a browser test cover it. Moving drawings by
  dragging was recorded as a separate feature.
- Remaining gap: if a trashed drawing's file comes back by other means
  (for example "Put Back"), the tab stays marked as unavailable and "Close
  Without Saving" is refused, as before; closing the window clears it.

Owner conclusion (recorded by the owner, separately from the results
above):

- Date and build:
- Failed items and what was seen:
- Conclusion: accepted / accepted with conditions / not accepted

## Final summary

- Automated: every gate in "Final regression" passes on the final
  candidate. Performance shows no regression against `main`; the
  cold-start budget fails on both binaries because of the first launch
  after a build.
- Documented differences between the design notes and the code, where the
  code is what the documents describe: an event for a drawing or Workspace
  that no window holds is dropped rather than sent to another window; after
  Recovery the stored windows are recreated and an empty Recovery window
  closes; the preferences-changed event carries the appearance and
  language only; the menu target is the focused window, else the window
  focused most recently.
- Residual risks: the reference VM was not measured; the real macOS
  clipboard, the approved boards, maximized and full-screen restore, a
  disconnected display, the Dock menu, the Window menu after a language
  switch, and other desktop spaces rest on the owner walkthrough; the
  empty state's shortcut hints wait for shortcuts to exist.
- Owner conclusion: recorded in "Owner walkthrough", separately.
