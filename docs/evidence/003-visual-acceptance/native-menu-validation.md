# T023b macOS native application-menu validation

**Recorded:** 2026-09-04 01:10 PDT
**Status:** **FAIL (partial native evidence; not product approval)**
**Commit under test:** `e93ef40b5644392945d1569d2e17de06c65adb40` (`feat: route shell commands through native menu`)

The original record below is retained as historical evidence for `e93ef40`.
The dated revalidation for the corrective accelerator change is recorded in
the section immediately before the final verdict.

This record covers the actual Tauri macOS application bundle. It does not use
Chrome/PWA automation, private SDK DOM selectors, or the SDK default save/export
paths. The native UI observations below are evidence only; they are not a
visual PASS or product-owner approval.

## Platform and artifact

| Item | Observed value |
|---|---|
| macOS | 26.6.2, build 25G83 |
| Hardware | Apple M5 Pro, 16-core GPU |
| Main display | CoreGraphics `1352x878` pixels / `1352x878` points; measured scale `1.0x` |
| Requested viewport | 1280x760 was attempted by native window resize; the available capture reached approximately 893x760, so the exact 1280x760 condition was not achievable on this display and is **not claimed** |
| Bundle | `/private/tmp/excalidraw-003-build.GOGSBm/cargo-target/release/bundle/macos/Excalidraw.app` |
| Executable | `Contents/MacOS/excalidraw-desktop`, Mach-O arm64 |
| Bundle identifier | `excalidraw-desktop` |
| Version | `0.2.0` (`CFBundleShortVersionString` and `CFBundleVersion`) |
| Signing | ad-hoc linker signature; no Developer ID/notarization evidence was attempted |

Commands and results:

```text
sw_vers
ProductName: macOS
ProductVersion: 26.6.2
BuildVersion: 25G83

swift -e '... CoreGraphics ...'
pixels=1352x878
points=1352x878
scale=1.0

pnpm tauri build --bundles app
Finished 1 bundle at:
  /private/tmp/excalidraw-003-build.GOGSBm/cargo-target/release/bundle/macos/Excalidraw.app

plutil -p .../Contents/Info.plist
CFBundleIdentifier => "excalidraw-desktop"
CFBundleShortVersionString => "0.2.0"
CFBundleVersion => "0.2.0"

file .../Contents/MacOS/excalidraw-desktop
Mach-O 64-bit executable arm64
```

The built app was launched with `cua.getApp` using the bundle path above. The
accessibility tree identified a native macOS menu bar (`Excalidraw`, `File`,
`Edit`, `View`, `Window`, `Help`) on the real Tauri window titled
`Excalidraw Whiteboard`.

## Native menu discovery and actions

### File > Save

Native accessibility output after opening File:

```text
0 File, Secondary Actions: Cancel, Pick
  1 menu Secondary Actions: Cancel
    2 Save, ID: fireMenuItemAction:
    3 Export Image, ID: fireMenuItemAction:
```

On a persisted test drawing (`menu-validation.excalidraw`), clicking native
`File > Save` changed the shell status from `Unsaved changes` to
`All changes saved`. After creating a rectangle, pressing native `Cmd+S` also
changed `Unsaved changes` to `All changes saved`.

Source/contract corroboration: `src-tauri/src/native_menu.rs:62-69` declares
the native Save item and Cmd+S equivalent; `src/app/AppShell.tsx:317-318,332-336`
routes it to `DocumentManager.checkpointActive("manualSave")`; and the focused
test `src/app/AppShell.test.tsx:301-322` verifies rejection text
`native save failed`. The real bundle's Save error path was not induced safely
without mutating permissions or deleting test data, so a native runtime error
toast is **not claimed** here.

### File > Export Image

Clicking native `File > Export Image` opened the application-owned
`Export drawing` dialog (not the SDK export dialog). Its native accessibility
tree showed `PNG image`, `SVG image`, scale, background, theme, `Export…`, and
`Cancel`.

- PNG was selected and exported through the native Save sheet to
  `/Users/liyongqiang/Documents/menu-validation-export.png`. The dialog
  displayed `Exported to /Users/liyongqiang/Documents/menu-validation-export.png`.
  `file` verified a 40x40 RGBA PNG, 200 bytes.
- SVG was selected in the same application ExportDialog and exported to
  `/Users/liyongqiang/Documents/menu-validation.svg`. The dialog displayed
  `Exported to /Users/liyongqiang/Documents/menu-validation.svg`.
  `file` verified an SVG, 199 bytes.
- `find` found no temporary export residue for these names.

