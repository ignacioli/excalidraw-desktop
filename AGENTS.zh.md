[English](AGENTS.md) | [简体中文](AGENTS.zh.md)

# excalidraw-desktop 项目说明

## 项目意图

将 `excalidraw-desktop` 做成 macOS 优先的桌面应用，使用 Tauri 2.x、React/TypeScript 前端与 Rust 后端。macOS 是必选原生验收平台；Ubuntu 24.04 Desktop 为可选社区验证；Fedora/其他 Linux 与 Windows 不在当前支持承诺内。保持原生桌面行为、严格安全边界、无障碍，以及可维护的前端/后端契约。

本仓库是可运行的 Tauri 2.x + Vite/React 应用，实现七个用户故事：离线编辑与保存、崩溃安全持久化、工作区文件侧边栏、外部变更检测与冲突消解、PNG/SVG 导出、macOS 原生集成，以及多工作区浏览（含缩略图与资产去重）。持久化核心以可靠性为先：合并后的热层草稿、原子冷文件写入、恢复快照，以及故障注入测试。不得为了压低 RSS 或空闲 CPU 而回退该合同——不要改回原地覆盖写入、不要把加长草稿窗口当作降低资源占用的权宜之计，也不要移除恢复快照或空闲 checkpoint。

## 预期结构

- `src/`：React 19 + TypeScript strict 前端。
- `src-tauri/`：Rust 后端（Tauri 2.x）。
- `specs/`：指向私有 specs 仓库的软链接，存放权威功能规格、计划、研究、数据模型、任务与检查清单（被 Git 忽略，不属于本公开仓库）。修改任何链接规格前，必须读取 `specs/AGENTS.md`，并分别审计私有仓库的 Git 状态、暂存内容和未推送提交；本公开仓库的 Git 状态不包含这些链接文件。
- `docs/`：面向实现的架构记录与 ADR。
- `.codex/`：开发者本机 Codex 配置。它被 Git 忽略，**不得**作为构建、测试、审查或贡献本项目的前提。

测试遵循所选前端、Rust 与端到端工具的既有约定，而不是事先发明一套结构。

## 架构与变更边界

应用是 Tauri 2.x 双进程布局：`src/`（React 19 + TypeScript strict 前端）与 `src-tauri/`（Rust 后端），经 IPC 契约边界通信。分层视图、数据流与信任边界见 `docs/architecture.md`；决策记录见 `docs/adr/`；IPC 契约见 `docs/contracts/ipc-contracts.md`。

一次改动可以碰哪些边界，是项目约束，而不是某个编辑器或助手的分工：

- 跨越 React 与 Rust 的改动必须把 IPC 契约、Tauri capabilities 和应用生命周期写清楚。不要扩大权限、绕过校验，或把原生 API 当成前端细节。只有工作确实完全落在一层内时，才适合只改 UI 或只改 Rust。
- 操作系统兼容性、安装包、文件关联、Gatekeeper 行为与发布打包需要原生平台验证。浏览器测试不能证明这些路径。
- 性能敏感工作在同一条验收路径中 **必须** 包含测量与回归裁决。不要只凭实现意图就给出性能结论。
- 原子持久化、异常退出恢复、冲突消解与原生桌面 E2E **必须** 包含进程级可靠性测试。仅有浏览器证据不足。
- 不要用普通功能切片去改核心 IPC 架构、崩溃恢复、原子持久化、原生打包、平台支持，或性能/可靠性门禁。

## 文档地图

规格驱动交付物记录在下列规范路径。私有 specs 仓库为交付物命名；本公开仓库拥有这些路径。

面向用户以及根目录贡献者文档以英文为规范文件名（无后缀），简体中文为同目录下的 `*.zh.md` 姊妹文件。`docs/architecture.md` 与 `docs/adr/` 不是双语。`docs/quickstart.md` 是中文贡献者验证指南，没有语言姊妹文件。

