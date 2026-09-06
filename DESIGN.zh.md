[English](DESIGN.md) | [简体中文](DESIGN.zh.md)

# Excalidraw Desktop 设计系统

**状态**：已对账的 canonical contract，已获产品负责人批准

**最后更新**：2026-09-03

**适用范围**：应用壳层、桌面专属界面与内嵌 Excalidraw 编辑器

本文档是仓库内供人类与 Coding Agent 共同遵守的视觉和交互事实来源。产品行为以项目规格为准。桌面壳层术语遵循 [CONTEXT.zh.md](CONTEXT.zh.md)。

## 产品气质

应用应当像“为可靠桌面文档工作流重新组织的 Excalidraw”：

- 熟悉、克制、轻量、直接；
- 内容优先，画布始终拥有最高视觉优先级；
- 遵循桌面工作流，不模仿浏览器或 PWA 外壳；
- 与锁定版本的官方 Excalidraw 保持同一视觉语言，不创造平行设计体系。

避免装饰性渐变、玻璃拟态、过量阴影、所有元素都使用大圆角、纯装饰动画、密集 SaaS Dashboard 风格，以及任何与画布争夺注意力的控件。

## 桌面信息架构

窗口是操作系统的普通装饰窗口，标题为 **Excalidraw Whiteboard**。标题栏颜色与标题位置由操作系统控制（标题栏选择 A）。不得在 Web 内容区重新绘制浏览器控制、PWA 顶栏或 macOS 红黄绿交通灯。不得强制全应用原生 Dark、透明/覆盖/混合/无边框标题栏，或生产环境始终置顶。

| 区域 | 用途 | 必须满足的行为 |
| --- | --- | --- |
| 原生标题栏 | 窗口身份与系统窗口装饰 | 普通装饰窗口；系统着色标题栏；标题 **Excalidraw Whiteboard** |
| 左侧壳层 | 工作区导航与文件管理 | 紧凑的 Sidebar 与 Back 图标控件并列于最顶层左端。Pinned 时包含 Current Workspace 标题行与树；Overlay 覆盖 Center 但不改变画布盒；Hidden 时释放全部 Sidebar 空间。 |
| 中央视壳层 | 文档导航与官方编辑器画布 | Tabs 位于中央顶层；官方 Excalidraw canvas 直接在其下。Hidden 时 Tabs 与画布立即回流至释放的水平空间。 |
| 右侧 SDK 边界 | 官方 Library 与 Presentation surface | 保持 SDK-owned boundary 或占位关系。不得出现空的 app-owned right sidebar；003 不重绘、不替换，也不依赖编辑器、Library 或 Presentation 的私有 DOM。 |
| 对话框层 | 恢复、冲突、确认、命名、偏好与应用/菜单动作 | 单一应用对话框层与单一上下文菜单；不得使用 `window.prompt` / `window.confirm`。 |

**Canvas-first 三分区壳层。** 每个可达状态都使用上述 Left / Center / Right 层级。首次启动为 Hidden。一个紧凑 Sidebar 按钮负责所有可见模式切换：Hidden 打开 Overlay，Overlay 固定为 Pinned，Pinned 隐藏并取消固定；进入左侧边缘 reveal zone 也可打开 Overlay，且不改变 canvas box，不显示独立 Pin/Unpin 控件。Pinned Sidebar 默认宽 360px，可在 280–480px 内调整，并按需进一步限制以确保 canvas 至少保留 post-Sidebar content width 的 70%（批准的 1280×760 参考值为 76.1%）；所选宽度持久化。指针离开后 500 ms 自动关闭 Overlay，除非焦点、上下文菜单、对话框或拖放仍将其保持。Escape 关闭 Overlay，除非对话框或菜单已经消费 Escape。

### 启动与浏览状态

