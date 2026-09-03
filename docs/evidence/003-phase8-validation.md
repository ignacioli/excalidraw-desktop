# 003 Phase 8 validation

Date: 2026-09-02

This record covers the Phase 8 polish work for the desktop shell UX/UI
refactor. It does not claim native macOS or Linux acceptance.

## Completed scope

- Public `DESIGN.md` and `DESIGN.zh.md` now describe the Welcome, Restored,
  Current Workspace, and Back states.
- The browser UI harness can model the startup handshake, recovery candidates,
  and the native event-listener boundary needed by browser routing tests.
- `e2e/tests/ui-desktop-shell-routing.spec.ts` covers empty Welcome startup,
  clean Restored startup, and recovery-dialog-first startup.
- The 003 branch diff was audited for accidental FileTree, production
  `dir_list`, thumbnail, and `thumb_*` usage. No such usage was introduced;
  existing historical tests and contract fixtures were left unchanged.
- Recovery startup inspection failures remain blocked instead of entering a
  normal route; unresolved recovery candidates stay visible on Escape; and
  all candidate actions are serialized while one decision is in flight.

## Results

| Check                          | Result                       |
| ------------------------------ | ---------------------------- |
| `pnpm test`                    | PASS — 239 tests in 33 files |
| `pnpm typecheck`               | PASS                         |
| `pnpm lint`                    | PASS                         |
| `git diff --check`             | PASS                         |
| Focused Playwright + shared UI | PASS — 14 tests              |

The focused Playwright run used the target worktree's Vite server on
`http://127.0.0.1:1421`, with `PLAYWRIGHT_SKIP_WEBSERVER=1` as required by the
managed macOS Codex environment.

## Known validation boundaries

- `pnpm exec tsc -p e2e/tsconfig.json --noEmit` remains non-clean because of
  pre-existing errors in unrelated E2E files: missing DOM library globals,
  incompatible Playwright `TestInfo` typings, and the existing `/src/...`
  module-path import. The new routing spec and harness introduced no reported
  errors in that output.
- Browser harness tests do not prove Tauri window behavior, native dialogs,
  filesystem authorization, packaging, or crash/recovery process semantics.
- No physical macOS, Parallels macOS VM, or Ubuntu native run was required by
  the Phase 8 task set and none is claimed here. Those remain separate native
  acceptance evidence for release-level verification.
