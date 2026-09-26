# 本地版本历史公共文档与菜单入口验证（T045–T047）

## 当前状态

公共双语文档和 IPC v3 说明已更新；生产 AppShell 已接入唯一 `File → Version History…` 菜单路由、当前文档列表与独立只读预览。T047 的 macOS Accessibility 收集器已扩展，产品提交 `ab67c3c43ee69ae32a040bb3e6f9c762807d8c3c` 的 production `.app` 已封存 PASS，包 SHA-256 `f753ffc97c1912a9d2d481ce11460bc90f1f25818dc73149ac1f4ce2706cf27f`；FINAL 准备计划 `/private/tmp/history-t047-current-uug7DR/post-t050-run-TUbF00/final-plan.json` 亦 PASS。实体 Command-S 与精确包原生菜单采集尚未执行；因此本文件不声称原生菜单验收通过。

## 已执行检查

| 检查                                                                   | 结果                      | 边界                                                                     |
| ---------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------ |
| `pnpm test`                                                            | 58 files / 465 tests PASS | AppShell、HistoryPanel、只读预览、IPC 与既有前端回归                     |
| `pnpm lint`、`pnpm build`                                              | PASS                      | ESLint、严格 TypeScript 与生产前端构建                                   |
| `cargo test --manifest-path src-tauri/Cargo.toml native_menu --lib -q` | 6/6 PASS                  | 原生菜单命令 ID 与事件契约                                               |
| `node --test scripts/native-macos-validation.test.mjs`                 | 23/23 PASS                | T047 收集器的结构、菜单探测、路由绑定与 BLOCKED 分支                     |
| `e2e/tests/local-version-history-production-preview.spec.ts`           | Chromium browser 2/2 PASS | 生产 AppShell 的菜单事件、独立预览、恢复启用门槛和切换文档后的旧响应丢弃 |

浏览器注入的 `native-menu-command` 只证明 WebView 路由，不能证明 macOS 菜单实际层级、可访问性状态或物理点击。T047 仍需把精确生产包、准备计划、唯一打开文档和独立菜单收集报告绑定后运行。

## 验收边界

只读预览使用独立 Excalidraw 实例，不连接当前文档的 draft/save 回调；版本 scene 和资产准备完成且实例报告可渲染后才启用恢复。当前浏览器结果是预检，macOS 生产包上的画面、焦点、Light/Dark 和裁切仍由人工视觉验收负责。性能、发布和产品负责人接受也未在此完成。
