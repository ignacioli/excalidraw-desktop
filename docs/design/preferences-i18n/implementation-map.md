# 画布主菜单 component anatomy 与实现映射

状态：2026-10-09 高保真 Review 通过（[README](high-fi/README.md)）。2026-10-10 已实现并通过浏览器验证；原生菜单联动和视觉验收另行记录。本文件是 CANVAS-MAIN-MENU 的唯一 anatomy 入口。

## 权威与实施入口

- 共享来源：[组件目录](../components.md) `DSC-SDK-001`（扩展）、[DESIGN：Canvas main menu / Interface language](../../../DESIGN.md#canvas-main-menu)。
- 当前设计：[manifest](high-fi/manifest.json) 与 6 张画板。数值取自锁定 SDK 0.18.1 的实测，不从实现反推。
- 代码 owner：[CanvasMainMenu.tsx](../../../src/editor/CanvasMainMenu.tsx) 组合菜单，[ExcalidrawEditor.tsx](../../../src/editor/ExcalidrawEditor.tsx) 把它作为 `<Excalidraw>` 的子组件渲染。宿主样式只覆盖语言下拉和不可用项，放在 [App.css](../../../src/App.css)。
- 边界：只用 SDK 公开 API（`MainMenu`、`MainMenu.DefaultItems.*`、`MainMenu.Item`、`MainMenu.ItemCustom`、`MainMenu.Group`、`MainMenu.Separator`、`langCode`）。不读取、不依赖、不借用私有 SDK DOM 或 CSS 类名。SDK 的菜单触发按钮原本没有可访问名称，由依赖补丁补上 `aria-label`（「Menu」/「菜单」，负责人 2026-10-10 决定，见 [patches/README](../../../patches/README.md)）。

## 部件顺序与文案来源

| #   | 部件              | SDK 组件                                    | 文案来源                                                                                                                             | 快捷键提示 |
| --- | ----------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| 1   | Find on canvas    | `DefaultItems.SearchMenu`                   | SDK 语言包（`zh-CN` 由补丁提供「在画布上查找」）                                                                                     | SDK 自带   |
| 2   | Help              | `DefaultItems.Help`                         | SDK                                                                                                                                  | SDK 自带   |
| —   | 分隔              | `Separator`                                 | —                                                                                                                                    | —          |
| 3   | 分组标题          | `Group title`                               | `menu.canvas.preferences`（Preferences / 偏好设置）                                                                                  | —          |
| 3.1 | Tool lock         | `Item`                                      | `menu.canvas.toolLock`（工具锁定）                                                                                                   | Q          |
| 3.2 | Toggle grid       | `Item`                                      | `menu.canvas.toggleGrid`（切换网格）                                                                                                 | Cmd+'      |
| 3.3 | Snap to objects   | `Item`                                      | `menu.canvas.snapToObjects`（吸附至对象）                                                                                            | Option+S   |
| 3.4 | Zen mode          | `Item`                                      | `menu.canvas.zenMode`（禅模式）                                                                                                      | Option+Z   |
| 3.5 | View mode         | `Item`                                      | `menu.canvas.viewMode`（查看模式）                                                                                                   | Option+R   |
| 3.6 | Language          | `ItemCustom` 内的宿主 `<select>`            | 可访问名称 `menu.canvas.language`（语言）；选项 `menu.canvas.languageSystem`（跟随系统）、`English`、`简体中文`、`Español`、`日本語` | —          |
| —   | 分隔              | `Separator`                                 | —                                                                                                                                    | —          |
| 4   | Theme             | `DefaultItems.ToggleTheme allowSystemTheme` | SDK（`zh-CN` 由补丁提供「主题」及 System 按钮的可访问名称）                                                                          | SDK 自带   |
| 5   | Canvas background | `DefaultItems.ChangeCanvasBackground`       | SDK                                                                                                                                  | —          |

四个语言自称（`English`、`简体中文`、`Español`、`日本語`）在任何界面语言下保持原文，是 `catalog.test.ts` 的显式例外。

## 状态与优先级

优先级从高到低：**不可用（强制只读）> 选中 > 默认**。悬停、按下和焦点环使用 SDK 自带样式。

- **选中**：`Item selected={true}`，显示 SDK 选中底色（Light `#E3E2FE` / Dark `#4F4D6F`）。同时给按钮加 `aria-pressed`，读屏能读出开关状态；状态不能只靠颜色表达。
- **Grid / Snap 互斥**：同一时刻最多一个选中，由宿主的统一切换函数保证。
- **View mode**：选中 = 强制只读 ∨ 用户开启。
- **不可用（强制只读）**：Tool lock、Snap to objects、View mode 设置 `disabled` 和 `aria-disabled="true"`，并加宿主 className。文字和快捷键以 40% 不透明度显示（SDK 菜单项本身没有不可用样式）；不可用项不响应悬停底色。View mode 保留选中底色。Grid、Zen、语言、主题仍可操作。
- **选择后关闭**：沿用 SDK 默认行为，选中条目后菜单关闭；语言下拉选择后同样关闭。

## 语言下拉的宿主样式（批准方案 B）

| 属性        | 值                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| 尺寸        | 宽度撑满分组（183px），高 32px，圆角 4px                                                                      |
| 背景 / 边框 | island 色（Light `#FFFFFF` / Dark `#232329`）；1px 边框（Light `#F1F0FF` / Dark `#31303B`）                   |
| 文字        | 12.8px，SDK UI 字体继承；左内边距 8px；颜色 Light `#1B1B1F` / Dark `#E3E3E8`                                  |
| 指示符      | 上下双 chevron，14px，1.5px 描边、圆角线头，颜色同文字；距右边 8px                                            |
| 交互        | 原生 `<select>`：键盘、弹出层和读屏均为系统行为；`appearance: none` 只替换外观；焦点环沿用宿主共享 focus ring |

颜色按应用当前解析出的 Light / Dark 方案切换，不读取 SDK 内部 CSS 变量。

## 键盘、焦点与可访问语义

- 打开、关闭和 Esc 回焦点都由 SDK 菜单负责，宿主不另外拦截。
- 条目都是原生按钮，沿用 SDK 的 Tab 顺序；不可用项不可聚焦（原生 `disabled`）。
- 按当前语言用可访问名称断言条目顺序（合同不变量 1），不依赖 DOM 类名。

## 快捷键提示写法

负责人 2026-10-10 决定：与 macOS 保持一致，修饰键写作 `Cmd`、`Option`，与 SDK 在 macOS 上的显示一致（SDK 的 Theme 按钮提示为 `Shift+Option+D`）。所以显示 `Option+S`、`Option+Z`、`Option+R`、`Cmd+'`。批准画板上的 `Alt+…` 来自合同原文，以本节为准。

## 最小执行记录

```text
分类与依据：已有设计修订（DESIGN「不复刻 PWA 主菜单」边界变更，2026-10-09 已修订）；批准来源 high-fi/manifest.json（2026-10-09，archive rev128）；流程：局部高保真 → 负责人 Review → 本 map → 实现。
影响范围：DSC-SDK-001 扩展（MainMenu 组合、langCode、ToggleTheme）；新增 feature-owned CANVAS-MAIN-MENU；消费者为 ExcalidrawEditor；同步 components.md 索引行。
设计决定：沿用 SDK 菜单视觉与 HF-2 壳层；新增已批准的 selected 底色、单行语言下拉（上下双 chevron，宿主样式）、40% 不透明度不可用态、SDK zh-CN 语言包补丁；快捷键提示随 macOS 写作 Cmd / Option（2026-10-10）。
实施与验证：条目集合/顺序按可访问名称断言（en/zh）；选中、互斥、强制只读真值表单测；浏览器 e2e 覆盖切换语言后的菜单文案；SDK 语言包覆盖率单测；不依赖私有 SDK DOM。
结果：设计批准完成；2026-10-10 实现完成。条目顺序、选中、强制只读和语言文案由单测与浏览器 e2e 覆盖。
```

```text
分类与依据：目标设计不改变画布主菜单 anatomy（宿主 `<select>`、批准方案 B 的尺寸与样式不变）。选项集合由 3 项扩展为 5 项；批准来源是 DESIGN「Interface language」与本 map。流程：先更新选项列与自称例外，再实现。不需要新设计稿。
影响范围：CANVAS-MAIN-MENU（`DSC-SDK-001` 扩展）语言下拉，扩展选项数据，不改 anatomy。原生 Language 子菜单同步五个选项。消费者仍是 ExcalidrawEditor。
设计决定：沿用批准的下拉几何与 SDK 菜单视觉。选项为跟随系统、English、简体中文、Español、日本語；自称在任何界面语言下保持原文。
实施与验证：单测断言五个选项、语言判定和 SDK `langCode`（`es` → `es-ES`，`ja` → `ja-JP`）。浏览器 e2e 覆盖既有菜单入口。原生菜单实机检查不在本轮。
结果：见 `docs/evidence/locales-es-ja-checkpoints.md` 的 Language set and matching。
```

## 验证记录

负责人集中体验（2026-10-11，候选 build `cf33b4b`，production `.app`，二进制 SHA-256 前缀 `94c2ccbb3f29f965`）：**接受**。体验覆盖首次启动跟随系统语言、中文输入法组合中切换语言、画布菜单与原生 Appearance 三态主题和 `Shift+Option+D`、两个 Tab 的画布偏好切换/保存重开/重启、外部修改冲突强制 View mode、中英文菜单文案与 Help。

同次体验提出三项壳层改进（不属于本 feature 的验收缺陷，在同一 PR 内修复）：浅色模式下侧栏底色与 Excalidraw PWA 的色差；工作区树行 ⋮ 菜单与 Tab 右键菜单的视觉，Tab 右键菜单缺少 Close All；侧栏行悬停显示文件路径。结论（2026-10-11，负责人在候选 `dddab2f` 上复验通过）：侧栏底色经 DOM 计算样式核实已是 `#ffffff`，未改；壳层菜单与版本历史行菜单统一采用 SDK 下拉菜单度量；新增 Close All；行悬停以原生 tooltip 显示完整路径（home 缩写 `~`）；另按负责人要求去掉浮层侧栏阴影。

本记录为负责人体验结论，与自动门禁结果（见 `docs/evidence/validation-summary.md`）分开。
