# 003 baseline audit

**Recorded**: 2026-09-03
**Task**: T002
**Classification**: The existing 003 product implementation is a `PARTIAL/REJECTED baseline`. Its commits are audit inputs only; no former checkmark, test result, or package observation is accepted as completion of corrected 003.

## Audit commands

Each checkout below was inspected with `git status --short --branch`, `git diff --stat`, `git diff --cached --stat`, and a four-commit `git log --oneline --decorate` immediately before reconciliation work. Both diff-stat commands produced no entries.

| Checkout | Branch and HEAD | Worktree state | Ahead history relevant to this audit |
|---|---|---|---|
| Public product primary checkout | `main` at `8c873e2` | clean | `8c873e2 Merge pull request #7 from ignacioli/docs/bootstrap-codex-and-specs` (also `origin/main` and `origin/feat/003-desktop-shell-ux-ui`) |
| Product 003 topic worktree | `feat/003-desktop-shell-ux-ui` at `8c63f05` | clean; ahead 3 of `origin/feat/003-desktop-shell-ux-ui` | `8c63f05 Polish desktop shell UX and routing`; `a5032fb Implement Phase 3–7 desktop shell`; `5553639 Add Phase 1–2 shell foundations` |
| Shared private specs checkout | `main` at `0ff85cd` | clean | `0ff85cd Merge pull request #1 from ignacioli/codex/excalidraw-desktop-003-ux-ui`; this checkout is not the corrective authority |
| Isolated corrective private specs worktree | `codex/excalidraw-desktop-003-ux-ui` at `eeffd45` | clean; ahead 4 of `origin/codex/excalidraw-desktop-003-ux-ui` | `eeffd45 Rebuild 003 visual acceptance gates`; earlier local commits `c9c051e`, `1b835b6`, `3d9fcf2` are revoked task-history inputs |

## Scope decision

All product-file reconciliation in this round is confined to the product topic worktree. The primary `main` checkout and the shared `specs` symlink are not modified. The isolated private specs worktree remains the authority for the corrective task wording; it is not pushed by this task.
