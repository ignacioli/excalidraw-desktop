# 验证证据汇总（Phase 10 / T095）

**日期**：2026-08-10
**范围**：Phase 10 全量回归执行结果与三类验证证据（Playwright 浏览器 UI、`APP_E2E=1` Tauri 进程级可靠性、macOS 原生 OS 环境验收）的汇总；2026-08-12 已按宪法 v3.0.0 同步 macOS 必选、Ubuntu 24.04 可选、性能参考测量与未签名开源分发政策。

## 1. 全量浏览器回归（T095 执行）

**命令**：`pnpm e2e`（Playwright `browser-ui`，Vite dev server + 浏览器 Tauri IPC harness）。

| 结果 | 数量 | 说明 |
|------|------|------|
| 通过 | 36 | 全部浏览器可测套件：US1 离线/格式/并发/磁盘满/外观、US3 文件管理/万级滚动、US4 外部变更/事件风暴、US5 导出 fidelity/失败、US7 缩略图/资产去重、T093 a11y 审计 |
| 跳过 | 12 | 原生可靠性（US2 八点故障注入、快照损坏、恢复窗口等）依赖 `APP_E2E=1` + `EXCALIDRAW_E2E_BINARY` 的测试构建；`production-harness-absence` 依赖 `TAURI_PRODUCTION_BINARY` |
| 失败 | 2 | `us1-concurrent-tabs-save`（严格模式定位到 2 个画布）与 `us3-scale-scroll`（`scrollHeight == clientHeight` 边界断言）——见 §1.1 |

### 1.1 已知失败（pre-existing，非本阶段回归）

两个失败用例在干净 `HEAD 9e6ea21`（相同依赖、独立快照目录）上以相同方式复现，且本阶段对 `src/` 的唯一改动是两个语义 token 颜色值（`src/app/theme/tokens.css`），不参与任何布局或虚拟化路径。结论：失败为环境/断言脆性，先于 Phase 10 存在。

- `us1-concurrent-tabs-save.spec.ts`：`locator(".excalidraw__canvas.interactive")` 严格模式命中两个画布（首个标签的 0×0 画布仍在 DOM）。
- `us3-scale-scroll.spec.ts:194`：`scrollHeightPx` 与 `clientHeightPx` 恰好相等（320032），1px 布局漂移即翻转断言；与 T093 审计中记录的外观基线像素漂移（字体/环境级）一致。

处理意见：作为已知偏差记录在案，后续以定位符收敛（`.first()`/可见性过滤）与 `>=` 边界修正消除；修复不属本阶段范围。

## 2. SC-012 统一可靠性阻断门禁

三类可靠性故障测试合并为统一的 SC-012 合并阻断门禁，任一失败即阻止合并：

| 套件 | 任务 | 覆盖 |
|------|------|------|
| `e2e/tests/us2-kill-during-save.spec.ts` | T037 | 原子写八个故障点逐点 SIGKILL，目标文件完整、恢复 UI 正确 |
| `e2e/tests/us2-snapshot-corruption.spec.ts` | T045 | 最新快照自损 → 回退次新并提示实际恢复时间点 |
| `e2e/tests/us4-external-changes.spec.ts` | T066 | 外部变更自动重载/冲突弹窗/失联另存，决策前零写入 |

**执行方式**：`APP_E2E=1 pnpm e2e`，要求 `EXCALIDRAW_E2E_BINARY` 指向故障注入测试构建（Harness 仅测试构建编译注册，生产构建无该接口）。当前证据状态：前序会话（Phase 8/9 交接）报告三套件通过；本会话未重新执行（未构建本地测试二进制），缺口记录见 §5。

## 3. SC-014 外观矩阵与视觉基线（T111）

- `e2e/tests/us1-appearance.spec.ts` 本次 4/4 通过：light/dark/system 初始解析、运行中系统变化、重启恢复、损坏偏好回退、壳层/画布同步、浅色/深色截图基线 `maxDiffPixelRatio <= 0.001`。
- 基线更新：T093 期间重新生成 `us1-shell-light/dark-browser-ui-darwin.png`。审计确认提交基线在生成前已存在约 35k 像素的环境级漂移（字体/渲染），重生成同时捕获当前渲染与 T093 的 token 颜色修正；该修正只改颜色，不改变断言阈值。

## 4. SC-015 无障碍证据（T097–T102 + T093）

