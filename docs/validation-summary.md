# 验证证据汇总（Phase 10 / T095）

**日期**：2026-08-10
**范围**：Phase 10 全量回归执行结果与三类验证证据（Playwright 浏览器 UI、`APP_E2E=1` Tauri 进程级可靠性、macOS/Linux 真机矩阵）的汇总；SC-012/SC-014/SC-015/SC-010 门禁状态终审。

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

## 5. 固定机性能门禁（T089/T090/T108/T091）

- 基础设施：T089 测量夹具与报告契约、T091 `performance.yml` 硬门禁工作流均已落地（仅 `self-hosted`/`macOS`/`ARM64`/`excalidraw-perf` runner 阻断合并并归档报告）。
- T090/T108 硬验收未执行：需要配置的 Apple M1 / 8GB runner；本会话无该 runner，也未构建本地测试二进制。该外部验收状态阻止 US1 合并/发布，但不构成其余独立开发线的调度依赖（plan.md）。
- 本会话未运行 `PERF_TEST=1` 套件；非固定机的诊断结果不得替代硬验收或勾选任务。

## 6. SC-010 范围记录

正式 macOS 签名、公证与零安全拦截分发为后续版本范围（spec Clarification 2026-08-05）；当前版本以本地未签名构建验证 macOS 启动、文件关联、单实例与原生行为（T078/T080，矩阵见 [native-verification.md](./native-verification.md)）。

## 7. 残余风险

- §1.1 两个 pre-existing 浏览器测试失败。
- T078/T080/T094 真机矩阵（含 Linux IME 八组合）待对应平台执行。
- T090/T108 固定机性能硬验收待 runner。
- 上游 `@excalidraw/excalidraw` 内部 DOM 不在壳层 a11y 扫描范围（T093 残余说明）。
