# HF2-01 independent visual review

- **Verdict:** FAIL
- **High:** 1
- **Critical:** 0
- **Mismatches:** 3
- **Owner requirement:** NOT_REQUIRED; no owner artifact was created
- **Independence:** Confirmed. Reviewer `/root/hf201_visual_review` did not author or modify the reviewed production UI or immutable browser collection. Implementation identity is `/root` at commit `fe7ca058763a3736bc661c69620d7b6ed1932e19`; the reviewer identity is distinct.
- **Runtime:** `gpt-5.6-sol`, reasoning effort `high`

## Binding

- Product commit: `fe7ca058763a3736bc661c69620d7b6ed1932e19`
- Browser build: `browser-ui`; `darwin/arm64`; semantic-browser route
- Viewport: 1280×760 CSS px; Light; deterministic `welcome` fixture
- Browser capture scale: 1, derived from the 1280×760 PNG matching the 1280×760 CSS viewport; physical macOS display scale is not claimed
- Font state: `document.fonts.ready=true`; remote font requests `0`
- HF-2 manifest SHA-256: `b3676f5a8c623a84b9c9e714ec9e1ef436df329db9034873c695f32d4f7cb0f1`
- Baseline: `01 · Welcome · Light`, SHA-256 `301e553d0ce94659233eb4683eb6bc018c26757397ecccf42bb162d6e7463cfa`
- Collector report SHA-256: `6204addcfe45f3f4ec2b7601f4ae3a2ca0ac27b2b75e055e3a67ee235ee88c8a`
- Collection: `HF2-01-light-hidden-browser` / `cdbd5da231c15e812b7ed390b816d4075356215a5a4f645d1f8575608fe818d5` / collector PASS
- Actual SHA-256: `c3a14892f1357f1730e6e822597da6e9f8d8607aef6e68750424dee633cb773a`
- Mask SHA-256: `313ab82bce1ae666d5ad3efe450acd9595dc40e08ed03d691b99454600f661ac`

## Screen matrix

| Screen | Status | Evidence | Mismatches |
| --- | --- | --- | ---: |
| 01 · Welcome · Light | FAIL | `collection/HF2-01-light-hidden-browser/actual.png` | 3 |

## Findings

| Severity | Screen/state | Expected | Actual | Reproduce |
| --- | --- | --- | --- | --- |
| High | Welcome Light / New Drawing default | White 16×16 leading glyph on the purple primary surface | Glyph renders black/dark while the adjacent label is white | Compare baseline and actual at 100%, around `x=176..194, y=318..336` |
| Medium | Welcome Light / Recent rows | Flat semantic row surfaces with restrained borders; reference Architecture row has the light filled surface | Every row shows a pronounced dark right/bottom browser-style bevel; Architecture lacks the reference fill | Compare all three row perimeters and the Architecture fill at 100% |
| Medium | Welcome Light / Recent vertical composition | Larger separation after actions and tighter heading-to-row grouping | Heading is pulled toward the actions while the row group is pushed away from its heading/subtitle | Compare the action-to-heading and heading-to-first-row intervals at 100% |

The registered semantic deviation is accepted: Recent rows show only `name` and `rootPath`; the baseline drawing-count and last-opened metadata are intentionally absent and were not counted as mismatches.

## Legacy removal

The immutable collector owns these structural counts and reports zero for each prohibited visible control.

| Prohibited visible control | Count |
| --- | ---: |
| Separate global top-level New Drawing | 0 |
| Textual Workspace sidebar | 0 |
| Large textual Pin/Unpin | 0 |
| Legacy top-level Save | 0 |
| Persistent normal-state All changes saved strip | 0 |
| Standalone top-level Export | 0 |
| Legacy top-level Appearance | 0 |
| Visible native-looking tab-strip scrollbar | 0 |
| Thick or always-visible Sidebar scrollbar | 0 |
| Unicode placeholder tree/file icons | 0 |
| Always-visible horizontal ellipsis | 0 |
| Duplicate workspace navigation state | 0 |
| Clipped/overflowed workspace-header actions | 0 |
| Old 002 shell composition | 0 |

## Masks and tolerances

`mask.json` contains no masks. That is appropriate for this Welcome capture because no SDK-owned editor, Library, or Presentation interior is visible; the complete shell was reviewed.

Structure, hierarchy, shell boundaries, and legacy counts have zero tolerance. The collector owns the ±2 CSS px geometry checks. Its auxiliary Welcome component-crop threshold is `maxDiffPixelRatio=0.01`, with observed ratio `0` after fonts were ready. The reviewer used no whole-screen raster tolerance and changed no mask or threshold.

## Unverified and next gate

This intermediate browser checkpoint does not prove a native package, bundle identifier, native window, physical display scale, native menus, or system dialogs. Behavioral, persistence, accessibility, focus, overflow, and legacy facts remain owned by the immutable semantic collector rather than the screenshot. HF2-05 and the other HF-2 screens are outside this review.

Remediate the primary-action glyph color, Recent row surface/state styling, and Recent section spacing. Then create a new immutable HF2-01 browser collection bound to the remediation commit and obtain a new independent reviewer verdict. No product-owner artifact is required or permitted for this intermediate gate.
