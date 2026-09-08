# Phase 2 independent visual review — VSL-001 first gate

> **SUPERSEDED BASELINE IDENTITY:** This 2026-09-04 blocked review used the then-current HF-2 assets and is retained only as historical failure evidence. The product owner approved Penpot revision 59 on 2026-09-06; its manifest and T008/T009 evidence now define the baseline. The hash recorded below MUST NOT be reused for current or future acceptance.

**Review date:** 2026-09-04
**Overall verdict:** **BLOCKED**
**Assigned screen verdict:** **FAIL — VSL-001 / 03 · Workspace · Pinned · Light**
**Product-owner decision:** **PENDING / no per-gate decision artifact present**

This is an independent blocking review, not implementation work. The reviewer did
not author the reviewed production UI and did not edit production source, tests,
private specs, task checkboxes, build configuration, or production assets.

## Independence and provenance

| Role | Identity | Result |
|---|---|---|
| Production implementation | **Unknown from the gate evidence.** Git author metadata for `d70d22c` is not an implementation-agent runtime identity. | **BLOCKED** — independence cannot be fully established from the evidence package. |
| Independent reviewer | `/root/phase2_independent_visual_review`; runtime configuration reported by the active reviewer as `gpt-5.6-sol`, `high` | Independent from the production UI; reviewer made no production changes. |

## Build and environment identity

| Item | Reviewed value |
|---|---|
| Product commit | `d70d22c4de1927d5472c3b1062ac6f7e4d11439d` (`test: add 003 visual shell harness`) |
| Browser actual | `e2e/test-results/tests-ui-desktop-shell-vis-976ec-t-with-exact-shell-geometry-browser-ui/workspace-pinned-light.png`; 1280×760 PNG; Light; fixture id `pinned`; SHA-256 `98bc0a1108d3d303e4ef3f7cd32d951446aac9ff118556722172374cfc93dbd8` |
| Browser provenance gap | No `environment.json`; browser/build version is not recorded. The actual was modified at 2026-09-04 01:08:31 PDT, before the reviewed commit timestamp, so exact commit provenance is not independently established. |
| Frozen baseline | `docs/design/desktop-shell/hf-2/screens/workspace-pinned-light.png`; 1280×760 PNG; manifest SHA-256 verified as `040f6dfaf02fe94b665a6d1c34e38b983b0edbb96a871789bac65966c17e528f` |
| macOS package | `/private/tmp/excalidraw-003-build.GOGSBm/cargo-target/release/bundle/macos/Excalidraw.app`; bundle id `excalidraw-desktop`; version/build `0.2.0`; arm64 |
| Native environment | macOS 26.6.2 (25G83), display 1352×878 at recorded 1.0× scale; native window approximately 893×760, not the required 1280×760 |

The app bundle path and its `Info.plist`/Mach-O identity were independently
read back. Native action observations and display scale come from the untracked
`native-menu-validation.md` record; that record does not persist its claimed
screenshots.

## Screen matrix

| Gate | Screen | Status | Evidence | Mismatch count |
|---|---|---|---|---:|
| VSL-001 | 03 · Workspace · Pinned · Light | **FAIL** | Baseline: `docs/design/desktop-shell/hf-2/screens/workspace-pinned-light.png`; actual: `e2e/test-results/tests-ui-desktop-shell-vis-976ec-t-with-exact-shell-geometry-browser-ui/workspace-pinned-light.png` | 7 reviewer-observed structural/state mismatches; no machine-readable count exists |

The other five browser screenshots exist and are all 1280×760, but they were
not visually accepted in this one-screen review. They are browser preflight
captures only. Six files in `e2e/test-results/` cannot become final evidence
without per-screen `environment.json`, `baseline.sha256`, `actual.png`,
`mask.json`, `diff.png` where applicable, `report.json`, `report.md`, native
package evidence, and a separate `product-owner-decision.md`.

## VSL-001 findings

| Severity | State | Expected | Actual | Reproduction / evidence |
|---|---|---|---|---|
| **HIGH** | Restored + Pinned + Light | The deterministic restored fixture and HF-2 baseline show document Tabs in the center top layer. | The screenshot has no Tab at all, even though `PINNED_SHELL_FIXTURE` inherits `activeDocumentId` and `tabs: [CLEAN_TAB]`. | Inspect the VSL-001 actual and `e2e/fixtures/003-shell-fixtures.ts:184-201`; compare `DESIGN.md:31-36` and the baseline. |
| **HIGH** | Restored active document | The active drawing occupies the editor boundary beneath the active Tab. | Center content says `Select a drawing to begin.`; the declared active document is not represented. | Same actual/fixture paths as above. |
| **HIGH** | Three-region shell | The right SDK Library/Presentation boundary remains visibly represented and its perimeter is reviewable. | The actual has no right SDK region/boundary; the center empty state expands across the remainder. | Compare VSL-001 baseline with actual; contract at `DESIGN.md:28-36`. |
| **HIGH** | Current Workspace header | One compact, single-line Current Workspace name row with the four approved actions; header actions do not displace or clip the name. | `Design Workspace` wraps to two lines; a separate pin control sits above; `Mount folder...` consumes header width and visibly forces the old 002 composition. | VSL-001 actual; `DESIGN.md:52-59`; HF-2 baseline. |
| **HIGH** | Legacy removal | `headerActionOverflow = 0`; no clipped/overflowed Mount-folder header action. | Reviewer-observed `headerActionOverflow = 1`. The automated selector only counts elements explicitly labelled/marked as overflow and therefore misses this visible layout failure. | VSL-001 actual; automated selector at `e2e/tests/ui-desktop-shell-visual.spec.ts:342-344`. |
| **MEDIUM** | Workspace row default/context state | Vertical-ellipsis row action is hidden when both pointer and keyboard focus are absent; focus is component-local and state-specific. | The root-row vertical ellipsis is visible while a blue focus outline surrounds the entire tree region, so the capture is not the approved default row state. | VSL-001 actual; `components.md:37-47`. |
| **HIGH** | Baseline comparison method | Visual comparison uses the frozen baseline, declared SDK-only masks, and the plan tolerance; structural mismatches remain zero-tolerance. | `compareCropStability` captures the same actual component twice and asserts byte equality/max diff 0. It never compares actual to the HF-2 baseline, so the passing harness result is determinism proof, not visual fidelity proof. | `e2e/tests/ui-desktop-shell-visual.spec.ts:377-408`; no gate `diff.png` or `report.json` exists. |

