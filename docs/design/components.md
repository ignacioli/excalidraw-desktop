# Excalidraw Desktop 组件目录

本文是共享组件与 anatomy 规范的入口目录。它记录当前可核实的设计权威、真实代码入口及各 feature 的复用关系；它本身不取代设计规范，也不表示同类视觉元素已经抽成共享 React 组件。

## 权威顺序

1. [DESIGN.md](../../DESIGN.md) 定义全应用共享设计系统、语义 token、交互和可访问性基线。
2. [HF-2 组件合同](desktop-shell/hf-2/components.md) 细化其中覆盖的 Icon Button、Tab、Workspace Row、Welcome Action 及布局状态；精确值见同目录的 `tokens.json`。
3. 各 feature 的批准设计、交互契约和实现映射定义 feature-specific anatomy。Local Version History 入口为 [implementation-map.md](local-version-history/implementation-map.md)、[interaction.md](local-version-history/interaction.md) 和 [high-fi/README.md](local-version-history/high-fi/README.md)。
4. 生产代码说明当前实现位置，不会在设计冲突时自动成为批准基线。

本目录用稳定 ID 供 plan、tasks 和 feature 映射引用。共享合同存在时应链接并复用；发现缺口时先在对应 feature 映射中说明需补充的 anatomy。只有多处确有相同需求时，才提升为共享规范或组件。不得从分类名称推断项目已有同名组件。

## 工作流选择与执行记录

Agent 应在修改前根据**目标设计是否改变、是否存在适用的批准来源**自行分类，并简述依据；不要求人类例行确认分类。先查看相关设计和 component spec，不能仅凭需求中的“修复”“优化”或组件文件名判断。混合任务按受影响组件分别分类。

| 场景               | 判断依据                                                   | 工作流                                                                                                                      |
| ------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 全新设计           | 缺少适用设计基础，需要建立新的视觉语言和核心组件           | 需求与关键流程 → 低保真确认 → 设计系统基础、核心组件及代表页面高保真 → owner Review → 定稿 component spec 与代码映射 → 实现 |
| 已有设计修订       | 将改变批准的布局、信息层级、视觉或交互，即使只涉及一个组件 | 核对既有规范与变更约束 → 高保真局部修订及 owner Review → 同步 component spec、受影响 token 和代码映射 → 实现                |
| 已有设计的规范补齐 | 目标设计已批准且不变，只缺文字 anatomy、节点说明或代码映射 | 从批准设计抽取 component spec → 核对来源与一致性 → 按需回填设计注释/绑定 → 实现；不因补文档重复视觉审批                     |
| 实现偏离修复       | 目标设计不变，代码未遵守适用的批准设计或 component spec    | 对照现有设计/spec定位偏差 → 修代码 → 定向验证；不修改设计以迁就错误实现                                                     |

Component spec 必须在依赖它的代码实现前定稿，但**不要求先于新高保真定稿**。设计前可以记录简短约束草案；草案不能冒充批准的视觉方案。新增 feature 不自动等于全新设计：若现有设计系统适用，应复用并按实际增量选择流程。

### 复用、扩展还是新增

- **复用**：既有 anatomy、状态和行为已覆盖需求，只改变数据或允许的配置。
- **扩展**：既有组件需要新的 slot、状态、variant 或行为；说明影响哪些消费者，局部更新其规范和设计。
- **新增**：既有组件无法合理表达需求，需要独立 anatomy/职责；先判断是否仅为 feature-owned 组件，多处确有共同需求时才提升为共享组件。
- 可以组合“复用 + 扩展”。抽出一个 React 文件不自动构成新增设计系统组件；共享 token 的复用也不证明结构无需扩展。局部反馈状态调整通常不需要新建全局 token 或重构整个组件库。

### 最小执行记录

在已有 plan/tasks、feature implementation map 或本轮执行说明中保留以下五行即可；不另建一套文件或复制权威规范。设计/spec 的修改发生在相应流程阶段，不提前把候选方案写成批准状态。

