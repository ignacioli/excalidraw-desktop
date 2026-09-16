# HF2-06 independent visual review — remediated attempt

- **Verdict:** PASS
- **High:** 0
- **Critical:** 0
- **Mismatches:** 0
- **Owner requirement:** NOT_REQUIRED; no owner artifact was created
- **Independence:** Confirmed. Reviewer `/root/hf206_visual_review_v2` did not author or modify the production UI, remediation, validation harness, fixtures, or either immutable collection. Implementation identity is `/root` at product commit `06a4e34152fb8cdcdae7a6fd20ac137565ab651d`; reviewer identity is distinct.
- **Runtime:** `gpt-5.6-sol`, reasoning effort `high`

## Binding

- Reviewed product commit: `06a4e34152fb8cdcdae7a6fd20ac137565ab651d`
- Collection-containing HEAD at dispatch: `8fe0e02a9982547bda5cbc42a2cfd098f502bc9c` (recorded only; not substituted for the reviewed product commit)
- Browser build: `browser-ui`; collection OS `darwin/arm64`; route `semantic-browser`; harness `003-shell-v3`
- Reviewer host: macOS 26.6.2 (`25G83`), arm64
- Viewport: 1280×760 CSS px; Dark; deterministic `pinned-dark` fixture
- Browser capture scale: 1, derived from the 1280×760 fixed visual PNG matching the CSS viewport; physical macOS display scale is not claimed
- Font state: `document.fonts.ready=true`; remote font requests `0`
- HF-2 manifest SHA-256: `b3676f5a8c623a84b9c9e714ec9e1ef436df329db9034873c695f32d4f7cb0f1`
- Baseline: `06 · Workspace · Pinned · Dark`, `docs/design/desktop-shell/hf-2/screens/workspace-pinned-dark.png`, SHA-256 `8b06a988270d4a6d8f7ce00fa32fb422c8bf3dea3c6e8346390b2b77ea9b34d0`
- Semantic collector report SHA-256: `56e7e45eb4c117e735b4bf61cecad335cb729f81e691a657221732389d3708e1`
- Semantic collection: `HF2-06-dark-pinned-semantic-browser` / `467f6c4e1b3c8fdaeed12511e0ba05eec9d3cc1c78e1809767cfe76746986f0a` / PASS
- Semantic actual SHA-256: `239741dc6300f1a173b240aad52ac52cf3b60c58d465864c36a73865f0cb8275`
- Semantic mask SHA-256: `30f23ea59517bf4537f3761692d97a16f37d6672e63fdf9b1870950b55932000`
- Fixed visual collector report SHA-256: `913ad544ab0e6fb1c721cea1befad6ab75a8a440d9af74344d0da1a3fa315e9a`
- Fixed visual collection: `HF2-06-dark-pinned-visual-browser` / `d4b6f1fe10aac1ab0042a7040b9299c0bfced232d5905ab9d2fee975abbb3f5e` / PASS
- Fixed actual SHA-256: `58c93cc9880219f16730d3166f9a52dc8451f4646f084a14d56544623369c9e7`
- Fixed mask SHA-256: `7aef96b71d3114db178bf5a0f753f83aefc9705398e14ae1221808302bc2b42f`
- All declared artifact SHA-256 values and both collection digests were independently recomputed and matched.

## Screen matrix

| Screen | Status | Evidence | Mismatches |
| --- | --- | --- | ---: |
| 06 · Workspace · Pinned · Dark | PASS | `collection/HF2-06-dark-pinned-visual-browser/actual.png` | 0 |

## Remediation check

The immutable prior attempt at product commit `59995846cb49dbd192f1bd861694afb5f05059ed` remains FAIL with one High finding (`HF2-06-VIS-001`): disclosure, folder, and drawing glyphs appeared near-black in the unmasked Workspace tree.

The new fixed actual shows those glyphs as readable gray-white marks against the `#232329` panel and `#403E6A` selected row. The prior near-black appearance is absent. The digest-owned semantic collection separately reports 9/9 readable computed styles; the generating assertion requires `filter: invert(1)` and opacity at least `0.8`. This resolves the prior High finding without altering its evidence.

## Visual and composition checks

| Check | Result | Observation |
| --- | --- | --- |
| Dark Pinned composition | PASS | The 360px Pinned Sidebar, top Tab strip, SDK-owned editor region, and app-owned shell perimeter remain visibly separated. |
| Tabs and unsaved state | PASS | System Map, Flow, and Research Tabs remain compact; Flow has one visible non-colour dirty marker and close slots remain stable. |
| Workspace header/actions | PASS | Architecture and the four compact actions remain on one row, readable and unclipped. |
| Workspace tree icon readability | PASS | Every visible disclosure, folder, and drawing glyph is gray-white and clearly distinguishable on normal and selected Dark rows. |
| Active row non-colour state | PASS | System Map retains a visible left indicator and marker; semantic evidence records exactly one active-row indicator. |
| Font/mask/legacy boundary | PASS | Fonts were ready, remote requests were zero, only the SDK editor interior is masked, and all prohibited legacy counts are zero. |

No Critical, High, Medium, or Low visual mismatch remains in the assigned screen.

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
| INFO | HF2-06 / Workspace tree disclosure, directory, and drawing glyphs | Recognizable 16×16 glyphs remain readable in Dark mode, following the light-secondary-foreground direction. | The remediated fixed visual renders every visible glyph gray-white; the prior near-black rendering is absent. No residual mismatch is visible. | Open the baseline and remediated fixed actual separately at native 1280×760. Inspect the unmasked Workspace tree around x=16..76, y=140..304, then confirm the bound semantic 9/9 readable-style assertion. Evidence: `collection/HF2-06-dark-pinned-visual-browser/actual.png`. |

## Masks and tolerances

The only mask in each collection is `.canvas-document:not([hidden]) .excalidraw-editor`, justified solely as the official Excalidraw SDK-owned editor interior. The Pinned Sidebar, top Tabs, Sidebar/Back controls, Workspace header, tree rows, row icons, divider, and shell perimeter remain unmasked. The remediated glyphs are outside the mask.

Structure, hierarchy, palette/readability, shell boundaries, component states, and legacy counts retain zero tolerance. Collector-owned shell geometry uses ±2 CSS px, while Light/Dark parity is exact. The auxiliary same-semantic `workspace-sidebar` crop permits at most `0.01` diff and records `0` after fonts were ready; it did not decide the remediation verdict. No whole-screen raster tolerance was used, and the reviewer changed neither masks nor thresholds.

## Unverified

- No native macOS package, bundle identifier, native window, physical display scale, native menu, or system dialog was reviewed; those are intentionally outside this intermediate browser checkpoint.
- The collection environment does not record the browser engine/version or exact collection-time macOS version.
- The SDK editor interior, toolbar, and Library implementation are excluded by the declared SDK mask.
- Behavior, persistence, keyboard operation, accessible names, focus-visible, contrast, non-colour state, reduced motion, Light/Dark geometry parity, tokens, fonts, masks, and legacy counts remain owned by the digest-bound semantic/visual assertions rather than pixels.
- The other five HF-2 screens are outside this single-screen review.
- No product-owner decision was created or inferred because `ownerRequirement=NOT_REQUIRED`.

## Next gate

HF2-06 passes its remediated independent reviewer gate. The primary agent may close T058 and the Phase 8 checkpoint. No intermediate product-owner artifact or production native package is required; proceed to Phase 9 only under its ordered dependency and evidence-ownership gates.
