# 本地版本历史生命周期验证（T038–T044）

## 当前范围

**用户故事 4 检查点：PASS（限产品实现与真实进程可靠性范围）。** 产品提交 `01977ec` 接通 Workspace Entry 变更日志的 History 第三阶段、应用内改名和祖先目录改名、Save As 独立身份、Trash adapter 提交后的整份绘图历史删除，以及单条版本删除。以下测试使用该提交的 test-only release binary，SHA-256 `585ad9ae4731838e480d876d70af2571af9fdd61bc1f02d1e368df134f250496`。库测试、进程测试、生产包和人工视觉各自承担不同事实。

## 已执行检查

| 检查 | 结果 | 所证明的边界 |
| --- | --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml workspace_entries::mutation_test --features e2e-harness` | 24/24 PASS | v1/v2/v3 日志兼容、可靠 inode 证明、旧路径重建和 symlink fail-closed、旧/新父目录同步失败重试 |
| `cargo test --manifest-path src-tauri/Cargo.toml --features e2e-harness -q` | 205 个库测试及全部 integration suites PASS | Rust 身份、仓库、GC、IPC 合同与既有工作区入口回归 |
| `pnpm test` | 58 files / 465 tests PASS | HistoryPanel、historyClient、IPC 类型、DocumentManager Save As 与生产预览回归 |
| `pnpm typecheck`、`pnpm lint` | PASS | TypeScript 严格类型与 ESLint |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features e2e-harness -- -D warnings` | PASS | Rust 所有 target 的 lint |
| `git diff --check` | PASS | 改动的空白检查 |
| `cargo test --manifest-path src-tauri/Cargo.toml --test contract_workspace -q` | 4/4 PASS | 卸载/重挂重新授权、原 UUID 保留、同路径新 inode 拒绝 |
| `e2e/tests/local-version-history-faults.spec.ts` | test-only native 32/32 PASS | 真实 post-FS/pre-marker SIGKILL、第三阶段 transaction fault 与 fresh-process retry、父目录同步权限失败、缺失 scene/asset、部分失败孤儿清理、真实 `history_preview` 完整加载与 GC 并发 |
| `e2e/tests/local-version-history-lifecycle.spec.ts` | test-only native 4/4 PASS | 改名/祖先移动、Save As、Trash adapter 删除、fresh-process 重放、卸载/Remove from Recents/重挂授权及同路径替换拒绝 |

首次 Rust 全套运行中，旧 `contract_entries` 入口因无 HistoryStore 的测试服务被错误地要求 History 阶段而失败（8/9）。随后把该要求限定在生产 `WorkspaceEntryState` 接线；定向合同测试 9/9、修正后 Rust 全套通过。失败未被删除或跳过。

T044 的保留规则引用 T010 的唯一后端矩阵：`retains_mixed_nineteen_twenty_and_only_the_newest_twenty_first_record` 证明 automatic/protected 共用 19/20/21 池；`equal_time_and_sequence_use_id_as_the_final_retention_tie_breaker` 证明同时间序号；`manual_versions_are_deduplicated_by_object_but_excluded_from_retention` 证明 manual 免自动淘汰；`old_records_are_not_expired_by_age_and_failed_publication_does_not_evict` 证明无按天过期。本轮未另建一套重复保留矩阵。

## 证据边界

- T043 的真实 post-FS/pre-marker 场景调用 `WorkspaceEntryService::rename`，父进程在精确 barrier 对子进程组发送 `SIGKILL`，新进程使用事前保存的 filesystem identity 判定提交并依次完成父目录同步、主 SQLite、Recovery 和 History 重放；版本数保持 1。v3 日志在旧路径被无关 inode 重建或目标/后代变成 symlink 时保持 pending，不静默改绑。
- 缺失不可重建的 scene/asset 时，该版本稳定标为不可用，完整兄弟版本仍可预览；部分保护写入失败留下的未注册对象在新进程由 GC 安全清理，不改变当前文件或已保留对象。真实 `HistoryQueryService::preview` 在 hydration pin 持有期间与 GC 并发，完整 scene、appState 和 asset base64 均返回。
- Trash 使用隔离的 `RecordingTrashOperator`，证明 Workspace Entry 的后端删除/历史重放，不证明 Finder/系统 Trash。`SIGKILL` 证明所测进程与文件系统中断，不证明物理断电、APFS flush 或 power-loss durability。
- 精确生产包 WKWebView、原生菜单、视觉审批和性能仍属后续验收，不由本文件声称通过。
- 手动版本删除的组件与 IPC 已实现；生产 History drawer 已接入，但真实 macOS 菜单层级和视觉验收仍由后续独立门负责。
