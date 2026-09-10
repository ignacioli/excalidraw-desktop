[English](quickstart.md) | [简体中文](quickstart.zh.md)

# Getting started and verification: Excalidraw Desktop

**Date**: 2026-08-04 | **Last updated**: 2026-08-24 | **Architecture**: [architecture.md](./architecture.md) | **Design contract**: [../DESIGN.md](../DESIGN.md) | **IPC contract**: [contracts/ipc-contracts.md](./contracts/ipc-contracts.md) | **ADR-009**: [adr/ADR-009-desktop-ui-interactions.md](./adr/ADR-009-desktop-ui-interactions.md)

This file explains how to run Excalidraw Desktop locally and how to check behavior against **product capabilities**. Implementation detail lives in the source and in [architecture.md](./architecture.md); it is not repeated here.

Verification evidence must be reported by source and **must not substitute for another source**:

| Evidence class | What it can prove | What it cannot prove |
|----------------|-------------------|----------------------|
| Browser Playwright | In-app dialogs, the continuous tree, overlay/pinned layout, keyboard, and a11y | Trash Put Back, Finder, system title-bar color, real pointing devices |
| `APP_E2E=1` process-level | Filesystem changes, close queues, recovery, conflicts, out-of-bounds rejection | Operator-visible native title-bar tint, window occlusion / minimize |
| Physical macOS (or a recorded macOS VM) | Window title `Excalidraw Whiteboard`, system title-bar color, normal stacking, Trash/Finder, Gatekeeper | Browser results cannot be claimed as this coverage |

The native-window matrix and reference-environment performance measurements are **not pre-filled pass/fail in this file**. Unrun checks stay unrun. Budget failures must still be recorded honestly, but they do not block merge or open-source release (ADR-004).

## 1. Prerequisites

| Platform | Requirement |
|----------|-------------|
| Common | Node.js 22.13+ (required by pnpm 11.20.0), pnpm (locked as the only package manager), Rust stable 1.80+ (rustup), Python 3.10+ and uv (font merge at build time only; the interpreter is pinned by `.python-version`; dependencies are declared by `pyproject.toml` + `uv.lock`; `uv run` installs them) |
| macOS | Xcode Command Line Tools. The project does not need Developer ID, signing, or notarization. On first launch of an unsigned build, follow the Gatekeeper manual-allow steps in the README |
| Ubuntu 24.04 Desktop (optional) | `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, and other Tauri 2 system dependencies. Optional single-environment smoke test. Fedora / other Linux distros are not in the current acceptance requirement |

## 2. Build and run

Use the script names in the root `package.json`:

```bash
pnpm install                 # frontend dependencies
pnpm fonts:build             # build-time Virgil-CJK font merge (uv resolves pyproject.toml deps into public/fonts/)
pnpm tauri dev               # development run
pnpm tauri build             # production bundle (dmg / AppImage / deb / rpm)

