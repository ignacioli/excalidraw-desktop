#!/usr/bin/env python3
"""Read the shippable x.y.z version shared by package.json, Tauri, and Cargo."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_VERSION_RE = re.compile(r'^version = "(\d+\.\d+\.\d+)"', re.MULTILINE)


def read_package_version() -> str:
    data = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    version = data["version"]
    if not isinstance(version, str):
        raise SystemExit("error: package.json version must be a string")
    return version


def read_tauri_version() -> str:
    data = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    version = data["version"]
    if not isinstance(version, str):
        raise SystemExit("error: tauri.conf.json version must be a string")
    return version


def read_cargo_version() -> str:
    text = (ROOT / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
    package = text.split("[package]", 1)[1].split("\n[", 1)[0]
    matched = PACKAGE_VERSION_RE.search(package)
    if matched is None:
        raise SystemExit("error: src-tauri/Cargo.toml [package] version is missing")
    return matched.group(1)


def main() -> int:
    package = read_package_version()
    tauri = read_tauri_version()
    cargo = read_cargo_version()
    versions = {"package.json": package, "tauri.conf.json": tauri, "Cargo.toml": cargo}
    unique = set(versions.values())
    if len(unique) != 1:
        detail = ", ".join(f"{name}={version}" for name, version in versions.items())
        raise SystemExit(f"error: version files disagree: {detail}")
    version = unique.pop()
    if re.fullmatch(r"\d+\.\d+\.\d+", version) is None:
        raise SystemExit(f"error: version must be x.y.z, got: {version}")
    sys.stdout.write(f"{version}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
