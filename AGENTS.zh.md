[English](AGENTS.md) | [简体中文](AGENTS.zh.md)

# excalidraw-desktop 项目说明

## 项目意图

将 `excalidraw-desktop` 做成 macOS 优先的桌面应用，使用 Tauri 2.x、React/TypeScript 前端与 Rust 后端。macOS 是必选原生验收平台；Ubuntu 24.04 Desktop 为可选社区验证；Fedora/其他 Linux 与 Windows 不在当前支持承诺内。保持原生桌面行为、严格安全边界、无障碍，以及可维护的前端/后端契约。

本仓库是可运行的 Tauri 2.x + Vite/React 应用，实现七个用户故事：离线编辑与保存、崩溃安全持久化、工作区文件侧边栏、外部变更检测与冲突消解、PNG/SVG 导出、macOS 原生集成，以及多工作区浏览（连续虚拟化工作区树与资产去重）。壳层以画布为先：工作区侧边栏首次启动隐藏，作为覆盖层打开，并可固定。不要恢复 FileTree、生产环境 `dir_list` 列举、画布内容缩略图或 `thumb_*` IPC。持久化核心以可靠性为先：合并后的热层草稿、原子冷文件写入、恢复快照，以及故障注入测试。不得为了压低 RSS 或空闲 CPU 而回退该合同——不要改回原地覆盖写入、不要把加长草稿窗口当作降低资源占用的权宜之计，也不要移除恢复快照或空闲 checkpoint。

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

面向用户以及根目录贡献者文档以英文为规范文件名（无后缀），简体中文为同目录下的 `*.zh.md` 姊妹文件。`docs/adr/` 不是双语。公开面向用户的页面（`README.md`、`DESIGN.md`、`CONTEXT.md`、`CHANGELOG.md`、`docs/architecture.md`、`docs/quickstart.md`）只描述产品、架构与如何运行；不得引用私有规格编号，例如特性 `001`/`002`、规格用户故事编号或 `T0xx` 任务号。那些标识属于 `docs/evidence/`，必要时也可出现在 ADR。

