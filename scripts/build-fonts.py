#!/usr/bin/env python3
"""Build the offline Virgil-CJK font from Excalidraw's packaged fonts.

The locked @excalidraw/excalidraw package contains the Latin Virgil font and
unicode-subset Xiaolai fonts. This script expands them to mergeable TrueType
fonts, keeps Virgil glyphs authoritative where codepoints overlap, and writes
a deterministic WOFF2 artifact for the desktop bundle.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path
from typing import Sequence

try:
    from fontTools.merge import Merger
    from fontTools.ttLib import TTFont
    from fontTools.ttLib.scaleUpem import scale_upem
except ImportError as error:
    raise SystemExit(
        "fonttools with WOFF2 support is required. "
        "Install it with `python3 -m pip install fonttools brotli`."
    ) from error


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
EXCALIDRAW_FONT_ROOT = (
    REPOSITORY_ROOT
    / "node_modules"
    / "@excalidraw"
    / "excalidraw"
    / "dist"
    / "prod"
    / "fonts"
)
DEFAULT_LATIN_FONT = EXCALIDRAW_FONT_ROOT / "Virgil" / "Virgil-Regular.woff2"
DEFAULT_CJK_DIRECTORY = EXCALIDRAW_FONT_ROOT / "Xiaolai"
DEFAULT_OUTPUT = REPOSITORY_ROOT / "public" / "fonts" / "Virgil-CJK.woff2"
OPEN_TYPE_UNIX_EPOCH = 2_082_844_800


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--latin-font",
        type=Path,
        default=DEFAULT_LATIN_FONT,
        help="Latin handwriting font; defaults to the locked package's Virgil font.",
    )
    parser.add_argument(
        "--cjk-font",
        action="append",
        type=Path,
        dest="cjk_fonts",
        help="CJK font or subset. Repeat to merge multiple files.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="Output WOFF2 path.",
    )
    return parser.parse_args()


def discover_cjk_fonts(explicit_fonts: Sequence[Path] | None) -> list[Path]:
    if explicit_fonts:
        return sorted(path.resolve() for path in explicit_fonts)

    return sorted(DEFAULT_CJK_DIRECTORY.glob("Xiaolai-Regular-*.woff2"))


def require_files(paths: Sequence[Path], label: str) -> None:
    missing = [path for path in paths if not path.is_file()]
    if missing:
        formatted = "\n".join(f"  - {path}" for path in missing)
        raise SystemExit(f"Missing {label} font file(s):\n{formatted}")


def expand_for_merge(source: Path, target: Path, target_upem: int) -> None:
    font = TTFont(source, recalcTimestamp=False)
    font.flavor = None
    current_upem = font["head"].unitsPerEm
    if current_upem != target_upem:
        scale_upem(font, target_upem)
    font["head"].created = OPEN_TYPE_UNIX_EPOCH
    font["head"].modified = OPEN_TYPE_UNIX_EPOCH
    font.save(target, reorderTables=True)
    font.close()


def set_font_names(font: TTFont) -> None:
    naming = {
        1: "Virgil CJK",
        2: "Regular",
        4: "Virgil CJK Regular",
        6: "Virgil-CJK",
    }
    name_table = font["name"]
    for name_id, value in naming.items():
        name_table.setName(value, name_id, 3, 1, 0x0409)
        name_table.setName(value, name_id, 1, 0, 0)


def build_font(latin_font: Path, cjk_fonts: Sequence[Path], output: Path) -> None:
    require_files([latin_font], "Latin")
    if not cjk_fonts:
        raise SystemExit(
            f"No Xiaolai subsets found under {DEFAULT_CJK_DIRECTORY}. "
            "Run `pnpm install` or pass one or more --cjk-font paths."
        )
    require_files(cjk_fonts, "CJK")

    with TTFont(latin_font, recalcTimestamp=False) as latin:
        target_upem = latin["head"].unitsPerEm

    with tempfile.TemporaryDirectory(prefix="excalidraw-fonts-") as temp_directory:
        temp_root = Path(temp_directory)
        expanded_fonts: list[Path] = []
        for index, source in enumerate([latin_font, *cjk_fonts]):
            expanded = temp_root / f"{index:04d}-{source.stem}.ttf"
            expand_for_merge(source, expanded, target_upem)
            expanded_fonts.append(expanded)

        merged_font = Merger().merge([str(path) for path in expanded_fonts])
        set_font_names(merged_font)
        merged_font["head"].created = OPEN_TYPE_UNIX_EPOCH
        merged_font["head"].modified = OPEN_TYPE_UNIX_EPOCH
        merged_font.flavor = "woff2"

        output.parent.mkdir(parents=True, exist_ok=True)
        merged_font.save(output, reorderTables=True)
        merged_font.close()

    print(
        f"Built {output.relative_to(REPOSITORY_ROOT)} from Virgil and "
        f"{len(cjk_fonts)} Xiaolai subset(s)."
    )


def main() -> int:
    args = parse_args()
    cjk_fonts = discover_cjk_fonts(args.cjk_fonts)
    build_font(args.latin_font.resolve(), cjk_fonts, args.output.resolve())
    return 0


if __name__ == "__main__":
    sys.exit(main())