# quality gates (same as CI)
pnpm lint && pnpm typecheck && pnpm test          # frontend
cargo fmt --manifest-path src-tauri/Cargo.toml --check && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings && cargo test --manifest-path src-tauri/Cargo.toml
APP_E2E=1 pnpm e2e           # Playwright desktop E2E (test-only build; exposes the fault-injection harness)
```

Process-level cases also require `EXCALIDRAW_E2E_BINARY` to point at a test binary built with `--features e2e-harness`. Production builds must not register the harness, and must not register `thumb_lookup` / `thumb_store`.

Related suites (verification entry points; this file does not claim they have passed): `e2e/tests/ui-sidebar-modes.spec.ts`, `e2e/tests/us3-workspace-files.spec.ts`, `e2e/tests/native-entry-mutations.spec.ts`, `e2e/tests/native-tab-close.spec.ts`, `e2e/tests/native-window-contract.spec.ts`, `e2e/tests/us7-thumbnails.spec.ts` (asserts thumbnail commands are not called).

## 3. Verification scenarios (by product capability)

### Offline create, edit, and save

1. Disconnect the network → start the app → create a drawing, draw shapes + Chinese text + drop in an image.
   - Expected: full function available; Chinese renders in the hand-drawn font (no system-font fallback); DevTools Network shows zero external requests.
2. Save with `Cmd/Ctrl+S` → quit → reopen that file.
   - Expected: content matches; the file imports cleanly on official excalidraw.com.
3. Inspect the main-window content area and the native frame.
   - Expected: ordinary system-decorated window titled `Excalidraw Whiteboard`; the canvas fills by default with no empty right pane; when the sidebar is not pinned it is an overlay (covers the canvas, does not change the canvas box); after pin it enters the layout and shrinks the canvas column; no browser/PWA chrome or account, Excalidraw+, collaboration, or cloud-service entry points. System title-bar color is OS-controlled (physical macOS evidence). Content light / dark / follow-system resolve independently.
4. Select Light, Dark, and Follow system in turn; while on Follow system, change the OS appearance; then restart with each of the three preferences.
   - Expected: shell and canvas stay in sync; only Follow system reacts to a live OS change; the first interactive frame after restart does not flash the opposite theme; light/dark screenshot baselines use `maxDiffPixelRatio <= 0.001`. The title bar is not force-tinted by the content theme.
5. Start after injecting an unknown `themeId`, an unknown mode, and a corrupted versioned appearance preference.
   - Expected: safe fallback to Follow system; the app reaches an interactive state; open or saved `.excalidraw` content is unchanged.
6. In Light and Dark, operate tabs, the workspace empty state, appearance selection, and file dialogs with the keyboard only, with Reduce Motion enabled.
   - Expected: keyboard loop and focus order are correct; focus is always visible; state is not color-only; non-essential animation is removed or reduced; applicable WCAG 2.2 AA contrast passes; automated scans have 0 serious/critical issues.

### Crash recovery and atomic write

1. **Kill during save**: on an `APP_E2E=1` build, inject `SIGKILL` at each of the eight atomic-write fault points `temp_created`, `mid_write`, `temp_synced`, `json_validated`, `before_rename`, `after_rename`, `before_parent_sync`, `parent_synced` → restart. PRs run every point deterministically; planned reliability work also runs and records 100 random seeds.
   - Expected: at each fault point the destination file is a parseable complete old version or complete new version; no silent overwrite; the recovery dialog appears and recovered draft content matches the last persistence window. The harness interface does not exist in production builds.
2. **Snapshot self-damage**: the harness corrupts the newest `recovery-00N.json` → trigger recovery.
   - Expected: automatic fallback to the next-newest snapshot, with a prompt that names the actual recovery timestamp.
3. **Clean quit**: edit, quit normally → restart.
   - Expected: no recovery dialog; content is on disk.

Atomic writes, the draft window, and recovery snapshots are the current reliability contract. Shell or IPC changes do not relax them.

### Workspace tree and entry management

The production list/mutation commands are `workspace_entry_list` / `workspace_entry_create` / `workspace_entry_rename` / `workspace_entry_delete_preflight` / `workspace_entry_delete` / `workspace_entry_reveal`, **not** `dir_list` or `file_*`.

1. Mount a workspace with nested directories → create drawings/directories, rename, and delete through in-app dialogs; open multiple tabs.
   - Expected: naming dialogs default to `Untitled` / `Untitled Folder`; the drawing extension `.excalidraw` is fixed and not editable; nothing is created before confirm; cancel is a zero mutation; a name collision keeps the dialog and shows an inline error, and does not overwrite. Tabs follow rename; a clean entry delete goes to the system Trash (physical macOS: Put Back works). Each tab has an independent undo history.
2. Delete an open dirty drawing; delete a directory that contains any child (including hidden / unsupported files).
   - Expected: dirty delete is blocked and the matching tab is focused; a non-empty directory is blocked, with Cancel and Open in file manager (reveal only after an explicit user choice). Emptiness is a real Rust `read_dir`, not the tree's filtered view.
3. Expand several workspaces at once → browse on a single continuous scroll surface.
   - Expected: titles and children stack vertically with no overlap and no horizontal scroll; no canvas-content thumbnails. Frame rate and memory for a 10k-scale tree are measurement items; this file does not pre-fill pass/fail.
4. Call `workspace_entry_list` (or an equivalent entry command) with a `../` path that escapes the workspace.
   - Expected: `PATH_ACCESS_DENIED`. The frontend branches only on `code` and does not parse `message`.

The browser can cover dialogs, the tree, and the keyboard. Process-level proof of Trash/Finder/`PATH_ACCESS_DENIED` needs `APP_E2E=1`. Physical macOS: deleting an empty drawing / empty directory goes to Trash and can be Put Back; after a non-empty directory is blocked, Finder opens only if the user chooses that. When scrolling the tree with a real trackpad/wheel, menus must flip inside the viewport.

### External changes, conflicts, orphan close, and tab switching

1. The in-app document has no edits → an external editor rewrites the file.
   - Expected: auto-reload within about 3 seconds + a light toast.
2. The in-app document has unsaved edits → an external rewrite.
   - Expected: conflict dialog (take the external version / keep the local draft / save as a new file). Zero writes to the target file until the user decides.
3. An external delete of an open file → close that orphan tab.
   - Expected: the tab is marked orphaned; close offers Save As / Discard / Cancel; `doc_close` with `discardOrphan` does not checkpoint a path that is already gone. Cancel leaves the tab open.
4. A script writes the file 20 times in 1s (cloud-sync storm).
   - Expected: events coalesce; no dialog flood.
5. Close several tabs in a row, or switch rapidly with the scroll wheel.
   - Expected: closes are serialized; a failure stops the batch; activation applies only the latest intent. The browser can measure queue behavior. Real Cmd+W / middle-click hits need physical macOS; harness-synthesized events must not be claimed as proof of the real shortcut.

### Export

1. Export a mixed Chinese/English canvas as PNG (2x / transparent) and SVG → open the SVG in a clean environment with no fonts installed.
   - Expected: the SVG embeds WOFF2 with no font fallback; Playwright screenshot baselines use `maxDiffPixelRatio <= 0.001`; PNG size = canvas × scale.
2. Export to a read-only directory.
   - Expected: a clear error; no leftover partial files.

### System integration and native window

1. Install a GitHub Release-class artifact on a recorded macOS VM or a physical machine → double-click a `.excalidraw` file in Finder. Ubuntu 24.04 may optionally run the matching smoke test.
   - Expected: the app starts and opens that file; if the app is already running, it reuses the instance and opens a new tab.
2. First launch of an unsigned, unnotarized macOS artifact.
   - Expected: Gatekeeper may block; the README/Release warns about the risk and gives user-initiated manual-allow steps; after that override the app runs.
3. Check the native-window contract (see ADR-009).
   - Expected: title is `Excalidraw Whiteboard`; ordinary decorated `Visible` window; title-bar color is system-controlled; other apps can occlude it; it can minimize and restore; production is not always-on-top. `e2e_harness` always-on-top under `EXCALIDRAW_PERF_CONTROL_DIR` must not appear in production. On first launch the sidebar is hidden; **Workspace sidebar** opens as overlay and does not change the canvas box; pin enters the layout; overlay closes 500ms after the pointer leaves unless focus/menu/dialog/drag still holds it; Escape closes overlay unless a dialog or menu already consumed Escape.
4. Optionally install AppImage/deb on Ubuntu 24.04 Desktop. rpm is a best-effort artifact; other Linux distros are not required for acceptance.
   - Expected: the application-menu entry and file-icon association work.

Step 3's system-tinted title bar and window management are physical macOS evidence. Statically reading `tauri.conf.json` can only check the title string; it does not replace looking at the title bar.

Prepare a native validation run only from an existing empty absolute directory and an exact production-package manifest. Select the real isolation boundary supplied by the operator; preparation does not claim that the OS honored it:

```bash
pnpm native:screen:prepare -- \
  --checkpoint VSL \
  --package-manifest <absolute-sealed-package-manifest.json> \
  --run-root <absolute-empty-run-root> \
  --plan <absolute-new-capture-plan.json> \
  --isolation-mode ephemeral-vm