| 交付物 | 路径 |
|-------------|------|
| 用户 README（英文 / 中文） | `README.md` / `README.zh.md` |
| 视觉与交互契约（英文 / 中文） | `DESIGN.md` / `DESIGN.zh.md` |
| 贡献者与维护者说明（英文 / 中文） | `AGENTS.md` / `AGENTS.zh.md` |
| 架构决策记录（ADR） | `docs/adr/` |
| 架构概述 | `docs/architecture.md` |
| IPC 契约 | `docs/contracts/ipc-contracts.md` |
| 贡献者验证指南 | `docs/quickstart.md` |
| 原生验证证据 | `docs/evidence/native-verification.md` |
| 无障碍审计 | `docs/evidence/a11y-audit.md` |
| 验证摘要 | `docs/evidence/validation-summary.md` |

`specs/` 中的 `Phase N`（`tasks.md`、`plan.md`）指 Spec-Driven Development 阶段（Setup、Foundational、US1–US7、Polish）。不要把 ADR 或证据里 2026-08-14 性能测量工作的编号复用成 `Phase 1/2/3/4`；那一套编号不是 SDD。按日期和实际做了什么来命名那些活动（全树重测、物理机归因、ADR-007 预算/工作负载校准）。

## Spec-Driven Development（SDD）工作流

1. 把模糊请求翻译成最小、连贯、用户可见的结果。识别假设、受影响边界，以及成功长什么样。
2. 编辑前检查相关代码、配置、测试与既有约定。不要发明命令、API、路径、Tauri 权限或仓库行为。
3. 低风险歧义若能被仓库约定解决，则继续推进并写明假设。当选择会实质改变 UX、数据、API、安全、依赖、兼容性或架构时，只问一个有针对性的问题。
4. 实现完整垂直切片，而不是互不相关的占位。范围保持收紧，并保留请求之外的行为。
5. 为变更行为补充或更新测试，并在每个受影响层运行最窄的相关检查。
6. 交接前审查最终 diff 的正确性、安全性、无障碍、兼容性，以及无关 churn。

不要添加投机性抽象、依赖、服务、配置格式或平台支持。不要为了解决局部问题而重写已经能工作的架构。

## 工程边界

- TypeScript 保持 strict，并忠实于运行时数据。避免 `any`，以及仅为压住类型错误而写的断言。
- 领域不变量只放在一个权威层。不要在 TypeScript 与 Rust 之间重复业务规则。
- IPC 与 API 契约保持小、有类型、显式、版本可感知。所有前端与外部输入在 Rust 或后端信任边界校验。
- 授予最少的 Tauri capabilities 与操作系统权限。不要把禁用 CSP、扩大权限、绕过校验或削弱签名当作默认 workaround。
- 密钥不得进入源码、前端状态、日志、fixture 与已提交的环境文件。
- 保持语义化 HTML、键盘操作、焦点行为、accessible name、reduced motion、响应式布局，以及 macOS 交互惯例。
- 避免 `unsafe`、panic，以及在可达生产输入上使用 `unwrap` / `expect`，除非已证明的不变量与仓库约定能证明其合理。
- 加载、空状态、取消、超时、重试、离线、权限拒绝与失败状态，在适用时都是功能的一部分。

## 命令与验证

清单确立了以下工作流：

