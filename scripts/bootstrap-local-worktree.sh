#!/usr/bin/env bash
# Link this machine's primary-checkout agent toolchain into the current
# git worktree. Editor skills, SpecKit scripts, and local handoff notes stay
# gitignored and out of the public repository; worktrees inherit them here.
#
# Usage (cwd must be the product worktree to bootstrap):
#   scripts/bootstrap-local-worktree.sh [--dry-run] [--force]
#   path/to/bootstrap-local-worktree.sh [--dry-run] [--force]
#
# --dry-run   Print actions without changing the filesystem.
# --force     Replace a real directory/file at the destination after copying
#             it to <path>.bak-<timestamp>. Already-correct symlinks are left
#             alone. Never use this on the primary checkout.

set -euo pipefail

DRY_RUN=0
FORCE=0

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown option '$arg'. Use --help." >&2
      exit 2
      ;;
  esac
done

relpath() {
  python3 -c 'import os, sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$1" "$2"
}

now_stamp() {
  date +%Y%m%d-%H%M%S
}

is_same_link() {
  local dest="$1"
  local src="$2"
  local dest_resolved src_resolved
  dest_resolved="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$dest")"
  src_resolved="$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$src")"
  [[ "$dest_resolved" == "$src_resolved" ]]
}

backup_then_remove() {
  local dest="$1"
  local backup="${dest}.bak-$(now_stamp)"
  if (( DRY_RUN )); then
    echo "DRY-RUN backup $dest -> $backup"
    return 0
  fi
  mv "$dest" "$backup"
  echo "backed up $dest -> $backup"
}

link_one() {
  local src="$1"
  local dest="$2"

  if [[ ! -e "$src" && ! -L "$src" ]]; then
    echo "skip    $dest  (no source on primary checkout)"
    return 0
  fi

  mkdir -p "$(dirname "$dest")"

  if [[ -L "$dest" ]]; then
    if is_same_link "$dest" "$src"; then
      echo "ok      $dest"
      return 0
    fi
    if (( DRY_RUN )); then
      echo "DRY-RUN replace symlink $dest"
      return 0
    fi
    rm "$dest"
  elif [[ -e "$dest" ]]; then
    if (( FORCE )); then
      backup_then_remove "$dest"
    else
      echo "ERROR: $dest exists and is not a symlink. Re-run with --force to back it up and replace it." >&2
      return 1
    fi
  fi

  local parent rel
  parent="$(dirname "$dest")"
  rel="$(relpath "$src" "$parent")"
  if (( DRY_RUN )); then
    echo "DRY-RUN ln -s $rel $dest"
    return 0
  fi
  ln -s "$rel" "$dest"
  echo "linked  $dest -> $rel"
}

if ! current="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "ERROR: run this script with the cwd inside a git checkout of excalidraw-desktop." >&2
  exit 1
fi

if [[ ! -f "$current/.specify/memory/constitution.md" || ! -d "$current/src-tauri" ]]; then
  echo "ERROR: $current does not look like the excalidraw-desktop product repository." >&2
  echo "This script is for product git worktrees only, not the private specs repository." >&2
  exit 1
fi

primary="$(git -C "$current" worktree list --porcelain | awk '/^worktree / { print $2; exit }')"
if [[ -z "$primary" ]]; then
  echo "ERROR: could not resolve the primary git worktree." >&2
  exit 1
fi

if [[ "$current" == "$primary" ]]; then
  if (( FORCE )); then
    echo "ERROR: --force is not valid on the primary checkout." >&2
    exit 1
  fi
  echo "primary checkout $current — nothing to link"
  exit 0
fi

echo "current  $current"
echo "primary  $primary"
if (( DRY_RUN )); then
  echo "mode     dry-run"
fi
if (( FORCE )); then
  echo "mode     force"
fi

failures=0
link_one "$primary/.handoff" "$current/.handoff" || failures=$((failures + 1))
link_one "$primary/.agents/skills" "$current/.agents/skills" || failures=$((failures + 1))
link_one "$primary/.cursor/skills" "$current/.cursor/skills" || failures=$((failures + 1))
link_one "$primary/.cursor/agents" "$current/.cursor/agents" || failures=$((failures + 1))
link_one "$primary/.claude/skills" "$current/.claude/skills" || failures=$((failures + 1))
link_one "$primary/.specify/scripts" "$current/.specify/scripts" || failures=$((failures + 1))
link_one "$primary/.specify/templates" "$current/.specify/templates" || failures=$((failures + 1))
link_one "$primary/.specify/workflows" "$current/.specify/workflows" || failures=$((failures + 1))
link_one "$primary/.specify/integrations" "$current/.specify/integrations" || failures=$((failures + 1))

if (( failures )); then
  echo "bootstrap failed with $failures blocking path(s). Existing real directories were left in place." >&2
  exit 1
fi

echo "bootstrap complete"
