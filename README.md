# Excalidraw Desktop

本地优先（local-first）的离线 Excalidraw 桌面应用，基于 Tauri 2.x、React 19、严格 TypeScript 与 Rust 构建。文档以本地文件为唯一事实来源，不依赖账号、云同步或网络服务。

## 功能范围

覆盖以下 7 个用户故事：

1. 离线创建、编辑与保存本地图纸
2. 异常退出后不丢失编辑成果
3. 工作区文件管理侧边栏
4. 外部文件变更感知与冲突消解
5. PNG/SVG 图纸导出
6. macOS 原生桌面系统集成（Ubuntu 24.04 可选社区验证）
7. 多工作区浏览与缩略图、资产去重

可靠性承诺贯穿全程：文件写入采用原子写，异常退出通过恢复快照保证不丢数据，并通过故障注入测试验证断电、强杀等中断场景下的恢复能力。

## 平台范围

- macOS 12+（Apple Silicon 与 Intel）
- Ubuntu 24.04 Desktop（可选社区验证；Fedora/其他 Linux 不在当前版本支持承诺内）
- Windows 不在支持范围
- macOS 产物通过 GitHub Releases 以未签名、未公证形式提供；项目不规划 App Store、Developer ID 或 Apple 公证

## macOS 安装与 Gatekeeper

GitHub Release 中的 macOS 安装包没有 Developer ID 签名或 Apple 公证。macOS 因此无法验证开发者身份，也无法利用 Apple 公证票据确认产物未被篡改；首次启动可能被 Gatekeeper 拦截。请仅从本项目的 GitHub Releases 下载产物，并在理解这一风险后手动放行：

1. 将应用拖入“应用程序”，并先尝试正常打开一次。
2. 如被拦截，打开“系统设置 → 隐私与安全性”，在安全性区域为该应用选择“仍要打开”。
3. 再次确认打开。该放行操作由用户主动执行，项目不要求禁用 Gatekeeper。

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

macOS 原生功能、安装和 IME 验收可在记录完整配置的虚拟机中执行且为当前版本必选；Ubuntu 24.04 Desktop 仅作可选社区验证，Fedora/其他 Linux 不形成当前门禁。性能 T090/T108 的首个参考环境为 Parallels Desktop Pro 26.4.1、macOS 26.5.2、4 vCPU / 8GB VM；完整测量必须记录真实 `pass`/`fail`，但预算失败不阻断开源发布。详见 [native-verification.md](docs/native-verification.md) 与 [ADR-004](docs/adr/ADR-004.md)。

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