```

Use `FINAL` for the six-screen final plan. Allowed isolation modes are `disposable-macos-user`, `ephemeral-vm`, and `verified-os-home-redirect`. The command provisions only safely representable repository-declared fixture data, records each screen's `fixture|operator-assisted` preparation mode, creates one distinct profile per screen plus a separate native-entrypoint profile, and writes an immutable nonce-bound plan. It does not write private WebKit storage. The production ready probe is inert without the plan/gate/nonce launcher environment. Runtime app-data and WebKit paths must still resolve inside the selected profile or the later collector returns `BLOCKED`.

Run capture and, when it prints `OPERATOR_SETUP_REQUIRED`, use normal application UI to establish the exact printed target within 600 seconds. Those actions are setup only and create no interaction PASS; focused tests and the semantic Playwright collection own that evidence. The observation-only ready probe must independently attest the state before capture proceeds:

```bash
pnpm native:screen:capture -- \
  --plan <absolute-capture-plan.json> \
  --gate VSL-001 \
  --collection-dir <absolute-new-collection-dir>

pnpm native:screen:capture -- \
  --plan <absolute-final-capture-plan.json> \
  --all-final \
  --collection-root <absolute-new-final-collection-root>
```

The collector matches the launched child to one bundle-owned window, calls macOS window-only capture, verifies raw dimensions as exactly `1280×760 × backingScale`, and emits `actual.png` through one `lanczos3-srgb-v1` proportional normalization. It never automates application content, uses full-screen/coordinate search, crops, pads, stretches beyond scale normalization, or performs visual repair. Every output directory must be absent. Exit codes are `0=PASS`, `1=FAIL`, `2=BLOCKED`, and `64=invalid invocation`.

For final-package native entrypoint collection, provide that FINAL plan together with the sealed manifest and immutable binding. The output path must not exist:

```bash
pnpm native:macos:validate -- \
  --manifest <sealed-package-manifest.json> \
  --capture-plan <final-capture-plan.json> \
  --collection-dir <new-native-entrypoint-collection> \
  --binding <evidence-binding.json>
