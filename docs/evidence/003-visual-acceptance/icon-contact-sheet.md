# HF-2 icon contact-sheet verification

**Task**: T009 revision-59 rerun
**Recorded**: 2026-09-08
**Status**: PASS

## Scope and provenance

This refresh uses only the approved HF-2 revision-59 `manifest.json`, `README.md`, and ten current `icons/*.svg` files. The handoff was approved by the product owner on 2026-09-06 and frozen by commit `404175840e9096effb4a286dc75ba053c31400b0`. It does not load, decode, or inspect `source/excalidraw-desktop-uxui-redesign.penpot`, and it makes no live Penpot request. The manifest supplies the preserved Penpot icon inventory: icon name, Penpot `shapeId`, path, and SHA-256.

The freshly generated revision-59 contact sheet is [icon-contact-sheet.png](./icon-contact-sheet.png), 960×384 grayscale PNG, SHA-256 `a4210f001d6473a2c9573ea7735ac15212b316f02327049fc8fc2bf27e066e76`. Its tiles are ordered left-to-right, then top-to-bottom: Back, Sidebar, Pin (deprecated), New Drawing, New Folder, Collapse All, Expand All, Refresh, More Vertical, Close. Two consecutive runs produced the same sheet SHA after output metadata was stripped.

## Per-icon result

| Icon | Manifest path | Penpot shape ID | SHA-256 match | XML | Fresh rendered tile | Result |
|---|---|---|---|---|---|---|
| Back | `icons/back.svg` | `18570eb3-fcf2-80e5-8008-9205ee6d3e59` | PASS | PASS | visible left arrow | PASS |
| Sidebar | `icons/sidebar.svg` | `18570eb3-fcf2-80e5-8008-9205ee79ab3c` | PASS | PASS | visible split panel | PASS |
| Pin (deprecated) | `icons/pin.svg` | `18570eb3-fcf2-80e5-8008-9205ee869477` | PASS | PASS | visible pin | PASS |
| New Drawing | `icons/new-drawing.svg` | `18570eb3-fcf2-80e5-8008-9205ee9357c3` | PASS | PASS | visible document plus | PASS |
| New Folder | `icons/new-folder.svg` | `18570eb3-fcf2-80e5-8008-9205ee9fe779` | PASS | PASS | visible folder plus | PASS |
| Collapse All | `icons/collapse-all.svg` | `18570eb3-fcf2-80e5-8008-9205eeac8588` | PASS | PASS | visible paired down chevrons | PASS |
| Expand All | `icons/expand-all.svg` | `18570eb3-fcf2-80e5-8008-9205eeb9c9bf` | PASS | PASS | visible paired up chevrons | PASS |
| Refresh | `icons/refresh.svg` | `18570eb3-fcf2-80e5-8008-9205eec73722` | PASS | PASS | visible circular refresh arrow | PASS |
| More Vertical | `icons/more-vertical.svg` | `18570eb3-fcf2-80e5-8008-9205eed48ce2` | PASS | PASS | visible vertical ellipsis | PASS |
| Close | `icons/close.svg` | `18570eb3-fcf2-80e5-8008-9205eeea0cbe` | PASS | PASS | visible close mark | PASS |

## Method and limitations

`pnpm run hf2:verify` validated each current source SVG with `xmllint --noout`, recomputed its SHA-256 against the revision-59 manifest, and rendered it independently with macOS Quick Look (`qlmanage`). The script changes only temporary render dimensions, then uses ImageMagick to trim, normalize the white background, assemble the fixed-order grid, and strip volatile PNG metadata. It does not modify a frozen SVG.

One scoped inspection of the generated sheet confirmed ten non-empty, recognizable tiles in manifest order. ImageMagick is not the SVG renderer and no screenshot-driven exploration is involved. The visual comparison is limited to the preserved manifest/Penpot inventory and recognizable rendered geometry; it is not a fresh Penpot export and does not alter the archived source.

`HF2-SVG-001` is resolved for revision 59: all ten current SVGs match the manifest inventory, pass XML validation, and produce recognizable current renders. This does not turn the failed historical direct SVG export channel into a valid export channel.
