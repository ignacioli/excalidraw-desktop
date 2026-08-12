# 跨故事无障碍回归审计（T093）

**日期**：2026-08-10
**依据**：FR-038 / SC-015、宪法原则 III、`DESIGN.md`；`quickstart.md` US1 第 6 项及 US2–US7 无障碍验收线
**范围**：桌面壳层、文档标签、外观选择、文件树/工作区面板、冲突/恢复/导出对话框，覆盖浅色与深色主题

## 方法

- 自动化扫描：axe-core 4.12.1（经 `@axe-core/playwright` 4.12.1 驱动），规则标签 `wcag2a`、`wcag2aa`、`wcag21aa`、`wcag22aa`。
- 运行方式：Playwright `browser-ui` 项目（Chromium）连接 Vite dev server（`127.0.0.1:1420`）；Tauri IPC 经浏览器 harness（`localStorage` 存根的 `__TAURI_INTERNALS__` invoke stub）模拟。
- 键盘闭环、焦点顺序、对话框 Esc/Enter 与焦点陷阱、reduced motion、非颜色唯一状态由脚本断言补充。
- 验收标准：自动化扫描的严重（serious）与致命（critical）问题数在扫描面上均为 0；对比度按 WCAG 2.2 AA 抽检。
- 审计脚本：`e2e/tests/a11y-audit.spec.ts`（15 个用例，全部通过）。

## 扫描面与结果

| 表面 | 浅色 serious/critical | 深色 serious/critical |
|------|----------------------|----------------------|
| 壳层空状态（标签栏/命令区/侧栏空状态/画布空状态） | 0 / 0 | 0 / 0 |
| 壳层含已打开文档（含 Excalidraw 编辑器之外的壳层） | 0 / 0 | 0 / 0 |
| 工作区文件树 + 多标签 | 0 / 0 | 0 / 0 |
| 文件树右键菜单 | 0 / 0 | 0 / 0 |
| 冲突对话框 | 0 / 0 | 0 / 0 |
| 恢复对话框 | 0 / 0 | 0 / 0 |
| 导出对话框 | 0 / 0 | 0 / 0 |
| 导出成功提示（`role="status"`） | 0 / 0 | 0 / 0 |
| 导出失败提示（`role="alert"` + `aria-describedby` 关联） | 0 / 0 | 0 / 0 |

修复前基线：导出对话框的成功提示（浅色 `#2b8a3e` 于白底，4.36:1）与失败提示（浅色 `#e67700` 于白底，2.99:1）各命中 1 个 serious `color-contrast`；修复后均归零。

## 键盘与焦点结论

- 标签栏：方向键 `ArrowRight` / `ArrowLeft` / `Home` / `End` 可循环移动并切换活动标签，选中标签为唯一 Tab 停靠点（roving tabindex），`aria-selected` 同步。
- 外观选择：单选组符合原生 radio 行为，选中项为唯一 Tab 停靠点；方向键切换选择并即时应用主题；`:focus-visible` 焦点环 2px 可见（浅色 `#1c7ed6`、深色 `#74c0fc`），测试断言计算样式 `outline-style/width/color`。
- 对话框：打开时焦点移入首个可交互控件；Tab/Shift+Tab 循环被约束在对话框内；Esc 关闭（冲突=放弃本次决策、恢复=取消、导出=关闭）；Enter 作用于对话框背景层时触发默认决策（冲突=采用外部版本、恢复=恢复首个候选）。
- reduced motion：`prefers-reduced-motion` 媒体查询存在；reduce 时全局 `transition`/`animation` 被压至 0.01ms（测试断言 `transition-duration` 计算值 ≤ 0.001s，且关闭 reduce 后恢复原值）。
- 非颜色唯一状态：脏/孤立标签除颜色外同时提供 `aria-label` 与 `.visually-hidden` 文本（"Unsaved changes" / "File unavailable"），测试断言可访问名称。

## 对比度抽检（WCAG 2.2 AA，axe 4.12.1 计算）

| Token 对 | 浅色 | 深色 |
|----------|------|------|
| `text-primary` 于面板背景 | 17.1:1 | 14.0:1 |
| `text-secondary` 于面板/表面背景 | 6.7:1 / 6.0:1 | 10.4:1 |
| `accent-contrast` 于 `accent`（选中态/主按钮） | 4.7:1 | 10.2:1 |
| `warning` 于面板/表面背景（错误文本、脏标记） | 5.5:1 / 4.9:1 | 11.0:1 / 8.5:1 |
| `success` 于面板/表面背景（导出成功文本） | 5.4:1 / 4.9:1 | 9.0:1 / 6.9:1 |

## 应用的修复

- `src/app/theme/tokens.css:19`：浅色 `--warning` 由 `#e67700` 调整为 `#9a5a00`（白底 2.99:1 → 5.47:1，表面 4.92:1）。
- `src/app/theme/tokens.css:20`：浅色 `--success` 由 `#2b8a3e` 调整为 `#1e7a34`（白底 4.36:1 → 5.40:1，表面 4.85:1）。
- 深色主题 token 值不变；该修复为语义 token 层修改，全部消费方（对话框错误/成功文本、标签脏/孤立标记）统一达标，无组件级硬编码。
- `e2e/tests/a11y-audit.spec.ts`：新增跨故事回归审计（新增 devDependency `@axe-core/playwright`）。

## 残余说明

- 上游 `@excalidraw/excalidraw` 编辑器内部 DOM 不在本审计的壳层扫描范围内：其主题与 DOM 由锁定版本的上游包控制，不属于本仓库所有权文件；上游对比度问题应随上游包处理。
- 原生窗口装饰、IME 候选框、Gatekeeper 手动放行及打包态的可访问性需在记录配置的 macOS VM 或物理机验证（T078/T080）；Ubuntu 24.04 的 T094 仅为可选补充证据，见 `docs/native-verification.md`。
- 错误/成功状态目前覆盖可经 harness 稳定触发的导出路径；冲突/恢复对话框的错误文本使用同一修复后的 token，其渲染路径依赖真实恢复/冲突故障注入（US2/US4 的 `APP_E2E=1` 进程级测试）。
- 参考 VM 性能测量（T090/T108）仍待完整执行；其 `pass`/`fail` 不影响本审计结论，也不阻断合并或开源发布。

## 验证与回归

- 本次执行 `pnpm e2e a11y-audit`：15/15 通过；`pnpm e2e us1-appearance`：4/4 通过；`us3-workspace-files`、`us5-export-failure`、`us5-export-fidelity` 回归通过。
- `pnpm lint`、`pnpm typecheck`、`pnpm test`（20 文件 / 93 用例）全部通过。
- 提交前基线截图（`us1-shell-light/dark`，T111/SC-014）与本次环境渲染存在既有漂移（两主题均约 3.5 万像素的字体级差异，与 token 修改无关）；已按当前渲染重新生成两个基线，浅色基线同时包含本审计的 `--warning` 颜色修正。基线更新范围已在本任务最终交接中显式披露。
- 审计期间新增 devDependency：`@axe-core/playwright`（仅用于自动化扫描）。
