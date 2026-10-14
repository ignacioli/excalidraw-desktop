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

Not run yet.

## Window size and placement

Not run yet.

## Empty Workspace state

Not run yet.

## Sidebar dialogs

Not run yet.

## Copy path

Not run yet.

## Performance

Not run yet.

## Owner walkthrough

Not run yet.
