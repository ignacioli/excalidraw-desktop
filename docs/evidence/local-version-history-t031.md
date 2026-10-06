# Local version history T031 evidence

Date: 2026-09-24

Scope: Phase 4 automatic/manual history cadence and fresh-process retention verification. This evidence does not claim native menu, visual, performance, release, Linux, or production-package acceptance.

## Exact native binary

- Path: `src-tauri/target/release/excalidraw-desktop`
- Build: `cargo build --manifest-path src-tauri/Cargo.toml --release --features e2e-harness`
- SHA-256: `8c9bc5d0ff2c26f67dd39a2b085a8034873234856ab0b77cd36135deaa2d0c51`
- Harness isolation: each journey uses a fresh `excalidraw-desktop-e2e-*` root; seed and verify are separate child processes sharing only that root and the exact binary.

## Native result

Command:

```text
APP_E2E=1 EXCALIDRAW_E2E_HISTORY_AUTOMATIC=1 \
EXCALIDRAW_E2E_BINARY=<absolute path to the binary above> \
PLAYWRIGHT_SKIP_WEBSERVER=1 pnpm exec playwright test \
  e2e/tests/local-version-history-automatic.spec.ts \
  e2e/tests/local-version-history-restart.spec.ts --workers=1
```

Result: **3/3 PASS**.

- 19 and 20 mixed automatic/protected records survive a fresh-process reopen without eviction.
- The 21st mixed record leaves exactly the newest 20 automatic/protected rows.
- The manual row remains outside that pool and remains previewable after restart.
- Manual preview contains the click-time `text-B`, `rect-B`, and `image-B` elements while the current file contains the later edited scene.
- Four calls run through the real `DocumentService::doc_checkpoint` path with only the history timestamp controlled: the first establishes the baseline; `30m-1s` waits; an unchanged close checkpoint adds no version; the changed checkpoint at `30m` publishes.
- A test-only callback counter observes four automatic callbacks for four real cold checkpoints, so the derived history-only timer wakeup count is zero. Production contains no automatic-history timer.

## Failed exploratory assertion retained

The first 21-record run failed because the test compared a frontend raw JSON hash with the backend-normalized and rehydrated preview hash. The persisted manual record and its element IDs were correct. The oracle was corrected to bind the durable response hash separately and compare semantic click-time element IDs; no product behavior was weakened.

## Additional validation

- `pnpm typecheck`: PASS
- `pnpm lint`: PASS
- full Vitest: 55 files, 423/423 PASS
- Rust `e2e-harness`: 173 unit tests plus all integration suites PASS
- `cargo fmt --check`: PASS
- `cargo clippy --all-targets --features e2e-harness -- -D warnings`: PASS
- `git diff --check`: PASS
