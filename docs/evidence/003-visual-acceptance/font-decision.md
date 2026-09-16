# 003 HF-2 shell typography decision record

**Recorded:** 2026-09-03
**Scope:** Phase 2 task T019 governance. This record preserves frozen HF-2 tokens and records the explicit product-owner exception that governs 003 implementation and visual review.

## Decision status

**APPROVED — `HF2-FONT-001`.** The product owner approved a 003-only exception to the frozen family names: 003 does not package Inter or IBM Plex Mono and does not provide a font-settings control. The shell must use the explicit platform-native stacks `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` and `ui-monospace, SFMono-Regular, Menlo, monospace`. The exception applies only to the family assignment; HF-2 font sizes, weights, line heights, component geometry, truncation, wrapping, and layout acceptance remain mandatory.

## Audit method and sources

- Read frozen `tokens.json` and `components.md`, public `DESIGN.md` / `DESIGN.zh.md`, UX brief, current shell components, `src/App.css`, `src/editor/fontLoader.ts`, and `public/fonts/README.md`.
- Read the six frozen 1280×760 PNG baselines one at a time: Welcome Light, Restored Hidden Light, Workspace Pinned Light, Workspace Overlay Light, Welcome Dark, and Workspace Pinned Dark.
- Did **not** load, decode, inspect, or request the `.penpot` archive.

`tokens.json` is direct evidence for the two family names and three UI weights. `components.md` is direct evidence for component variants, dimensions, state priority, and focus treatment, but has no component-to-font-family mapping. The PNGs show rendered shapes only: they cannot identify a font family with sufficient certainty to make a component-specific typography decision.

## Current implementation and asset facts

| Topic                | Confirmed fact                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell UI family      | `src/App.css` uses `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`.                                                                                      |
| Current mono uses    | Recent Workspace root paths, recovery candidate paths, and conflict-dialog paths use `ui-monospace, SFMono-Regular, Menlo, monospace`.                               |
| Bundled assets       | `public/fonts/` contains Assistant, Cascadia Code, Excalidraw-related fonts, Liberation Sans, Nunito, Virgil, and CJK assets; it contains no Inter or IBM Plex Mono. |
| Existing font loader | `src/editor/fontLoader.ts` serves editor/font loading concerns; it does not provide an approved shell Inter or IBM Plex Mono source.                                 |
| Remote source        | No current shell `@font-face`, CDN, runtime font download, or Inter/IBM dependency was found.                                                                        |

## Component typography-use table

| Component / text                     | Frozen-screen or contract evidence                                                                                                           | Inter / IBM Plex proof classification                                                                    | Mono needed?                           | Fallback effect for Chinese / Unicode names and paths                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Welcome title                        | Both Welcome screens visibly use a large sans-like heading; `components.md` does not define its family.                                      | `font.ui` supports a **reasonable inference** of Inter for shell UI; no component-specific direct proof. | No evidence.                           | Inter would fall back for unsupported CJK glyphs; differing fallback metrics can change title wrapping, so CJK must be measured. |
| Welcome body and actions             | Welcome Action contract specifies geometry/state and leading icon plus text, not family.                                                     | **Reasonable inference** for Inter from global UI token; no direct component mapping.                    | No evidence.                           | System fallback should render CJK, but width/line-height must be checked at the frozen geometry.                                 |
| Recent Workspace name                | Welcome screens show names in the shell UI treatment; no family metadata is present.                                                         | **Reasonable inference** for Inter; no direct proof.                                                     | No evidence.                           | CJK names need fallback and truncation/layout verification.                                                                      |
| Recent Workspace rootPath            | Screens visibly include root-path text, but raster evidence cannot identify a mono family. Current CSS uses system monospace.                | **No approved evidence** for IBM Plex Mono. The `font.mono` token alone is not a component binding.      | Unproven.                              | Mono fallback for Chinese paths can have wider/full-width glyph metrics; truncation and row alignment must be tested.            |
| Tabs                                 | Tab contract defines 196×36 geometry, states, border, and close slot; no font family.                                                        | **Reasonable inference** for Inter as shell UI; no direct proof.                                         | No evidence.                           | CJK tab titles may change clipping/close-slot pressure; measure with deterministic Unicode fixtures.                             |
| Workspace header                     | Pinned/overlay screens show the header and icon actions; contract gives no typography family.                                                | **Reasonable inference** for Inter; no direct proof.                                                     | No evidence.                           | CJK workspace names require fallback and no header-action overflow.                                                              |
| Workspace directory / drawing rows   | Workspace Row contract gives 360×28, icon, variants, and action behavior; no family.                                                         | **Reasonable inference** for Inter; no direct proof.                                                     | No evidence.                           | CJK/Unicode labels require fallback, truncation, tooltip, and row-height verification.                                           |
| Tooltips, dialogs, status/error copy | These states are governed by the public design/interaction contract but are not typographically specified by the frozen screens/components.  | **No component-specific evidence** for either family.                                                    | No evidence.                           | Use the approved UI fallback policy; path fields must be assessed independently rather than making all dialog text mono.         |
| Recovery/conflict path fields        | Current CSS deliberately uses system monospace for file paths, but these are not visible typography mappings in the HF-2 component contract. | **No approved IBM evidence**. Current source is implementation context, not a frozen-font decision.      | Plausible product use, but unapproved. | CJK paths may use a system fallback; verify glyph availability and wrapping.                                                     |

## Special finding: IBM Plex Mono

IBM Plex Mono does **not** appear by name in any approved screen copy or in the frozen component contract. It appears only as the unbound `font.mono` token. The root-path strings in Welcome screenshots look visually narrower than UI labels, but that is insufficient evidence to identify a font. Therefore the audit cannot support either “all paths must use IBM Plex Mono” or “all technical text must be mono.”

The historical low-fidelity brief explicitly deferred exact production typography. Its later HF-1 approval accepts typography density, not a documented component-to-family assignment. This leaves the family token globally approved while its `font.mono` use remains under-specified.

## Approved implementation and visual-review rules

`HF2-FONT-001` is broader than the earlier recommended B: it retains neither Inter nor IBM Plex Mono. It is preferable for 003 because the evidence did not prove a component-specific use for either family, and it avoids inventing a production-font procurement requirement solely to satisfy an unbound token.

1. Keep `tokens.json` and the frozen HF-2 component contract unchanged. The deviation, rather than a silent rewrite of those baselines, is the authoritative 003 family exception.
2. Do not package Inter or IBM Plex Mono; do not add `@font-face`, CDN URLs, runtime font downloads, font dependencies, or a user-facing font setting.
3. Apply the UI stack to shell labels, controls, Tabs, Welcome, Workspace rows, tooltips, dialogs, and status/error copy. Keep the system-mono stack only where the existing product already treats a value as a path/technical field; do not infer that all technical copy must be mono.
4. Before every visual capture, wait for `document.fonts.ready`; record the declared CSS stacks, the computed UI/mono families, zero remote font requests, and successful deterministic English plus Chinese/Unicode fallback rendering.
5. Visual review must assert the approved family exception exactly, and must still assert exact size, weight, and line-height plus the unchanged component geometry, truncation, wrapping, and layout rules. A settled font promise or visible glyph alone is not visual acceptance.
