# 本地版本历史公共文档与菜单入口验证（T045–T047）

## 最新 T047 原生结果（2026-09-26，UTC 2026-09-27）

**T047：PASS（精确 production package 的 History 原生入口范围）**。产品修复提交 `e873aac208e0271641cb2434f49daa4a6d2e01fd`，validator 提交 `0be255df09eec3a076d2e56b9eb64564afece21c`；包 SHA-256 `ef7ce6a97ad7c00da4d5524e36e8b1635e8c2ea8ee74d1798b84b067c8eaf162`。在 macOS 26.6.2 / arm64 / scale 2 上，首次 AX 菜单采样即 enabled；一次 `versionHistory` 路由（validationId 1）、面板标题/唯一目标文件名/关闭按钮各 1 个，以及规范化 fixture 的前后 SHA-256 一致全部通过。[原始报告](local-version-history-t047/history-pass/collection/native-report.json)、[binding](local-version-history-t047/history-pass/binding.json)与[package manifest](local-version-history-t047/history-pass/package-manifest.json)已封存。T048 人工视觉仍 BLOCKED，T049 性能和 T054 负责人接受未在本轮执行。

### 根因与修复

| 分类 | 确认事实 | 修复与判别证据 |
| --- | --- | --- |
| 产品 bug | 前端调用 `native_menu_set_enabled`，Tauri 原注册名却是 `set_native_menu_enabled`，enable 请求不能进入 setter，菜单维持初始 disabled。 | 显式 command rename 对齐合同；使用 Tauri 生成的实际命令名对前端 invoke 做回归检查，旧代码 FAIL、修复后 PASS。新生产包首次菜单采样 PASS。 |
| Harness bug | AppleScript 直接遍历未物化的 `entire contents` specifier，元素 role 读取失败被局部 try 静默忽略，旧 probe 返回 0/0/0。 | 先取得 AX 元素列表再遍历，并让读取错误进入外层限时错误报告。[同包诊断](local-version-history-t047/ipc-registration/diagnostics/corrected-probe.json)得到 1/1/1；AXHeading 另有 AXStaticText 子元素，先前 role 猜测被排除。 |
| Harness fixture 缺陷 | 默认 73-byte 最小场景缺少 SDK 的持久化默认 appState，正常启动后变成 235 bytes；旧 Save 目标未在 manifest 中，启动文件依赖排序 fallback。 | 新增独立规范化源 fixture 与 FINAL-only `--native-launch-fixture`，明确 launchDocument，准备前绑定字节和 SHA。不改变默认 003 fixtures，不放宽 unchanged 断言；fresh collector 前后均为 `48179c1f5f1218ff453d7fbb3ad0c97a680dc4c9c0120101ab03a9437a1cf009`。 |
| Specs | T047 要求实际菜单层级/标签/状态、一次路由和目标文档绑定，范围明确且可验证。 | 本轮无须修改验收要求。旧 003 physical-key 图谱误用于 T047 是此前执行范围问题，不是当前 disabled 根因。 |

### 本轮验证与身份

- Rust 菜单测试 7/7、fmt、Clippy PASS；前端相关测试 38/38 PASS；production build（含严格 TypeScript）和 seal PASS。
- Native collector helper tests 26/26（含 AppleScript 编译）、fixture preparer tests 6/6 PASS；独立 review 无阻断项。
- 正式 attempt `T047-history-003-ax-fixture-fixed` 的 collector、native report、Version History entry 均 PASS，13/13 checks PASS。source package 与 validator 的 runtime-input digest 均为 `eeb27a1de0ec9f5b001c76aa2640aad79dda4ecda8d4bb12eecd6dd0fb64c446`，因此仅 harness 变更后复用同一精确包。
- 中间 attempt [ipc-registration](local-version-history-t047/ipc-registration/collection/native-report.json) 保留 BLOCKED：menu 已 PASS，但暴露新的 AX/fixture 问题；其通用失败计数沿用先前尝试，不能当作同一 disabled 根因连续失败。随后按新的 HARNESS 根因及实际变更独立绑定，不改写旧 attempt。诊断运行仅用于定因，未代替正式 PASS collection。
- Collector 的 1280×760 几何记录不是 T048 的两次稳定截图采样或视觉 verdict；没有执行截图、视觉审批、性能、push、merge 或发布。

### 复验命令

从干净 validator commit，使用新建空 run root 和现存 sealed manifest：

```sh
pnpm native:screen:prepare -- --checkpoint FINAL --package-manifest /private/tmp/t047-e873aac-package-manifest.json --native-launch-fixture "$PWD/e2e/native/004-history-launch.excalidraw" --run-root /private/tmp/t047-history-harness-fixed --plan /private/tmp/t047-history-harness-fixed/final-plan.json --isolation-mode backend-app-data-home-redirect
pnpm native:macos:validate -- --manifest /private/tmp/t047-e873aac-package-manifest.json --capture-plan /private/tmp/t047-history-harness-fixed/final-plan.json --collection-dir /private/tmp/t047-history-harness-fixed/collection --binding /private/tmp/t047-history-harness-fixed/binding.json
```

这些路径记录本次运行；重新执行必须使用新的空 root、重新生成 plan/profile digest 和 binding，不能覆盖本次产物。

## 先前 T047 原生失败（2026-09-26，保留原文）

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
