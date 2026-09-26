# 本地版本历史生命周期验证（T038–T044）

## 当前范围

产品实现已接通 Workspace Entry 变更日志的 History 第三阶段、应用内改名和祖先目录改名、Save As 独立身份、实际 Trash 提交后的整份绘图历史删除，以及单条版本删除。T043 的独立真实进程场景仍在收集；本文件记录已执行的定向与跨层检查，不把库测试当作进程级证据。

## 已执行检查

| 检查 | 结果 | 所证明的边界 |
| --- | --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml workspace_entries::mutation_test --lib -q` | 17/17 PASS | v1/v2 日志兼容、History 第三阶段保留与重放、应用内改名、Trash 后历史删除、post-FS/pre-marker 待修复状态及旧/新父目录同步失败重试 |
| `cargo test --manifest-path src-tauri/Cargo.toml --features e2e-harness -q` | 198 个库测试及全部 integration suites PASS | Rust 身份、仓库、GC、IPC 合同与既有工作区入口回归 |
| `pnpm test` | 58 files / 465 tests PASS | HistoryPanel、historyClient、IPC 类型、DocumentManager Save As 与生产预览回归 |
| `pnpm typecheck`、`pnpm lint` | PASS | TypeScript 严格类型与 ESLint |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features e2e-harness -- -D warnings` | PASS | Rust 所有 target 的 lint |
| `git diff --check` | PASS | 改动的空白检查 |

首次 Rust 全套运行中，旧 `contract_entries` 入口因无 HistoryStore 的测试服务被错误地要求 History 阶段而失败（8/9）。随后把该要求限定在生产 `WorkspaceEntryState` 接线；定向合同测试 9/9、修正后 Rust 全套通过。失败未被删除或跳过。

T044 的保留规则引用 T010 的唯一后端矩阵：`retains_mixed_nineteen_twenty_and_only_the_newest_twenty_first_record` 证明 automatic/protected 共用 19/20/21 池；`equal_time_and_sequence_use_id_as_the_final_retention_tie_breaker` 证明同时间序号；`manual_versions_are_deduplicated_by_object_but_excluded_from_retention` 证明 manual 免自动淘汰；`old_records_are_not_expired_by_age_and_failed_publication_does_not_evict` 证明无按天过期。本轮未另建一套重复保留矩阵。

## 尚待证明

- T043 已有 test-only macOS binary 真实进程生命周期 3/3 PASS，覆盖改名/祖先移动、同路径外部替换拒绝、Trash 后历史清理、真实 `DocumentService` conflict Save As New 与孤儿 Save As、带持久提交标记的日志 fresh-process 重放。该 Harness 的 Trash 是隔离的 `RecordingTrashOperator`，不代表 Finder/系统 Trash 验收；产品提交后需用该提交的二进制重新绑定此进程结果。
- T043 仍缺 post-FS/pre-marker SIGKILL 的自动修复证据；当前实现对此保留 `HistoryOperationPending` 日志，避免误清理。父目录同步故障、GC 锁/完整加载、历史资源缺失等专门故障矩阵尚未完成，因此 T043 不标记完成。
- 精确生产包 WKWebView、原生菜单、视觉审批和性能仍属后续验收，不由本文件声称通过。
- 手动版本删除的组件与 IPC 已实现；生产 History drawer 的最终入口及原生菜单路由由后续产品接线和原生验证负责。
