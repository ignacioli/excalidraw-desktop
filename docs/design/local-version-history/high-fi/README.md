# Local Version History high-fidelity handoff

**Status:** Approved by the product owner on 2026-09-23

**Penpot version:** `T004 · Local Version History · High-Fidelity Review Baseline · Compact action menu`

**Penpot file:** `excalidraw-desktop-uxui-redesign`

**Penpot page:** `05 · Local Version History · T004`

This directory is the immutable, repository-owned recovery baseline for the approved Local Version History high-fidelity design. Penpot remains the editable design carrier; `interaction.md` is the implementation-facing interaction contract. Stop and resolve any conflict instead of silently choosing one source.

## Approved frames

1. History · Default · Light
2. More Actions · Light
3. Version Preview · Light
4. Restore Confirmation · Light
5. External Recovery · Light
6. History · Compact 300 · Dark

All frames use 1280 × 760. The default drawer is 360 px; 300 px is a compact fallback. The final More actions menu is 180 × 84 px with vector vertical-more, bookmark, and trash icons.

## Artifacts

- `manifest.json` records stable Penpot identity, frame IDs, geometry, validation, approval, and archive integrity.
- `source/excalidraw-desktop-uxui-redesign.penpot` is an offline recovery snapshot downloaded through Penpot Web's native file-download action after Remote MCP validation.

Do not decode or summarize the `.penpot` archive during ordinary implementation. Use the page/frame IDs for focused live reads only when this handoff and `interaction.md` are insufficient or contradictory.

## Evidence boundary

Remote MCP created and individually exported all six frames for visual QA. Penpot file validation reported zero errors, and the product owner approved the resulting high-fidelity design. This approval allows T020 implementation to begin; it does not claim the production UI exists or replace exact-package macOS visual acceptance.
