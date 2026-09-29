# History 原生视觉状态的离线准备

`prepare_history_visual_fixture` 是独立 Rust example。它不启动 Tauri、WebView 或应用窗口，只通过现有 `WorkspaceService`、`DocumentService`、`HistoryRepository` 和 `HistoryQueryService` 在隔离目录中准备并回读合成数据。

```sh
fixture_parent=$(mktemp -d)
cargo run --manifest-path src-tauri/Cargo.toml --example prepare_history_visual_fixture -- "$fixture_parent/fixture"
```

参数必须是系统临时目录内**尚不存在**的绝对路径；已有目录（包括空目录）、符号链接和临时目录外路径均拒绝。程序不清理或覆盖现有数据。标准输出是 JSON manifest，包含 `profileHome`、`appDataDirectory`、`database`、`historyDatabase`、`workspace`、`currentFile`、`currentFileSha256`、`documentId`、`versionCount` 和 `nativeVerified:false`。产品主数据库位于 `<profileHome>/Library/Application Support/excalidraw-desktop/excalidraw-desktop.sqlite3`，HistoryStore 使用同一 app-data 目录内的 `version-history`。

当前准备的 `history-long-list-and-preview` 场景具有一个已打开身份的合成绘图和 50 个不同内容的 manual marked versions。程序通过生产查询 API 回读两页各 25 条，检查可用性、marked 状态、内容 hash 唯一性，并对首、中、末三条执行 preview hydration。此结果仅证明离线状态可复现；它**不证明** production 包读取了该 profile、原生窗口显示正确，或 T048 已通过。

使用该状态进行原生验收前，应先以独立的应用配置启动目标 production 包，并核对其真实 app-data 路径及打开文件身份与 manifest 一致；尤其不能把 `e2e-harness` 的 `<root>/data/reliability.sqlite3` 路径当作 production profile。实际启动方式和桌面占用须在 owner session 中确认。

generic error 与单行 missing-resource 暂无已证明的离线准备方式；不得把 maintenance issue 或损坏资源的替身当成通过的原生画面。
