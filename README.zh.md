[English](README.md) | [简体中文](README.zh.md)

# Excalidraw Desktop

面向 macOS、围绕官方 Excalidraw 画布打造的桌面工作空间。完全离线绘图，并把作品保留为磁盘上的普通 `.excalidraw` 文件——中间没有账号、云同步或协作服务。

编辑器使用官方 `[@excalidraw/excalidraw](https://www.npmjs.com/package/@excalidraw/excalidraw)` 包，不是 Fork。Excalidraw Desktop 在画布周围补上可靠的本地文件工作流：工作区浏览、安全保存、异常中断后的恢复，以及其他程序修改文件时的明确处理方式。

## 更放心地绘图

绘图始终便于带走。你可以在 Excalidraw Desktop 中打开，也可以复制到 git，或导入 [excalidraw.com](https://excalidraw.com/)；文档格式仍是标准 `.excalidraw`。编辑器资源随应用打包，包含 Virgil 与小赖中文手绘字体，因此应用不需要从网络拉取脚本或字体。

本地持久化工作流重点处理真正容易出问题的时刻：

- **正在绘图时：** 画布保持响应，编辑会合并写入私有草稿，不会每画一笔就重写文档。
- **应用被中断时：** 崩溃、强制退出或掉电后，恢复快照可以找回尚未写入图纸文件的编辑。
- **保存图纸时：** 新文件会先经过校验，再替换旧文件；写入中断不会留下半份 `.excalidraw`。
- **其他程序修改文件时：** 没有本地编辑的文档可以重新加载；有本地编辑时会显示冲突选项，不会静默覆盖任一版本。

## 画布优先的桌面工作流

Welcome 页面提供 **New Drawing**、**Open Workspace** 和 **Recent Workspaces**。工作区文件夹可访问时，可以从 Recent 重新打开；也可以只从应用历史中移除记录，不删除磁盘上的任何内容。

进入工作区后，**Current Workspace** 是侧边栏中唯一显示的目录树。其他工作区记录通过 Welcome 和 Recent 使用，不会把多个根目录堆在同一个侧边栏里。打开的图纸以标签显示在官方画布上方；首次启动时侧边栏隐藏，让画布拥有完整空间。需要浏览时可打开覆盖层，长时间浏览时可将其固定到布局中；**Back** 返回上一个浏览位置，不会关闭已经打开的图纸。

## 功能

- 完全离线地创建、编辑并保存本地图纸
- 在异常中断后恢复未保存的编辑
- 通过一棵连续的 Current Workspace 目录树浏览文件夹和图纸
- 在多个标签中打开图纸；从 Finder 打开文件时复用正在运行的应用实例
- 感知外部文件变更并明确解决冲突
- 将图纸导出为 PNG 或 SVG；SVG 输出会内嵌捆绑字体
- 对图纸内重复图片去重，避免重复粘贴导致存储的资源数据倍增

本版本桌面壳层 UI 为英文。中文 README 只是文档翻译，不表示应用界面已经本地化。

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
