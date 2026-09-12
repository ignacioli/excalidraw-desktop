# HF2-05 independent visual review

- **Verdict:** PASS
- **High:** 0
- **Critical:** 0
- **Mismatches:** 0
- **Owner requirement:** NOT_REQUIRED; no owner artifact was created
- **Independence:** Confirmed. Reviewer `/root/hf205_visual_review` did not author or modify the production UI or immutable browser collection. Implementation identity is `/root` at commit `63417a0db7650bbdf6f323d98110f2685c10a17b`; the reviewer identity is distinct.
- **Runtime:** `gpt-5.6-sol`, reasoning effort `high`

## Binding

- Product commit: `63417a0db7650bbdf6f323d98110f2685c10a17b`
- Browser build: `browser-ui`; `darwin/arm64`; semantic-browser route
- Viewport: 1280×760 CSS px; Dark; deterministic `welcome` fixture
- Browser capture scale: 1, derived from the 1280×760 PNG matching the 1280×760 CSS viewport; physical macOS display scale is not claimed
- Font state: `document.fonts.ready=true`; remote font requests `0`
- HF-2 manifest SHA-256: `b3676f5a8c623a84b9c9e714ec9e1ef436df329db9034873c695f32d4f7cb0f1`
- Baseline: `05 · Welcome · Dark`, SHA-256 `6801579936067a6905ff7cd0896d6604861b176e5b9d7e56d141cc64434fd567`
- Collector report SHA-256: `381cb17e6443724b637102d2180d9286a6549bd2f621ffdf0e8b1bd65707c9c6`
- Collection: `HF2-05-dark-hidden-browser` / `69ff5321687f9af735e7c6caad347389fdcee20b31c6ed84c35d9f911a7e0893` / collector PASS
- Actual SHA-256: `cb49e0eac4a039bbe1dcc2a908b009cbefe05efe9a8e881ff7db78d7fdf2e237`
- Mask SHA-256: `33b625f1b9bd0ea12f9be264d4e1c81a4ee968ab81c855949f7e91d5fdaf1697`

## Screen matrix

| Screen | Status | Evidence | Mismatches |
| --- | --- | --- | ---: |
| 05 · Welcome · Dark | PASS | `collection/HF2-05-dark-hidden-browser/actual.png` | 0 |

## Visual and composition checks

| Check | Result | Observation |
| --- | --- | --- |
| Compact shell controls | PASS | Sidebar and Back remain compact at the far-left of the top shell layer. |
| Welcome hierarchy | PASS | Hero, supporting copy, two actions, Recent section, three rows, and quiet footer preserve the frozen screen's grouping and visual order. |
| Dark action emphasis | PASS | New Drawing remains primary and Open Workspace remains secondary, with legible foregrounds on the approved Dark surfaces. |
| Dark surface hierarchy | PASS | The top shell, body, action surfaces, Recent rows, and footer remain visually distinct without adding legacy chrome. |
| Approved Recent metadata omission | PASS | Rows show only `name` and `rootPath`; drawing-count and last-opened metadata remain intentionally absent under `HF2-RECENT-COUNT-TIME`. |

No Critical, High, Medium, or Low visual mismatch remains in the assigned screen.

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

## Findings

Only informational observations were recorded: the Welcome Dark composition and Dark visual hierarchy are faithful, and the registered Recent metadata omission is accepted. Reproduce by opening the immutable `actual.png` at 1280×760 and comparing it one image at a time with the manifest-verified `welcome-dark.png` baseline. Evidence is `collection/HF2-05-dark-hidden-browser/actual.png`.

## Masks and tolerances

`mask.json` contains no masks. That is appropriate for this Welcome capture because no SDK-owned editor, Library, or Presentation interior is visible; the complete shell was reviewed.

Structure, hierarchy, shell boundaries, and legacy counts have zero tolerance. The collector owns the ±2 CSS px geometry checks. Its auxiliary Welcome component-crop threshold is `maxDiffPixelRatio=0.01`, with observed ratio `0` after fonts were ready. The reviewer used no whole-screen raster tolerance and changed no mask or threshold.

## Unverified and next gate

This intermediate browser checkpoint does not prove a native package, bundle identifier, native window, physical display scale, native menus, or system dialogs. Behavioral, persistence, accessibility, focus, reduced-motion, overflow, Light/Dark geometry, token, font, mask, and legacy facts remain owned by the immutable semantic collector rather than the screenshot. The other five HF-2 screens are outside this review.

HF2-05 passes its independent reviewer gate with `ownerRequirement=NOT_REQUIRED`. Proceed to T043 US2 Welcome regression evidence, then stop at the Phase 5 checkpoint. Do not create an intermediate owner artifact or enter Phase 6.
