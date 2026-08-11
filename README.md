# Excalidraw Desktop

本地优先（local-first）的离线 Excalidraw 桌面应用，基于 Tauri 2.x、React 19、严格 TypeScript 与 Rust 构建。文档以本地文件为唯一事实来源，不依赖账号、云同步或网络服务。

## 功能范围

覆盖以下 7 个用户故事：

1. 离线创建、编辑与保存本地图纸
2. 异常退出后不丢失编辑成果
3. 工作区文件管理侧边栏
4. 外部文件变更感知与冲突消解
5. PNG/SVG 图纸导出
6. macOS/Linux 原生桌面系统集成
7. 多工作区浏览与缩略图、资产去重

可靠性承诺贯穿全程：文件写入采用原子写，异常退出通过恢复快照保证不丢数据，并通过故障注入测试验证断电、强杀等中断场景下的恢复能力。

## 平台范围

- macOS 12+（Apple Silicon 与 Intel）
- Linux（Ubuntu/Debian 与 Fedora，X11/Wayland）
- Windows 不在支持范围
- 正式签名与公证在后续版本提供

## 环境前提

- Node.js 20+
- pnpm（项目声明 `packageManager: pnpm@11.20.0`）
- Rust stable 1.80+
- macOS：Xcode Command Line Tools
- Linux：WebKitGTK 系统依赖
- Python 3.10+ 与 uv（仅用于字体构建，即 `pnpm fonts:build`；解释器由 `.python-version` 固定为 3.14，依赖经 `pyproject.toml` + `uv.lock` 管理，`uv run` 自动创建 `.venv`）

## 开发与构建

```sh
pnpm install
pnpm dev            # 启动 Vite 开发服务器
pnpm fonts:build    # 构建内置 CJK 手写字体（uv 管理 fonttools/brotli，产出 public/fonts/）
pnpm tauri dev      # 启动 Tauri 开发应用
pnpm tauri build    # 构建当前 Tauri 安装包
```

## 质量门禁与验证

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

## 文档索引

- [DESIGN.md](DESIGN.md) — 桌面 UI 主题与视觉契约
- [specs/001-excalidraw-desktop/](specs/001-excalidraw-desktop/) — 权威功能设计集
  - [spec.md](specs/001-excalidraw-desktop/spec.md) — 特性规格
  - [plan.md](specs/001-excalidraw-desktop/plan.md) — 实现计划
  - [research.md](specs/001-excalidraw-desktop/research.md) — 技术决策与约束
  - [data-model.md](specs/001-excalidraw-desktop/data-model.md) — 数据模型
  - [quickstart.md](specs/001-excalidraw-desktop/quickstart.md) — 快速上手
  - [contracts/ipc-contracts.md](specs/001-excalidraw-desktop/contracts/ipc-contracts.md) — IPC 契约
  - [tasks.md](specs/001-excalidraw-desktop/tasks.md) — 任务清单
- [docs/](docs/) — 实现文档
  - [native-verification.md](docs/native-verification.md) — 原生平台验证
  - [architecture.md](docs/architecture.md) — 架构说明
  - [adr/](docs/adr/) — 架构决策记录
  - [a11y-audit.md](docs/a11y-audit.md) — 无障碍审计
  - [validation-summary.md](docs/validation-summary.md) — 验证摘要

## 贡献指引

- 遵循 [specs/001-excalidraw-desktop/tasks.md](specs/001-excalidraw-desktop/tasks.md) 的任务编号与仓库 `AGENTS.md` 的约束
- 仅在被明确要求时提交代码
- 修改行为或契约时，同步更新相关设计、契约与验证文档
