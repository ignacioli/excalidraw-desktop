# US2 Welcome regression collector report

- Bound product commit: `0284a81c0dcf504ff2eacf8c6da69247d5ca9f5a`
- Result: **PASS**
- Exact T043 command: **36/36 files, 276/276 tests**
- Explicit focused confirmation: **4/4 files, 50/50 tests**
- Test-source digest: `ad590b897399bb9cbd4f89d30f0ea65fcdca4bd51c3891496855612f0de80acd`
- Runtime: macOS 26.6.2 arm64, Node 26.7.0, pnpm 11.25.0, Vitest 4.1.10

The deterministic regressions cover non-persisted Welcome routing, memory-only New Drawing, Open Workspace cancellation, inaccessible Recent handling, approved Recent fields, all-record retention with a five-row scroll boundary, persisted Appearance, System changes, corrupted preference repair, startup Dark-frame behavior, and Light/Dark component-geometry parity.

This collector does not re-aggregate either independent visual reviewer verdict, make a visual-fidelity claim, build or launch a native package, run native-entrypoint acceptance, or author a product-owner artifact. The Phase 5 intermediate owner requirement is `NOT_REQUIRED`.