- `pnpm dev`：运行 Vite 开发服务器。
- `pnpm build`：运行严格 TypeScript 检查与 Vite 生产构建。
- `pnpm lint`：运行前端 ESLint 门禁。
- `pnpm typecheck`：运行独立的严格 TypeScript 门禁。
- `pnpm test`：运行 Vitest 单元套件。
- `APP_E2E=1 pnpm e2e`：运行 Playwright 套件；原生 shell 与故障注入用例需要 E2E fixture 描述的测试专用 Tauri 构建。
- `pnpm fonts:build`：从已获授权的本地源字体构建内置 CJK 手写字体。
- `pnpm tauri dev`：通过 package script 运行 Tauri 开发应用。
- `pnpm tauri build`：通过 package script 构建当前 Tauri 包。
- `VITE_E2E_HARNESS=1 pnpm tauri build --features e2e-harness`：构建 T090/T108 所需的测试专用原生二进制；生产发布 **必须** 省略该 feature。
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`：检查 Rust 格式。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：运行 Rust lint 门禁。
- `cargo test --manifest-path src-tauri/Cargo.toml`：运行 Rust 单元与集成测试。

参考性能工作流与测试专用故障注入 harness 已是落地的基础设施。T090/T108 在声明的 macOS 26.5.2、4 vCPU / 8GB Parallels Desktop Pro VM 上产出可审计的 `pass`/`fail` 测量；预算失败仍然可见，但不阻断合并或开源发布。参考运行设置 `PERF_TEST=1`、`PERF_REFERENCE_RUN=1`、`PERF_EXECUTION_ENVIRONMENT=virtual`、`PERF_HOST_HARDWARE`、`PERF_VIRTUALIZATION_NAME="Parallels Desktop Pro"` 与 `PERF_VIRTUALIZATION_VERSION`；GitHub workflow 从仓库变量读取宿主硬件与 Parallels 版本。macOS 包长期通过 GitHub Releases 以未签名、未公证形式分发；推送 `v*` tag 会发布它们，而 App Store、Developer ID 与 Apple 公证不是项目要求。

性能验证顺序：功能开发之后，先跑物理 macOS 的功能与性能测量（快速迭代，在慢速 VM 门禁之前暴露产品回归与工作负载设计问题），再跑声明参考 VM 测量（T090/T108）作为可审计门禁。VM 报告是权威证据，但物理机运行必须在它之前。

验证必须与风险成比例，并最终在适用时包含：

- 前端 formatter、lint、严格 typecheck、聚焦测试与生产构建。
- Rust 格式检查、定向编译、Clippy 与聚焦测试。
- 变更前端/后端边界时的契约或 IPC 集成测试。
- Playwright CLI 流程，覆盖浏览器可见的 UI 行为。
- 浏览器测试无法证明的手动 macOS/Tauri 检查：窗口、菜单、对话框、权限、文件系统行为、Gatekeeper 用户放行与打包。记录完整配置的目标 OS 虚拟机或物理机均可作为证据；永远不要声称未执行的物理设备覆盖。

除非检查确实成功跑过，否则不得声称它通过。若验证需要不可用的服务、目标操作系统，或声明 VM 配置细节，报告确切缺口，而不削弱代码或测试。

## 长时间运行的任务

以下规则约束任何启动预计超过几分钟命令的人（性能测量、soak 测试、构建、VM 运行）：

1. **启动前先说明**：在对话里、启动前讲清预计时长与具体完成信号（例如 “canvas-io spec，约 8–10 分钟，报告 JSON 落地即完成”）。用户必须能离开去做别的事，而不是盲目等待。
2. **运行中保持心跳**：按固定间隔（大约每 5 分钟）主动检查任务健康，并把结果写回对话——即使是无进展报告（“仍在健康运行，已采集 N 个样本”）也算。仅有存活进程不等于健康；要检查可观察的中间产物（样本数、报告文件、`error.json`）。无法暴露这类信号的任务，应在被依赖之前先改到能暴露。
3. **默认 30 分钟上限，显式豁免**：单个后台命令默认不得超过 30 分钟。可拆分的工作必须拆分（例如把三个 perf spec 分成三条命令；每个边界都是自然报告点）。确实不可拆的更长任务，必须在启动前向用户说明预计时长并得到确认，且仍须满足心跳规则。

## Git 与完成标准

主分支是 `main`。改动保持聚焦，使用简短祈使主语；永远不要绕过 hook，也不要对主分支 force-push。不要丢弃或覆盖无关的本地改动。自动化编码工具 **不得** 在操作者未明确要求时创建提交。

只有当请求的结果在受影响路径上可用、相关测试与文档已更新、适用检查通过或确切缺口已报告、未引入密钥，且最终交接列出变更文件、验证、假设与残余风险时，任务才算完成。

## Worktree 安全与 SDD 提交节奏

两条相关策略约束每一位贡献者和每一种自动化编码工具。破坏性 worktree 操作与提交节奏是共同的失败模式，而不是某个编辑器独有。

- **Worktree 安全（所有开发模式）**：工作前的未提交改动审计、破坏性 worktree 操作前的 WIP 分支备份，以及原生 Git 集成。这适用于每个仓库和每种开发模式，包括不使用 SpecKit 工具的手动 spec → plan → task → implement → validate 循环。
- **Spec-Driven Development 提交节奏**：带安全与边界触发的 checkpoint 级提交，以及与满足它们的代码一起提交的任务跟踪复选框。只要工作由本仓库私有 `specs/` 的 spec/plan/tasks 工件驱动，无论用 SpecKit 工具还是手工执行，都适用。

本项目没有冲突规则；若将来需要项目级例外，在此显式记录，而不是复制全局策略。
