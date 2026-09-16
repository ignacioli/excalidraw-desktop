# HF2-02 independent visual review

- **Verdict:** FAIL
- **High:** 1
- **Critical:** 0
- **Mismatches:** 1
- **Owner requirement:** NOT_REQUIRED; no owner artifact was created
- **Independence:** Confirmed. Reviewer `/root/hf202_visual_review` did not author or modify the production UI, validation harness, or immutable browser collection. Implementation identity is `/root` at commit `a81e3f74a6404d301a2b52a06b4631cef815f027`; the reviewer identity is distinct.
- **Runtime:** `gpt-5.6-sol`, reasoning effort `high`

## Binding

- Reviewed product commit: `a81e3f74a6404d301a2b52a06b4631cef815f027`
- Current repository HEAD at review time: `4e6d1b1a17b0849c7777ed04cdfe6c7ecfcd578e` (not substituted for the collection binding)
- Browser build: `browser-ui`; `darwin/arm64`; semantic-browser route
- Viewport: 1280×760 CSS px; Light; Sidebar Hidden; Restored session; deterministic `restored-recovery` fixture
- Browser capture scale: 1, derived from the 1280×760 PNG matching the 1280×760 CSS viewport; physical macOS display scale is not claimed
- Font state: `document.fonts.ready=true`; remote font requests `0`
- HF-2 manifest SHA-256: `b3676f5a8c623a84b9c9e714ec9e1ef436df329db9034873c695f32d4f7cb0f1`
- Baseline: `02 · Restored · Hidden · Light`, SHA-256 `0a8bc3c5ad8052a53225a98f2820b34c1969a936d2fe940b77593d4c135f3a79`
- Collector report SHA-256: `5ad1a94100f7c8d787913d1725af0b6577efb72b6bb6c78f6b1c2453b58b9e28`
- Collection: `HF2-02-light-hidden-browser` / `0d3e1c937d52d062c365dc894bd30e6973aad55c9401a54a986b5a5fe7d9ebb2` / collector PASS
- Actual SHA-256: `b0856389b9a9d841dad3efe04c221a4d74a5db492a065fc5ac62ce5d28a3eb12`
- Mask SHA-256: `60e6f90397cf1bbe64db7f78e8177cb6d24da14118d1cd188e718a962abe18a9`

Every declared artifact hash and the canonical collection digest were recomputed and matched before review.

## Screen matrix

| Screen | Status | Evidence | Mismatches |
| --- | --- | --- | ---: |
| 02 · Restored · Hidden · Light | FAIL | `collection/HF2-02-light-hidden-browser/actual.png` | 1 |

## Visual and composition checks

| Check | Result | Observation |
| --- | --- | --- |
| Hidden Sidebar reflow | PASS | The Sidebar releases its visible space; compact controls and Tabs occupy the left of the top shell, and the canvas spans the window below. |
| Compact far-left controls | PASS | Sidebar and Back are compact icon controls; no textual Sidebar or large Pin/Unpin control is visible. |
| Tab geometry | PASS | Collector-owned evidence records the first Tab at x=88 and the 196×36 Tab geometry within the approved tolerance. |
| Recovery notice | PASS | `Recovered · 3 drawings restored` is present with the approved restrained hierarchy and placement. |
| Light shell composition | PASS | The app-owned top shell, Tabs, dividers, and notice preserve the restrained Light hierarchy outside the SDK-owned editor interior. |
| Migration unsaved cue | **FAIL** | The frozen baseline contains a visible circular unsaved marker; the actual capture omits it. |

## Blocking finding

`HF2-02-VIS-001` — **HIGH** — `Migration.excalidraw` lacks the visible circular unsaved marker shown in the frozen HF2-02 baseline. The HF-2 Tab contract requires a visible non-colour cue for unsaved state; an underline or colour-only treatment cannot substitute for that marker.

Reproduce by opening the manifest-verified `restored-hidden-light.png` and immutable `actual.png` separately at 100%, then comparing the Migration Tab in the top strip. The baseline has a purple circular marker between the title and close slot; the actual does not.

## Legacy removal

The immutable collector owns the structural legacy counts and reports zero for every prohibited visible control: global New Drawing, textual Sidebar, large Pin/Unpin, top-level Save/Export/Appearance, autosave strip, visible tab scrollbar, persistent Sidebar scrollbar, placeholder icons, horizontal ellipsis, duplicate workspace navigation, header overflow, and old 002 shell composition.

## Masks and tolerances

The only declared mask is `.canvas-document:not([hidden]) .excalidraw-editor`, limited to the official Excalidraw SDK editor interior. Its perimeter is checked; it does not include the Tabs, top shell, canvas boundary, or sibling app-owned recovery notice. Those app-owned regions were reviewed.

Structure, hierarchy, shell boundary, and visible-state cues have zero tolerance. The collector owns ±2 CSS px geometry checks. Its auxiliary `shell-tabs` repeated-capture raster check reports ratio `0` against a maximum `0.01`; no whole-screen raster tolerance was used, and the reviewer changed neither masks nor tolerances.

## Unverified and ownership boundaries

No production/native package, bundle identifier, native window, physical display scale, native menu, or system dialog was reviewed. Exact geometry, tokens, fonts, accessibility, keyboard behavior, persistence, filesystem outcomes, and recovery behavior were not re-proved from pixels.

The separate T046 deterministic process/filesystem collection at `docs/evidence/003-visual-acceptance/030f279b21bb603d1545e2920aac5a25ae20d977/HF2-02/collection/recovery-process/` owns recovery safety. This visual review does not prove it. No owner artifact was created because `ownerRequirement=NOT_REQUIRED`.

## Next gate

Remediate the HF2-02 visible unsaved-state cue and add a deterministic browser assertion for it within Phase 6. Then create a new immutable HF2-02 collection bound to the remediation commit and obtain another independent reviewer verdict. Stop at the Phase 6 checkpoint; do not enter Phase 7.
