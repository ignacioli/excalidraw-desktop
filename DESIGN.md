[English](DESIGN.md) | [简体中文](DESIGN.zh.md)

# Excalidraw Desktop Design System

**Status**: Reconciled canonical contract — approved by product owner

**Last updated**: 2026-09-03

**Scope**: Application shell, desktop-specific UI, and the embedded Excalidraw editor

This document is the in-repo visual and interaction contract for humans and coding agents. Product behavior is defined by the project specification. Desktop-shell terms follow [CONTEXT.md](CONTEXT.md).

## Product character

The app should feel like “Excalidraw reorganized for a reliable desktop document workflow”:

- Familiar, restrained, lightweight, and direct;
- Content first: the canvas always has the highest visual priority;
- Follow desktop workflow conventions; do not imitate a browser or PWA chrome;
- Stay in the same visual language as the locked official Excalidraw package; do not invent a parallel design system.

Avoid decorative gradients, glassmorphism, excessive shadows, large corner radii on every element, purely decorative animation, dense SaaS-dashboard styling, and any control that competes with the canvas for attention.

## Desktop information architecture

The window is an ordinary decorated native window titled **Excalidraw Whiteboard**. Title-bar color and title placement are controlled by the operating system (titlebar choice A). Do not redraw browser chrome, a PWA top bar, or macOS red/yellow/green traffic lights in the web content area. Do not force an app-wide native Dark appearance, a transparent/overlay/hybrid/frameless title bar, or production always-on-top.

| Region | Purpose | Required behavior |
| --- | --- | --- |
| Native title bar | Window identity and OS chrome | Ordinary decorated window; system-colored title bar; title **Excalidraw Whiteboard** |
| Left shell | Workspace navigation and file management | The compact Sidebar and Back icon controls sit together at the far-left of the topmost shell layer. Pinned contains the Current Workspace header and tree; Overlay covers the center without changing its canvas box; Hidden releases all Sidebar space. |
| Center shell | Document navigation and official editor canvas | Tabs occupy the center top layer; the official Excalidraw canvas is directly below. Hidden immediately reflows Tabs and canvas into released horizontal space. |
| Right SDK boundary | Official Library and Presentation surface | Remains an SDK-owned boundary or placeholder. There is no empty app-owned right sidebar; 003 does not redraw, replace, or depend on private editor, Library, or Presentation DOM. |
| Dialog layer | Recovery, conflict, confirmation, naming, preferences, and application/menu actions | One application dialog layer and one context menu; no `window.prompt` / `window.confirm`. |

**Canvas-first three-region shell.** Every reachable state uses the Left / Center / Right hierarchy above. First launch is Hidden. One compact Sidebar button owns every visible mode transition: Hidden opens Overlay, Overlay pins, and Pinned hides/unpins. Entering the left-edge reveal zone may open Overlay without changing the canvas box; no separate Pin/Unpin control is shown. A Pinned Sidebar is resizable from a 360px default within 280–480px, further clamped as needed so the canvas retains at least 70% of post-Sidebar content width (the approved 1280×760 reference is 76.1%); the chosen width persists. Overlay auto-closes 500 ms after pointer leave unless focus, a context menu, a dialog, or a drag holds it. Escape closes the overlay unless a dialog or menu already consumed Escape.

### Startup and browsing states

- **Welcome** is the empty, non-tab document state. It offers **New Drawing**, **Open Workspace**, and Recent Workspaces projected from retained records using only `name` and `rootPath`, ordered by existing `createdAt` descending. **Remove Workspace** safely closes or saves open drawings, unmounts the root, and retains that record here. Activating an accessible unmounted row remounts the same record; an inaccessible row reports an error only when activated and remains visible. **Remove from Recents** is available only on unmounted rows and deletes application history without touching disk. Choosing the same retained root through **Open Workspace** also remounts that record instead of creating a duplicate. The default region shows at most five rows and then scrolls internally. No last-opened time or drawing count is added, and cancelling workspace selection leaves the state unchanged.
- **Restored** is the normal post-start shell when a valid Current Workspace or reopenable document exists. A clean reopen does not show the recovery dialog.
- An abnormal exit with recovery candidates shows the recovery dialog first. The Restored shell appears only after the candidates have been resolved; recovery decisions do not overwrite the disk file before the decision is applied.
- **Current Workspace** is the single workspace used by the sidebar tree and its header actions. A missing or invalid saved id falls back to an available workspace without creating a new workspace record.
- **Back** returns to the previous valid browsing location within the Current Workspace. It is disabled when the browsing stack is empty and does not close open documents.

**Workspace tree.** The Current Workspace root and its visible descendants form one continuous virtualized tree of Workspace Entries; multiple mounted workspace roots never stack in the Sidebar. Other workspace records remain available through Welcome/Recent or an explicit workspace-open flow. Drawing rows use a file icon. There is no FileTree, no production `dir_list` listing, and no canvas-content thumbnail worker or `thumb_*` IPC.

