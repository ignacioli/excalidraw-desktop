[English](README.md) | [简体中文](README.zh.md)

# Excalidraw Desktop

面向 macOS 的本地优先 Excalidraw 桌面应用。图纸就是磁盘上普通的 `.excalidraw` 文件。没有账号、云同步或协作。

画布用官方 [`@excalidraw/excalidraw`](https://www.npmjs.com/package/@excalidraw/excalidraw)，不是 Fork。这个项目补的是画布和文件系统怎么相处：高频编辑、崩溃、Finder，以及别的程序改同一份文件。

## 为什么存在这个应用

把 Excalidraw 套进桌面窗口并不难。常见做法是按定时器、每隔几十秒把整份图纸就地覆盖写回。程序可以很小。代价是崩溃会丢掉这整个间隔，写到一半被杀掉还可能留下残缺 JSON。

本应用按另一份合同来做。

**画的时候别砸磁盘。** Excalidraw 可以每秒回调 60 次。这些变更先留在内存，大约 300 ms 没有新笔划后才写一份私有草稿。`.excalidraw` 不会每画一笔、也不会按 30 秒时钟被整份覆盖。在 Apple Silicon 上，一万图元的场景平移和编辑仍约 60 fps。

**文件别坏，最近几秒也别丢。** 草稿和几份轮换快照在应用数据目录里，不是 `.excalidraw`。崩溃、强杀或掉电后，用它们找回还没写进图纸的编辑。真正写图纸时，先写临时文件、确认 JSON 完整，再 `rename` 换上，从不就地覆盖。

**带走的还是标准文件。** 拷贝、进 git、用 [excalidraw.com](https://excalidraw.com/) 打开的仍是标准 `.excalidraw`。字体和编辑器资源打进包内，含 Virgil + 小赖的中文手绘字体，运行时不从网上拉脚本或字体。

不宣称的事情：这不是轻量进程。WKWebView 跑 Excalidraw 就是几百 MB。本应用空闲内存落在「空白 Tauri 窗口」和「Safari 打开同一块画布」之间。打磨过的是合并写入和能用的一万图元画布，不是 50 MB 内存口号。

## 保存怎么分层

- **正在画：** 先内存，约 300 ms 安静后再写私有草稿。
- **应用挂了：** 用草稿和快照恢复。
- **`.excalidraw` 文件：** 只在空闲、切标签、保存或退出时写入，且只走临时文件 → 校验 → `rename`。

## 和「定时覆盖写」的差别

| | 按时钟整份覆盖 | 本应用 |
| --- | --- | --- |
| 正在画 | 每隔几十秒就地写整份文件 | 内存 → 合并草稿；`.excalidraw` 此时不动 |
| 崩溃 / 掉电 | 可能丢掉整个间隔；文件可能截断 | 草稿 + 快照；目标文件要么完整旧版要么完整新版 |
| 外部修改（git、iCloud、别的编辑器） | 常常无感知 | 自动重载或冲突对话框，从不静默覆盖 |
| 文件夹 | 通常一棵目录树 | 多个工作区，缩略图按需生成 |

## 功能

- 完全离线地创建、编辑并保存本地图纸，中文为手绘字体
- 崩溃、强杀或掉电后恢复未保存的编辑
- 工作区侧边栏浏览图纸；可挂载多个工作区
- 感知外部文件变更并消解冲突
- 导出 PNG 或 SVG（SVG 内嵌捆绑字体）
- 从 Finder 打开 `.excalidraw`；已运行时复用同一实例
- 画布内重复图片按内容去重，避免每粘贴一次文件就胀一截

## 平台

- **macOS 12+**（Apple Silicon 与 Intel）是受支持的发布平台。
- **Ubuntu 24.04 Desktop** 为可选的社区 / 尽力验证。Fedora 及其他 Linux 发行版不在当前版本支持范围内。
- **Windows** 不在支持范围。

## 从 GitHub Releases 安装

请从本仓库的 GitHub Releases 下载安装包。预期仓库路径为 [ignacioli/excalidraw-desktop](https://github.com/ignacioli/excalidraw-desktop)。

macOS 产物是**未签名、未公证**的 `.dmg`。项目不提供 App Store 上架、Developer ID 签名或 Apple 公证。

Linux 的 **AppImage**、**deb** 和 **rpm** 也可能出现在 Releases 页面，它们只是**尽力提供的二进制**。这并不表示本版本已验证或支持 Linux。

### macOS 与 Gatekeeper

GitHub Release 中的 macOS 安装包没有 Developer ID 签名或 Apple 公证。macOS 因此无法验证开发者身份，也无法利用 Apple 公证票据确认产物未被篡改；首次启动可能被 Gatekeeper 拦截。请仅从本项目的 GitHub Releases 下载产物，并在理解这一风险后手动放行：

1. 将应用拖入“应用程序”，并先尝试正常打开一次。
2. 如被拦截，打开“系统设置 → 隐私与安全性”，在安全性区域为该应用选择“仍要打开”。
3. 再次确认打开。该放行操作由用户主动执行，项目不要求禁用 Gatekeeper。

## 从源码构建

### 环境前提

- Node.js 22.13+（pnpm 11.20.0 的要求）
- pnpm（项目声明 `packageManager: pnpm@11.20.0`）
- Rust stable 1.80+
- macOS：Xcode Command Line Tools
- Linux：WebKitGTK 系统依赖（仅在你选择于 Linux 构建时需要）
- Python 3.10+ 与 uv（仅用于字体构建，即 `pnpm fonts:build`；解释器由 `.python-version` 固定为 3.14，依赖经 `pyproject.toml` + `uv.lock` 管理，`uv run` 自动创建 `.venv`）

### 开发与打包

```sh
pnpm install
pnpm dev            # 启动 Vite 开发服务器
pnpm fonts:build    # 构建内置 CJK 手写字体（uv 管理 fonttools/brotli，产出 public/fonts/）
pnpm tauri dev      # 启动 Tauri 开发应用
pnpm tauri build    # 构建当前 Tauri 安装包
```

### 质量门禁

```sh
pnpm lint                                            # 前端 ESLint
pnpm typecheck                                       # 严格 TypeScript 检查
pnpm test                                            # Vitest 单元测试
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
APP_E2E=1 pnpm e2e                                   # Playwright E2E
```

`APP_E2E=1 pnpm e2e` 覆盖浏览器可见的 E2E 流程；原生 shell 与故障注入用例需要测试专用 Tauri 构建。

## 文档

- [DESIGN.md](DESIGN.md) / [DESIGN.zh.md](DESIGN.zh.md) — 视觉与交互契约
- [docs/architecture.md](docs/architecture.md) — 架构说明
- [docs/contracts/ipc-contracts.md](docs/contracts/ipc-contracts.md) — IPC 契约
- [docs/adr/](docs/adr/) — 架构决策记录
- [docs/quickstart.md](docs/quickstart.md) — 贡献者验证指南（不是最终用户手册）
- [AGENTS.md](AGENTS.md) / [AGENTS.zh.md](AGENTS.zh.md) — 贡献者与维护者的约束、命令与贡献规则

## 许可证

本项目采用 [MIT License](LICENSE)。

内置 CJK 手绘字体由 Virgil 与小赖字体生成，这两套源字体仍适用 SIL Open Font License。见 [public/fonts/README.md](public/fonts/README.md)。

## 贡献

修改本项目前请阅读 [AGENTS.zh.md](AGENTS.zh.md)（英文见 [AGENTS.md](AGENTS.md)）。修改行为或契约时，同步更新相关设计、契约与验证文档。
