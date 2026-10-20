[English](README.md) | [简体中文](README.zh.md)

# Excalidraw Desktop

<a href="https://deepwiki.com/ignacioli/excalidraw-desktop"><img src="docs/assets/ask-deepwiki-badge.png" width="109" height="20" alt="Ask DeepWiki"></a>

面向 macOS、围绕官方 Excalidraw 画布打造的桌面工作空间。完全离线绘图，并把作品保留为磁盘上的普通 `.excalidraw` 文件——中间没有账号、云同步或协作服务。

编辑器使用官方 `[@excalidraw/excalidraw](https://www.npmjs.com/package/@excalidraw/excalidraw)` 包，不是 Fork。Excalidraw Desktop 在画布周围补上可靠的本地文件工作流：工作区浏览、安全保存、异常中断后的恢复，以及其他程序修改文件时的明确处理方式。

## 更放心地绘图

绘图始终便于带走。你可以在 Excalidraw Desktop 中打开，也可以复制到 git，或导入 [excalidraw.com](https://excalidraw.com/)；文档格式仍是标准 `.excalidraw`。编辑器资源随应用打包，包含 Virgil 与小赖中文手绘字体，因此应用不需要从网络拉取脚本或字体。

本地持久化工作流重点处理真正容易出问题的时刻：

- **正在绘图时：** 画布保持响应，编辑会合并写入私有草稿，不会每画一笔就重写文档。
- **应用被中断时：** 崩溃、强制退出或掉电后，恢复快照可以找回尚未写入图纸文件的编辑。
- **保存图纸时：** 新文件会先经过校验，再替换旧文件；写入中断不会留下半份 `.excalidraw`。
- **其他程序修改文件时：** 没有本地编辑的文档可以重新加载；有本地编辑时会显示冲突选项，不会静默覆盖任一版本。
- **需要找回早期状态时：** 本地 Version History 保存 automatic、manual 和操作前保护版本，并为每份文档维护持久身份。改名会保留身份，Save As 会开始独立历史，删除历史条目不会改变当前图纸。

## 画布优先的桌面工作流

Welcome 页面提供 **New Drawing**、**Open Workspace** 和 **Recent Workspaces**。工作区文件夹可访问时，可以从 Recent 重新打开；也可以只从应用历史中移除记录，不删除磁盘上的任何内容。

每个窗口持有一个工作区，其 **Current Workspace** 是该窗口侧边栏中唯一显示的目录树。**File > New Window**（⇧⌘N）会打开另一个窗口，因此不同工作区可以并排打开。打开已在其他窗口中打开的工作区时，会把那个窗口前置，而不会打开第二份；打开其中的子文件夹时同样如此，并在那个窗口的侧边栏中定位到该文件夹。打开一个包含了其他窗口中工作区的文件夹时，会询问是否关闭那个窗口并在此打开。同一幅图纸同一时间只能在一个窗口中打开；从侧边栏或 Finder 再次打开它时，会切换到已打开它的窗口。其他工作区记录通过 Welcome 和 Recent 使用，不会把多个根目录堆在同一个侧边栏里。每个窗口会记住其工作区上次显示的位置，包括大小、位置以及最大化或全屏状态；原位置不再能被访问时，窗口会回到已连接的显示器上。正常退出后，下次启动会重新打开你之前的窗口、工作区和标签。有工作区但没有打开图纸的窗口会显示空白画布，带有提示、**New Drawing** 和 **Show Sidebar**。每个工作区各自记住侧边栏的固定、宽度与展开状态；外观与语言对所有窗口生效。在侧边栏中右键点击图纸或文件夹，或右键点击标签，可以**复制路径**或**复制相对路径**（相对于工作区根目录）；工作区根目录只提供复制路径。打开的图纸以标签显示在官方画布上方；首次启动时侧边栏隐藏，让画布拥有完整空间。需要浏览时可打开覆盖层，长时间浏览时可将其固定到布局中；**Back** 返回上一个浏览位置，不会关闭已经打开的图纸。

## 功能

- 完全离线地创建、编辑并保存本地图纸
- 在异常中断后恢复未保存的编辑
- 通过一棵连续的 Current Workspace 目录树浏览文件夹和图纸
- 在多个标签中打开图纸；从 Finder 打开文件时复用正在运行的应用实例
- 同时使用多个窗口，每个窗口一个工作区，并按工作区记住窗口位置
- 从侧边栏和标签复制图纸或文件夹的路径，或相对于工作区的路径
- 感知外部文件变更并明确解决冲突
- 为 automatic checkpoint、manual 标记以及受保护的 restore/clear/import 操作保留本地 Version History
- 将图纸导出为 PNG 或 SVG；SVG 输出会内嵌捆绑字体
- 对图纸内重复图片去重，避免重复粘贴导致存储的资源数据倍增
- 以英文、简体中文、西班牙语或日语使用界面，并可在画布主菜单或原生菜单栏中调整常用画布偏好

## 语言、偏好与菜单

**界面语言。** 应用提供英文、简体中文、西班牙语（Español）和日语（日本語）四种界面语言。首次启动时跟随 macOS 的首选语言列表，列表中没有受支持的语言时回退到英文。可随时通过应用菜单中的 **Language（语言）** 子菜单，或画布主菜单中的 **Language** 项切换（跟随系统、English、简体中文、Español、日本語）。选择会立即应用到应用界面、画布编辑器和原生菜单，并在重启后保留。macOS 首选语言的变化在下次启动时生效。系统自有的对话框（如打开、保存面板）遵循 macOS；macOS 自行加入 Edit 和 Window 菜单的项（如 AutoFill、Start Dictation、Fill）也一样，使用 macOS 在应用启动时为它选定的语言。如需与应用语言一致，可在「系统设置 > 通用 > 语言与地区 > 应用程序」中为 Excalidraw 单独设置语言，然后重启应用。西班牙语和日语为 AI 翻译，并已经过独立 AI 审校，欢迎母语使用者指正。

**画布偏好。** 画布主菜单中有 **Preferences（偏好设置）** 分组，包含 Tool lock（工具锁定）、Toggle grid（切换网格）、Snap to objects（吸附至对象）、Zen mode（禅模式）和 View mode（查看模式），另有 Language 项与 Theme（主题）控件。原生 **View（显示）** 菜单提供相同的开关，并带有 **Appearance（外观）** 子菜单（跟随系统、浅色、深色）。二者写入同一份应用偏好。当图纸被强制只读时，Tool lock、Snap to objects 和 View mode 不可用。

**主题快捷键。** 按 `Shift+Option+D` 可用键盘切换主题。

**原生菜单栏。** macOS 菜单栏提供 App、File、Edit、View、Window 和 Help 菜单，菜单文案跟随界面语言。File 包含 New Window、Open Workspace、Save、Export Image 和 Version History；Save 为 `Cmd+S`，Export Image 为 `Cmd+Option+E`。

## 平台

- **macOS 12+**（Apple Silicon 与 Intel）是受支持的发布平台。
- **Ubuntu 24.04 Desktop** 为可选的社区 / 尽力验证。Fedora 及其他 Linux 发行版不在当前版本支持范围内。
- **Windows** 不在支持范围。

## 从 GitHub Releases 安装

请从本仓库的 [GitHub Releases](https://github.com/ignacioli/excalidraw-desktop/releases) 下载安装包。

macOS 产物是**未签名、未公证**的 `.dmg`。项目不提供 App Store 上架、Developer ID 签名或 Apple 公证。Linux 的 **AppImage**、**deb** 和 **rpm** 也可能作为**尽力提供的二进制**出现；有这些产物不代表 Linux 是受支持平台。

### macOS 与 Gatekeeper

由于 macOS 安装包没有 Developer ID 签名或 Apple 公证，macOS 无法验证开发者身份，也无法利用 Apple 公证票据确认二进制产物。首次启动可能被 Gatekeeper 拦截。请仅从本项目的 GitHub Releases 下载，并在理解这一风险后手动放行：

1. 将应用拖入“应用程序”，并先尝试正常打开一次。
2. 如被拦截，打开“系统设置 → 隐私与安全性”，在安全性区域为该应用选择“仍要打开”。
3. 再次确认打开。该放行操作由用户主动执行，项目不要求禁用 Gatekeeper。

## 进一步了解

- [DESIGN.md](DESIGN.md) / [DESIGN.zh.md](DESIGN.zh.md) — 视觉与交互契约
- [docs/architecture.md](docs/architecture.md) / [docs/architecture.zh.md](docs/architecture.zh.md) — 架构说明
- [docs/contracts/ipc-contracts.md](docs/contracts/ipc-contracts.md) — IPC 契约
- [docs/adr/](docs/adr/) — 架构决策记录
- [docs/quickstart.md](docs/quickstart.md) / [docs/quickstart.zh.md](docs/quickstart.zh.md) — 贡献者环境与验证指南
- [CHANGELOG.md](CHANGELOG.md) — 面向用户的版本说明
- [AGENTS.md](AGENTS.md) / [AGENTS.zh.md](AGENTS.zh.md) — 贡献者与维护者规则、工作流和命令

## 许可证

本项目采用 [MIT License](LICENSE)。

内置 CJK 手绘字体由 Virgil 与小赖字体生成，这两套源字体仍适用 SIL Open Font License。见 [public/fonts/README.md](public/fonts/README.md)。

贡献前请先阅读 [AGENTS.zh.md](AGENTS.zh.md)（英文见 [AGENTS.md](AGENTS.md)）。