**Tabs.** Every tab reserves a close-control slot. The tab context menu provides **Close**, **Close Others**, and **Close Tabs to the Right**. Middle-click closes the pointed tab. Cmd+W (macOS) and Ctrl+W (supported Linux) close the active drawing tab in the application shell. A predominantly vertical wheel gesture over the tab bar switches tabs and coalesces to the latest intent; overflow tabs use the nearest-visible compact strategy without a visible tab-strip scrollbar or smooth scrolling when reduced motion is requested. Closing an Orphaned Document offers **Save As**, **Close Without Saving**, and **Cancel**.

### Action ownership and legacy removal

The shell removes rather than restyles old chrome. All visible counts below must be zero in every reachable state:

- Text or card-style `Workspace sidebar` controls, large text `Pin` / `Unpin` controls, duplicate Workspace-root titles, and multiple Workspace roots in one Sidebar;
- A global top-level `New Drawing`, standalone top-level `Save`, `Export`, or `Appearance` controls, and the normal-state `All changes saved` / autosave strip or its reserved vertical space;
- A visible tab-strip scrollbar, a thick or persistent Sidebar scrollbar, a permanently visible horizontal ellipsis, and triangle, letter, diamond, or Unicode placeholder glyphs for directory/drawing identity;
- Header-action overflow that hides the Current Workspace's compact `New Drawing`, `New Folder`, Collapse-or-Expand-All, or Refresh actions.

Accessible names, tooltips, keyboard operation, hidden semantic labels, and error copy remain required; the zero count applies only to visible obsolete or duplicate chrome. `New Drawing` is a compact Current Workspace-header action and targets the selected directory or the workspace root. `Save To` and `Export Image` retain their SDK or application/menu-level owner; no duplicate top-level Export is introduced. Appearance remains an application/menu-level preference, not standalone shell chrome.

Application-shell UI copy is English in this version.

The first version does not recreate the official PWA main menu, browser/PWA title bar, Excalidraw+ entry points, account UI, realtime collaboration, or cloud-service controls.

## Official Excalidraw boundary

- Import the styles shipped with the locked `@excalidraw/excalidraw` package. Canvas tools, editor panels, icons, control geometry, and in-editor interaction states are owned by the official package.
- Control the editor only through official public `theme` and UI composition APIs. Do not copy upstream private React components or fork upstream application CSS.
- Override only Excalidraw CSS variables documented by the official docs, and keep those overrides scoped to the application root. Do not depend on unstable internal classes unless a compatibility decision records the reason and upgrade tests.
- Initial light/dark values come from the locked dependency package, not from screenshot color picking. Screenshots are for overall style and visual-regression reference only.
- Desktop-specific tabs, file management, dialogs, and preferences belong to the application shell and use the semantic tokens below. Save/Export/Appearance ownership remains with documented SDK or application/menu-level capabilities, never duplicate top-level shell controls.

Official references:

- <https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/>
- <https://docs.excalidraw.com/docs/@excalidraw/excalidraw/customizing-styles>

## Theme model

Theme family and light/dark mode preference are independent concepts:

- `themeId`: theme-family identifier; the first version provides only `excalidraw`.
- `modePreference`: `light`, `dark`, or `system`.
- `resolvedColorScheme`: `light` or `dark`, resolved from the mode preference and the system appearance.

The resolved light/dark mode controls both the application shell and the embedded editor. When `system` is selected, operating-system appearance changes must update both in the same frame; after a fixed `light` or `dark` choice, later system changes must not override the user selection.

Appearance preference is application-local state, not document content. It must not change `.excalidraw` files, drawing semantics, or the export contract. Invalid preferences, or preferences from a future version, fall back to `system`. Native title-bar color stays OS-controlled even when the content mode is a fixed `light` or `dark` choice.

Saved preferences must be applied before the first user-visible UI. Startup must not flash the opposite light/dark mode.

## Semantic tokens

Application components consume semantic tokens and must not use palette literals directly. The approved desktop-shell values are frozen in `docs/design/desktop-shell/hf-2/tokens.json`. At implementation time, reconcile shared roles with the locked Excalidraw package and record its version; SDK-owned editor styling continues to use documented upstream variables, while approved shell roles must not be silently replaced by screenshot-picked values or private SDK internals.

| Canonical token ID | Purpose |
| --- | --- |
| `color.app.background` / `color.canvas.background` | Window content and default editor surface |
| `color.panel.background` / `color.surface.background` | Panels, menus, dialogs, controls, tabs, and floating controls |
| `color.surface.hover` / `color.surface.active` | Hover and pressed states |
| `color.text.primary` / `color.text.secondary` / `color.text.disabled` | Text hierarchy |
| `color.border.subtle` / `color.border.strong` | Dividers, inputs, and selected borders |
| `color.accent.base` / `color.accent.hover` / `color.accent.contrast` | Primary actions and selected controls |
| `color.focus.ring` | Keyboard focus indicator |
| `color.status.danger` / `color.status.warning` / `color.status.success` | Status states; never the only information channel |
| `radius.control` / `radius.panel` / `space.1` / `space.2` / `space.3` / `space.4` / `space.6` | Shared geometry scale |
| `font.ui` / `font.mono` / `font.size.*` / `font.weight.*` | Shell typography |

