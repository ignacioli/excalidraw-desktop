# Phase 2 remediation validation

**Recorded:** 2026-09-05
**Status:** **IMPLEMENTATION/AUTOMATION READY; T023b remains BLOCKED**
**Base product commit:** `fa7474920f56a76ffeacccaf2588f3212495f0c1`
**Source patch SHA-256 (`git diff --binary -- src e2e`):** `20faea5af930befde58b0708b615169761a98953ab26fd937d59699f4f97c261`

This record covers the corrective Phase 2 working tree. It is not an independent
visual-review verdict, product-owner approval, or exact-commit native PASS. No
task checkbox was changed because the product changes remain uncommitted and
T023b is incomplete.

## Corrected failures

- Restored fixtures now open their declared persisted drawing through the public
  Workspace UI before capture. The Pinned screen therefore renders one active
  Tab and the official editor instead of `Select a drawing to begin.`
- Pinned capture opens the public SDK `Library` checkbox for deterministic setup;
  shell assertions still stop at `.excalidraw-editor` and do not inspect private
  SDK DOM.
- The Pinned top layer, 360 px Workspace Sidebar, 196 x 36 Tab, 32 px icon
  actions, 16 px icons, and 28 px rows have explicit +/-2 CSS px assertions.
- The Current Workspace name and its four approved actions share one
  non-wrapping row. `Mount folder...` is no longer present when a Workspace is
  active; it remains available only in the no-Workspace state.
- The Pinned Sidebar no longer renders a separate Unpin control above the
  header. The top Sidebar control retains the Pinned-to-Overlay transition, and
  Overlay retains its compact Pin control.
- Roving-tabindex state no longer makes a row action visible before real pointer
  or keyboard focus. The active drawing has a visible shape cue in addition to
  `aria-selected`.
- The browser harness's empty scene now matches persisted default app state, so
  a clean restored fixture is not falsely marked dirty.
- Native-menu handler ref updates moved out of React render and into an effect,
  closing the repository ESLint gate without changing menu ownership.

## Automated validation

| Command | Result |
| --- | --- |
| `pnpm vitest run src/app/AppShell.test.tsx src/workspaces/WorkspacePanel.test.tsx src/app/nativeMenu.test.ts --reporter=verbose` | PASS — 34 tests |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | PASS |
| `cargo test --manifest-path src-tauri/Cargo.toml native_menu` | PASS — 3 tests |
| `PLAYWRIGHT_SKIP_WEBSERVER=1 PLAYWRIGHT_BASE_URL=http://127.0.0.1:1421 APP_E2E=1 pnpm exec playwright test --config e2e/playwright.config.ts e2e/tests/ui-desktop-shell-visual.spec.ts --reporter=line --workers=1` | PASS — 8 tests |
| `CARGO_TARGET_DIR=/private/tmp/excalidraw-003-phase2-final.m0xQv0/cargo-target pnpm tauri build --bundles app` | PASS |

The Playwright run generated six 1280 x 760 browser-preflight captures under
`e2e/test-results/`. These are not VSL gate evidence and do not replace a
commit-bound macOS capture or independent review.

## Final working-tree bundle

| Item | Value |
| --- | --- |
| Bundle | `/private/tmp/excalidraw-003-phase2-final.m0xQv0/cargo-target/release/bundle/macos/Excalidraw.app` |
| Executable SHA-256 | `9935bbf90b16a3c774ae82b8ac4950770cf0cb70c5c7f737d1c798fb6ea88170` |
| Bundle identifier | `excalidraw-desktop` |
| Version | `0.2.0` |
| Architecture | `arm64` |
| macOS | `26.6.2 (25G83)` |

The final bundle contains the complete latest source changes, but it is a dirty
working-tree build and therefore cannot satisfy the exact-product-commit field
required by T023b.

## Remaining blocker

T023b remains `FAIL / partial` for two non-substitutable gaps:

1. The native runtime Save error was not safely induced. Save on a memory-only
   Untitled drawing remained unsaved but did not expose an error; focused unit
   coverage cannot replace native runtime evidence.
2. No uncropped native 1280 x 760 capture was produced. Browser viewport
   captures cannot substitute for this condition.

Because T023b is incomplete and the tasks require `T023a -> T023b -> T024`, the
successful T024 command set above is pre-review evidence only; T024 remains open.