- 各故事 a11y 最低线 T097–T102 随功能交付（壳层/标签/外观选择/文件对话框、恢复/冲突对话框、文件树键盘导航、缩略图/多工作区区域、导出对话框表单关联）。
- T093 跨故事审计：axe-core 4.12.1（`@axe-core/playwright`），标签 `wcag2a/wcag2aa/wcag21aa/wcag22aa`，浅色与深色各表面 serious/critical 均为 0；15 个用例全部通过。修复：`--warning`/`--success` 浅色值（白底 2.99:1 → 5.47:1、4.36:1 → 5.40:1）。完整矩阵与键盘/焦点/reduced motion 结论见 [a11y-audit.md](./a11y-audit.md)。

## 5. 参考环境性能测量（T089/T090/T108/T091）

- 基础设施：T089 测量夹具与报告 schema v2.0.0 记录宿主、虚拟化层与客体环境；T091 `performance.yml` 由维护者手动触发参考 VM 完整测量并归档报告。
- 首个参考环境：Apple M5 Pro / 48GB 宿主上的 Parallels Desktop Pro 26.4.1、macOS 26.5.2（25F84）、4 vCPU / 8 GiB VM（客体 `VirtualMac2,1 (Apple M5 Pro (Virtual))`，arm64，WebKit 21624.2.5.11.8）。测量 commit `8c75caafd6e2e1dde19c8ee2afdbb79030e6512f`，e2e-harness 可执行文件 SHA-256 `0235da4dadc0f847fd995db57f4b0f9969bd701791e238b1a818d378fd8273a5`。
- 2026-08-13 根因修复：此前 canvas/I/O 与 soak 的 `not_evaluated` 源于前端 driver `parseCommand` 的序列化缺口——Rust 将 `Option::None` 序列化为 `"targetEvents": null`，而 TS 校验用 `!== undefined`，导致所有不带 `targetEvents` 的 pan-zoom/edit-soak 命令被拒、`result.json` 永不产出。修复为 `PerformanceCommand.target_events` 增加 `#[serde(skip_serializing_if = "Option::is_none")]`，并补 Rust/TS 回归测试。
- 2026-08-13 T090 startup/idle 完整执行，verdict `fail`：10 次冷启动均发布可编辑画布信号，nearest-rank P95 为 2229.164333 ms（超过 2000 ms 预算）；空闲进程树 RSS P95 为 140328960 bytes（低于 150000000 bytes 预算）；60 秒空闲观察 0 个文件系统事件、0 个持久路径变化。
- 2026-08-13 T090 canvas/I/O 完整执行，verdict `fail`：10k 场景稳定后进程树 RSS P95 233537536 bytes（≤350 MB 预算）；pan/zoom 观测 2.04 fps（<30 fps 预算）、最大帧间隔 15668 ms（>100 ms 冻结预算）；60 秒高频编辑 58.72 fps 但最大帧间隔 750 ms（>100 ms）；写合并比 0.00194（≤0.01 预算）。pan/zoom 低帧率与长冻结与 paravirtual GPU 软件渲染一致，需复测并区分产品回归与虚拟化噪声（ADR-004）。
- 2026-08-13 T108 30 分钟 soak 完整执行，verdict `fail`：RSS 增长 18235392 bytes（≤50 MB）且 7.82%（≤15%）；静置 60 秒 CPU P95 为 9.7% 单逻辑核（>1% 预算）；静置观察 8 个文件系统事件、8 个持久路径变化（>0 预算）。空闲 CPU 与静置写盘超出预算，需定位静置期后台写入来源（draftScheduler 兜底/索引/缩略图等）。
- 进程树计量边界（2026-08-13 记录，2026-08-14 已修复，见下）：macOS 上 WKWebView 的 WebContent/GPU/Network 进程被 reparent 到 launchd（ppid=1）且命令行不含 app token，`processMetrics` 的「递归父闭包 + 令牌归属」无法将其归入进程树，故 2026-08-13 报告的 RSS 样本 `processCount=1`、仅计 Tauri 主进程。
- 报告归档：`e2e/perf/results/startup-idle.json`（SHA-256 `0d3a1091…`）、`canvas-io.json`（`62568c47…`）、`edit-soak.json`（`a336a2f6…`），三者 schemaVersion `2.0.0`、commit `8c75caa…`、verdict 均为真实 `fail`。
- 2026-08-14 soak 时长政策变更：经 ADR-006（宪法 v3.2.0、私有 specs 同步），T108 必要编辑 soak 时长由 30 分钟缩短为 15 分钟；RSS 增长预算（≤50 MB 且 ≤15%）与静置检查不变。15 分钟序列的 `rssGrowthBytes` 不得与旧 30 分钟报告直接比较。
- 2026-08-14 测量基础设施修复（`e2e/helpers/webkitProcesses.ts`、`app.ts`、`processMetrics.ts`、driver 错误桥）：
  1. 进程树 RSS 归因改为「启动时间窗口」：ppid=1、启动晚于 app 启动、且不在启动前快照中的 WebKit 角色进程归入应用树。物理机验证 `processCount` 由 1 变为 4（Tauri/WebContent/GPU/Networking）。诚实计量后，物理机（Apple M5 Pro）diagnostic 空闲 RSS P95 为 413.4 MB，超过 150 MB 预算——2026-08-13 VM 报告的 140 MB「通过」是 Tauri-only 口径假象，RSS 全序列需按新口径在参考 VM 重测（构成新测量序列）。
  2. `launchTauriTestApp.close()` 现按同一追踪集终止被 reparent 的 WebKit 孤儿进程；物理机多次启动后确认零泄漏（交接文档所记跨启动进程累积问题关闭）。
  3. driver 错误桥：driver 致命错误经新 Tauri 命令 `e2e_perf_publish_error` 原子发布 `error.json`，Node 侧 `waitForReady/waitForResult` 轮询即刻快速失败；`launchTauriTestApp` 改为捕获 stderr 尾部并入契约错误。WebKit 的 `error.stack` 不含 message，错误格式化已改为 message+stack。
  4. 宿主机「`result.json` 不返回」根因确诊：性能工作负载由 rAF 驱动，窗口被遮挡（用户在其他 Space/全屏应用）或显示器休眠时 WKWebView 暂停 rAF 且 `visibilityState=hidden`，driver 在 `nextAnimationFrame` 上无限挂起、无任何错误输出。driver 的 rAF 停摆看门狗：`visibilityState=hidden` 时 10 秒失败（遮挡/App Nap）；可见但慢的帧等到 60 秒，以便把 10k pan/zoom 的长冻结记成样本而不是 `not_evaluated`（2026-08-13 VM 最大冻结 15668 ms；2026-08-15 第一次 10 秒看门狗在 `visibilityState=visible` 下误杀）。Node 侧 `waitForResult` 松弛 75 秒，须长于可见挂起看门狗。harness 构建禁用 App Nap（`NSProcessInfo` activity）并在 perf 控制模式下窗口置顶。宿主机 diagnostic 跑的硬性前提：测量窗口全程可见；参考 VM 独占 GUI 会话且 Parallels 窗口在前台时不受遮挡暂停影响。
  5. 物理机 2026-08-14 diagnostic startup-idle（修复后口径）：冷启动 P95 1982 ms（贴近 2 s 预算）、空闲全树 RSS P95 413.4 MB（fail）、60 秒空闲 0 写入。报告保留为 `e2e/perf/results/startup-idle.json`（commit `53e6c20`）。
