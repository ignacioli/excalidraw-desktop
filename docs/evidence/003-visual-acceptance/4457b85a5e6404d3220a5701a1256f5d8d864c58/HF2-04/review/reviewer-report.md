# HF2-04 independent visual review

- **Verdict:** FAIL
- **High:** 2
- **Critical:** 0
- **Mismatches:** 3
- **Owner requirement:** NOT_REQUIRED; no owner artifact was created
- **Independence:** Confirmed. Reviewer `/root/hf204_visual_review` did not author or modify the production UI, validation harness, or immutable browser collection. Implementation identity is `/root` at commit `4457b85a5e6404d3220a5701a1256f5d8d864c58`; the reviewer identity is distinct.
- **Runtime:** `gpt-5.6-sol`, reasoning effort `high`

## Binding

- Reviewed product commit: `4457b85a5e6404d3220a5701a1256f5d8d864c58`
- Collection-containing product HEAD at dispatch: `d1fb4fff8523b3436ccc0859b09681b87a605829` (recorded only; not substituted for the reviewed product commit)
- Browser build: `browser-ui`; `darwin/arm64`; semantic-browser route
- Viewport: 1280×760 CSS px; Light; deterministic `overlay` fixture
- Browser capture scale: 1, derived from the 1280×760 PNG matching the CSS viewport; physical macOS display scale is not claimed
- Font state: `document.fonts.ready=true`; remote font requests `0`
- HF-2 manifest SHA-256: `b3676f5a8c623a84b9c9e714ec9e1ef436df329db9034873c695f32d4f7cb0f1`
- Baseline: `04 · Workspace · Overlay · Light`, `docs/design/desktop-shell/hf-2/screens/workspace-overlay-light.png`, SHA-256 `ab2c2baf8b7b32e8d78095f29165eb369663389a62aa13e5a672a47d3511a059`
- Collector report SHA-256: `1e3b3f1f91aa5235458a14f7c380c526b6b781c19fbb93650f347e40592cf7aa`
- Collection: `HF2-04-light-overlay-browser` / `73e25c1054f327280e6cc60fd0b796ac3df9c3168bf4d764c8592f06d01ba25d` / collector PASS
- Actual SHA-256: `cfe6637676ba4e92e86222f5091d6409a22b53b70c70f1553bcd2bb1c09d186a`
- Mask SHA-256: `c7cf4a498d05effe8f7f4a700f5acaa0fd20b72e09266302af4679bbbf3ccb74`

All artifact hashes were independently recomputed. The collection digest was independently reproduced from the collector's sorted `path + NUL + sha256` artifact list.

## Screen matrix

| Screen | Status | Evidence | Mismatches |
| --- | --- | --- | ---: |
| 04 · Workspace · Overlay · Light | FAIL | `collection/HF2-04-light-overlay-browser/actual.png` | 3 |

## Visual and composition checks

| Check | Result | Observation |
| --- | --- | --- |
| Overlay layering and perimeter | PASS | The 360px Sidebar, header, tree, divider, shadow, and perimeter remain visible above the SDK editor and were not excluded. |
| Canvas box before/after | PASS | Collector-owned exact assertions report `x=0`, `y=44`, `width=1280`, `height=716` before and after. The screenshot was not used to re-prove this fact. |
| Compact Back | PASS | Back is enabled for valid history and retains exact 32×32 geometry. |
| Top Tab placement | FAIL | The baseline first active underline begins at `x=89`; actual begins at `x=141`, leaving an extra 52px unmasked gap. |
| Dirty Tab cue | FAIL | The deterministic fixture declares the second Tab dirty, but actual Flow.excalidraw has no visible unsaved marker. |
| Sidebar toggle capture state | FAIL | The actual toggle retains the Light hover surface while the baseline shows the default transparent/rest state. |

## Legacy removal

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
| Duplicate current-workspace heading/navigation state | 0 |
| Clipped/overflowed workspace-header actions | 0 |
| Old 002 shell composition | 0 |

## Findings

| Severity | Screen/state | Expected | Actual | Reproduction and evidence |
| --- | --- | --- | --- | --- |
| HIGH | HF2-04 / top Tab strip placement | First Tab begins immediately after the compact control group, at the frozen baseline position within ±2 CSS px. | Baseline underline starts at `x=89`; actual starts at `x=141`, a 52px composition shift. | Open baseline and actual separately at 1280×760. Inspect baseline scanline `y=38` and actual scanline `y=39`; evidence: `collection/HF2-04-light-overlay-browser/actual.png`. |
| HIGH | HF2-04 / dirty second Tab | Dirty second Tab has a visible circular unsaved marker as required by the frozen screen and Tab contract. | Flow.excalidraw has no visible marker even though the fixture declares it dirty. | Compare the second Tab in baseline and actual at 100%; the Tab strip is unmasked. Evidence: `collection/HF2-04-light-overlay-browser/actual.png`. |
| MEDIUM | HF2-04 / Sidebar toggle state | Fixed key screen captures the toggle at rest with transparent/default background. | Actual retains the lavender Light hover surface while Back is at rest. | Compare the compact top-left controls in baseline and actual. Evidence: `collection/HF2-04-light-overlay-browser/actual.png`. |

## Masks and tolerances

The only mask is `.canvas-document:not([hidden]) .excalidraw-editor`, justified solely as the official Excalidraw SDK editor interior. The review did not exclude the Overlay Sidebar, overlay shadow or perimeter, Tabs, Sidebar/Back controls, Workspace header, or tree rows, even where the Overlay is stacked over the underlying editor.

Structure, hierarchy, shell boundaries, layer ordering, visible state cues, and legacy counts retain zero tolerance. The collector owns the exact canvas-box and Back measurements; the general shell-geometry tolerance is ±2 CSS px. Its auxiliary `workspace-sidebar` repeated component-crop comparison allows at most `0.01` and observed `0` after fonts were ready. No whole-screen raster tolerance was used, and the reviewer changed neither masks nor thresholds.

## Unverified

- No native macOS package, bundle identifier, native window, physical display scale, native menu, or system dialog was reviewed; those are intentionally outside this intermediate browser checkpoint.
- `environment.json` does not record the browser engine name/version.
- Back-history behavior, Overlay hold/Escape behavior, persistence, accessibility, font fallback, token values, mask semantics, and legacy counts remain owned by deterministic evidence rather than pixels.
- The other five HF-2 screens are outside this single-screen review.
- No product-owner decision was created or inferred because `ownerRequirement=NOT_REQUIRED`.

## Next gate

Remediate the app-owned top-Tab placement, restore the fixture-declared dirty Tab marker, and capture the Sidebar toggle in the baseline default state. Create a new product commit and a new immutable HF2-04 collection with new digest binding, then obtain another independent visual review. Do not enter Phase 8 and do not create an intermediate owner artifact.