- **Welcome** 是空启动时的非标签文档状态，提供 **New Drawing**、**Open Workspace** 和 Recent Workspaces。Recent Workspaces 只从现有记录投影 `name` 与 `rootPath`，并按既有 `createdAt` 降序；所有记录均保留，默认区域最多显示五行，超出后内部纵向滚动。Recent 行使用与 Sidebar row 相同的语义 hover/focus 表面，不增加 last-opened time 或 drawing count。取消选择工作区后状态不变。不可访问的 Recent Workspace 显示可理解的错误，仍保留 Welcome 与该记录。
- **Restored** 是存在有效 Current Workspace 或可重新打开文档时的正常启动壳层。干净重启不会显示恢复对话框。
- 异常退出且存在恢复候选时，必须先显示恢复对话框。候选全部处理完成后才显示 Restored；在用户应用恢复决定前不得覆盖磁盘文件。
- **Current Workspace** 是侧边栏树和标题行操作唯一使用的工作区。保存的 id 缺失或无效时回退到可用工作区，不创建新的工作区记录。
- **Back** 返回 Current Workspace 内上一个有效浏览位置。浏览栈为空时禁用 Back，且 Back 不关闭已打开文档。

**工作区树。** Current Workspace root 及其可见后代组成一棵连续虚拟化的 Workspace Entries 树；多个 mounted Workspace root 不得堆叠在同一 Sidebar。其他 workspace record 通过 Welcome/Recent 或明确的 workspace-open flow 提供。图纸行使用文件图标。没有 FileTree，没有生产环境 `dir_list` 列举，也没有画布内容缩略图 worker 或 `thumb_*` IPC。

**标签。** 每个标签预留关闭控件位置。标签上下文菜单提供 **Close**、**Close Others** 和 **Close Tabs to the Right**。中键关闭所指标签。应用壳层内，macOS 的 Cmd+W 与受支持 Linux 的 Ctrl+W 关闭活动图纸标签。标签栏上以垂直方向为主的滚轮手势切换标签，并合并到最新意图；溢出标签使用最近可见的紧凑策略，不显示可见 tab-strip scrollbar，且 reduced motion 时不使用平滑滚动。关闭孤立文档时提供 **Save As**、**Close Without Saving** 与 **Cancel**。

### 动作归属与 legacy 移除

壳层应移除而不是重新装饰旧 chrome。以下每项在每个可达状态中的可见计数必须为零：

- 文字或卡片式 `Workspace sidebar` 控件、大型文字 `Pin` / `Unpin` 控件、重复的 Workspace-root title，以及同一 Sidebar 中多个 Workspace root；
- 全局顶层 `New Drawing`、独立顶层 `Save`、`Export` 或 `Appearance` 控件，以及正常状态 `All changes saved` / autosave strip 或为其保留的垂直空间；
- 可见 tab-strip scrollbar、粗大或常驻 Sidebar scrollbar、永久可见的 horizontal ellipsis，以及用于目录/图纸 identity 的三角、字母、菱形或 Unicode placeholder glyph；
- 使 Current Workspace 紧凑 `New Drawing`、`New Folder`、Collapse-or-Expand-All 或 Refresh action 不可见的 header-action overflow。

accessible name、tooltip、键盘操作、隐藏语义标签和错误文案仍是必须项；零计数仅针对可见的 obsolete 或 duplicate chrome。`New Drawing` 是紧凑的 Current Workspace-header action，目标是 selected directory 或 workspace root。`Save To` 与 `Export Image` 保持由 SDK 或 application/menu-level owner 负责；不得新增重复 top-level Export。Appearance 是 application/menu-level preference，不是独立 shell chrome。

本版本应用壳层界面文案为英文。

第一版不复刻官方 PWA 主菜单、浏览器/PWA 标题栏、Excalidraw+ 入口、账号界面、实时协作或云服务控件。

## 官方 Excalidraw 边界

- 导入锁定版本 `@excalidraw/excalidraw` 随包提供的样式。画布工具、编辑器面板、图标、控件几何和编辑器内部交互状态由官方包负责。
- 只通过官方公开的 `theme` 与 UI 组合 API 控制编辑器。不得复制上游私有 React 组件或 Fork 上游应用 CSS。
- 仅覆盖官方文档公开的 Excalidraw CSS Variables，并限制在应用根节点作用域内。除非兼容性决策记录了原因与升级测试，否则不得依赖不稳定的内部 class。
- 初始浅色/深色数值以锁定依赖包为准，不从截图取色。截图只用于整体风格与视觉回归参考。
- 桌面专属标签、文件管理、对话框和偏好设置属于应用壳层，使用下文语义 Token。Save/Export/Appearance 的归属保持为已文档化的 SDK 或 application/menu-level capability，不得成为重复的 top-level shell control。