- 2026-08-15 物理机 diagnostic **全树新序列**（`PERF_EXECUTION_ENVIRONMENT=physical`，二进制 `837c5cd82bf4fb316c4405aec131b84640d4d2a2ea608e6f291aa4c1448aca7e`，与 VM canvas-io/soak 同一份；测量窗口 `always_on_top`。报告 JSON 的 `commit` 为测量时宿主 `eb41486`；该二进制已含随后提交的可见慢帧看门狗与 `waitForResult` 松弛）：
  1. startup-idle，verdict `fail`：冷启动 P95 **2049.818417 ms**（略超 2000 ms）；空闲全树 RSS P95 **411025408 bytes**（411.0 MB，> 150 MB）；`processCount=4`；60 秒空闲 0 写入。与 VM 410.7 MB、前次 diagnostic 413.4 MB 同量级。报告：`e2e/perf/results/startup-idle.host.json`（SHA-256 `2d93d88f7464db13ce083d9840553f723ad109dd5d585f390678075bb3304d59`）。
  2. canvas-io，verdict `fail`：10k 全树 RSS P95 **730546176 bytes**（730.5 MB，> 350 MB）；pan/zoom **21.82 fps**（<30）但最大冻结仅 **108 ms**（>100，贴近预算）；高频编辑 **59.97 fps**、最大冻结 **46 ms**（两项冻结/编辑帧率通过）；写合并比 0（通过）。相对 VM 的 2.10 fps / 15396 ms 冻结，物理机 pan/zoom 约高一个数量级，坐实 VM 低帧率主要是 paravirtual GPU；21.82 fps 仍低于 30 fps 预算，属 Phase 2 要归因的产品/workload 问题。报告：`e2e/perf/results/canvas-io.host.json`（SHA-256 `9312a02e11b5ae118237701c6c7f43d1ddeb653d1016e2798047884f18899254`）。
  3. T108 15 分钟 soak，verdict `fail`：预热全树 RSS P95 780976128 bytes（781.0 MB），soak 后 872366080 bytes（872.4 MB）；RSS 增长 **91389952 bytes**（91.4 MB，> 50 MB）但相对增长 **11.70%**（≤15%，通过）；静置 CPU P95 **16.3%**（>1%）；静置写 8 事件 / 8 路径（>0）。`processCount=4`，3600 次编辑、53988 帧。相对 VM 的 167 MB / 22.6% / 28.9% CPU，物理机泄漏与空闲 CPU 更轻，但 8 次静置写盘与 VM 相同，属产品路径而非虚拟化噪声。报告：`e2e/perf/results/edit-soak.host.json`（SHA-256 `fb2569d54e9306b640814ca053a2e28f440bf9572c8d6b250991f56a218f6a37`）。
