# 本地版本历史公共文档与菜单入口验证（T045–T047）

## 最新 T047 原生结果（2026-09-26）

**T047 保持未完成，当前精确包实测为 `FAIL`。** Production `.app` 的 package SHA-256 为 `f753ffc97c1912a9d2d481ce11460bc90f1f25818dc73149ac1f4ce2706cf27f`，manifest 绑定产品提交 `55458f23e4a50c02bff7d85de550b74dca163c37`；后续 validator-only 提交 `dd14eeefdb652ea9fe320c4b471ad20b602d2b42` 的 runtime-input digest 与该包来源相同。包身份、干净 worktree、macOS 26.6.2/arm64、隔离 profile 和进程安全检查均 PASS。

- 旧 FINAL collector 的[原始报告](local-version-history-t047/legacy-final-observer/native-report.json)（SHA-256 `684b73b971559dee5117166c9e2d6d82a852019cbb6ba02d686159dca082952f`）显示：physical Command-S observer 为 `BLOCKED`，同时 History 菜单 disabled、History 路由超时；Save/Export/Appearance 的其他六个 route 检查 PASS。这些检查不能互相替代。原始 [binding](local-version-history-t047/legacy-final-observer/binding.json) 与 collection 保留。
- 对照 003 的已批准 R15 决定后，停止复用 automated physical-key / 003 七动作 FINAL 图谱。004 T047 的批准范围只是精确包上的 History 菜单层级、状态、一次路由和目标文档绑定；validator-only `history` scope 的结构测试 26/26 PASS，不要求人再次按 Command-S。
- 新 `history` scope 的[原始报告](local-version-history-t047/history-only/native-report.json)（SHA-256 `26a73b16e463972b3bae2f56cd25d76acc58539b416fe8889f18f77b42d1020e`）在全新隔离 profile 的 15 秒/30 次 AX 采样中持续读到 `File → Version History…` disabled，形成 `native-menu=FAIL`；因此没有点击菜单，也没有任何 History 路由或面板文件名 PASS。原始 [binding](local-version-history-t047/history-only/binding.json)、[package manifest](local-version-history-t047/package-manifest.json)和 collection 保留。该 profile 的历史 identity 与 clean draft 均指向唯一启动文件，但这不能证明采样时 React 活动会话或 `native_menu_set_enabled` 的调用顺序；当前尚不能把 disabled 状态确定归因为产品或启动/菜单状态同步缺陷。
- 两次 collection 均同时封存 prepared plan 和 fixture manifest；history-only 还保留了[启动绘图原件](local-version-history-t047/history-only/launch-document.excalidraw)。旧失败 root 和两个独立 profile 未清理，原始 `FAIL/BLOCKED` 不因新探针而被改写。

下一步只追踪已打开文档到 `native_menu_set_enabled(true)` 的可观察调用/结果；若证明活动文档 ready 且菜单仍 disabled，按产品失败修复。不得重跑旧 physical observer，也不得以人工视觉结果覆盖 disabled 菜单或缺失的路由配对。T048 视觉仍由独立人工审查负责。

## 先前预检状态（历史）

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