```

The adapter writes collector-owned `environment.json`, `route-acknowledgements.json`, `filesystem-outcomes.json`, `native-report.json`, and `collector-report.json`. It never writes reviewer or product-owner state. Publish a completed VSL-001 or FINAL-003 gate only after all required roles have sealed their own artifacts:

```bash
pnpm evidence:publish -- \
  --source <sealed-gate-dir> \
  --destination docs/evidence/003-visual-acceptance/<commit>/<gate-id>
```

The destination must be new and remain inside the 003 evidence root. Publication validates digests and role boundaries, copies every source byte unchanged, re-hashes source and destination, and writes `<gate-id>.publication.json` adjacent to the copied tree. Exit codes are `0=PASS`, `1=FAIL`, `2=BLOCKED`, and `64=invalid invocation`.

### Read-only evidence aggregation

Every mode reads immutable inputs, validates raw artifact bytes and transitive bindings, and writes only a new requested output. It never edits source evidence, reviewer/owner artifacts, the product repository, or `tasks.md`:

```bash
pnpm evidence:aggregate -- --mode delta --product-root <path> --checkpoint-map <json> --final-commit <sha> --ownership-map e2e/visual/003EvidenceOwnership.json --output <new-json>
pnpm evidence:aggregate -- --mode technical --input <final-input.json> --output-dir <new-dir>
pnpm evidence:aggregate -- --mode task-proof --tasks <tasks.md> --proof-source <proof-source.json> --output <new-map.json>
pnpm evidence:aggregate -- --mode closure --technical-report <report.json> --task-proof-map <map.json> --tasks <tasks.md> --self-task <id> --output-dir <new-dir>
pnpm evidence:aggregate -- --mode closure-verify --closure-report <report.json> --tasks <tasks.md> --output <new-json>
```

`delta` requires a clean product HEAD and classifies every changed path through the versioned ownership map; zero or multiple owners is `BLOCKED`. `technical` requires six distinct final screen collections plus package and regression claim sets, and independently validates every referenced artifact digest. `task-proof` requires exactly one proof record per task. `closure` permits only the declared unchecked self task; it computes the expected post-transition hash but does not edit the task. After the human/task writer changes exactly that checkbox, `closure-verify` validates the expected hash. Exit codes are `0=PASS`, `1=FAIL`, `2=BLOCKED`, and `64=invalid invocation`.

### Multiple workspaces and asset deduplication

1. Mount two workspaces → they appear side by side in the same continuous tree and can be removed independently (disk files are not deleted).
2. Browse the file list.
   - Expected: canvas thumbnails are **not** generated; production and browser paths must not call `thumb_lookup` / `thumb_store`. Real images inside `.excalidraw_assets` still load; the asset protocol is not a thumbnail cache.
3. Paste the same 10MB image 10 times → save.
   - Expected: document size growth ≤5% (asset deduplication).

## 4. Performance fixtures (regression baselines)

| Metric | Fixture | Threshold |
|--------|---------|-----------|
| Cold start | Clear app test data, run 10 cold process launches; monotonic clock from process start → canvas is editable, then compute P95 | ≤2s |
| Idle memory | After 30s of startup settle, sample 60s; aggregate RSS P95 of the Tauri main process and related WebView/GPU process tree | ≤500MB (ADR-007) |
| Idle CPU | After soak, wait for crash-safe flush, then sample 60s process-tree CPU P95, normalized to one logical core | ≤35% of one logical core (ADR-007) |
| Large-scene frame rate / memory | 10k-element fixed fixture + constant pan/zoom script; collect frame times and process-tree RSS after the scene is stable | ≥30fps, target 60fps, no >100ms freeze, RSS ≤950MB (ADR-007) |
| Write coalescing | 60s continuous-draw script + write counts on app-managed paths | writes ≤1% of events, and no persistence frame-time spikes |
| Long-run stability | After warmup, scripted editing for 15min, compare process-tree RSS; wait 5s for crash-safe flush, then idle 60s for CPU and writes | RSS growth ≤50MB **and** ≤15%; idle CPU ≤35%; zero sustained writes (ADR-006/007) |

Reference-environment cold-start / canvas I/O / soak measurements run in full on the declared Parallels Desktop Pro 26.4.1, macOS 26.5.2, 4 vCPU / 8GB reference VM. The workflow still uses the `self-hosted`, `macOS`, `ARM64`, and `excalidraw-perf` labels. Reports record host hardware, virtualization product/version, guest OS, WebView, vCPU, and memory, and emit a real `pass`/`fail`. Budget failure does not block merge or open-source release. A change to the reference configuration requires a new independent measurement series and an ADR update. Do not mix incomparable results or silently relax budgets. Incomplete measurements must not be written as passed.

Fixtures emit JSON reports with schema version, commit, hardware model, memory, exact OS/WebView versions, samples, statistics, budget, and verdict. They must not include machine-unique identifiers or secrets. Aggregation must cover the Tauri main process and related WebView/GPU processes, and the report must name any exclusion that could not be attributed. A performance regression is a defect (constitution principle IV).

## 5. Chinese IME verification (Linux target-OS matrix item)

While composing Pinyin, the candidate window tracks the canvas text caret (including after zoom/pan); composition events neither drop nor duplicate characters. Native macOS acceptance is required. Ubuntu 24.04 may optionally run one recorded-configuration smoke test. Fedora / other Linux and a full display-protocol / IME matrix are not requirements of this version.

## 6. Evidence rollup and shared gates

Full-regression results and the three evidence classes (browser UI, `APP_E2E=1` process-level reliability, recorded native OS environment matrix) are recorded in `docs/evidence/validation-summary.md`. This file does not repeat that detail.

**Reliability merge gate**: the following three fault suites are a combined merge blocker. Any failure blocks merge, and a result from a suite outside this file must not substitute:

1. `e2e/tests/us2-kill-during-save.spec.ts`: SIGKILL at each of the eight atomic-write fault points; the destination file must be a complete old or complete new version, and recovery UI must be correct;
2. `e2e/tests/us2-snapshot-corruption.spec.ts`: a damaged snapshot falls back to the next-newest and names the actual recovery timestamp;
3. `e2e/tests/us4-external-changes.spec.ts`: external-change auto-reload / conflict / orphan Save As, with zero writes until the user decides.

How to run: `APP_E2E=1 pnpm e2e` with `EXCALIDRAW_E2E_BINARY` pointing at the fault-injection test build (production builds have no harness interface).

**Performance reference measurement**: cold start / canvas I/O / 15-minute soak run in full on Parallels Desktop Pro 26.4.1, macOS 26.5.2, 4 vCPU / 8GB VM, with `PERF_REFERENCE_RUN=1`, `PERF_EXECUTION_ENVIRONMENT=virtual`, `PERF_HOST_HARDWARE`, `PERF_VIRTUALIZATION_NAME="Parallels Desktop Pro"`, and `PERF_VIRTUALIZATION_VERSION`. Reports must emit a real `pass`/`fail`, but budget failure does not block merge or open-source release. Results from different environments are not compared directly. Before/after a shell or IPC change must be recorded separately; architectural intent must not be written as an already-measured improvement.

When running manually inside the reference VM, replace the last item with the exact installed Parallels Desktop Pro version:

```bash
VITE_E2E_HARNESS=1 pnpm tauri build --features e2e-harness

PERF_TEST=1 \
PERF_REFERENCE_RUN=1 \
PERF_EXECUTION_ENVIRONMENT=virtual \
PERF_HOST_HARDWARE="Apple M5 Pro / 48GB" \
PERF_VIRTUALIZATION_NAME="Parallels Desktop Pro" \
PERF_VIRTUALIZATION_VERSION="26.4.1" \
pnpm exec playwright test \
  --config=e2e/playwright.config.ts \
  --project=browser-ui \
  --retries=0 \
  e2e/perf/startup-idle.spec.ts \
  e2e/perf/canvas-io.spec.ts \
  e2e/perf/edit-soak.spec.ts
```

To run via GitHub Actions, first install a self-hosted runner on that macOS VM with the `self-hosted`, `macOS`, `ARM64`, and `excalidraw-perf` labels, set repository variables `PERF_HOST_HARDWARE` and `PERF_VIRTUALIZATION_VERSION`, then manually dispatch `performance.yml`.

**Open-source distribution**: macOS artifacts are published long-term to GitHub Releases unsigned and unnotarized. The project does not plan an App Store listing, Developer ID, or Apple notarization. The README and release notes must disclose the Gatekeeper risk and the user-initiated manual-allow steps.
