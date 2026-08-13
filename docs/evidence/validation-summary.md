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
- 首个参考环境：Apple M5 Pro / 48GB 宿主上的 Parallels Desktop Pro 26.4.1、macOS 26.5.2（25F84）、4 vCPU / 8 GiB VM，客体 WebKit 21624.2.5.11.8；测量 commit `308178a7a2b209a87d0d571731717983c460ab56`，e2e-harness 可执行文件 SHA-256 `049c5babb9c420d2f4687cfb35ba3a6a8f057f58b2d3f4075dd1a4b2a6c168b2`。
- 2026-08-13 T090 startup/idle 正式运行完成并产生真实 `fail`：10 次冷启动均发布可编辑画布信号，nearest-rank P95 为 2895.874334 ms，超过 2000 ms 预算；空闲进程树 RSS P95 为 140623872 bytes，低于 150000000 bytes 预算；60 秒空闲观察为 0 个文件系统事件、0 个持久路径变化。由于启动预算失败，T090 仍不得勾选。
- 2026-08-13 T090 canvas/I/O 正式运行两次，均在 10k 场景 30 秒预热与 30 秒 RSS 窗口后，等待首个 30 秒 pan/zoom `result.json` 45 秒超时。最新正式报告保留 30 个场景 RSS 样本（223723520–223821824 bytes），但缺少 pan/zoom、60 秒高频编辑和写入观察结果，因此 verdict 为 `not_evaluated`，不得用 RSS 单项代替完整 verdict。额外 foreground 诊断在 command 开始后通过 UID 501 GUI launchd 域激活 app，仍以相同边界 `not_evaluated`，不能计作门禁证据。
- 诊断期间发现先前临时脚本向 GUI launchd 持久写入了 `TMPDIR`、XDG 路径、`EXCALIDRAW_E2E_ROOT` 与 `RUST_LOG`；这些变量已逐项定向清除并读回为空。清理后正式 canvas 失败仍复现，因此该污染不是唯一根因。当前较强假设是 macOS/WebKit rAF workload 或最终 Tauri result publication 链路失败；app 在两次当前运行中未留下新 crash report，正式 fixture 又丢弃 stdio，driver rejection 未进入报告。
- T108 依赖 T090 且复用同一 native command/result driver。由于该先决契约仍不可用，本轮未启动 30 分钟 soak，避免把确定不可评估的运行伪装成有效验收；T108 保持未勾选。完整运行仍必须产生真实 `pass` 或 `fail`，预算失败保留为已知风险但不阻断合并或开源发布。
- VM 内带日期证据：`/Users/Shared/excalidraw-perf/e2e/perf/results/2026-08-13-startup-idle-formal.json`（SHA-256 `6b06e3a98ef52f6ff2cbac92afb2b8610d2223978bda2748126ba878998cebea`）、`2026-08-13-canvas-io-formal.json`（`08c927b8d81f1f03787e457f8b196761008e77f43cd98d650b3e2c39f47dd384`）和 `2026-08-13-canvas-io-focus-diagnostic.json`（`4e5b89a0b1dd4846c1ee0acf5b6c283e533ac6bbf0c7ed34fff69d1b86a9ecf5`）。Parallels 官方说明 Apple-silicon macOS VM 由 Apple Virtualization Framework 管理，CLI/配置与第三方兼容性存在已知限制；本轮未把这些一般限制直接认定为应用故障根因（[KB 128867](https://kb.parallels.com/en/128867)）。

## 6. SC-010 开源分发记录

2026-08-12 决策取代 2026-08-05 的“延后签名/公证”设想：项目不规划 App Store、Developer ID 或 Apple 公证。`.github/workflows/release.yml` 在 `v*` tag 构建并创建 GitHub Release，上传未签名/未公证 macOS 与 Linux 产物；README 和发布说明披露 Gatekeeper 风险与用户主动手动放行步骤。本会话未触发真实 tag/Release。

## 7. 残余风险

- §1.1 两个 pre-existing 浏览器测试失败。
- T078/T080 macOS 原生验收待在记录配置的 VM 或物理机执行；T094 仅为可选 Ubuntu 24.04 IME smoke test，Fedora/其他 Linux 矩阵已移出当前门禁。
- T090 startup/idle 已完成并真实 `fail`，canvas/I/O 仍 `not_evaluated`；T108 因共享 native command/result 契约未恢复而未执行。两项均保持未完成。
- 上游 `@excalidraw/excalidraw` 内部 DOM 不在壳层 a11y 扫描范围（T093 残余说明）。
