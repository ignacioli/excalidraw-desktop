# 003 Phase 1 design-gate evidence

Date: 2026-09-02

## T001 — HF-2 SVG inventory

- Source inventory: `docs/design/desktop-shell/hf-2/manifest.json`
- Rendered artifact: [`hf2-icons-contact-sheet.png`](./hf2-icons-contact-sheet.png)
- Result: PASS
- Ten manifest icon records were loaded and rendered from their corresponding
  `icons/*.svg` paths.
- All ten SHA-256 values in `manifest.json` matched the bytes rendered from
  disk; no mismatch was found.
- Visual review of the 5-by-2 contact sheet confirmed that each rendered icon
  corresponds to its manifest name and path: Back, Sidebar, Pin, New Drawing,
  New Folder, Collapse All, Expand All, Refresh, More Vertical, and Close.
- No icon source was redrawn or modified.

## T002 — HF-2 token inventory

Compared `docs/design/desktop-shell/hf-2/tokens.json` with
`src/app/theme/tokens.css`. This task records the mapping only; it does not
change runtime token application.

### Existing semantic coverage

The current CSS already contains equivalent variables for all HF-2 Light and
Dark semantic color roles:

- app, canvas, panel, and surface backgrounds
- surface hover and active states
- primary, secondary, and disabled text
- subtle and strong borders
- accent base, hover, and contrast
- focus ring
- danger, warning, and success status colors

Variable names are abbreviated in the existing runtime layer (for example,
`--accent` represents `color.accent.base` and `--danger` represents
`color.status.danger`); values match apart from JSON/CSS casing.

### Existing primitive coverage

`--space-1`, `--space-2`, `--space-3`, `--space-4`, `--space-6`,
`--radius-control`, and `--radius-panel` cover the corresponding HF-2 space
and radius primitives.

### Gaps for later token work

The runtime token file does not yet expose named variables for the following
HF-2 primitives or component values:

- `border.default` and `border.icon`
- `size.icon`, `size.hit-target`, `size.tree-row`, and `size.tab-height`
- UI and mono font families, font sizes, and font weights
- icon-button, tab, workspace-row, welcome-action, and workspace-sidebar
  component tokens

The existing `--shadow-floating` variable has no corresponding HF-2 token
record and is retained as an existing runtime value. No runtime token swap is
performed in Phase 1.