Light mode uses white and near-white surfaces, deep charcoal text, restrained cool borders, and Excalidraw purple accents. Dark mode uses a near-black canvas surround, dark-gray panels, warm-white text with sufficient contrast, restrained borders, and corresponding light-purple accents. Exact shell values use the canonical IDs in the approved in-repository HF-2 token handoff; exact SDK-owned editor values follow the locked upstream package. Floating-shadow use is a component stacking rule, not a frozen semantic token.

The approved shell geometry uses a 4/8/12/16/24 px spacing scale; 8 px control and 12 px panel radii; 16 px icons with a 1 px default stroke (1.25 px for directional chevron/collapse/expand glyphs) and at least a 32 px hit target; 28 px Workspace rows; 36 px Tabs; and a compact 11/12/14/20/28 px type scale. This is the effective 16 px visual weight of the locked public `@excalidraw/excalidraw` 0.18.1 icon set. Component-specific 6 px radii for Tabs and Workspace rows are recorded in the HF-2 component contract.

## Component and interaction rules

- Prefer semantic HTML and controls that match platform conventions. Every interactive element must have an accessible name and a visible focus indicator.
- hover, active, selected, disabled, loading, empty, error, conflict, permission-denied, and offline are part of the component definition.
- Tabs must show the file name and must not rely on icons alone; unsaved state uses both a visible marker and accessible text. The close-control slot stays reserved so titles do not jump.
- At most one context menu is open. The same trigger toggles it; another trigger replaces it.
- File hierarchy, the active document, selection, warnings, and conflicts must not be expressed by color alone. Drawing rows in the Workspace Sidebar use a file icon, never a canvas thumbnail or a literal text dot.
- When a modal dialog opens, focus moves into it and is constrained there; when it closes, focus returns to the triggering control. One dialog layer at a time; do not use `window.prompt` or `window.confirm`.
- Motion exists only to aid state understanding and stays brief; respect reduced motion, and avoid animated layout jumps around the canvas.
- Shadows express stacking only for floating controls, menus, and dialogs; persistent panels use borders or luminance difference.
- Shell icon controls use the frozen 16×16 icons within 32×32 hit targets. Compact icon controls have transparent fill/border at rest and use secondary foreground colors (`#5C5C5C` Light, `#CED4DA` Dark), gaining the semantic hover/pressed surface and stronger contrast only through interaction. The Current Workspace header keeps New Drawing, New Folder, Collapse-or-Expand-All, and Refresh compact on its name row. Row actions use a borderless vertical ellipsis only while pointer or keyboard focus is present. Tab close stays visually integrated in its reserved slot rather than appearing as a separately boxed button.
- [`docs/design/desktop-shell/hf-2/components.md`](docs/design/desktop-shell/hf-2/components.md) is normative for Icon Button/Back, Tab, Workspace Row, and Welcome Action variants: its 2px theme focus ring, disabled-to-default state priority, visible non-colour cues, row-action tooltip/accessibility rules, and primary/secondary Welcome Action emphasis apply alongside these broader interaction rules.

## Later theme expansion

Later built-in themes and user-defined themes extend the system through validated semantic-token definitions mapped onto a light or dark base mode.

- A theme definition may supply token values only; arbitrary CSS, scripts, remote resources, and selectors are forbidden.
- A custom theme declares a stable identifier, a display name, a base light/dark mode, and the supported semantic tokens.
- Missing or unsupported tokens fall back to the chosen base mode.
- Theme import, a theme editor, theme sharing, and a public theme file format are out of scope for the first version.

## Verification contract

The initial implementation must provide evidence for:

- Light, dark, and follow-system behavior;
- Persistence across restart and fallback from corrupted preferences;
- Shell/canvas synchronization with no opposite-theme flash at startup;
- Six individually reviewed 1280×760 HF-2 shell gates: Welcome Light, Restored Hidden Light, Workspace Pinned Light, Workspace Overlay Light, Welcome Dark, and Workspace Pinned Dark;
- Keyboard navigation, focus visibility, accessible names, contrast, non-color-only state, and reduced motion;
- Native decorated-window behavior on macOS and supported Linux environments.

Each visual gate records the frozen manifest hash, SDK-only mask declaration, shell geometry/token assertions, legacy counts, browser preflight, and macOS package evidence. An independent visual reviewer must inspect each gate; its runtime identity and verdict are evidence, not a substitute for the product-owner decision. The product owner approved this reconciled contract on 2026-09-03 and approved the Penpot revision-59 refinement on 2026-09-06; those approvals do not substitute for screen-level implementation evidence or later visual review.

Penpot SaaS, accessed through Penpot's official hosted Remote MCP, is the approved high-fidelity review carrier for the current desktop-shell redesign. HF-2 revision 59 was approved on 2026-09-06 and is frozen in [`docs/design/desktop-shell/hf-2/`](docs/design/desktop-shell/hf-2/README.md), including the editable archive, manifest, exact token values, component contract, six screen baselines, and ten shell icons. The completed OpenDesign HTML artifacts remain low-fidelity exploration and interaction evidence; they are not the high-fidelity source of truth. An external design workspace must not become a parallel source of truth.