官方参考：

- <https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/props/>
- <https://docs.excalidraw.com/docs/@excalidraw/excalidraw/customizing-styles>

## 主题模型

主题家族与明暗模式偏好是两个独立概念：

- `themeId`：主题家族标识；第一版仅提供 `excalidraw`。
- `modePreference`：`light`、`dark` 或 `system`。
- `resolvedColorScheme`：根据模式偏好与系统外观解析得到的 `light` 或 `dark`。

解析后的明暗模式同时控制应用壳层与内嵌编辑器。选择 `system` 时，操作系统外观变化必须在同一帧同步更新两者；选择固定 `light` 或 `dark` 后，后续系统变化不得覆盖用户选择。

外观偏好是应用本地状态，不是文档内容。它不得改变 `.excalidraw` 文件、图纸语义或导出契约。无效或来自未来版本的偏好回退为 `system`。即使内容模式固定为 `light` 或 `dark`，原生标题栏颜色仍由操作系统控制。

已保存偏好必须在首个用户可见界面前应用，启动时不得闪现相反明暗模式。

## 语义 Token

应用组件消费语义 Token，不直接使用调色板字面值。已批准的桌面壳层数值冻结在 `docs/design/desktop-shell/hf-2/tokens.json`。实现时必须将共享角色与锁定版本的 Excalidraw 包对齐并记录包版本；SDK 所有的编辑器样式继续使用上游公开变量，已批准的壳层角色不得被截图取色值或私有 SDK 内部样式静默替换。

| Canonical token ID | 用途 |
| --- | --- |
| `color.app.background` / `color.canvas.background` | 窗口内容与默认编辑器表面 |
| `color.panel.background` / `color.surface.background` | Panel、menu、dialog、control、tab 与 floating control |
| `color.surface.hover` / `color.surface.active` | hover 与 pressed state |
| `color.text.primary` / `color.text.secondary` / `color.text.disabled` | 文本层级 |
| `color.border.subtle` / `color.border.strong` | divider、input 与 selected border |
| `color.accent.base` / `color.accent.hover` / `color.accent.contrast` | primary action 与 selected control |
| `color.focus.ring` | keyboard focus indicator |
| `color.status.danger` / `color.status.warning` / `color.status.success` | status state；不得成为唯一信息通道 |
| `radius.control` / `radius.panel` / `space.1` / `space.2` / `space.3` / `space.4` / `space.6` | shared geometry scale |
| `font.ui` / `font.mono` / `font.size.*` / `font.weight.*` | shell typography |

浅色模式使用白色与近白表面、深炭色文字、克制的冷色边框和 Excalidraw 紫色强调色。深色模式使用近黑画布周边、深灰面板、具有足够对比度的暖白文字、克制边框和对应的浅紫强调色。壳层精确数值使用仓库内已批准 HF-2 token handoff 的 canonical ID；SDK 所有的编辑器精确数值跟随锁定上游包。floating shadow 的使用是 component stacking rule，不是冻结的 semantic token。

已批准的壳层几何采用 4/8/12/16/24 px 间距尺度、8 px 控件与 12 px 面板圆角、16 px 图标与默认 1 px 描边（方向性 chevron/collapse/expand 为 1.25 px）及至少 32 px 命中区域、28 px 工作区行、36 px 标签页，以及紧凑的 11/12/14/20/28 px 字号尺度。这与锁定的公开 `@excalidraw/excalidraw` 0.18.1 图标集在 16 px 下的有效视觉重量一致。标签页与工作区行的组件级 6 px 圆角记录在 HF-2 组件契约中。

## 组件与交互规则