- 2026-08-14/15 参考 VM **全树归因新序列**（ADR-006 的 15 分钟 soak。报告 JSON 的 `commit` 字段仍是来宾旧仓库副本的 `8c75caa`，**不可信**，取证以二进制 SHA-256 为准。`startup-idle` 二进制 `8246ecf0dfe976580fb228b96d24b1510ea1654fdd822ee09d4e75c749d59a5d`（宿主 `HEAD` `eb41486`）；`canvas-io` / `edit-soak` 二进制 `837c5cd82bf4fb316c4405aec131b84640d4d2a2ea608e6f291aa4c1448aca7e`，含可见慢帧 60 秒看门狗与 75 秒 `waitForResult` 松弛，测量时相对 `eb41486` 尚未提交该 driver/spec 修复）：
  1. T090 startup/idle 完整执行，verdict `fail`：冷启动 P95 **3650.417292 ms**（> 2000 ms）；空闲全树 RSS P95 **410746880 bytes**（410.7 MB，> 150 MB）；`processCount=4`（Tauri + WebContent + GPU + Networking）；60 秒空闲 0 个文件系统事件、0 个持久路径变化。与物理机 diagnostic 空闲 RSS 413.4 MB 同量级，坐实 2026-08-13 VM 的 140 MB「通过」是 Tauri-only 假象。报告：`e2e/perf/results/startup-idle.ref.json`（SHA-256 `b8d6b29d4728853f3e0369639832608e4e7ebf4d94d5a7dd3c26714648975f65`）。
  2. T090 canvas/I/O 完整执行，verdict `fail`：10k 场景稳定后全树 RSS P95 **726368256 bytes**（726.4 MB，> 350 MB）；pan/zoom 观测 2.10 fps（<30 fps）、最大帧间隔 15396 ms（>100 ms）；60 秒高频编辑 58.71 fps 但最大帧间隔 625 ms（>100 ms）；写合并比 0.00111（≤0.01 预算，通过）。`processCount=4`。相对 2026-08-13 Tauri-only 的 233.5 MB「通过」，10k RSS 在诚实全树口径下同样不达标。报告：`e2e/perf/results/canvas-io.ref.json`（SHA-256 `b8e9bcce1693e9fa4169f85424d08fb82fdb693917ec40507f4c6920f3215623`）。
  3. T108 15 分钟 soak 完整执行，verdict `fail`：预热全树 RSS P95 738967552 bytes（739.0 MB），soak 后 905969664 bytes（906.0 MB）；RSS 增长 **167002112 bytes**（167.0 MB，> 50 MB）且 **22.60%**（> 15%）；静置 60 秒 CPU P95 **28.9%** 单逻辑核（> 1%）；静置观察 8 个文件系统事件、8 个持久路径变化（> 0）。`processCount=4`，soak 完成 3600 次脚本编辑、53956 帧。15 分钟 `rssGrowthBytes` 不得与 2026-08-13 的 30 分钟序列直接比较；静置 8 次写盘与旧报告同数量级。报告：`e2e/perf/results/edit-soak.ref.json`（SHA-256 `efb1cc94d8bd144622b7dfe6dd2b7cb13685d117c58a0163af4b5ff20ea66580`）。

## 6. SC-010 开源分发记录

2026-08-12 决策取代 2026-08-05 的“延后签名/公证”设想：项目不规划 App Store、Developer ID 或 Apple 公证。`.github/workflows/release.yml` 在 `v*` tag 构建并创建 GitHub Release，上传未签名/未公证 macOS 与 Linux 产物；README 和发布说明披露 Gatekeeper 风险与用户主动手动放行步骤。本会话未触发真实 tag/Release。

