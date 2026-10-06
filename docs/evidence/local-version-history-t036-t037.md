# 本地版本历史 T036–T037 验证记录

日期：2026-09-25（America/Los_Angeles）。本记录只覆盖 Phase 5 清空／导入的产品浏览器入口与 macOS test-only 进程事务；不代表生产包 WKWebView、最终视觉、性能、发布或其他平台验收。

## 证据归属

- T036 使用实际产品 React + Excalidraw 0.18.1，在 Chromium 中通过 browser Tauri Harness 模拟 IPC 响应。它证明快捷键、拖放、文件选择、焦点和普通图片／素材库的前端分流；mock 的 `history_replace` 响应不证明后端持久化。
- T037 使用真实 `DocumentService` backed `HistoryReplacementService`、隔离数据根和 macOS test-only binary。它证明 clear/import 目标的后端校验、保护事务、文件结果及 `SIGKILL` 后的 fresh-process 协调；它不运行前端输入准备或首次保存对话框。
- 首次保存取消和输入准备由 T036 的浏览器流程验证。Native Harness 不再输出恒为 true 的 `preparedInput` 字段。

## T036 浏览器结果

命令：

```text
APP_E2E=1 PLAYWRIGHT_SKIP_WEBSERVER=1 pnpm e2e \
  e2e/tests/local-version-history-protected-input.spec.ts \
  e2e/tests/local-version-history-import.spec.ts \
  --project=browser-ui --workers=1 --retries=0
```

结果：**14/14 PASS**。覆盖清空快捷键、导入快捷键与取消、文本编辑、普通 PNG/SVG 单次插入、内嵌场景 PNG/SVG 受保护、素材库 MIME 插入、无效绘图、多文件拒绝、切换文档后的迟到导入、当前不可达的命令面板，以及 clear/import 两种首次保存取消。Dev server 按项目要求在沙箱外启动，测试完成后停止。

共享 browser Tauri Harness 的文件摘要由长度占位值改为实际 SHA-256，以满足 `history_replace` 的真实请求校验。对所有引用该 Harness 的套件扩展回归得到 **41/45 PASS**；四项现有 US1 测试仍因旧 UI 定位器失败：三个 `New drawing` 定位器同时匹配禁用的侧栏按钮与 Welcome 按钮，一个 `Open drawing…` 定位器找不到当前 Welcome 界面的入口。这四项未被计作通过，也未用放宽断言掩盖。

## T037 真实进程结果

- Test-only binary：`src-tauri/target/release/excalidraw-desktop`
- Build：`cargo build --manifest-path src-tauri/Cargo.toml --release --features e2e-harness`
- SHA-256：`abdc76fc9652914457682ca1c55c97a1427f36533a5094679b61fb7cce7527e4`
- 每个用例使用新的隔离 `excalidraw-desktop-e2e-*` 根；response-lost 用例在 `metadata_complete_before_frontend_ack` 屏障处 `SIGKILL`，再以同一数据根启动 fresh-process probe。

命令：

```text
APP_E2E=1 EXCALIDRAW_E2E_BINARY="$PWD/src-tauri/target/release/excalidraw-desktop" \
PLAYWRIGHT_SKIP_WEBSERVER=1 pnpm e2e \
  e2e/tests/local-version-history-protected-replacement.spec.ts \
  --project=browser-ui --workers=1 --retries=0
```

结果：**9/9 PASS**。Clear/import 成功路径各 1 项；disk full、permission denied 和 response lost 各覆盖两个目标；import missing asset 1 项。成功路径的 protected action 与目标一致、文件 hash 等于目标 hash、JSON 可解析、临时文件为空。保护失败时旧文件保持原 hash、无新的 protected record。缺图用例实际调用同一 `e2e_replace`，后端在保护发布前拒绝，旧文件和 protected 数量均不变。响应丢失用例经 fresh process 确认完成状态与完整新文件。

首轮缺图运行曾出现旧文件不变但多出 protected record 的真实失败。产品随后将 import target 的 scene/assets 校验前移到保护发布前；保持原严格断言，重建 binary 后 9/9 PASS。早期四个把前端输入准备预设为失败的伪进程用例已删除，未计入最终结果。

## 其他检查与边界

- `pnpm test`：57 files / 453 tests PASS；`pnpm build`、`pnpm lint`、`pnpm typecheck` PASS。
- Rust `cargo test --features e2e-harness`：174 unit tests 与全部 integration suites PASS；`cargo fmt --check`、Clippy `--all-targets --features e2e-harness -D warnings` PASS。
- 本任务触及文件的 Prettier 检查与 `git diff --check` PASS。全仓 `pnpm format` 因 10 个未被本任务修改的文件仍有格式差异而 FAIL；未为取得绿灯改写这些无关文件。
- Native 结果不证明真实断电、设备缓存耐久性或生产包 WebView 拖放；这些继续归属各自验收层。上述 binary 从本轮未提交工作树构建，当前尚无提交绑定。
