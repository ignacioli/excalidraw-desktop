# HF2-06 independent visual review

- **Verdict:** FAIL
- **High:** 1
- **Critical:** 0
- **Mismatches:** 1
- **Owner requirement:** NOT_REQUIRED; no owner artifact was created
- **Independence:** Confirmed. Reviewer `/root/hf206_visual_review` did not author or modify the production UI, validation harness, fixtures, or either immutable collection. Implementation identity is `/root` at product commit `59995846cb49dbd192f1bd861694afb5f05059ed`; reviewer identity is distinct.
- **Runtime:** `gpt-5.6-sol`, reasoning effort `high`

## Binding

- Reviewed product commit: `59995846cb49dbd192f1bd861694afb5f05059ed`
- Collection-containing HEAD at dispatch: `fbc2bd761065b1c96783d5200585e46f59cd4f9d` (recorded only; not substituted for the reviewed product commit)
- Browser build: `browser-ui`; collection OS `darwin/arm64`; route `semantic-browser`; harness `003-shell-v3`
- Reviewer host: macOS 26.6.2 (`25G83`), arm64
- Viewport: 1280×760 CSS px; Dark; deterministic `pinned-dark` fixture
- Browser capture scale: 1, derived from the 1280×760 fixed visual PNG matching the CSS viewport; physical macOS display scale is not claimed
- Font state: `document.fonts.ready=true`; remote font requests `0`
- HF-2 manifest SHA-256: `b3676f5a8c623a84b9c9e714ec9e1ef436df329db9034873c695f32d4f7cb0f1`
- Baseline: `06 · Workspace · Pinned · Dark`, `docs/design/desktop-shell/hf-2/screens/workspace-pinned-dark.png`, SHA-256 `8b06a988270d4a6d8f7ce00fa32fb422c8bf3dea3c6e8346390b2b77ea9b34d0`
- Semantic collector report SHA-256: `bb7b31c699de7791cfa9d844623630732b7a467743e0ed3df8da38aafff3e11c`
- Semantic collection: `HF2-06-dark-pinned-semantic-browser` / `d16021a308dac6ba14ce03d57ef98ed1f07c256965d98b6fcbb0aba7cebec7df` / PASS
- Semantic actual SHA-256: `81d0b12bc0f15c4033754cf0e3e51cf5a247f84c4d4dd79714e4d93dc0a1e8fd`
- Semantic mask SHA-256: `699e09b3ee38c25c914c6a0dc44b02b84bd6593e219a01e3a2eeebdbd3452546`
- Fixed visual collector report SHA-256: `762b06763888b49bf78ee8bb988eed301679133c5006ae46d60e9893592d6fc6`
- Fixed visual collection: `HF2-06-dark-pinned-visual-browser` / `22a39bf6600ffe7d2ef584e82300d5be1384a2434e1de9f400db696ace97fb88` / PASS
- Fixed visual actual SHA-256: `706164d159388a803e9250e949fb2764e4c916d13b0bd9735e1c02b049e6ef35`
- Fixed visual mask SHA-256: `146f1f3534da73ac212096a8fb0c6848b7b30e458d64609355733410ef198ae0`

All manifest, baseline, collector-report, artifact, mask, and canonical sorted artifact-list collection digests were independently recomputed. The applicable UX brief, `DESIGN.md`, approved HF-2 README/components/tokens/manifest, and authoritative 003 spec/plan/UI contract are consistent for this checkpoint.

## Screen matrix

| Screen | Status | Evidence | Mismatches |
| --- | --- | --- | ---: |
| 06 · Workspace · Pinned · Dark | FAIL | `collection/HF2-06-dark-pinned-visual-browser/actual.png` | 1 |

## Semantic authority

The digest-owned semantic collection passes all 57 assertions: axe violations `0`; minimum recorded contrast `8.925483265455044` against `>=4.5`; Back focus ring `2px`; Flow dirty marker `1`; clean markers `0`; active-row non-colour indicator `1`; reduced-motion duration `0.000001s` against `<=0.000001s`; and exact Light/Dark geometry for top layer, Sidebar, canvas, Back, Tab, Workspace Row, and header action. These facts are not re-proved from pixels. The generic recorded contrast assertion does not override the fixed visual finding below for Workspace icon foregrounds.

## Visual and composition checks

| Check | Result | Observation |
| --- | --- | --- |
| Dark Pinned three-region composition | PASS | The 360px Pinned Sidebar, top Tabs, SDK editor region, and app-owned shell perimeter remain visibly separated. |
| Tabs and unsaved state | PASS | Three Tabs retain active/inactive hierarchy and reserved close slots; Flow has one visible yellow dirty marker. |
| Workspace header actions | PASS | Architecture and all four compact actions remain on one row, readable and unclipped. |
| Active-row non-colour state | PASS | The selected System Map row has a left indicator and marker in addition to its selected surface. |
| Workspace tree iconography/readability | **FAIL** | Disclosure, folder, and drawing glyphs render near black against the Dark panel/selected row and lose the approved readable icon hierarchy. |
| Font/mask/legacy record | PASS | Fonts are ready, remote requests are zero, only the SDK editor interior is masked, and prohibited legacy counts are zero. |

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
| **HIGH** | HF2-06 / Workspace tree disclosure, directory, and drawing glyphs | Recognizable 16×16 glyphs remain readable in Dark mode. The baseline uses light glyphs; the Dark secondary foreground direction is `#CED4DA` on `#232329`. | The fixed visual actual renders these glyphs near black. Sampled non-background pixels are dominated by `#000000` and `#111114`, collapsing into the `#232329` panel and remaining too dark on the `#403E6A` selected row. Text and the selected-row indicator remain readable, but hierarchy and entry identity icons do not. | Open the baseline and fixed visual actual separately at native 1280×760. Inspect the unmasked Workspace tree around x=16..76, y=140..274. Evidence: `collection/HF2-06-dark-pinned-visual-browser/actual.png`. |

No Critical, Medium, Low, or Info finding was recorded. One High mismatch makes the gate fail.

## Masks and tolerances

The only mask in each collection is `.canvas-document:not([hidden]) .excalidraw-editor`, justified solely as the official Excalidraw SDK editor interior. The Pinned Sidebar, top Tabs, Sidebar/Back controls, Workspace header, tree rows, row icons, divider, and shell perimeter remain unmasked. The High mismatch is outside the mask.

Structure, hierarchy, palette/readability, shell boundaries, component states, and legacy counts retain zero tolerance. Collector-owned shell geometry uses ±2 CSS px, while Light/Dark parity is exact. The auxiliary same-semantic `workspace-sidebar` crop permits at most `0.01` diff and records `0` after fonts were ready; that auxiliary result cannot override the visible icon-foreground mismatch. No whole-screen raster tolerance was used, and the reviewer changed neither masks nor thresholds.

## Unverified

- No native macOS package, bundle identifier, native window, physical display scale, native menu, or system dialog was reviewed; those are intentionally outside this intermediate browser checkpoint.
- The collection environment does not record the browser engine/version or exact collection-time macOS version.
- The SDK editor interior, toolbar, and Library implementation are excluded by the declared SDK mask.
- The other five HF-2 screens are outside this single-screen review.
- No product-owner decision was created or inferred because `ownerRequirement=NOT_REQUIRED`.

## Next gate

Remediate the Dark Workspace tree icon foreground/readability in production code. This FAIL attempt must remain immutable. A retry requires a named fix, a new product commit, new immutable HF2-06 semantic and visual collection paths with new digest bindings, and another independent reviewer. Do not close T058 from this attempt.