```text
分类与依据：目标设计是否改变；适用批准来源（路径/版本）；所选流程。
影响范围：组件ID；复用/扩展/新增；受影响消费者、状态及需要同步的文件。
设计决定：沿用哪些批准决定；新增决定及其Review状态；真实缺口或冲突。
实施与验证：组件关键不变量、代表状态、页面组合抽检及必要平台检查。
结果：实际通过/失败/BLOCKED、证据位置、剩余项；不得以计划代替执行结果。
```

Agent 负责分类、影响分析与证据整理；人类主要判断新增设计决定的局部 Review 和必要的最终体验抽检。已有授权和批准决定继续有效，不重复请求“是否实施”。只有权威来源冲突、无法确定目标是否改变且会影响方案，或出现未授权的实质新设计决定时，才提出一个针对性问题；继续不依赖该答案的工作。Review 中若改变已批准目标，回到设计修订流程。

所有流程均先验证受影响组件，再抽检受影响页面组合；复用仍适用的未变部分证据。保留必要的 native、可访问性、可靠性等检查，不用此表缩减必需覆盖。文档、自动检查和 owner 判断各自记录，不能互相替代；这些规则减少流程遗漏，不保证 Agent 的判断永远正确。

## 共享 anatomy 基线 `DSC-BASE-001`

以下规则有当前规范依据，适用于新建或扩展的 app-owned UI：

