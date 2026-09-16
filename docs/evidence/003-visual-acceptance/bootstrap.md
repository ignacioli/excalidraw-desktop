# 003 product-worktree bootstrap and reviewer availability

**Recorded**: 2026-09-03
**Tasks**: T003, T004

## T003 — product worktree bootstrap

The bootstrap script ran from the existing product topic worktree:

```text
/Users/liyongqiang/gitrepo/ignacioli/excalidraw-desktop/.worktrees/feat-003-desktop-shell-ux-ui
```

`scripts/bootstrap-local-worktree.sh` completed successfully and preserved the existing relative `specs` symlink (`../../../specs/excalidraw-desktop`). It did not copy configuration and did not repoint the shared specs checkout. The product topic worktree's `.codex/agents` is a symlink resolving to:

```text
/Users/liyongqiang/gitrepo/ignacioli/excalidraw-desktop/.codex/agents
```

The corrective private-spec authority remains the isolated absolute path below, rather than the shared `specs` symlink:

```text
/Users/liyongqiang/gitrepo/ignacioli/excalidraw-desktop-specs-003/excalidraw-desktop/003-desktop-shell-ux-ui
```

## T004 — independent reviewer configuration

The following TOML parsed successfully from the bootstrapped product worktree:

```text
.codex/agents/ui-visual-acceptance-reviewer.toml
name=ui-visual-acceptance-reviewer
model=gpt-5.6-sol
model_reasoning_effort=high
```

This proves static role availability only. It does not prove a future runtime model, reasoning setting, reviewer task identity, independence from the UI author, or visual verdict. Each VSL-001 and later screen review must record those runtime facts in its screen evidence and must not be performed by the production UI author.
