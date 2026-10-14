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

Not run yet.

## Nested folders and file routing

Not run yet.

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