Source/contract corroboration: `src/app/ExportDialog.tsx:70-100` renders PNG/SVG
bytes then invokes `doc_export`; `src-tauri/src/commands/export.rs:130-154`
accepts the bytes and routes the write through the backend export service.
These exports therefore used the existing application/doc_export atomic-write
contract, not SDK default disk export.

### Historical keyboard-equivalent conflict (e93ef40)

The native Rust item declares `CmdOrCtrl+Shift+E` at
`src-tauri/src/native_menu.rs:63-69`. In the real launched bundle,
`Cmd+Shift+E` opened the SDK-owned `Export image` dialog with buttons
`Export to PNG`, `Export to SVG`, and `Copy PNG to clipboard`, rather than the
application `Export drawing` dialog. I closed that dialog with Escape without
invoking any SDK export. This was a contract failure in `e93ef40`: the native
keyboard path could bypass the required app-owned ExportDialog/doc_export
pipeline. The d70d22c revalidation below supersedes this result for the current
commit while keeping the original observation auditable.

### View > Appearance

Native accessibility output after opening View:

```text
0 View, Secondary Actions: Cancel, Pick
  1 menu Secondary Actions: Cancel
    2 Appearance
      3 menu Secondary Actions: Cancel
        4 System, ID: fireMenuItemAction:
        5 Light, ID: fireMenuItemAction:
        6 Dark, ID: fireMenuItemAction:
    7 Toggle Full Screen, ID: toggleFullScreen:
```

Clicking System, Light, and Dark each returned focus to the Tauri webview. The
active rendered shell/canvas visibly synchronized: System and Light rendered
light on this light macOS system; Dark rendered the dark shell, canvas, and
ExportDialog; restoring System returned to light. The source owner is
`src/app/AppShell.tsx:332-336`, which calls `ThemeController.setModePreference`,
and `src/app/theme/themeController.ts:108-117` persists and applies the mode.

## Shell and SDK-boundary checks

- The normal native AX tree showed only Back/sidebar controls, tabs, drawing
  status/canvas, and the native menu bar; no top-shell Save, Export, or
  Appearance controls were present.
- `src/editor/ExcalidrawEditor.tsx:141-147` keeps
  `saveToActiveFile: false` and disables SDK canvas export/toggle-theme entries.
- The SDK DOM was not inspected. The one observed SDK export dialog was noted
  only because the public keyboard action visibly opened it; it was not used.

## Automated corroboration

Commands run in the same worktree:

```text
pnpm vitest run src/app/nativeMenu.test.ts --reporter verbose
Test Files  1 passed (1)
Tests       2 passed (2)

pnpm vitest run src/app/AppShell.test.tsx -t 'routes native Save' --reporter verbose
Test Files  1 passed (1)
Tests       1 passed (1)

pnpm vitest run src/app/nativeMenu.test.ts src/app/AppShell.test.tsx \
  -t 'native|theme|disk-full' --reporter verbose
Test Files  2 passed (2)
Tests       6 passed, 14 skipped (20)

cargo test --manifest-path src-tauri/Cargo.toml native_menu
test result: ok. 2 passed; 0 failed
```

An earlier unfiltered two-file Vitest invocation during concurrent worktree
changes reported one failure in `routes native Save through DocumentManager`
(`Expected native save failed; Received Cannot read properties of undefined
(reading 'length')`). The same test passed when rerun alone and in the focused
native/theme/disk-full run above; this record does not treat the first run as a
clean full-suite result.

## d70d22c revalidation (2026-09-04 01:26 PDT)

### Artifact and launch

The exact current product commit was `d70d22c4de1927d5472c3b1062ac6f7e4d11439d`
(`test: add 003 visual shell harness`). A fresh
`pnpm tauri build --bundles app` completed with exit code 0 and produced:

```text
/private/tmp/excalidraw-003-build.GOGSBm/cargo-target/release/bundle/macos/Excalidraw.app
```

`cua.getApp` launched that bundle as the real Tauri window `Excalidraw
Whiteboard`; native AX again reported the macOS menu bar
`Excalidraw`, `File`, `Edit`, `View`, `Window`, `Help`. The bundle metadata
remained identifier `excalidraw-desktop`, version `0.2.0`, executable
`Contents/MacOS/excalidraw-desktop` (Mach-O arm64).

### Export accelerator separation

The current source declares `CmdOrCtrl+Alt+E` at
`src-tauri/src/native_menu.rs:18-19,65-72`, and the Rust regression test at
`src-tauri/src/native_menu.rs:201-209` asserts it is not
`CmdOrCtrl+Shift+E`.