- 优先使用语义化 HTML 和符合平台认知的控件。每个交互元素必须具有 accessible name 和可见焦点。
- hover、active、selected、disabled、loading、empty、error、conflict、permission-denied 与 offline 都是组件定义的一部分。
- 标签页必须显示文件名，不得只依赖图标；未保存状态同时使用可见标记与无障碍文本。关闭控件位置始终预留，标题不得因此跳动。
- 同一时刻最多打开一个上下文菜单。同一触发器切换开关；另一触发器直接替换。
- 文件层级、活动文档、选中、警告和冲突不得只用颜色表达。工作区侧边栏中的图纸行使用文件图标，不得使用画布缩略图或文字圆点。
- 模态对话框打开时焦点进入并被约束在其中；关闭后焦点返回触发控件。同一时刻只有一层对话框；不得使用 `window.prompt` 或 `window.confirm`。
- 动效只服务于状态理解且保持短暂；必须尊重 reduced motion，避免画布周围发生动画布局跳动。
- 阴影只表达浮动控件、菜单和对话框的层级；常驻面板使用边框或明度差分隔。
- shell icon control 使用冻结的 16×16 icon 和 32×32 hit target。紧凑图标控件默认无填充、无边框，前景色为 secondary（Light `#5C5C5C`、Dark `#CED4DA`），仅在交互时使用语义 hover/pressed 表面与更高对比度。Current Workspace header 将 New Drawing、New Folder、Collapse-or-Expand-All 与 Refresh 保持为同一名称行上的紧凑控件。Row action 仅在 pointer 或 keyboard focus 存在时使用无边框 vertical ellipsis；Tab close 在预留槽位内视觉整合，不显示为单独的方框按钮。
- [`docs/design/desktop-shell/hf-2/components.md`](docs/design/desktop-shell/hf-2/components.md) 是 Icon Button/Back、Tab、Workspace Row 与 Welcome Action variant 的规范来源：其中的 2px theme focus ring、disabled-to-default state priority、可见的 non-colour cue、row-action tooltip/accessibility rule，以及 primary/secondary Welcome Action emphasis 与这些更广泛的 interaction rule 同时适用。

## 后续主题扩展

后续内置主题与用户自定义主题通过映射到浅色或深色基础模式的、经校验的语义 Token 定义扩展。

- 主题定义只能提供 Token 值；禁止任意 CSS、脚本、远程资源与选择器。
- 自定义主题声明稳定标识、显示名称、基础明暗模式与支持的语义 Token。
- 缺失或不支持的 Token 回退到所选基础模式。
- 主题导入、主题编辑器、主题分享和公开主题文件格式不属于第一版。

## 验证契约

初始实现必须提供以下证据：

- 浅色、深色与跟随系统行为；
- 重启持久化与损坏偏好回退；
- 壳层/画布同步且启动无相反主题闪现；
- 六张分别审查的 1280×760 HF-2 shell gate：Welcome Light、Restored Hidden Light、Workspace Pinned Light、Workspace Overlay Light、Welcome Dark 与 Workspace Pinned Dark；
- 键盘导航、焦点可见性、accessible name、对比度、非颜色唯一状态与 reduced motion；
- macOS 与受支持 Linux 环境中的系统原生装饰窗口行为。

每个 visual gate 都记录冻结 manifest hash、仅 SDK 的 mask declaration、shell geometry/token assertion、legacy count、browser preflight 与 macOS package evidence。独立 visual reviewer 必须逐个检查 gate；其 runtime identity 和 verdict 是证据，而不是产品负责人决定的替代品。产品负责人已于 2026-09-03 批准该已对账 contract，并于 2026-09-06 批准 Penpot revision 59 修订；这些批准不替代屏幕级实现证据或后续视觉评审。

Penpot SaaS 是当前桌面壳层重设计已批准的高保真评审载体，通过 Penpot 官方托管的 Remote MCP 访问。HF-2 revision 59 已于 2026-09-06 批准，并冻结在 [`docs/design/desktop-shell/hf-2/`](docs/design/desktop-shell/hf-2/README.md)，其中包含可编辑归档、manifest、精确 Token、组件契约、六张屏幕基准图和十个壳层图标。已完成的 OpenDesign HTML 产物仅作为低保真探索与交互证据，不是高保真事实来源；外部设计工作区不得成为并行事实来源。