- 使用 [共享语义 token](../../DESIGN.md#semantic-tokens)，Light/Dark 改变语义值，不随意改变组件结构；不要在组件 CSS 中复制主题色常量。
- anatomy 至少要明确可见层级与阅读顺序、交互部件及其命名、状态表现、键盘/焦点行为，以及窄宽度或内容截断规则。具体数值与变体必须来自相应组件合同或批准 feature 设计，不能从现有代码推测。
- 交互元素要有可访问名称与可见焦点；选中、警告、冲突和层级不能只靠颜色表达。禁用、加载、错误、空状态和 reduced motion 按适用情况处理。
- 浮层、菜单、对话框与持久面板按共享堆叠规则区分；modal 打开后焦点进入并留在对话框，关闭后返回触发控件。
- 官方 Excalidraw SDK 拥有编辑器内部工具栏、Library 和 Presentation。app-owned 组件不得借助私有 SDK DOM 来仿制或修改这些界面。

这是跨 feature 的最小合同，不是一套新 token，也不要求一次性建成通用组件库。feature anatomy 应引用本条，并继续列出自身的顺序、几何、文案和状态规则；不要在这里复制 feature 细节。

## 组件索引

“复用方式”描述新增/修改 feature 时与现有实现的关系；“缺口/状态”说明当前规范或代码的边界，不代表该组件已通过视觉验收。

| 类别与稳定 ID                     | 规范来源                                                                                                                                                                                       | 真实代码入口                                                                                                                                                                                                            | 复用方式                                                                                      | History 消费者                                                      | 缺口 / 状态                                                                                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 基础与主题 `DSC-BASE-001`         | [DESIGN：Semantic tokens、Component and interaction rules](../../DESIGN.md#semantic-tokens)；[HF-2 tokens](desktop-shell/hf-2/tokens.json)                                                     | [theme/tokens.css](../../src/app/theme/tokens.css)、[App.css](../../src/App.css)                                                                                                                                        | 复用共享语义 token 与焦点/状态规则；不新增 feature 色板或字体                                 | History 全部 app-owned UI                                           | token 层已存在；各 feature 的结构仍需由 anatomy 明确。字体、基础 token 冲突先修共享规范。                                                                                                           |
| Button `DSC-BUTTON-001`           | [DESIGN：Semantic tokens 与 Component and interaction rules](../../DESIGN.md#component-and-interaction-rules)；[HF-2 Welcome Action](desktop-shell/hf-2/components.md#shell--welcome-action)   | [WelcomeScreen.tsx](../../src/app/WelcomeScreen.tsx)、[App.css](../../src/App.css)；History 按钮位于 [HistoryPanel.tsx](../../src/history/HistoryPanel.tsx) 与 [HistoryStates.tsx](../../src/history/HistoryStates.tsx) | 复用语义 button 状态和共享 token；没有证据表明有通用 `Button` React 组件                      | Mark、Preview、Restore、Retry、对话框动作                           | Welcome Action 规范只支配 Welcome 的主/次动作；History 的按钮角色与几何以其 feature 映射为准。通用按钮 React 抽象目前未确认。                                                                       |
| Icon Button `DSC-ICON-BUTTON-001` | [HF-2 Icon Button / Back](desktop-shell/hf-2/components.md#shell--icon-button--back)；[DESIGN：Component and interaction rules](../../DESIGN.md#component-and-interaction-rules)               | [App.css](../../src/App.css) 的 `.icon-button`；[WorkspacePanel.tsx](../../src/workspaces/WorkspacePanel.tsx)                                                                                                           | 复用既有 `.icon-button` 样式与 HF-2 几何/焦点合同；只有组件变体存在证据时再扩展               | History 关闭、Preview 退出按钮                                      | History 行内 `More` action 是 `.history-actions-trigger` 专用结构，并非所有图标动作都已统一到 `.icon-button`。                                                                                      |
| Tab `DSC-TAB-001`                 | [HF-2 Tab](desktop-shell/hf-2/components.md#shell--tab)；[DESIGN：Tabs](../../DESIGN.md#startup-and-browsing-states)                                                                           | [TabBar.tsx](../../src/app/TabBar.tsx)、[App.css](../../src/App.css)                                                                                                                                                    | 复用既有 Tab 及标签栏交互；History 需求若触及标签栏，应扩展 Tab 合同并做标签栏回归            | 无 History drawer 内的 Tab；同属应用外壳，文件名 tooltip 是旁路行为 | Tab 是已定义的共享 shell 组件。History 组件不应为自身文件名标题复制 Tab 样式。                                                                                                                      |
| Row `DSC-ROW-001`                 | [HF-2 Workspace Row](desktop-shell/hf-2/components.md#shell--workspace-row)                                                                                                                    | [WorkspaceTree.tsx](../../src/workspaces/WorkspaceTree.tsx)、[App.css](../../src/App.css)；History 列表为 [HistoryList.tsx](../../src/history/HistoryList.tsx)、[history.css](../../src/history/history.css)            | Workspace Row 复用 HF-2 合同；History row 保留不同的 listbox/option 语义与 feature-owned 结构 | History version row                                                 | 当前没有可核实的通用 React `Row` primitive。Workspace treeitem 与 History option 的层级、状态和操作不同，不能仅因外观相似而强行共用。                                                               |
| Badge / Status `DSC-STATUS-001`   | [DESIGN：Component and interaction rules](../../DESIGN.md#component-and-interaction-rules)；颜色角色见 [HF-2 tokens](desktop-shell/hf-2/tokens.json)                                           | History status 在 [HistoryList.tsx](../../src/history/HistoryList.tsx) 与 [history.css](../../src/history/history.css)；其它状态按所属 feature 实现                                                                     | 复用 warning/success/danger 语义及非颜色状态线索；不假设存在共享 Badge 组件                   | Ready、Marked、Unavailable 等 History 状态                          | 未发现共享 React Badge。需在各 feature anatomy 中说明标签位置、排序、语义、图标和颜色；视觉数字服从批准的设计源。                                                                                   |
| Menu `DSC-MENU-001`               | [DESIGN：Dialog layer、Component and interaction rules](../../DESIGN.md#desktop-information-architecture)                                                                                      | 共享 [ContextMenu.tsx](../../src/app/interaction/ContextMenu.tsx)；History inline action menu 在 [HistoryPanel.tsx](../../src/history/HistoryPanel.tsx)、[history.css](../../src/history/history.css)                   | Tab 与 Workspace 复用 `ContextMenu`；History 行菜单保留当前行锚定实现，沿用同一可访问菜单原则 | 每个 version row 的 Mark/Unmark/Delete 菜单                         | 已有共享 `ContextMenu`，但 History menu 是独立实现；本轮不要求统一重构。共同菜单规则是同一时刻至多一个菜单，重复 trigger 切换、另一 trigger 替换。                                                  |
| Dialog `DSC-DIALOG-001`           | [DESIGN：Dialog layer、Component and interaction rules](../../DESIGN.md#desktop-information-architecture)                                                                                      | 共享 [ApplicationDialog.tsx](../../src/app/interaction/ApplicationDialog.tsx)；调用者包括 [HistoryPanel.tsx](../../src/history/HistoryPanel.tsx)、[WorkspacePanel.tsx](../../src/workspaces/WorkspacePanel.tsx)         | History 复用 `ApplicationDialog` 外壳，在 caller 提供标题、内容和动作                         | History Restore confirmation 与删除确认                             | 共享 modal/focus 管理已存在；对话框具体文案、按钮层级、宽度和状态仍由各 feature anatomy 定义。                                                                                                      |
| Panel `DSC-PANEL-001`             | [DESIGN：Desktop information architecture、Semantic tokens](../../DESIGN.md#desktop-information-architecture)；HF-2 布局说明见 [components.md](desktop-shell/hf-2/components.md#layout-states) | [WorkspacePanel.tsx](../../src/workspaces/WorkspacePanel.tsx)、[HistoryPanel.tsx](../../src/history/HistoryPanel.tsx)、[App.css](../../src/App.css)、[history.css](../../src/history/history.css)                       | 复用共享 surface、边框、层级与焦点规则；History 保留独立、可缩放的 panel composition          | History drawer/panel 与其固定详情区                                 | 未发现通用 React `Panel` primitive。Workspace sidebar 与 History panel 的定位、尺寸和内部滚动职责不同；History 几何只由 [implementation-map.md](local-version-history/implementation-map.md) 维护。 |
| Feedback `DSC-FEEDBACK-001`       | [DESIGN：Component and interaction rules](../../DESIGN.md#component-and-interaction-rules)                                                                                                     | History 状态由 [HistoryStates.tsx](../../src/history/HistoryStates.tsx) 呈现；History 操作反馈由 [HistoryPanel.tsx](../../src/history/HistoryPanel.tsx) 呈现                                                            | 复用 live region、状态语义、错误与可访问性原则；不创建未经证实的全应用 Feedback component     | History loading/empty/error/unavailable/retry/Mark feedback         | `HistoryStateView` 是 History 专属，不是已证实的共享状态组件。Feedback 的文案和版位须由 owning feature 明确。                                                                                       |
| SDK Boundary `DSC-SDK-001`        | [DESIGN：Official Excalidraw boundary](../../DESIGN.md#official-excalidraw-boundary)；[HF-2 SDK boundary](desktop-shell/hf-2/components.md#sdk-boundary)                                       | 编辑器 wrapper：[ExcalidrawEditor.tsx](../../src/editor/ExcalidrawEditor.tsx)；只读 History scene：[ReadonlyPreviewCanvas.tsx](../../src/history/ReadonlyPreviewCanvas.tsx)                                             | 复用官方 public API 与现有 wrapper；不覆盖、不复制私有 SDK UI                                 | History Preview scene；History drawer 本身由应用拥有                | Excalidraw Editor、工具栏、Library、Presentation 属于 SDK；History preview 通过公开 SVG export API 呈现静态只读画面，不挂载第二个交互式 SDK editor。                                                |

## 新增或扩展组件时的引用方式

feature 的 plan/tasks 或自然语言执行说明引用相关 `DSC-*` ID，并在 feature-owned implementation map 中写清该 feature 的 component anatomy：

1. 部件清单及视觉/阅读顺序；
2. 每个部件承担的信息或动作，以及批准文案来源；
3. 状态、状态优先级、图标/文字/颜色的共同提示；
4. 采用的共享 token、几何来源，以及响应式或截断规则；
5. 键盘、焦点和可访问语义；
6. 真实代码入口、复用/扩展决定和尚未解决的偏差。

该清单应来自已批准设计和可核实的产品行为。共享组件只承载确有多处共同的 anatomy；单 feature 的特殊结构留在 feature 文档。测试只校验组件合同里能稳定表达的关键事实，页面组合检查覆盖新引入的布局、裁切和阅读顺序风险。项目级落地步骤及 History anatomy 在 History 实施映射中维护，避免与本目录形成第二份权威。