- With an active persisted `menu-validation.excalidraw`, clicking native
  `File > Export Image` opened the application `Export drawing` dialog with
  PNG/SVG options.
- Pressing `Cmd+Option+E` with the canvas focused opened the same application
  `Export drawing` dialog. AX showed `PNG image`, `SVG image`, `Export…`, and
  `Cancel`.
- Pressing `Cmd+Shift+E` with the canvas focused opened the SDK `Export image`
  dialog (`Export to PNG`, `Export to SVG`, `Copy PNG to clipboard`). It did not
  open the application dialog and was closed with Escape without invoking SDK
  export. This confirms the SDK shortcut remains separate and is not treated
  as the app equivalent.

### Save, export, and appearance revalidation

- A new rectangle made the persisted drawing dirty; `Cmd+S` changed the shell
  status from `Unsaved changes` to `All changes saved`. In this d70d22c run,
  clicking native `File > Save` also left the persisted drawing at
  `All changes saved`; the current menu remained discoverable as `Save`.
- `Cmd+Option+E` ExportDialog PNG wrote
  `/Users/liyongqiang/Documents/-reval.png`; the dialog displayed the written
  path and `file` verified `PNG image data, 320 x 240, 8-bit/color RGBA` (8731
  bytes). The generated name is retained exactly as entered by the native
  Save sheet.
- The same dialog SVG path wrote
  `/Users/liyongqiang/Documents/menu-validation-reval.svg`; the dialog
  displayed the path and `file` verified `SVG Scalable Vector Graphics` (1746
  bytes). No temporary residue was found for either target.
- Native View > Appearance again exposed System, Light, and Dark. Light and
  System rendered the shell/canvas/ExportDialog light on this light macOS
  system; Dark rendered all three dark; restoring System returned to light.
  Screenshots were captured from the Tauri window after each selection.

The exact 1280x760 condition remains unavailable: the physical display is
1352x878 at 1.0x and the native resize reached approximately 893x760. The
runtime Save error path also remains uninduced safely; source and focused
rejection tests still provide only non-runtime error evidence.

Current-commit focused checks:

```text
cargo test --manifest-path src-tauri/Cargo.toml native_menu
test result: ok. 3 passed; 0 failed

pnpm vitest run src/app/nativeMenu.test.ts src/app/AppShell.test.tsx \
  -t 'native|theme|disk-full' --reporter verbose
Test Files  2 passed (2)
Tests       6 passed, 14 skipped (20)
```

## Verdict and limitations

**FAIL / partial evidence.** On the current `d70d22c` bundle, native menu
discoverability, click invocation, `Cmd+Option+E` application routing, Save
success, PNG/SVG application export, and three appearance states were
observed. The record cannot be accepted as a complete T023b PASS because:

1. A real runtime Save error message was not safely induced; only the source
   route and focused rejection tests prove the error contract.
2. Exact 1280x760 capture was unavailable on the 1352x878, 1.0x display.
3. No Developer ID, notarization, or Gatekeeper validation was attempted.

No production files, private specs, task checkboxes, or commits were changed
by this evidence task. Existing concurrent worktree changes were preserved.

## 2026-09-05 Phase 2 remediation revalidation

**Status: FAIL / partial.** The corrective working tree was based on
`fa7474920f56a76ffeacccaf2588f3212495f0c1`. An intermediate bundle built from
source patch `e96dc96769fe5e3ce690bb429b7630890fd2bdc0108c90601198207befb39c8a`
was launched directly from its `/private/tmp` bundle path. Accessibility
identified `tauri://localhost`, the corrected Welcome shell, and the native
macOS File menu with `Save` and `Export Image`.

On a memory-only Untitled drawing, native File > Save was invoked and the
drawing remained `Untitled, unsaved changes`; no visible error was exposed, so
this does **not** satisfy the required native Save-error evidence. Native
File > Export Image opened the application-owned `Export drawing` dialog with
PNG/SVG, scale, background, theme, Export, and Cancel controls. No export target
was selected and no user file was written.

After the final lint and responsive-token corrections, a fresh working-tree
bundle was built successfully at
`/private/tmp/excalidraw-003-phase2-final.m0xQv0/cargo-target/release/bundle/macos/Excalidraw.app`.
Its executable SHA-256 is
`9935bbf90b16a3c774ae82b8ac4950770cf0cb70c5c7f737d1c798fb6ea88170`,
bundle identifier `excalidraw-desktop`, version `0.2.0`, architecture `arm64`.
It was not launched for another Computer Use pass because the source remains
uncommitted and the already-known native 1280 x 760 and Save-error conditions
were still unavailable. T023b therefore remains open; this section is not a
native PASS or product approval.
