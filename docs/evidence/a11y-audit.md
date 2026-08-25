# 跨故事无障碍回归审计（T063 / 历史 T093）

**日期**：2026-08-23（T063 扩展）；历史 T093 记录于 2026-08-10  
**依据**：002 FR-048 / SC-006、宪法原则 III、`DESIGN.md`；历史 001 FR-038 / SC-015  
**范围**：桌面壳层（canvas-first overlay/pinned 侧栏）、连续 Workspace 树、文档标签关闭/孤立对话框、外观选择、冲突/恢复/导出对话框，覆盖浅色与深色主题

## 方法

- 自动化扫描：axe-core（经 `@axe-core/playwright` 驱动），规则标签 `wcag2a`、`wcag2aa`、`wcag21aa`、`wcag22aa`。
- 运行方式：Playwright `browser-ui` 项目（Chromium）连接 Vite dev server；Tauri IPC 经浏览器 harness 模拟。002 表面使用 `e2e/tests/uiInteractionHarness.ts`。
- 键盘闭环、焦点顺序、对话框 Esc/Enter 与焦点陷阱、reduced motion、非颜色唯一状态、loading/error、permission-denied 由脚本断言补充。
- 验收标准：自动化扫描的严重（serious）与致命（critical）问题数在扫描面上均为 0；对比度按 WCAG 2.2 AA 抽检。
- 审计脚本：`e2e/tests/a11y-audit.spec.ts`。

本文件不把浏览器 harness 或合成 native 场景表述为真实 VoiceOver / Cmd+W / 触控板证据。那些条目属于 T070。

## 扫描面与结果

历史 T093（001 壳层）在 2026-08-10 记录为 15 个用例全部通过，serious/critical 均为 0。T063 在同一脚本上补齐 002 US1–US4 表面，并修正 US4 默认隐藏侧栏后「New drawing / Mount folder」不再位于首屏 DOM 的定位。

| 表面 | 浅色 serious/critical | 深色 serious/critical |
|------|----------------------|----------------------|
| 壳层空状态（标签栏/画布空状态；侧栏默认隐藏） | 0 / 0 | 0 / 0 |
| 壳层含已打开文档 + overlay 侧栏 | 0 / 0 | 0 / 0 |
| 工作区连续树 + 多标签 | 0 / 0 | — |
| 文件树/工作区右键菜单 | 0 / 0 | — |
| 条目命名对话框（含 inline name conflict） | 0 / 0 | — |
| 孤立文档关闭对话框 | 0 / 0 | — |
| 冲突对话框 | 0 / 0 | — |
| 恢复对话框 | — | 0 / 0 |
| 导出对话框 / 成功 / 失败 | 0 / 0 | 0 / 0 |
| 文件夹 loading 与 `PATH_ACCESS_DENIED` | 0 / 0 | — |

## 键盘与焦点结论

- **Workspace sidebar**：显式按钮打开 overlay（非屏幕边缘悬停）；为首个 Tab 停靠点之一，`:focus-visible` 焦点环 2px。Escape 在无对话框/菜单 `preventDefault` 时关闭 overlay。
- 标签栏：方向键 `ArrowRight` / `ArrowLeft` / `Home` / `End` 可循环移动并切换活动标签，选中标签为唯一 Tab 停靠点（roving tabindex），`aria-selected` 同步。关闭控件有独立 accessible name（`Close {title}`）。
- 外观选择：单选组符合原生 radio 行为；方向键切换选择并即时应用主题；`:focus-visible` 焦点环 2px 可见（浅色 `#1c7ed6`、深色 `#74c0fc`）。
- 对话框：打开时焦点移入首个可交互控件；Tab/Shift+Tab 循环被约束在对话框内；Esc 关闭（冲突=放弃本次决策、恢复=取消、导出=关闭、命名=Cancel、孤立关闭=Cancel）；Enter 作用于对话框背景层时触发默认决策（冲突=采用外部版本、恢复=恢复首个候选）。
- reduced motion：`prefers-reduced-motion` 媒体查询存在；reduce 时全局 `transition`/`animation` 被压至 0.01ms；overlay 开/关不依赖动画即可完成。
- 非颜色唯一状态：脏/孤立标签除颜色外同时提供 `aria-label` 与 `.visually-hidden` 文本（"Unsaved changes" / "File unavailable"）。
- Loading / error / permission-denied：Workspace 面板在列举进行中以 `role="status"` 宣告 “Loading folder…” 并设置 `aria-busy`；失败以 `role="alert"` 宣告。`PATH_ACCESS_DENIED` 在树列举与命名对话框中均不以颜色作为唯一通道。

