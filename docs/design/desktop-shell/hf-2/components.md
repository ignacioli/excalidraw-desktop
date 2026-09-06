# HF-2 shell component contract

This document records the approved Penpot component families and the implementation behavior that is not safely recoverable from pixels alone. Exact visual values come from `tokens.json`; broader behavior and accessibility remain governed by `DESIGN.md`.

## Shared rules

- Use semantic theme tokens, never copied Light/Dark literals inside component styles.
- The shell icon keyline is 16 x 16. Default action glyphs use a 1 px stroke; directional chevron/collapse/expand glyphs use 1.25 px for optical clarity. Both use round caps and joins. Interactive icon controls have at least a 32 x 32 hit target.
- Compact icon buttons have no fill or border at rest. Their default foreground is `color.text.secondary` (`#5C5C5C` Light, `#CED4DA` Dark); hover and pressed use higher contrast with `color.surface.hover` and `color.surface.active`.
- Visible focus uses the theme's `color.focus.ring`, a 2 px indicator, and must remain distinguishable from selected or active state.
- State priority is disabled, loading, pressed, focus, hover, then default. Do not remove accessible names, keyboard paths, or non-color state cues when combining states.
- Light and Dark variants share geometry. Theme switching changes semantic values, not layout.

## Shell / Icon Button / Back

| Property | Approved value |
|---|---|
| Variant axes | `Mode`, `State` |
| Reference variants | Light Default, Hover, Pressed, Focus, Disabled; Dark Default |
| Button size | 32 x 32 |
| Glyph | 16 x 16 `icons/back.svg` |
| Radius | 8 px |

Back means return to the previous browsing location. It is not an up-one-directory control and must preserve disabled semantics when no history target exists. The same geometry and state treatment applies to other compact shell icon buttons unless a component-specific contract says otherwise.

The compact **Sidebar** button is the only visible owner of Sidebar mode changes: Hidden opens Overlay, Overlay pins the Sidebar, and Pinned hides/unpins it. Entering the left-edge reveal zone may open Overlay. A separate Pin/Unpin button is deprecated and must not appear in key screens.

## Shell / Tab

| Property | Approved value |
|---|---|
| Variant axes | `Mode`, `State` |
| Reference variants | Light Active, Inactive, Hover, Unsaved; Dark Active, Inactive, Unsaved |
| Reference size | 196 x 36 |
| Radius | 6 px |
| Border | 1 px semantic border |

The file name stays visible. Active and unsaved states must not rely on color alone; unsaved includes a visible marker and accessible text. The close slot remains reserved so the title does not move between states. Overflow and close behavior remain defined by `DESIGN.md` and the feature specification rather than by the seven static reference frames.

The close glyph is visually integrated into the tab rather than rendered as a separately boxed control. The slot remains stable and keyboard accessible.

## Shell / Workspace Row

| Property | Approved value |
|---|---|
| Variant axes | `Mode`, `Type`, `State` |
| Reference variants | Light Directory Default/Expanded/Selected; Light Drawing Default/Hover/Selected; Dark Drawing Selected; Dark Directory Expanded |
| Reference size | 360 x 28 |
| Radius | 6 px |
| Leading glyph | 16 x 16 directory or drawing icon |

Directory disclosure, drawing identity, active selection, and unsaved state use icons or labels in addition to color. Row actions use `icons/more-vertical.svg`, remain hidden only when both pointer and keyboard focus are absent, and always expose an accessible name and tooltip. Long names truncate visually while retaining the complete accessible name and tooltip.

Workspace rows use the same semantic hover/pressed surfaces as compact Sidebar controls. The vertical action remains borderless and gains its visible background only on hover, focus, or press.

## Shell / Welcome Action

| Property | Approved value |
|---|---|
| Variant axes | `Mode`, `Emphasis`, `State` |
| Reference variants | Light Primary Default/Hover; Light Secondary Default/Hover; Dark Primary Default; Dark Secondary Default |
| Reference size | 220 x 40 |
| Radius | 8 px |
| Border | 1 px |

The approved primary action is **New Drawing**; **Open Workspace** is secondary. Both include text and a leading 16 x 16 icon. The static references do not waive required focus, disabled, loading, permission-denied, or error behavior.

## Layout states

- **Hidden:** Sidebar releases its space; Tabs reflow into the available top layer and the canvas expands.
- **Overlay:** Sidebar covers the canvas without changing the canvas box and obeys the hold/escape rules in `DESIGN.md`.
- **Pinned:** Sidebar participates in layout. It is pointer- and keyboard-resizable, defaults to 360 px, and is clamped to 280–480 px plus the stricter runtime maximum required to keep at least 70% of post-Sidebar content width for the canvas. The approved 1280 x 760 reference leaves 76.1% to the canvas. The chosen width persists with shell preferences.
- **Welcome:** No recoverable session shows the Welcome content as a document state, not a persisted extra tab.
- **Restored:** A recoverable session restores Workspace, tabs, and the previously active drawing without showing Welcome over the session.

The Current Workspace header always keeps four icon actions on the name row: New Drawing, New Folder, Collapse-or-Expand-All, and Refresh.

Recent Workspaces retains every existing record but shows at most five rows in the default viewport; additional rows remain available through an internal vertical scroll region. Rows use the Workspace-row hover/focus surface. No last-opened time or drawing count is introduced.

## SDK boundary

The central editor canvas and the right-side Library or Presentation surfaces are owned by the official Excalidraw SDK. Shell styling stops at that boundary. Placeholder blocks in the HF-2 screenshots communicate ownership and spatial relationships only; they do not authorize private DOM dependencies or replacement editor UI.