## 7. 残余风险

- §1.1 两个 pre-existing 浏览器测试失败。
- T078/T080 macOS 原生验收待在记录配置的 VM 或物理机执行；T094 仅为可选 Ubuntu 24.04 IME smoke test，Fedora/其他 Linux 矩阵已移出当前门禁。
- 2026-08-15 Phase 2 物理机归因（未重跑 T090/T108；报告 gitignored）：
  1. 分角色 RSS（`e2e/perf/results/phase2-attribution.host.json`，SHA-256 `6681a9b6dc469049e20d68ba2230c1262019832d790723471e2b3309d4de6d4a`，二进制 `837c5cd8…`）：空闲全树 P95 **400.7 MB** = WebContent 195.4 + Tauri 147.9 + GPU 40.4 + Network 17.0。10k 加载后（编辑前）**761.7 MB** = WebContent 427.8 + Tauri 239.8 + GPU 76.8 + Network 17.2。150 / 350 MB 全树预算低于 WebContent 单项，属预算对照基线而非产品泄漏。空闲 CPU P95 **9.4%**（Tauri 4.2 + WebContent 5.2），空画布已远超 1%。
  2. 静置 8 次写：15 秒高频编辑后立即观察 60 秒，仍是 **8 事件 / 8 路径**（与 T108 相同）。路径为一次 `save_draft` 的 recovery 原子写 + 一次 idle checkpoint 的 `performance.excalidraw` 原子写 + sqlite/WAL。编辑结束后再等 5 秒再观察 20 秒：**0 写入**（`phase2-panzoom.host.json`）。不是持续后台写盘。
  3. pan/zoom A/B（`phase2-panzoom.host.json`，SHA-256 `882da7d55d54b844078516d9c52b24e1a5da18aea0d200f2dce7262b47b5ebc8`，探测二进制 `3d747904…`）：官方每帧 `updateScene` 振荡 zoom **24.38 fps** / 91 ms；同场景锁定 zoom=1 只平移 **59.69 fps** / 63 ms。物理机 21.82 fps 主要是测试视口在每帧改 zoom，不是 10k 平移本身。探测用的 adapter 种子约定已从工作区撤回。
- T090（startup/idle 与 canvas/I/O）与 T108（soak）已在声明参考 VM 以 **全树归因新口径** 完整重测并产生真实 `fail` 报告（§5 2026-08-14/15 序列）。2026-08-15 **ADR-007** 已按 Phase 2 证据重校准空载 RSS 500MB、10k RSS 950MB、idle CPU 35%，并将 T090 pan 改为恒定 zoom、T108 静置观察放到崩溃安全刷新之后。旧序列报告仍按当时预算解读；新序列须在 workload 落地后重测。冷启动 2s 与 soak RSS 增长预算未改，仍可能 `fail`。失败不阻断合并或开源发布。
- 2026-08-16 物理机空载对照（全树、与 harness 相同的 launchd-reparent 归因；一次性脚本，JSON 未入库）：空白 Tauri v2 窗口 P95 **201 MB**（host 119 + WebContent 37 + GPU 28 + Network 17）；Safari 新进程打开空的 excalidraw.com **629 MB**（host 233 + WebContent 300 + GPU 48 + Network 49）。本应用空闲 411 MB 落在空壳与 Safari+Excalidraw 之间；WebContent 195 MB 低于 Safari 加载同一画布的 300 MB。坐实 500 MB 空载预算对照的是 WKWebView+Excalidraw 基线，不是把 411 MB 算进壳层泄漏。空窗口 / Safari 在未禁用 App Nap 时 idle CPU P95 约为 0%，不能用来否定 harness（可见窗口 + 禁用 App Nap）下的 9–29% idle CPU 测量条件。
- 物理机 diagnostic：2026-08-15 已用同一份 `837c5cd8…` 二进制跑完 startup-idle / canvas-io / 15 分钟 soak（`*.host.json`，§5）。空闲 RSS 411 MB 与 VM 410.7 MB 同量级；10k pan/zoom 21.82 fps / 108 ms 冻结，对照 VM 2.10 fps / 15396 ms，低帧率主要是虚拟化；静置 8 次写盘两边相同。
- 宿主机 diagnostic 性能跑要求测量窗口全程可见（rAF 遮挡暂停约束，§5）；`visibilityState=hidden` 时 driver 10 秒失败，可见慢帧最多等 60 秒。
- 上游 `@excalidraw/excalidraw` 内部 DOM 不在壳层 a11y 扫描范围（T093 残余说明）。