## 对比度抽检（WCAG 2.2 AA，axe 计算）

历史 T093 token 抽检（axe 4.12.1）仍然适用，002 未改语义 token：

| Token 对 | 浅色 | 深色 |
|----------|------|------|
| `text-primary` 于面板背景 | 17.1:1 | 14.0:1 |
| `text-secondary` 于面板/表面背景 | 6.7:1 / 6.0:1 | 10.4:1 |
| `accent-contrast` 于 `accent`（选中态/主按钮） | 4.7:1 | 10.2:1 |
| `warning` 于面板/表面背景（错误文本、脏标记） | 5.5:1 / 4.9:1 | 11.0:1 / 8.5:1 |
| `success` 于面板/表面背景（导出成功文本） | 5.4:1 / 4.9:1 | 9.0:1 / 6.9:1 |

## 应用的修复

历史 T093：

- `src/app/theme/tokens.css`：浅色 `--warning` / `--success` 对比度修正。

T063：

- `src/workspaces/WorkspacePanel.tsx`：可见的文件夹 loading 状态（`role="status"` + `aria-busy`），以满足 data-model `loadStateByParent` 的可见 loading/error 合同。列举失败按 `PATH_ACCESS_DENIED` 的 `code` 映射为 “This location is outside the Workspace.”，不回显 IPC `message`。
- `src/app/interaction/EntryNamingDialog.tsx`：`PATH_ACCESS_DENIED` 映射为稳定的 “This location is outside the Workspace.”
- `src/app/TabBar.tsx`：关闭按钮与 `role="tab"` 同簇，但不作为 `tablist` 的 DOM 子节点；`tablist` 保留真实盒并用 `aria-owns` 关联各 tab（避免 `display: contents`）。溢出滚动以 tab+close 簇为范围。
- `src/App.css`：为壳层侧栏开关、标签关闭按钮与上下文菜单项补齐 `:focus-visible`；关闭热区 24px。
- `e2e/tests/a11y-audit.spec.ts`：打开 overlay 后再找 New drawing / Mount folder；补齐 002 对话框、侧栏、loading 与 permission-denied 覆盖；permission-denied 夹具使用后端文案，断言前端映射结果。

## 残余说明

- 上游 `@excalidraw/excalidraw` 编辑器内部 DOM 不在本审计的壳层扫描范围内。
- 原生窗口装饰、VoiceOver、IME 候选框、Gatekeeper 手动放行及打包态的可访问性需在记录配置的 macOS 上验证（T070）；Ubuntu 24.04 仅为可选补充证据，见 `docs/evidence/native-verification.md`。
- 本审计是浏览器可见合同。合成 e2e-harness 不能当作真实 Cmd+W / 中键 / 触控板证据。

## 验证与回归

- 历史 T093：`pnpm e2e a11y-audit` 15/15 通过（2026-08-10）。
- T063：`pnpm e2e tests/a11y-audit.spec.ts --workers=1`：**21/21 通过**（2026-08-23，Playwright `browser-ui`，Vite `127.0.0.1:1420`）。

### T063 执行（2026-08-23）

`pnpm e2e tests/a11y-audit.spec.ts --workers=1` → **21 passed**. 扫描面 serious/critical 均为 0。未覆盖真实 VoiceOver / Cmd+W / 触控板（T070）。
