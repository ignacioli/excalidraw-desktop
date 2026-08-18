[English](DESIGN.md) | [简体中文](DESIGN.zh.md)

# Excalidraw Desktop Design System

**Status**: Approved design contract

**Last updated**: 2026-08-06

**Scope**: Application shell, desktop-specific UI, and the embedded Excalidraw editor

This document is the in-repo visual and interaction contract for humans and coding agents. Product behavior is defined by the project specification.

## Product character

The app should feel like “Excalidraw reorganized for a reliable desktop document workflow”:

- Familiar, restrained, lightweight, and direct;
- Content first: the canvas always has the highest visual priority;
- Follow desktop workflow conventions; do not imitate a browser or PWA chrome;
- Stay in the same visual language as the locked official Excalidraw package; do not invent a parallel design system.

Avoid decorative gradients, glassmorphism, excessive shadows, large corner radii on every element, purely decorative animation, dense SaaS-dashboard styling, and any control that competes with the canvas for attention.

## Desktop information architecture

The standard window uses the operating system’s ordinary decorated window. Do not redraw browser chrome, a PWA top bar, or macOS red/yellow/green traffic lights in the web content area.

| Region | Purpose | Required behavior |
|------|------|----------------|
| Top tab bar | Navigation among open documents | Show the file name, active state, and unsaved state; support keyboard and pointer operation |
| Left file pane | Mounted workspaces and drawing files | Own file navigation and file actions; show an actionable empty state when no workspace is mounted; collapsible, but must not cover the active canvas by default |
| Right editing area | Official Excalidraw editor | Occupy remaining space and remain the primary visual surface |
| Dialog layer | Export, recovery, conflict, confirmation, and preferences | Use a unified dialog and focus-management model |

The first version does not recreate the official PWA main menu, browser/PWA title bar, Excalidraw+ entry points, account UI, realtime collaboration, or cloud-service controls.

## Official Excalidraw boundary

- Import the styles shipped with the locked `@excalidraw/excalidraw` package. Canvas tools, editor panels, icons, control geometry, and in-editor interaction states are owned by the official package.
- Control the editor only through official public `theme` and UI composition APIs. Do not copy upstream private React components or fork upstream application CSS.
- Override only Excalidraw CSS variables documented by the official docs, and keep those overrides scoped to the application root. Do not depend on unstable internal classes unless a compatibility decision records the reason and upgrade tests.
- Initial light/dark values come from the locked dependency package, not from screenshot color picking. Screenshots are for overall style and visual-regression reference only.
- Desktop-specific tabs, file management, status, dialogs, and preferences belong to the application shell and use the semantic tokens below.

Official references:

- <https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/>
- <https://docs.excalidraw.com/docs/@excalidraw/excalidraw/customizing-styles>

## Theme model

Theme family and light/dark mode preference are independent concepts:

- `themeId`: theme-family identifier; the first version provides only `excalidraw`.
- `modePreference`: `light`, `dark`, or `system`.
- `resolvedColorScheme`: `light` or `dark`, resolved from the mode preference and the system appearance.

The resolved light/dark mode controls both the application shell and the embedded editor. When `system` is selected, operating-system appearance changes must update both in the same frame; after a fixed `light` or `dark` choice, later system changes must not override the user selection.

Appearance preference is application-local state, not document content. It must not change `.excalidraw` files, drawing semantics, the export contract, or the thumbnail-cache contract. Invalid preferences, or preferences from a future version, fall back to `system`.

Saved preferences must be applied before the first user-visible UI. Startup must not flash the opposite light/dark mode.

## Semantic tokens

Application components consume semantic tokens and must not use palette literals directly. Initial values must be extracted from the locked Excalidraw light/dark styles, and the corresponding package version must be recorded at implementation time.

| Token role | Purpose |
|------------|------|
| `app-background` | Window content background |
| `canvas-background` | Default editor surface around document content |
| `panel-background` | Sidebars, menus, dialogs, and persistent panels |
| `surface-background` | Buttons, tabs, inputs, and floating controls |
| `surface-hover` / `surface-active` | Hover and pressed states |
| `text-primary` / `text-secondary` / `text-disabled` | Text hierarchy |
| `border-subtle` / `border-strong` | Dividers, inputs, and selected borders |
| `accent` / `accent-hover` / `accent-contrast` | Primary actions and selected controls |
| `focus-ring` | Keyboard focus indicator |
| `danger` / `warning` / `success` | Danger, warning, and completion states; must not be the only information channel |
| `shadow-floating` | Menus and dialogs only |
| `radius-control` / `radius-panel` | Shared corner radii for controls and panels |
| `space-*` | Shared spacing scale for the shell |

Light mode uses white and near-white surfaces, deep charcoal text, restrained cool borders, and Excalidraw purple accents. Dark mode uses a near-black canvas surround, dark-gray panels, warm-white text with sufficient contrast, restrained borders, and corresponding light-purple accents. Exact values follow the locked upstream package.

## Component and interaction rules

- Prefer semantic HTML and controls that match platform conventions. Every interactive element must have an accessible name and a visible focus indicator.
- hover, active, selected, disabled, loading, empty, error, conflict, permission-denied, and offline are part of the component definition.
- Tabs must show the file name and must not rely on icons alone; unsaved state uses both a visible marker and accessible text.
- File hierarchy, the active document, selection, warnings, and conflicts must not be expressed by color alone.
- When a modal dialog opens, focus moves into it and is constrained there; when it closes, focus returns to the triggering control.
- Motion exists only to aid state understanding and stays brief; respect reduced motion, and avoid animated layout jumps around the canvas.
- Shadows express stacking only for floating controls, menus, and dialogs; persistent panels use borders or luminance difference.

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
- Representative light/dark visual snapshots of the desktop shell and editor;
- Keyboard navigation, focus visibility, accessible names, contrast, non-color-only state, and reduced motion;
- Native decorated-window behavior on macOS and supported Linux environments.

Open Design is only an optional exploration tool for later original visual work, such as recovery flows, complex empty states, first-run guidance, or a theme editor. Adopted exploration results must be written back into this document and the in-repo token definitions; an external design workspace must not become a parallel source of truth.