| 交付物 | 路径 |
|-------------|------|
| 用户 README（英文 / 中文） | `README.md` / `README.zh.md` |
| 视觉与交互契约（英文 / 中文） | `DESIGN.md` / `DESIGN.zh.md` |
| 统一语言（英文 / 中文） | `CONTEXT.md` / `CONTEXT.zh.md` |
| 贡献者与维护者说明（英文 / 中文） | `AGENTS.md` / `AGENTS.zh.md` |
| 更新日志 | `CHANGELOG.md` |
| 架构决策记录（ADR） | `docs/adr/` |
| 架构概述（英文 / 中文） | `docs/architecture.md` / `docs/architecture.zh.md` |
| IPC 契约 | `docs/contracts/ipc-contracts.md` |
| 上手与验证指南（英文 / 中文） | `docs/quickstart.md` / `docs/quickstart.zh.md` |
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
- **Codex managed macOS 沙箱**：运行浏览器可见的 Playwright 用例时，不得让 Playwright 在沙箱内启动其配置的 `webServer`。先在沙箱外启动 `pnpm dev --host 127.0.0.1` 并等待 ready URL，再设置 `PLAYWRIGHT_SKIP_WEBSERVER=1` 运行 Playwright；使用非默认端口时同时设置 `PLAYWRIGHT_BASE_URL`。普通开发者 shell 与 CI 仍可继续使用配置中的 `webServer`。
- `pnpm fonts:build`：从已获授权的本地源字体构建内置 CJK 手写字体。
- `pnpm tauri dev`：通过 package script 运行 Tauri 开发应用。
- `pnpm tauri build`：通过 package script 构建当前 Tauri 包。
- `VITE_E2E_HARNESS=1 pnpm tauri build --features e2e-harness`：构建 T090/T108 所需的测试专用原生二进制；生产发布 **必须** 省略该 feature。
- `pnpm native:screen:prepare -- --checkpoint VSL|FINAL --package-manifest <absolute-path> --run-root <absolute-empty-dir> --plan <absolute-new-path> --isolation-mode backend-app-data-home-redirect`：验证 exact production package binding，只 provision 能通过当前安全格式表达的已声明 fixture，记录每张屏的 `fixture|operator-assisted` preparation mode，为各 gate 创建独立 backend-home root，并额外创建 T023b root，然后写一个绑定 harness v3 的 immutable schema-v2 capture plan。该 mode 只隔离并在 capture 时验证 run root 内的 backend Application Support/SQLite；它明确不声称 WKWebView filesystem isolation。
- `pnpm native:screen:capture -- --plan <absolute-plan> --gate VSL-001 --collection-dir <absolute-new-dir>`：启动 plan-bound package，解析唯一 owned 1280×760 window 并取得两次稳定 sample；打印 declared visual checklist 与一次精确 `CAPTURE <gate-id> <challenge>`，在 600 秒内只接受一次，重新校验同一 PID/window/bounds/scale，写 backend-only `isolation.json` 与 `capture-readiness.json`，只把保守的 plan-declared SDK rectangles 写入 `mask.json`，并使用 `lanczos3-srgb-v1` normalization。Codex/非交互场景由 Agent 持有 collector PTY、向 operator 展示 challenge、等待明确回复 `ready`，再把 exact line 转发到同一 PTY；不得把它当作独立 shell command 执行。Harness 不得读取、打印、备份、清理或直接修改 operator WebKit data。只有 FINAL plan 可使用 `--all-final --collection-root <absolute-new-root>`。Operator action 与 confirmation 只控制时机；semantic state 仍由 focused tests 与 browser evidence 负责。退出码为 `0=PASS`、`1=FAIL`、`2=BLOCKED`、`64=invalid invocation`；禁止 content-GUI automation、full-screen capture、coordinate search、crop、padding 与 visual repair。
- `pnpm native:macos:validate -- --manifest <path> --capture-plan <final-plan> --collection-dir <new-path> --binding <binding.json>`：使用 plan 中专用 T023b profile 验证最终安装包的原生菜单入口，不依赖 capture-specific production IPC，并把报告适配为新的、collector 自有的 immutable collection（不可变证据集合）。`--collection-dir` 与 `--binding` 必须成对提供；adapter 不得写 reviewer 或 owner artifact。
- `pnpm evidence:publish -- --source <sealed-gate-dir> --destination <new-evidence-dir>`：验证角色边界及全部已声明 digest，要求目标目录不存在，逐字节复制 sealed gate，并在目标旁写 publication receipt。退出码固定为 `0=PASS`、`1=FAIL`、`2=BLOCKED`、`64=invalid invocation`。
- `pnpm evidence:publish:test`：运行目标不存在、digest、路径、角色边界与 byte-preserving（字节保持）发布测试。
- `pnpm evidence:aggregate -- --mode <mode> ...`：运行 read-only compositional validator（只读组合验证器）。mode 包含 `delta`、`technical`、`task-proof`、`closure`、`closure-verify`；每次只写指定的新 aggregate output，绝不编辑 source collection、reviewer/owner artifact 或 `tasks.md`。准确参数见 `pnpm evidence:aggregate -- --help`。退出码为 `0=PASS`、`1=FAIL`、`2=BLOCKED`、`64=invalid invocation`。
- `pnpm evidence:aggregate:test`：运行缺失/重复 screen、path/symlink/digest、ownership classification、stale binding、task proof、deterministic output 与 closure self-transition 测试。
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`：检查 Rust 格式。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：运行 Rust lint 门禁。
- `cargo test --manifest-path src-tauri/Cargo.toml`：运行 Rust 单元与集成测试。

参考性能工作流与测试专用故障注入 harness 已是落地的基础设施。T090/T108 在声明的 macOS 26.5.2、4 vCPU / 8GB Parallels Desktop Pro VM 上产出可审计的 `pass`/`fail` 测量；预算失败仍然可见，但不阻断合并或开源发布。参考运行设置 `PERF_TEST=1`、`PERF_REFERENCE_RUN=1`、`PERF_EXECUTION_ENVIRONMENT=virtual`、`PERF_HOST_HARDWARE`、`PERF_VIRTUALIZATION_NAME="Parallels Desktop Pro"` 与 `PERF_VIRTUALIZATION_VERSION`；GitHub workflow 从仓库变量读取宿主硬件与 Parallels 版本。macOS 包长期通过 GitHub Releases 以未签名、未公证形式分发；项目不规划 App Store、Developer ID 或 Apple 公证。把「四个版本文件 + `CHANGELOG.md` 一节」的发版 PR 合入 `main` 会创建 annotated tag `vX.Y.Z` 并发布 GitHub Release。推送 `v*` tag 仍会发布。普通功能 PR 不得改 `CHANGELOG.md`、不得打 tag。不要在 workflow 跑完前于 GitHub UI 先建空 Release。

性能验证顺序：功能开发之后，先跑物理 macOS 的功能与性能测量（快速迭代，在慢速 VM 门禁之前暴露产品回归与工作负载设计问题），再跑声明参考 VM 测量（T090/T108）作为可审计门禁。VM 报告是权威证据，但物理机运行必须在它之前。

验证必须与风险成比例，并最终在适用时包含：

- 前端 formatter、lint、严格 typecheck、聚焦测试与生产构建。
- Rust 格式检查、定向编译、Clippy 与聚焦测试。
- 变更前端/后端边界时的契约或 IPC 集成测试。
- Playwright CLI 流程，覆盖浏览器可见的 UI 行为。
- 浏览器测试无法证明的手动 macOS/Tauri 检查：窗口、菜单、对话框、权限、文件系统行为、Gatekeeper 用户放行与打包。记录完整配置的目标 OS 虚拟机或物理机均可作为证据；永远不要声称未执行的物理设备覆盖。

### UI 调试与视觉证据效率

- 原生证据不等于视觉证据。按以下顺序选择证据来源：
  1. shell、文件系统、安装包元数据及其他构件检查；
  2. 面向 WebView 自有 UI 的语义化浏览器自动化；
  3. 面向原生菜单和原生 UI 操作的 macOS Accessibility/System Events（包括 `osascript`）；
  4. 确定性的应用状态、日志、事件与文件系统结果；
  5. 证明实现层委托关系的现有回归测试；
  6. 只有在剩余事实本质上是视觉事实且无法通过结构化方式建立时，才使用 Computer Use 或截图。
- 将每个验收事实路由到能够证明它的最低视觉证据来源。在使用截图前，先通过源码检查、聚焦的单元/集成测试、语义化 DOM/无障碍定位器和确定性 Playwright fixture 验证应用自有壳层 UI。优先使用 role、name 与 label；仅在应用自有元素缺少稳定语义时补充 `data-testid`，且不得依赖 Excalidraw SDK 私有 DOM 或 test ID。
- 使用当前 feature contract 规定的 viewport、主题、fixture、字体状态与 tolerance；不得用通用 viewport 或临时桌面状态替换。
- 原生证据门禁本身并不授权截图驱动的探索（A native evidence gate is not by itself authorization for screenshot-driven exploration）。
- 截图不得作为以下事实的主要证明：git commit；bundle identifier；应用版本；安装包身份或 hash；macOS 或环境元数据；菜单存在性、标签或启用/禁用状态；键盘等价键；命令委托；保存/导出的文件系统结果；`saveToActiveFile`；直接写入或 SDK 默认路径绕过；以及能够通过结构观察的错误路由。
- 如果需要反复截图才能判断原生行为是否发生，停止视觉循环，改为新增或改进确定性 probe。现有 probe 不足时，必须先创建或扩展可维护的项目本地确定性 harness，再考虑使用 Computer Use。
- 仅为明确的本质视觉门禁，或结构化检查无法建立且范围严格限定的最后一公里事实，才捕获或查看图像。一次处理一张必需屏幕或一个失败区域；当门禁确实要求多张截图时，不设置任意数量上限。
- 浏览器渲染只作为 preflight。原生菜单、窗口、对话框、文件系统错误路径、系统外观、打包及浏览器无法证明的行为，必须使用精确的 Tauri 安装包验证；在可能时通过 Accessibility/System Events 记录原生菜单检查与调用。
- 证据必须绑定精确产品 commit、安装包身份与已记录环境。自动化结果、独立视觉 reviewer verdict 与产品负责人决定相互独立，不能彼此替代。

除非检查确实成功跑过，否则不得声称它通过。若验证需要不可用的服务、目标操作系统，或声明 VM 配置细节，报告确切缺口，而不削弱代码或测试。

## 长时间运行的任务

以下规则约束任何启动预计超过几分钟命令的人（性能测量、soak 测试、构建、VM 运行）：

1. **启动前先说明**：在对话里、启动前讲清预计时长与具体完成信号（例如 “canvas-io spec，约 8–10 分钟，报告 JSON 落地即完成”）。用户必须能离开去做别的事，而不是盲目等待。
2. **运行中保持心跳**：按固定间隔（大约每 5 分钟）主动检查任务健康，并把结果写回对话——即使是无进展报告（“仍在健康运行，已采集 N 个样本”）也算。仅有存活进程不等于健康；要检查可观察的中间产物（样本数、报告文件、`error.json`）。无法暴露这类信号的任务，应在被依赖之前先改到能暴露。
3. **默认 30 分钟上限，显式豁免**：单个后台命令默认不得超过 30 分钟。可拆分的工作必须拆分（例如把三个 perf spec 分成三条命令；每个边界都是自然报告点）。确实不可拆的更长任务，必须在启动前向用户说明预计时长并得到确认，且仍须满足心跳规则。

## Git 与完成标准

主分支是 `main`。改动保持聚焦，使用简短祈使主语；永远不要绕过 hook，也不要对主分支 force-push。不要丢弃或覆盖无关的本地改动。自动化编码工具 **不得** 在操作者未明确要求时创建提交。

**受保护的主分支。** 不得在 `main` 或 `master` 上修改已跟踪文件、暂存或提交。先 fetch `origin/main`，再从该最新 tip 创建主题分支（或把 `origin/main` 合并进该主题分支），然后才改已跟踪文件。优先使用独立 git worktree，以便主 checkout 保持在 `main`。即使改动看起来很小，也禁止直接提交到 `main`/`master`；通过分支和 pull request 合入。主 checkout 上的 gitignore 本地状态可以保留：编辑器/agent skills、`.codex/`、`.handoff/`。

只有当请求的结果在受影响路径上可用、相关测试与文档已更新、适用检查通过或确切缺口已报告、未引入密钥，且最终交接列出变更文件、验证、假设与残余风险时，任务才算完成。

## Worktree 安全与 SDD 提交节奏

两条相关策略约束每一位贡献者和每一种自动化编码工具。破坏性 worktree 操作与提交节奏是共同的失败模式，而不是某个编辑器独有。

- **Worktree 安全（所有开发模式）**：工作前的未提交改动审计、破坏性 worktree 操作前的 WIP 分支备份，以及原生 Git 集成。这适用于每个仓库和每种开发模式，包括不使用 SpecKit 工具的手动 spec → plan → task → implement → validate 循环。
- **Spec-Driven Development 提交节奏**：带安全与边界触发的 checkpoint 级提交，以及与满足它们的代码一起提交的任务跟踪复选框。只要工作由本仓库私有 `specs/` 的 spec/plan/tasks 工件驱动，无论用 SpecKit 工具还是手工执行，都适用。

**本地工具链 bootstrap。** 编辑器 skills、SpecKit scripts/templates、Codex 项目 subagent、私有 `specs/` 软链和 `.handoff/` 属于开发者本地文件，已被 gitignore，以免公开仓库绑定某一种编辑器工具链。它们只安装在主 checkout。为本产品仓库执行 `git worktree add` 之后，以及在该 worktree 中使用项目 skills、SpecKit 脚本、`.handoff`、Cursor subagent 或 Codex 项目 subagent 之前，把该 worktree 作为当前工作目录运行 `scripts/bootstrap-local-worktree.sh`。若当前分支还没有这份脚本，用另一份已更新 checkout 里的拷贝同样调用：以要接线的 worktree 为 `cwd`，而不是以脚本所在位置为准。脚本是幂等的：它把主 checkout 上已存在的目录做成相对 symlink，缺失的源则跳过。若目标已是普通目录，则停止并报告；`--force` 会先备份再替换，且不得用于主 checkout。不要把另一位开发者的 `.agents`、`.cursor` 或 `.codex` 拷进 git 或 worktree。不要把整个 `.specify/`、`.cursor/` 或 `.codex/` 链过去——只链脚本列出的被忽略运行时子树（包括 `.codex/agents`，而不是整个 `.codex/`）。私有 specs worktree 属于另一个 Git 仓库，不受此脚本接线。

**把产品 worktree 切到 Codex。** Codex 从该 worktree 根目录读取 `.codex/agents/*.toml`，不会去读主 checkout。若后续会话要在 Codex 里继续本分支，或对着已有产品 worktree 打开 Codex，agent 必须：(1) 以该 worktree 为 `cwd`，绝不在 `main` 上开发；(2) 运行 `scripts/bootstrap-local-worktree.sh`（幂等）；(3) 确认 `.codex/agents` 是指向主 checkout `.codex/agents` 的 symlink，且 TOML 可解析；(4) 确认 `specs/003-desktop-shell-ux-ui`（或当前 `feature.json` 目录）能解析。然后以该 worktree 为工作目录启动 Codex。不要复制 TOML，不要链整个 `.codex/`，不要在 `main` 上开始实现。

本项目没有冲突规则；若将来需要项目级例外，在此显式记录，而不是复制全局策略。
