# Local Version History T025 fault acceptance

**Date:** 2026-09-24

**Platform:** macOS 26.6.2 / arm64

**Scope:** shared protected-replacement transaction faults only; this does not close later lifecycle, native-menu, visual, performance, or release acceptance.

## Exact binaries

- E2E Harness binary: `src-tauri/target/release/excalidraw-desktop`
- E2E Harness SHA-256: `eb8e3575ab690d38473c2233ce593da48d3e5de7ac8185f540e40724499398f1`
- Production-absence binary SHA-256: `4225b4eec78e8cb768f09d6d6f04a5e15fe2b8dd98b4861adb95783e737db7c5`
- Harness build: `VITE_E2E_HARNESS=1 VITE_E2E_HISTORY_FRONTEND=1 pnpm tauri build --features e2e-harness --no-bundle`
- Production build: `pnpm tauri build --no-bundle`

The production build replaced the target executable only for the absence check. The E2E Harness was rebuilt afterward; the final native fault and restart results below both bind to the E2E Harness digest above.

## Native process results

- `e2e/tests/local-version-history-faults.spec.ts`: **25/25 PASS**.
- `e2e/tests/local-version-history-recovery.spec.ts`: **1/1 PASS** in 1.6 seconds, run outside the managed sandbox because the sandboxed macOS GUI process cannot initialize required HIServices/TIS XPC services.
- `e2e/tests/production-harness-absence.spec.ts`: **2/2 PASS** against the production binary.

The fault matrix covers:

- standalone marker validation for all seven maintained barriers;
- real protected replacement at object publication, protection commit, intent commit, rename-before-parent-sync, and metadata-before-frontend-ack;
- object-store typed `EACCES` and `ENOSPC`, SQLite pre-commit permission and disk-full rollback, and an unregistered partial-publication orphan;
- missing/corrupt scene objects and image assets while a sibling version remains readable;
- same-request idempotency, different-request exclusion, external write preservation, and request-id status replay after response loss;
- a real 20→21 protected-publication retention eviction interrupted by `SIGKILL` before GC, followed by fresh-process old-state and reachability checks;
- a real frontend callback captured before replacement adoption and released afterward: the old generation is rejected before draft/checkpoint IPC, the cold file is not the attempted stale scene, and the persisted draft remains clean.

## Regression gates

- Vitest: **55 files, 414/414 PASS**.
- Rust with `e2e-harness`: **166 unit tests PASS**, plus all document, entry, workspace, history, identity, query, and untrusted-scene integration suites PASS.
- `pnpm lint`: PASS.
- `pnpm typecheck`: PASS.
- `cargo fmt --check`: PASS.
- `cargo clippy --all-targets --features e2e-harness -- -D warnings`: PASS.
- `git diff --check`: PASS.

## Failure classification and proof limits

Earlier development runs failed for four distinct Harness-oracle mistakes (wrong schema column, wrong phase cardinality, internal/public error-name mismatch, and a deduplicated partial-publication fixture). They were corrected before the final run and are not counted as product PASS evidence. Two earlier restart attempts produced no frontend marker: one ran inside the known-incompatible sandbox GUI environment and one used a bare Cargo rebuild that did not preserve the authoritative Tauri build binding. The final exact Tauri build and outside-sandbox run passed.

The deterministic ENOSPC/EACCES selectors are typed test-only injections at the real object-write and SQLite pre-commit layers; they prove error propagation, cleanup, and rollback, not physical exhaustion of a quota-backed filesystem. Production artifact inspection proves the selectors, process scenarios, and frontend driver tokens are absent.
