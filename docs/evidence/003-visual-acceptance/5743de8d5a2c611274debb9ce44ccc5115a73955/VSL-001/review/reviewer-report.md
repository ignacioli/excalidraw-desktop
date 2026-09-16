# VSL-001 independent remediation visual review

- **Verdict:** PASS
- **High:** 0
- **Critical:** 0
- **Owner gate:** PENDING
- **Independence:** Confirmed. Reviewer `/root/vsl001_remediation_review` did not author or modify the reviewed production UI, capture harness, specs, immutable collection, owner artifacts, or task checkboxes. The implementation task identity is `/root`; the reviewer identity is distinct.
- **Runtime:** `gpt-5.6-sol`, reasoning effort `high`

## Binding

- Product commit: `5743de8d5a2c611274debb9ce44ccc5115a73955`
- Package: `Excalidraw.app` 0.2.0, bundle ID `excalidraw-desktop`
- Package artifact SHA-256: `e98afb4c55f2ea373adc2441a30596a2d0e553d1fbd8d9ba11e07d74acfc7e59`
- Native collector report SHA-256: `52a634d262a5638c163cb71ab8b7e6c0ce74ce49b0eb5949568fe05e029e8d6f`
- Native collection: `VSL-001-native-capture` / `ecc7a598f613efbae37ece92cb9afd0b0bf3c03323a01d7bd028cfc3a8189b92`
- Browser semantic collection: `VSL-001-light-pinned-browser` / `beb9ea5a4f33d357031e8e8c300af1fb043bd2bb056cef9ebca51ab89b356b59`
- Environment: macOS 26.6.2, arm64, display scale 2
- Window: 1280×760 logical; 2560×1520 raw; Light; fixture `003-native-capture-v4 / Design Workspace`
- Baseline: `03 · Workspace · Pinned · Light`, SHA-256 `5bfbd5dba0363271192309594304a2291166a65bf91df5c2effb5550e961829a`
- HF-2 manifest SHA-256: `b3676f5a8c623a84b9c9e714ec9e1ef436df329db9034873c695f32d4f7cb0f1`
- Actual SHA-256: `dd554bc699585e6919bccb22a96311dc785626f8c6498061c81a0ba15fc0117b`
- Mask SHA-256: `94ffa491f715acf0b7ec69c1d519b2add60c1e5edc496f69cb8a8a996705c226`

## Screen matrix

| Screen | Status | Evidence | Mismatches |
| --- | --- | --- | ---: |
| 03 · Workspace · Pinned · Light | PASS | `collection/VSL-001-native-capture/actual.png` | 0 |

## Remediation verdicts

| Check | Result | Native measurement |
| --- | --- | --- |
| Selected Architecture file icon/content does not shift right versus same-depth rows | PASS | Architecture, Migration, and Research icon bounds are all `x=64..75`; all text starts at `x=93` |
| Collapse All is optically aligned with the other Workspace-header actions | PASS | Glyph bounds `y=121..127`, centroid `y=123.833`, against button optical center `y=124`; sibling bounds span `y=119..131` |
| No new High/Critical shell visual regression | PASS | Tabs, Workspace header, tree, dividers, mask perimeter, and native window chrome are intact |

Measurements locate dark-core pixels below RGB 140 in normalized `actual.png`; this threshold localizes coordinates and is not an acceptance tolerance.

## Composition and legacy removal

The 360px Pinned Sidebar perimeter remains outside the x=480 canvas mask; `flows` is expanded; Architecture, Migration, and Research are visible; Architecture is active and selected; Library is open; and all four Workspace-header actions are visible without clipping.

All prohibited visible controls have observed count 0: separate global New Drawing; textual Sidebar; large Pin/Unpin; top-level Save/Export/Appearance; normal-state saved strip; tab or persistent Sidebar scrollbar; Unicode placeholders; persistent horizontal ellipsis; duplicate workspace navigation beyond the approved header/root representation; header-action overflow; and old 002 composition.

## Masks and tolerances

- `sdk-canvas`: `rect(480,74,506,686)`, approved SDK editor interior. The Sidebar and its perimeter remain visible.
- `sdk-library`: `rect(986,74,294,686)`, approved SDK Library interior below the native titlebar.
- Structure, hierarchy, and perimeter use zero tolerance. No raster tolerance or whole-screen diff decided this review.

## Unverified and next gate

This review does not inspect the SDK-owned interiors beyond their boundary/presence, does not re-review hover/focus-visible/disabled/Dark states, and does not claim final six-screen acceptance. Product-owner approval remains separate and PENDING. The next gate is T034 owner review bound to this package, both collection digests, and this reviewer report.
