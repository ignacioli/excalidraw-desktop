# HF2-04 independent visual review

- **Verdict:** PASS
- **High:** 0
- **Critical:** 0
- **Mismatches:** 0
- **Owner requirement:** NOT_REQUIRED; no owner artifact was created
- **Independence:** Confirmed. Reviewer `/root/hf204_visual_review_v2` did not author or modify the production UI, validation harness, fixture, or immutable collection. Implementation identity is `/root` at product commit `a00d82b1f939299687128e697e4aef91cfc98466`; reviewer identity is distinct.
- **Runtime:** `gpt-5.6-sol`, reasoning effort `high`

## Binding

- Reviewed product commit: `a00d82b1f939299687128e697e4aef91cfc98466`
- Collection-containing HEAD at dispatch: `b72404261ad6083e4d0912079eb0ed88322324cd` (recorded only; not substituted for the reviewed product commit)
- Browser build: `browser-ui`; recorded collection OS `darwin/arm64`; semantic-browser route; harness `003-shell-v3`
- Reviewer host: macOS 26.6.2 (`25G83`), arm64; this does not add an exact collection-time OS-version claim
- Viewport: 1280×760 CSS px; Light; deterministic `overlay` fixture
- Browser capture scale: 1, derived from the 1280×760 PNG matching the CSS viewport; physical macOS display scale is not claimed
- Font state: `document.fonts.ready=true`; remote font requests `0`
- HF-2 manifest SHA-256: `b3676f5a8c623a84b9c9e714ec9e1ef436df329db9034873c695f32d4f7cb0f1`
- Baseline: `04 · Workspace · Overlay · Light`, `docs/design/desktop-shell/hf-2/screens/workspace-overlay-light.png`, SHA-256 `ab2c2baf8b7b32e8d78095f29165eb369663389a62aa13e5a672a47d3511a059`
- Collector report SHA-256: `5d1fccfc7b5f12015f236098cee0beef2e72560517dbda96fc2fc909f4e73141`
- Collection: `HF2-04-light-overlay-browser` / `e231780167da85b7710a98fa2c432beac48e5352938ab3ca6810c94a1b35345e` / collector PASS
- Actual SHA-256: `f7159ce8618bffb3a944a041045db22e247380d149ffcbae77c51aeb7be54eb6`
- Mask SHA-256: `e220ad154e27065602b0c60dda4facb259fc97a62b90ded6855f82101bf71562`

All artifact hashes were independently recomputed. The collection digest was independently reproduced from the collector's canonical sorted artifact digest list. The applicable UX brief, `DESIGN.md`, approved HF-2 README/components/tokens/manifest, and current 003 spec/plan/UI contract are consistent for this checkpoint.

## Screen matrix

| Screen | Status | Evidence | Mismatches |
| --- | --- | --- | ---: |
| 04 · Workspace · Overlay · Light | PASS | `collection/HF2-04-light-overlay-browser/actual.png` | 0 |

## Remediation and visual checks

| Check | Result | Observation |
| --- | --- | --- |
| Prior HF2-04-VIS-001: first Tab placement | PASS | Collector records `x=88`; the first Tab now begins immediately after the compact control group and aligns with the baseline underline near `x=89` within ±2 CSS px. |
| Prior HF2-04-VIS-002: Flow dirty marker | PASS | Collector records `dirty` plus marker count `1`; one circular marker is visibly present on Flow and absent from the two clean Tabs. |
| Prior HF2-04-VIS-003: Sidebar toggle rest state | PASS | The pointer has moved away and the fixed capture shows the Sidebar toggle at rest without the prior lavender hover surface. |
| Overlay layering and perimeter | PASS | The 360px Sidebar, Workspace header/tree, divider, shadow, and full perimeter remain visible above the SDK editor and unmasked. |
| Canvas box before/after | PASS | Collector-owned exact assertions report `x=0`, `y=44`, `width=1280`, `height=716` before and after. Pixels were not used to re-prove this behavior fact. |
| Compact Back | PASS | Back is enabled for valid history and retains exact 32×32 geometry. |
| Light shell composition | PASS | Compact controls, Tabs, Overlay Sidebar, header/tree, and shell boundaries preserve the approved restrained hierarchy outside the SDK-owned editor interior. |

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
| INFO | HF2-04 / first Tab placement | First Tab `x=88`, matching the baseline underline near `x=89` within ±2 CSS px. | Collector records `x=88`; the prior 52px extra gap is absent. | Open baseline and actual separately at native 1280×760; inspect the first active Tab after compact controls and confirm `geometry.overlay.first-tab.x` in `assertions.json`. Evidence: `collection/HF2-04-light-overlay-browser/actual.png`. |
| INFO | HF2-04 / Flow dirty Tab | Dirty Flow exposes exactly one visible circular marker plus accessible dirty state. | Collector records `dirty` and marker count `1`; the marker is visible. | Inspect Flow in the unmasked Tab strip and confirm its two semantic assertions in `assertions.json`. Evidence: `collection/HF2-04-light-overlay-browser/actual.png`. |
| INFO | HF2-04 / Sidebar toggle rest state | Fixed key screen captures the toggle at rest with transparent/default background. | Actual captures the control at rest; the prior hover surface is absent. | Compare the top-left Sidebar control in baseline and actual after the pointer has moved away. Evidence: `collection/HF2-04-light-overlay-browser/actual.png`. |

No Low, Medium, High, or Critical mismatch remains.

## Masks and tolerances

The only mask is `.canvas-document:not([hidden]) .excalidraw-editor`, justified solely as the official Excalidraw SDK editor interior. The review did not exclude the Overlay Sidebar, overlay shadow/perimeter, Tabs, Sidebar/Back controls, Workspace header, tree rows, or any shell boundary.

Structure, hierarchy, shell boundaries, layer ordering, visible state cues, and legacy counts retain zero tolerance. The collector owns the exact canvas-box, Back, and first-Tab measurements; the general shell-geometry tolerance is ±2 CSS px. Its auxiliary same-semantic `workspace-sidebar` component crop permits at most `0.01` diff and observed `0` after fonts were ready. No whole-screen raster tolerance was used, and the reviewer changed neither masks nor thresholds.

## Unverified

- No native macOS package, bundle identifier, native window, physical display scale, native menu, or system dialog was reviewed; those are intentionally outside this intermediate browser checkpoint.
- `environment.json` does not record the browser engine/version or exact collection-time macOS version.
- Back-history behavior, Overlay hold/Escape behavior, persistence, accessibility, keyboard operation, focus-visible, reduced motion, tokens, font fallback, mask semantics, and legacy counts remain owned by deterministic evidence rather than pixels.
- The other five HF-2 screens are outside this single-screen review.
- No product-owner decision was created or inferred because `ownerRequirement=NOT_REQUIRED`.

## Next gate

Bind this independent reviewer PASS to T053 and close the Phase 7 checkpoint through the task owner. Phase 8 may begin only after checkpoint evidence and task state are recorded. Do not create an intermediate product-owner artifact or production native package.