## Legacy-removal matrix — VSL-001 actual

These are reviewer-observed visible counts for the actual screenshot. They are
not a substitute for the absent machine-readable `report.json`.

| Canonical check | Observed count | Status |
|---|---:|---|
| `globalNewDrawing` | 0 | PASS |
| `textSidebar` | 0 | PASS |
| `largePinUnpin` | 0 | PASS |
| `topLevelSaveExportAppearance` | 0 | PASS |
| `autosaveStrip` | 0 | PASS |
| `tabScrollbar` | 0 | PASS |
| `sidebarScrollbar` | 0 | PASS |
| `placeholderIcons` | 0 | PASS |
| `horizontalEllipsis` | 0 | PASS (the visible glyph is vertical, but its always-visible state is a separate component-state failure) |
| `duplicateWorkspaceRoots` | 0 | PASS |
| `headerActionOverflow` | **1** | **FAIL** |

Any visible legacy count above zero is blocking; VSL-001 therefore fails even
before the missing evidence artifacts are considered.

## Masks, SDK boundary, geometry, fonts, and tolerances

- **SDK-private selector dependency:** source-level preflight passes. The shell
  selector list uses `.excalidraw-editor` only as the public boundary and the
  test rejects a known private `.App-menu__items` selector. No SDK-private
  selector was found in the visual harness.
- **Mask evidence:** **BLOCKED.** No VSL-001 `mask.json` exists. No stable SDK
  selector/rectangle, perimeter check, or mask rendering is tied to this actual.
  No mask was assumed during this review.
- **Geometry:** the harness checks only the first workspace action hit target
  (32 px), its icon width (16 px), and a Workspace row height (28 px), with the
  approved ±2 px geometry tolerance. It does not prove Tabs, three-region
  boundaries, canvas share, header fit, typography, overflow, or shell hierarchy.
- **HF2-FONT-001:** the browser code waits for `document.fonts.ready`, checks
  declared platform stacks and zero remote font requests, and checks for a
  replacement glyph. However, no `environment.json` records the computed UI
  and mono families, and VSL-001 does not use the Unicode fixture. Exact font
  size, weight, line-height, truncation, wrapping, and header layout are not
  persisted. The required font evidence is therefore **BLOCKED**.
- **Raster tolerance:** plan threshold is `maxDiffPixelRatio <= 0.01` for
  same-semantic component crops only and is auxiliary. It was not applied to
  baseline-vs-actual pixels here. No raster ratio is claimed; structure,
  hierarchy, typography, overflow, and legacy counts remain zero-tolerance.

## Native application-menu evidence

The current-commit native record demonstrates useful partial evidence for the
real macOS package: menu discovery, click invocation, `Cmd+S`, `Cmd+Option+E`,
PNG/SVG output through the application dialog, and System/Light/Dark visible
synchronization. It also records that `Cmd+Shift+E` remains SDK-owned and was
not treated as the application Export equivalent. Source inspection retains
`saveToActiveFile: false`.

Native acceptance remains **BLOCKED** because the same record explicitly marks
itself `FAIL / partial`: a real runtime Save error was not induced, the native
window was not captured at 1280×760, and the claimed theme/menu screenshots
have no persisted evidence paths. The missing Save error is directly within
the revised native-menu contract; source and unit-test corroboration cannot
replace native runtime proof.

## Additional blockers and unverified items

1. The required per-gate evidence directory and files do not exist under
   `docs/evidence/003-visual-acceptance/<commit>/<gate-id>/`.
2. Implementation-agent/task identity is absent, so reviewer independence
   cannot be fully established from the evidence package.
3. The product worktree's `specs` symlink resolves to shared private specs
   `main@0ff85cd`, which lacks the revised native-menu requirements. The revised
   contract was found only in the separate private specs worktree at
   `codex/excalidraw-desktop-003-ux-ui@dbc7696`. Final evidence must identify one
   authoritative specs revision rather than silently mixing them.
4. Keyboard focus, hover, selected, disabled, reduced-motion, truncation,
   overflow, and complete Light/Dark state evidence are not present for this
   gate.
5. Native signing/notarization is not a requirement for this repository's
   permanently unsigned release policy and is not used as a blocker here.

## Next gate

Implementation remediation is required before another independent review:

1. Make the pinned restored fixture produce the same semantic state as the
   baseline (Tabs, active document, three-region boundary, compact header).
2. Remove the visible header overflow/legacy composition and capture the
   approved default/context states separately.
3. Generate the complete VSL-001 evidence package with verified commit/build
   provenance, allowed SDK masks, font/geometry assertions, real baseline
   comparison, and machine-readable counts.
4. Complete native 1280×760 package evidence and safely demonstrate the Save
   runtime error path without deleting or exposing user data.
5. Run another independent VSL-001 review. Only after it passes should the
   remaining five screens be inspected one at a time. Product-owner review is
   a later, separate gate and is not supplied by this report.
