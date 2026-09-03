# HF-2 icon contact-sheet verification

**Task**: T009
**Recorded**: 2026-09-03
**Verdict**: PASS

## Scope and provenance

This check uses only the frozen HF-2 `manifest.json`, `README.md`, and ten `icons/*.svg` files. It does not load, decode, or inspect `source/excalidraw-desktop-uxui-redesign.penpot`, and it makes no live Penpot request. The manifest supplies the preserved Penpot icon inventory: icon name, Penpot `shapeId`, path, and SHA-256.

The contact sheet is [icon-contact-sheet.png](./icon-contact-sheet.png). Its tiles are ordered left-to-right, then top-to-bottom: Back, Sidebar, Pin, New Drawing, New Folder, Collapse All, Expand All, Refresh, More Vertical, Close.

## Per-icon result

| Icon | Manifest path | Penpot shape ID | SHA-256 match | XML | Rendered tile | Result |
|---|---|---|---|---|---|---|
| Back | `icons/back.svg` | `18570eb3-fcf2-80e5-8008-9205ee6d3e59` | PASS | PASS | visible left-arrow | PASS |
| Sidebar | `icons/sidebar.svg` | `18570eb3-fcf2-80e5-8008-9205ee79ab3c` | PASS | PASS | visible split-panel | PASS |
| Pin | `icons/pin.svg` | `18570eb3-fcf2-80e5-8008-9205ee869477` | PASS | PASS | visible pin | PASS |
| New Drawing | `icons/new-drawing.svg` | `18570eb3-fcf2-80e5-8008-9205ee9357c3` | PASS | PASS | visible document-plus | PASS |
| New Folder | `icons/new-folder.svg` | `18570eb3-fcf2-80e5-8008-9205ee9fe779` | PASS | PASS | visible folder-plus | PASS |
| Collapse All | `icons/collapse-all.svg` | `18570eb3-fcf2-80e5-8008-9205eeac8588` | PASS | PASS | visible paired down-chevrons | PASS |
| Expand All | `icons/expand-all.svg` | `18570eb3-fcf2-80e5-8008-9205eeb9c9bf` | PASS | PASS | visible paired up-chevrons | PASS |
| Refresh | `icons/refresh.svg` | `18570eb3-fcf2-80e5-8008-9205eec73722` | PASS | PASS | visible circular refresh arrow | PASS |
| More Vertical | `icons/more-vertical.svg` | `18570eb3-fcf2-80e5-8008-9205eed48ce2` | PASS | PASS | visible vertical ellipsis | PASS |
| Close | `icons/close.svg` | `18570eb3-fcf2-80e5-8008-9205eeea0cbe` | PASS | PASS | visible close mark | PASS |

## Method and limitations

`xmllint --noout` validated each source SVG. SHA-256 values were recomputed and compared to the manifest. macOS Quick Look (`qlmanage`) rendered each source SVG independently; the resulting ten thumbnails were cropped, enlarged for inspection, and arranged without modifying any frozen SVG. The rendered sheet is 960×384 with non-white raster content.

ImageMagick's SVG reader did not resolve these files' `currentColor` reliably, so it was not used as the SVG renderer. It was used only to crop, scale, and arrange the Quick Look PNG thumbnails. The visual comparison is therefore limited to the preserved manifest/Penpot inventory and recognizable rendered geometry; it is not a fresh Penpot export and does not alter the archived source.

`HF2-SVG-001` is resolved for the required rendered contact-sheet comparison: the frozen XML-valid SVGs match the manifest inventory and produce ten visible, recognizable tiles. This does not turn the failed historical direct SVG export channel into a valid export channel.
