# T023b exact-commit native revalidation

**Recorded:** 2026-09-07
**Status:** **PARTIAL — native Save error and exact window evidence resolved; T023b not closed**
**Product commit:** `668c6df14797ccc3625c93d5120796892a882cef`
**Implementation commit:** `f4f9943735ba7b0125186c00b31295d19a72d849`

This record covers the production macOS bundle built from the clean product
commit above. It is native behavior evidence only; it is not an independent
visual-review verdict or product-owner approval.

## Artifact and environment

| Item | Observed value |
| --- | --- |
| Bundle | `src-tauri/target/release/bundle/macos/Excalidraw.app` |
| Bundle ID / version | `excalidraw-desktop` / `0.2.0` |
| Executable | Mach-O arm64; SHA-256 `00c6566f3d93b80633be1672035c9a24199b2fee20e18fa9d4f99c194066edba` |
| macOS | 26.6.2 (25G83) |
| Main display | 1352 x 878 points; backing scale 2.0 |
| Native window | CG window 2602 at X=54, Y=30; exactly 1280 x 760 logical points |
| Raw captures | 2560 x 1520 pixels, uncropped, matching the 2.0 backing scale |

The pre-existing app process was older than the bundle and was quit normally.
The exact bundle was then launched with `open -na`; process-path inspection
resolved to this bundle before native observations began.

## Verified behavior

- The native menu bar exposed `File > Save`, `File > Export Image`, and
  `View > Appearance > System / Light / Dark` on the Tauri window whose webview
  URL was `tauri://localhost`.
- A controlled drawing under
  `/private/tmp/excalidraw-phase2-save-error.5nEbQv` was made dirty after its
  directory was changed to mode `0555`. Both `File > Save` and a human-assisted
  `Command+S` left the tab unsaved and exposed the runtime error
  `The filesystem operation failed.` The directory was restored to mode `0755`.
- Human-assisted `Command+Option+E` opened the application-owned
  `Export drawing` dialog with PNG/SVG, scale, background, theme, Export, and
  Cancel controls. Clicking `File > Export Image` opened the same dialog.
- Native Appearance selections rendered Dark, Light, and System. System matched
  Light on the current system. All three were observed at the exact 1280 x 760
  logical window size.

## Persisted captures

| Capture | Purpose |
| --- | --- |
| `native-window-1280x760.png` | Exact uncropped native window geometry |
| `native-save-error.png` | Runtime filesystem Save failure with unsaved tab |
| `native-export-dialog-command-option-e.png` | App-owned dialog opened by `Command+Option+E` |
| `native-appearance-dark.png` | Native Dark delegation |
| `native-appearance-light.png` | Native Light delegation |
| `native-appearance-system.png` | Native System delegation |

Hashes and exact environment values are recorded in `environment.json`.

## Remaining limitations

1. The exact `668c6df` run reached the native Save sheet boundary but did not
   complete new PNG and SVG writes before the session-end handoff. Older
   `d70d22c` evidence contains successful PNG/SVG writes, but it is not promoted
   to exact-commit proof.
2. T024 final focused validation was not run after this native session.
3. T018, T019, T021, T023b, and T024 remain unchecked in the authoritative
   private tasks file. No independent visual PASS or product-owner approval is
   claimed.
