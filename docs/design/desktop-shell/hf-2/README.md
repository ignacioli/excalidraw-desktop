# Desktop shell HF-2 design handoff

**Status:** Approved by the product owner on 2026-09-06

**Penpot version:** `HF-2 product-approved · icon and interaction refinement · revision 59`
**Penpot file:** [`excalidraw-desktop-uxui-redesign`](https://design.penpot.app/#/workspace?team-id=c269caa0-e456-818c-8008-8942beb7b0c1&file-id=40e06342-8830-80d6-8008-98d2d723d49b&page-id=18570eb3-fcf2-80e5-8008-921038f9d49b)

This directory is the immutable, repository-owned implementation baseline for the approved HF-2 desktop-shell design. Penpot remains the editable design carrier; `DESIGN.md` remains the canonical visual and interaction contract. When they disagree, stop and resolve the conflict instead of silently choosing one source.

## Scope

The baseline covers the Welcome state, recoverable-session shell, Tabs, Workspace Sidebar hidden/overlay/pinned layouts, Workspace rows, shell action icons, Light/Dark styling, and the boundary around the embedded Excalidraw editor. The editor canvas, toolbar, Library, and Presentation surfaces are SDK-owned; their representations in the screenshots are boundary placeholders, not pixel specifications.

## Artifacts

| Artifact | Purpose | Default model-loading policy |
|---|---|---|
| `manifest.json` | Stable board IDs, filenames, hashes, dimensions, and validation evidence | Always read for design-referenced work |
| `tokens.json` | Primitive, Light/Dark semantic, and component token handoff | Read for tokens, themes, or any shell component |
| `components.md` | Variant coverage, dimensions, state behavior, accessibility, and implementation boundaries | Read for the component being implemented |
| `screens/*.png` | Approved visual baselines | Load only the screen relevant to the current task |
| `icons/*.svg` | Normalized 16 x 16 shell icon geometry | Load only referenced icons |
| `source/*.penpot` | Offline recovery snapshot of the approved editable source | Archive only; never load into model context for ordinary implementation |

## Task-scoped reading

- Theme and token work: read this file, `manifest.json`, and `tokens.json`.
- Welcome work: additionally read `welcome-light.png`, `welcome-dark.png`, and the Welcome Action section of `components.md`.
- Sidebar or tree work: additionally read the relevant pinned/overlay screen, Workspace Row section, and referenced icons.
- Tabs or session restoration: additionally read `restored-hidden-light.png`, one pinned screen, and the Tab section.
- Final visual acceptance: compare the implementation against all six screenshots, one at a time.

Do not decode or summarize the `.penpot` archive during normal SDD or implementation. Use the Penpot board IDs in `manifest.json` for a focused live read only when the frozen handoff is insufficient or contradictory.

## Provenance and limitations

- The `.penpot` archive was downloaded through Penpot Web's native file-download action because the hosted Remote MCP file-export call failed before producing bytes.
- The six PNGs were exported through Penpot Remote MCP and verified as 1280 x 760 RGBA images.
- Remote MCP returned two NUL bytes instead of SVG/XML for a direct icon export. The ten SVGs are repository-normalized `currentColor` versions of the Penpot geometry: 16 x 16 keylines, 1 px default action strokes, 1.25 px directional strokes, round caps, and round joins. These effective strokes match the visual weight of the locked public `@excalidraw/excalidraw` 0.18.1 icon set at 16 px.
- Penpot revision 59 validation returned no structural errors or stroke mismatches across its 124-icon audit. The pinned layout leaves 76.1% of post-sidebar content width to the canvas.

## Known handoff risks

- The ten SVGs match the approved Penpot geometry and pass XML validation. The direct Remote MCP SVG-export defect remains an upstream transport limitation, not a design ambiguity.
- This frozen handoff is the product-approved input to the existing 003 SDD workflow. Screen-level implementation acceptance still requires its own exact-build evidence, independent reviewer result, and product-owner decision.

The archive and every exported asset are checksummed in `manifest.json`.
