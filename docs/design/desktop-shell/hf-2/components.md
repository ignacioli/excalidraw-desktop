# HF-2 shell component contract

This document records the approved Penpot component families and the implementation behavior that is not safely recoverable from pixels alone. Exact visual values come from `tokens.json`; broader behavior and accessibility remain governed by `DESIGN.md`.

## Shared rules

- Use semantic theme tokens, never copied Light/Dark literals inside component styles.
- The shell icon keyline is 16 x 16 with a 1.75 px stroke, round caps, and round joins. Interactive icon controls have at least a 32 x 32 hit target.
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

## Shell / Tab

| Property | Approved value |
|---|---|
| Variant axes | `Mode`, `State` |
| Reference variants | Light Active, Inactive, Hover, Unsaved; Dark Active, Inactive, Unsaved |
| Reference size | 196 x 36 |
| Radius | 6 px |
| Border | 1 px semantic border |

The file name stays visible. Active and unsaved states must not rely on color alone; unsaved includes a visible marker and accessible text. The close slot remains reserved so the title does not move between states. Overflow and close behavior remain defined by `DESIGN.md` and the feature specification rather than by the seven static reference frames.

## Shell / Workspace Row

| Property | Approved value |
|---|---|
| Variant axes | `Mode`, `Type`, `State` |
| Reference variants | Light Directory Default/Expanded/Selected; Light Drawing Default/Hover/Selected; Dark Drawing Selected; Dark Directory Expanded |
| Reference size | 360 x 28 |
| Radius | 6 px |
| Leading glyph | 16 x 16 directory or drawing icon |

Directory disclosure, drawing identity, active selection, and unsaved state use icons or labels in addition to color. Row actions use `icons/more-vertical.svg`, remain hidden only when both pointer and keyboard focus are absent, and always expose an accessible name and tooltip. Long names truncate visually while retaining the complete accessible name and tooltip.

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
- **Pinned:** Sidebar participates in layout. The approved 1280 x 760 reference leaves 76.1% of post-sidebar content width to the canvas; supported sizes must remain at or above the 70% contract.
- **Welcome:** No recoverable session shows the Welcome content as a document state, not a persisted extra tab.
- **Restored:** A recoverable session restores Workspace, tabs, and the previously active drawing without showing Welcome over the session.

## SDK boundary

The central editor canvas and the right-side Library or Presentation surfaces are owned by the official Excalidraw SDK. Shell styling stops at that boundary. Placeholder blocks in the HF-2 screenshots communicate ownership and spatial relationships only; they do not authorize private DOM dependencies or replacement editor UI.
