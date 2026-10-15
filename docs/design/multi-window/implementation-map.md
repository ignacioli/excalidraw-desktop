# 多窗口界面 component anatomy 与实现映射

状态：低保真 2026-10-13 负责人批准（[low-fi/manifest.json](low-fi/manifest.json)）；高保真 2026-10-13 负责人批准（[high-fi/manifest.json](high-fi/manifest.json)，13 张画板）。共享组件 `DSC-DIALOG-001` 侧栏变体与 `MW-COPY-FEEDBACK` 已实现（2026-10-14）；页面消费者尚未接入。本文件是多窗口相关 app-owned 界面的唯一 anatomy 入口；共享部分在 [组件目录](../components.md) 中登记并链接到这里。

## 权威与实施入口

- 共享来源：[组件目录](../components.md) `DSC-BASE-001`、`DSC-BUTTON-001`、`DSC-MENU-001`（复用）、`DSC-DIALOG-001`（扩展）、`DSC-FEEDBACK-001`（原则复用）；[DESIGN：Desktop information architecture](../../../DESIGN.md#desktop-information-architecture)。
- 批准设计：Penpot 文件 `excalidraw-desktop-uxui-redesign`，页面「07 · Multi-window · 006 hi-fi (approved 2026-10-13)」，版本快照「006 multi-window hi-fi approved by owner 2026-10-13」；导出截图在 [high-fi/screens/](high-fi/screens/)。
- 数值来源：对话框、按钮与菜单度量沿用现有 [App.css](../../../src/App.css) 中的 `ApplicationDialog`、按钮与 `ContextMenu` 实现；新数值只来自批准画板，不从代码反推。
- 字体代理：画板上的手写体用 Kalam（英文）与 LXGW WenKai TC（中文）代替；产品使用应用自带的手写字体（与画布手写字体一致）。中文 UI 文本以 Noto Sans SC 代替系统 CJK 字体。

## 组件清单

| 组件 | 分类与范围 | 代码入口（计划） | 画板 |
| --- | --- | --- | --- |
| `DSC-DIALOG-001` 侧栏对话框 anatomy | 扩展：为命名、确认、嵌套冲突三类对话框定义统一 anatomy | [ApplicationDialog.tsx](../../../src/app/interaction/ApplicationDialog.tsx)（外壳）；[EntryNamingDialog.tsx](../../../src/app/interaction/EntryNamingDialog.tsx)、[EntryDeleteDialogs.tsx](../../../src/app/interaction/EntryDeleteDialogs.tsx)、[WorkspacePanel.tsx](../../../src/workspaces/WorkspacePanel.tsx)（移除工作区）、新增嵌套冲突对话框 | 01–03、12、13 |
| `DSC-MENU-001` 复制路径菜单项 | 复用：新增菜单项，度量与分组不变 | [ContextMenu.tsx](../../../src/app/interaction/ContextMenu.tsx)；菜单模型在 [WorkspacePanel.tsx](../../../src/workspaces/WorkspacePanel.tsx) 与 [TabBar.tsx](../../../src/app/TabBar.tsx) | 04–06 |
| `MW-COPY-FEEDBACK` 反馈 toast | 新增 feature-owned：复制路径反馈与子目录定位提示共用 | [FeedbackToast.tsx](../../../src/app/FeedbackToast.tsx)、[feedbackToastState.ts](../../../src/app/feedbackToastState.ts) | 04–06 |
| `MW-EMPTY-STATE` 画布空状态 | 新增 feature-owned：替换 [AppShell.tsx](../../../src/app/AppShell.tsx) 中的 `.canvas-empty-state` | 新组件，位于 `src/app/` 壳层 | 07–11 |
| 窗口标题 | 文字决定，无视觉组件 | 原生窗口标题，由后端按窗口设置 | — |

未受影响：History、Recovery、Conflict、Export、Orphaned Document 等现有对话框。它们继续使用 `ApplicationDialog` 的默认外壳，宽度、文案和动作层级仍由各自 feature 定义；本次扩展以可选变体加入，默认渲染不变。

## `DSC-DIALOG-001` 扩展：侧栏对话框 anatomy

适用于：新建绘图、新建文件夹、重命名绘图、重命名文件夹、删除确认、文件夹非空、移除工作区、嵌套工作区冲突。

### 部件顺序

| # | 部件 | 命名对话框 | 确认对话框 | 嵌套冲突 |
| --- | --- | --- | --- | --- |
| 1 | 标题 | 动作名（New drawing / New folder / Rename drawing / Rename folder） | 动作 + 对象（`Delete {name}?`、`Remove {name}?`、`Folder isn't empty`） | `“{target}” contains an open Workspace` |
| 2 | 说明 | 无 | 后果说明（沿用现有文案键 `entry.delete.body`、`entry.notEmpty.body`、`workspace.remove.description`） | `“{workspace}” is already open in another window. A Workspace can't be opened inside another one.` |
| 3 | 对象路径块 | 无 | 有（home 缩写 `~`） | 有：`{target} ⊃ {open workspace}` |
| 4 | 字段 | 标签 `Name` 在上；输入框占满宽度；绘图的固定后缀 `.excalidraw` 在同一字段框内的右侧，以分隔线和 surface 底色区分；打开时默认全选可编辑名称（不含后缀） | — | — |
| 5 | 错误 | 字段下方，`role="alert"`；保留输入与焦点 | 动作行上方，`role="alert"` | 同确认对话框 |
| 6 | 动作行 | 右对齐：取消（次要）→ 主操作 | 同；破坏性主操作用 danger 样式 | 左侧链接动作「Close it and open here」；右侧取消 → 主操作「Switch to that window」 |

中文文案见画板 03；工作区统一译作「工作区」，在访达中打开为「在访达中打开」。

### 几何与样式

| 属性 | 值 |
| --- | --- |
| 外壳 | 宽 480；内边距 24；圆角 16；panel 底色、strong 边框；阴影 `0 24px 64px rgba(0,0,0,.28)`；遮罩 `rgba(0,0,0,.48)`（沿用现有 `ApplicationDialog`） |
| 标题 | 20px / 600，行高 1.3，主文字色 |
| 说明 | 标题下 8；14px，行高 1.5，次要文字色 |
| 对象路径块 | 上方 16；高 36，圆角 8，surface 底色；等宽 12px 次要文字色，左右内边距 12；超长时中间省略并以原生 tooltip 显示全文 |
| 字段标签 | 上方 20；12px / 500，次要文字色；标签到输入框 8 |
| 输入框 | 高 36，圆角 8；聚焦时 2px focus 色描边，错误时 2px danger 描边；值 14px，左内边距 12；默认选中区用 active 色 |
| 固定后缀 | 输入框内右侧；1px strong 分隔线；surface 底色；14px 次要文字色，左右内边距 12 |
| 错误文本 | 字段下 8；12px，行高 1.4，danger 色 |
| 动作行 | 上方 24；按钮高 32，圆角 8，左右内边距 12，间距 8；14px（次要 500，主/危险 600） |
| 按钮样式 | 次要：surface 底 + strong 边框 + 主文字色；主：accent 底 + accent 对比文字色；危险：danger 底，文字 Light `#FFFFFF` / Dark `#121212`；链接：无底无框，accent 文字色，与内容左边对齐 |
| 焦点 | 2px focus 环（共享 focus ring） |

「Open in Finder / 在访达中打开」与「移除工作区」不是破坏性操作，使用主样式；「删除」使用危险样式（负责人 2026-10-13 批准）。

### 状态与行为

- 初始焦点：命名对话框在输入框；确认对话框在「取消」；嵌套冲突在「Switch to that window」。
- Enter 提交（确认对话框中触发当前焦点按钮），Escape 取消；提交中禁用输入与全部按钮，防止重复提交。
- 错误不清空输入，焦点留在输入框。
- 关闭后焦点返回触发控件（菜单项所属行或 Tab）。
- 嵌套冲突的「Close it and open here」进行中：对话框显示进行状态并禁用动作，结果返回后关闭或在动作行上方显示失败说明。
- 窄宽度（画板未覆盖，实现默认）：外壳宽度取 `min(480px, 100vw - 32px)`；动作行在放不下时折行，主操作保持在最右。

## `DSC-MENU-001` 复用：复制路径菜单项

度量、分隔线和危险项规则不变（SDK 下拉菜单度量）。新增两项及顺序：

| 菜单 | 顺序 |
| --- | --- |
| 侧栏绘图行 | Rename · ─ · Copy Path · Copy Relative Path · ─ · Delete |
| 侧栏文件夹行 | New Drawing · New Folder · ─ · Copy Path · Copy Relative Path · ─ · Rename · ─ · Delete |
| 侧栏工作区根行 | New Drawing · New Folder · ─ · Copy Path · ─ · Remove Workspace（说明行 `Files on disk will not be deleted`） |
| Tab（工作区内绘图） | Close · Close Others · Close Tabs to the Right · Close All · ─ · Copy Path · Copy Relative Path |
| Tab（工作区外绘图） | 四个关闭项 · ─ · Copy Path |

文案：Copy Path / Copy Relative Path；复制路径 / 复制相对路径。首版不分配快捷键。

## `MW-COPY-FEEDBACK` 反馈 toast

| 属性 | 值 |
| --- | --- |
| 位置 | 窗口内容区底部居中（画板未给出距底距离，实现取 24）；同一时刻至多一个，新的替换旧的 |
| 外形 | 高 40，圆角 8，左右内边距 16；阴影 `0 8px 24px rgba(0,0,0,.18)` |
| 内容顺序 | 状态符号（✓ / !）→ 消息（14px / 500）→ 可选路径（等宽 12px，中间省略） |
| 成功 | Light：深色反转底 `#1B1B1F`、浅色文字、符号 `#69DB7C`；Dark：surface 底、主文字色、success 色符号；`role="status"`、`aria-live="polite"`；约 2 秒自动消失 |
| 失败 | panel 底 + 1px danger 描边、主文字色、danger 色符号；`role="alert"`；6 秒或手动关闭；不写剪贴板 |
| 子目录定位提示 | 成功样式，无路径；文案 `“{folder}” is inside {workspace}, already open in this window`；约 3 秒自动消失 |
| 动效 | 画板未定义；实现只用短淡入淡出，reduced motion 时直接出现与消失 |

文案：Path copied / Relative path copied / Couldn't copy path: the item no longer exists；已复制路径 / 已复制相对路径 / 无法复制路径：该条目已不存在。

## `MW-EMPTY-STATE` 画布空状态

出现条件：窗口承载工作区且没有打开的绘图 Tab。Welcome 窗口不显示。不挂载 Excalidraw 实例，不响应绘制。

| # | 部件 | 规则 |
| --- | --- | --- |
| 1 | 背景 | 画布同色（Light `#FFFFFF`，Dark `#1B1B1F`）；20px 细线网格，Light `#EEF0F2`、Dark `#2C2B33`，无粗线；装饰（`aria-hidden`） |
| 2 | 主提示 | 手写字体 30px，次要文字色，单行居中：Pick a drawing from the sidebar / 从左侧选择一个绘图 |
| 3 | 副提示 | 主提示下 6；手写字体 18px，次要文字色 85% 不透明度：or start a new one / 或者新建一个，开始画吧 |
| 4 | 动作 | 副提示下 22；两个按钮间距 10，高 32，圆角 8，画布底 + strong 边框；标签 14px / 500 + 8 + 快捷键提示 12px 次要文字色：New Drawing `⌘N`、Show Sidebar `⌘\`（新建绘图、显示侧边栏） |
| 5 | 箭头 | 手绘曲线箭头从内容区左上指向工具栏 Sidebar 按钮，2px 次要文字色；旁注手写 18px：Your drawings live here / 绘图都在这里；装饰（`aria-hidden`） |

- 整组主提示 + 副提示 + 动作在画布区域内水平居中、垂直方向略高于中线（上移 20）。
- 快捷键提示暂不显示：应用尚无 `⌘N`（新建绘图）与 `⌘\`（显示侧栏）快捷键，提示与行为不一致（负责人 2026-10-14 决定）；快捷键实现后再按上表加入。
- **侧栏固定**时：隐藏箭头与旁注，只保留「New Drawing」一个动作（负责人 2026-10-13 批准）。侧栏为 Overlay 时与 Hidden 相同。
- 可访问性：区域有 `aria-label`（Empty canvas area / 空白画布区域）；提示为普通文本；动作为按钮，按 DOM 顺序可达。
- 主题与语言切换即时更新。窄宽度下提示可折行，动作行可折行，不出现横向滚动。
- 动作复用现有新建绘图流程与侧栏控制器。

## 窗口标题

| 窗口状态 | 标题 |
| --- | --- |
| Welcome，无 Tab | `Excalidraw` |
| Welcome，有工作区外绘图 | `{drawing} — Excalidraw` |
| 工作区，无活动绘图 | `{workspace}` |
| 工作区，活动绘图 | `{drawing} — {workspace}` |
| 两个打开的工作区同名 | `{workspace} ({parent folder})` |

标题栏外观不变（系统绘制）。

## 不变量与验证

| 不变量 | 检查方式 |
| --- | --- |
| 8 类对话框的部件顺序、role、初始焦点、Enter/Escape、提交中禁用、错误保留输入、焦点返回 | 组件单测（按可访问名称与 role 断言） |
| 破坏性动作只出现在「删除」；「移除工作区」「在访达中打开」为主样式 | 组件单测（按动作 kind 断言） |
| 菜单项出现矩阵与顺序（6 种菜单 × 中英文） | 菜单模型单测 |
| toast 同时至多一个、成功/失败 role 与时长 | 组件单测（假时钟） |
| 空状态不挂载编辑器；侧栏固定时只有一个动作且无箭头；可访问名称 | 组件单测 + Playwright 语义定位 |
| 四种主题 × 语言组合无溢出（`scrollWidth ≤ clientWidth`） | Playwright |
| 对话框、空状态与 toast 对照批准画板 | 负责人在最终集中体验中查看一次 |

## 最小执行记录

```text
分类与依据：DSC-DIALOG-001 为规范补齐 + 局部修订（侧栏对话框 anatomy 从未定义）；MW-EMPTY-STATE 为已有设计修订（替换 .canvas-empty-state）；MW-COPY-FEEDBACK 为新增 feature-owned；DSC-MENU-001 复用。批准来源 high-fi/manifest.json（2026-10-13）。流程：低保真 → 高保真 → 负责人 Review → 本 map → 实现。
影响范围：DSC-DIALOG-001 扩展（消费者 EntryNamingDialog、EntryDeleteDialogs、WorkspacePanel 移除工作区、新增嵌套冲突对话框；其他对话框默认渲染不变）；DSC-MENU-001 新增两项（WorkspacePanel、TabBar）；新增 MW-COPY-FEEDBACK、MW-EMPTY-STATE；同步 components.md 索引与 DESIGN.md / DESIGN.zh.md。
设计决定：沿用 ApplicationDialog 外壳度量与 SDK 菜单度量；新增并已批准：对话框宽 480、危险按钮实心填充（Dark 文字 #121212）、toast 样式、空状态网格颜色、侧栏固定时空状态只保留新建绘图、工作区外 Tab 菜单只有复制路径。
实施与验证：见上表不变量；页面组合抽检对话框叠在空状态上（Light）与嵌套冲突（Dark）。
结果：设计批准完成。2026-10-14 组件层：DSC-DIALOG-001 侧栏变体（ApplicationDialog variant="sidebar"、ApplicationDialogField、ApplicationDialogActions、ApplicationDialogButton）与默认渲染不变由 ApplicationDialog.test.tsx 覆盖，PASS；MW-COPY-FEEDBACK（FeedbackToast、feedbackToastState）成功/失败/定位提示/替换由 FeedbackToast.test.tsx（假时钟）覆盖，PASS。尚无页面消费者。2026-10-14 首批消费者：嵌套冲突对话框（NestedWorkspaceDialog，侧栏变体：默认、进行中、未关闭与其他失败，初始焦点与按钮顺序）由 NestedWorkspaceDialog.test.tsx 与浏览器 multi-window-nesting.spec.ts 覆盖，原生经 Accessibility 读到三个按钮名称，PASS；子目录定位提示（MW-COPY-FEEDBACK 定位样式，无路径，3 秒）由 multi-window-nesting.spec.ts 覆盖，PASS。四种主题 × 语言溢出检查与负责人对照画板留待最终集中体验。2026-10-14 侧栏消费者：命名（新建绘图、新建文件夹、重命名绘图、重命名文件夹；默认、错误、提交中）与确认（删除、文件夹非空、移除工作区）改用侧栏变体，由 EntryNamingDialog.test.tsx、EntryDeleteDialogs.test.tsx、WorkspacePanel.test.tsx 与浏览器 ui-entry-dialogs.spec.ts（1280×760，四种主题 × 语言，无溢出、动作顺序、初始焦点、焦点返回）覆盖，PASS；固定后缀改为隐藏文本描述，菜单打开的对话框焦点返回所属行。负责人对照画板留待最终集中体验。2026-10-14 复制路径：DSC-MENU-001 侧栏绘图、文件夹、工作区根行与 Tab（工作区内/外）按上表顺序与分隔加入复制项（ContextMenu 新增可选 separatorBefore，其他菜单渲染不变）；MW-COPY-FEEDBACK 成功（含路径）与失败提示由 clipboard.test.ts、TabBar.test.tsx、WorkspacePanel.test.tsx 与浏览器 multi-window-copy-path.spec.ts 覆盖，PASS。
```
