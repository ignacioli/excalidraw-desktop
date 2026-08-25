#!/usr/bin/env python3
"""Extract one Keep a Changelog section and append the Gatekeeper footer."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

VERSION_RE = re.compile(r"^v?(?P<version>\d+\.\d+\.\d+)$")
HEADING_RE = re.compile(r"^## \[(\d+\.\d+\.\d+)\]")
COMPARE_LINK_RE = re.compile(r"^\[\d+\.\d+\.\d+\]:")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Print GitHub Release notes for a version from CHANGELOG.md."
    )
    parser.add_argument("version", help="Version such as 0.2.0 or v0.2.0")
    parser.add_argument(
        "--changelog",
        type=Path,
        default=Path("CHANGELOG.md"),
        help="Path to CHANGELOG.md",
    )
    parser.add_argument(
        "--footer",
        type=Path,
        default=Path("docs/release-notes-footer.md"),
        help="Path to the Gatekeeper footer",
    )
    return parser.parse_args()


def extract_section(changelog: str, version: str) -> str:
    lines = changelog.splitlines()
    start: int | None = None
    end = len(lines)
    for index, line in enumerate(lines):
        heading = HEADING_RE.match(line)
        if heading is None:
            if start is not None and COMPARE_LINK_RE.match(line):
                end = index
                break
            continue
        if heading.group(1) == version:
            start = index
            continue
        if start is not None:
            end = index
            break
    if start is None:
        raise SystemExit(f"error: no CHANGELOG.md section for [{version}]")
    section = "\n".join(lines[start:end]).strip()
    if not section:
        raise SystemExit(f"error: empty CHANGELOG.md section for [{version}]")
    return section


def main() -> int:
    args = parse_args()
    matched = VERSION_RE.fullmatch(args.version)
    if matched is None:
        raise SystemExit(f"error: version must be x.y.z, got: {args.version}")
    version = matched.group("version")
    if not args.changelog.is_file():
        raise SystemExit(f"error: missing changelog: {args.changelog}")
    if not args.footer.is_file():
        raise SystemExit(f"error: missing footer: {args.footer}")
    section = extract_section(args.changelog.read_text(encoding="utf-8"), version)
    footer = args.footer.read_text(encoding="utf-8").strip()
    sys.stdout.write(f"{section}\n\n{footer}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
