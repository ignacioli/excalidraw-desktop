<!--
Sync Impact Report
==================
Version change: 2.0.0 → 3.0.0
Modified principles:
  - Core Principle II（测试标准 / Testing Standards）：将 macOS 设为必选原生验收平台，
    Ubuntu 24.04 Desktop 设为可选社区验证，移除 Fedora/其他 Linux 矩阵的当前版本要求
  - Core Principle III（用户体验一致性 / UX Consistency）：将平台一致性边界收敛为 macOS
    与 macOS 优先支持范围，Ubuntu 仅作为可选社区验证环境
Added sections: none
Governance: MAJOR change; supported-platform acceptance scope narrowed to macOS-first
Removed sections: none
Templates requiring updates: none; templates read this constitution at runtime
Follow-up TODOs: none
-->

# Excalidraw Desktop Constitution

## Core Principles

### I. 代码质量与设计范式（Code Quality）

代码 MUST 遵循 SOLID 与 DRY 范式：单一职责的小模块、面向接口的依赖方向、禁止复制粘贴式
重复逻辑。领域不变量 MUST 保持单一权威层——同一业务规则不得在 TypeScript 与 Rust 两侧
重复实现；跨边界行为通过小而明确、强类型、版本可控的 IPC 契约表达。

- TypeScript MUST 保持 strict 模式；MUST NOT 使用 `any` 或仅为压制类型错误的断言。
- Rust MUST NOT 在可达的生产输入路径上使用 `unwrap`、`expect`、`panic` 或 `unsafe`，
  除非有已证明的不变量并以注释说明。
- 抽象 MUST 由至少两个真实调用方驱动（禁止投机性抽象）；重构 MUST NOT 顺带改变行为。
- 任何 PR MUST 通过格式化、lint、strict typecheck、`cargo clippy` 后方可合并。

**Rationale**: 本产品的核心承诺是数据可靠性；可靠性来自可推理的代码。清晰的边界与单一
权威层使原子写、恢复、冲突消解等关键路径可以被独立验证与演进。

### II. 测试标准——桌面端 E2E 优先（Testing Standards）

测试策略以桌面端端到端验证为中心，单元/集成测试为支撑。

- 每个用户可见功能 MUST 具备对应的 E2E 覆盖（Playwright 桌面测试套件），随功能同一
  PR 交付；测试未通过 MUST NOT 声明任务完成。
- 数据可靠性路径（原子写入、崩溃恢复、外部变更冲突消解）MUST 具备自动化故障注入测试
  （保存中强杀、外部写冲突、损坏文件恢复三类场景为最低集合）。
- 浏览器可测行为与原生壳验证 MUST 明确区分：窗口、菜单、对话框、文件关联、安装包等
  浏览器无法证明的行为，MUST 以目标操作系统的原生环境手动或自动化检查闭环。
- macOS 是当前版本唯一必选的原生验收平台；配置并记录完整的 macOS 虚拟机是有效验收
  环境。Ubuntu 24.04 Desktop 仅作为可选社区验证环境，不阻断合并、发布或任务阶段完成。
- Fedora、其他 Linux 发行版、桌面环境、显示协议与输入法组合不属于当前版本的必需验收
  矩阵；项目 MUST NOT 宣称未执行平台的原生覆盖。
- 所有 VM 交付证据 MUST 记录宿主机、虚拟化软件及版本、客体 OS、虚拟 CPU/内存和显示
  协议，并如实披露 VM 未覆盖的物理硬件边界。
- 修复缺陷 MUST 先补充能复现该缺陷的测试，再实施修复。

**Rationale**: 桌面应用的失效模式（断电、强杀、外部并发写）无法靠单元测试覆盖，只有
E2E 与故障注入才能证明"零损坏、零静默覆盖"的产品承诺。

### III. 用户体验一致性（UX Consistency）

- macOS 是产品交互与发布验收的首要平台；Ubuntu 24.04 Desktop 的兼容性属于可选社区
  验证。平台差异仅允许出现在遵循各自平台惯例的场景（快捷键修饰键、菜单位置、系统
  对话框样式）。
- 可访问性为强制项：语义化结构、完整键盘操作、可见焦点、accessible name、
  reduced motion 支持 MUST 随功能交付，不得作为后补项。
- 加载、空、错误、冲突、离线、权限拒绝等状态 MUST 视为功能的组成部分并有明确 UI 呈现；
  MUST NOT 出现静默失败或无反馈的长时操作。
- 同类操作在应用内 MUST 使用统一的交互与文案模式（保存状态标识、确认对话框、快捷键）。

**Rationale**: 一致性与可访问性决定"成熟桌面应用"的感知质量，事后修补的成本远高于
随功能交付。

### IV. 性能与资源预算（Performance Requirements）

权威 PRD（`specs/001-excalidraw-desktop/spec.md`）的 Success Criteria 为性能预算红线，性能回归等同于
功能缺陷：

- 性能验收 MUST 在维护者声明的 macOS 参考环境执行完整工作负载。首个参考
  环境为 Parallels Desktop Pro 26.4.1 中的 macOS 26.5.2 虚拟机（4 vCPU / 8GB RAM）；
  报告 MUST 记录宿主硬件、虚拟化软件与版本、客体 OS/WebView 和虚拟资源。
- 冷启动至画布可编辑 ≤ 2 秒；空载应用进程树 RSS ≤ 150MB。
- 空闲 CPU P95 ≤ 单逻辑核的 1%；10,000 图元场景稳定后应用进程树 RSS ≤ 350MB；
  30 分钟脚本编辑后，RSS 相对热身基线增长 MUST 同时 ≤ 50MB 且 ≤ 15%；应用静置
  60 秒时，其管理的数据目录与已挂载工作区 MUST 无持续写入。
- 10,000+ 图元场景下平移/缩放保持可用流畅度，编辑无 >100ms 可感知冻结。
- 高频编辑路径 MUST NOT 逐事件执行完整场景序列化、IPC 传输或磁盘写入；持久化 MUST
  经过防抖/合并调度（相对逐事件写盘削峰 ≥95%）。
- 涉及性能敏感路径的变更 MUST 附带同一参考环境的前后对比数据，不得以主观判断替代。
- T090/T108 MUST 在记录配置的参考环境完整执行并保留机器可读报告。预算结果
  MUST 如实标记 `pass` 或 `fail`，但不再是合并、开源发布或安装包交付的硬门禁。
  参考环境变化时 MUST 建立新的趋势系列，MUST NOT 将不可比环境的结果直接对比，
  也 MUST NOT 通过静默放宽阈值伪造通过。

**Rationale**: 选择轻量桌面架构的全部意义在于性能与资源优势；没有预算约束的性能目标
会在迭代中被逐步侵蚀。

### V. 文档规范——全局强制（Documentation Discipline）

- 所有对外行为、IPC 契约、数据格式、架构决策 MUST 有对应文档：产品规格存放于
  `specs/`，架构与开发文档存放于 `docs/`；文档正文使用中文，标识符与代码引用保持原文。
- 架构决策 MUST 记录决策背景、备选方案与取舍理由（ADR 形式或等效章节）。
- 文档与实现不一致 MUST 视为缺陷处理，修复优先级等同代码缺陷。
- 新增命令、配置、环境要求 MUST 同步更新 `AGENTS.md` 的对应章节。

**Rationale**: 本项目采用规格驱动流程（spec-kit），文档是各阶段的输入而非附属品；
过期文档会直接导致后续阶段产出错误。

### VI. 版本控制与协作规范（Git & Pull Request Discipline）

协作历史是审计与回滚的依据。提交与 Pull Request MUST 可预测、可审查、可追溯。

**分支与安全**

- 主分支为 `main`；MUST NOT 对 `main`/`master` 强推；MUST NOT 跳过 hooks
  （`--no-verify`、`--no-gpg-sign` 等）。
- MUST NOT 丢弃或覆盖用户未请求的本地改动；MUST NOT 在未获明确授权时执行破坏性
  git 操作（如 `push --force` 到主分支、硬重置丢弃他人工作）。
- 密钥、凭据、`.env` 等敏感材料 MUST NOT 进入提交；若被请求提交此类文件 MUST 拒绝并
  警告。

**提交**

- MUST NOT 在用户未明确要求时主动创建 commit。
- 每次提交 MUST 聚焦单一意图；提交说明 MUST 用简短祈使句说明动机（why），并通过
  HEREDOC 传入以避免格式问题。
- `--amend` 仅在以下情形允许：（1）用户明确要求；或（2）pre-commit hook 自动改写文件
  且该 commit 由当前会话创建、尚未推送到远端。commit 被 hook 拒绝后 MUST 新建
  commit，MUST NOT 用 amend 掩盖失败。
- 已推送到远端的提交 MUST NOT 擅自 amend；若用户明确要求 amend 已推送提交，MUST 先
  说明强推后果并仅在用户确认后执行，且目标 MUST NOT 为主分支。

**Pull Request**

- GitHub 相关操作（issue、PR、checks、releases）MUST 使用 `gh`。
- 开 PR 前 MUST 核对：工作区状态、相对 base 的完整分支 diff、提交历史、远端跟踪
  状态；需要时先 `git push -u`。
- PR 描述 MUST 含 Summary（1–3 要点）与 Test plan（可勾选验证项）；范围 MUST 保持
  小而聚焦，MUST NOT 夹带无关 churn。
- 合并前 MUST 满足既有质量门禁（原则 I 的格式化/lint/typecheck/clippy、原则 II 的
  测试要求、Docs-Code Sync Gate）；CI 或审查未通过 MUST NOT 合并。
- MUST NOT 默认强推功能分支以“整理历史”；仅在用户明确要求且目标不是主分支时允许。

**Rationale**: 可预测的提交与 PR 纪律降低误操作与审查成本，使规格驱动交付的变更边界
清晰可审计，并保护主分支与用户工作区不被意外破坏。

## 架构图交付标准（Architecture Diagram Standards）

- 架构图 MUST 使用 PlantUML 或 Mermaid 文本图源交付并纳入版本管理；MUST NOT 仅交付
  图片或不可再生的绘图文件（导出图片仅可作为附属产物）。
- 任何架构级交付（架构文档、涉及边界变化的设计文档、`$speckit-plan` 产物）MUST 至少
  包含以下两类图：
  1. **分层图（Layered View）**：呈现前端（React/画布）、IPC 边界、Rust 后端、
     持久化存储各层及其依赖方向；
  2. **数据流图（Data Flow）**：呈现关键链路的数据流转，最低覆盖"编辑事件 → 内存状态
     → 草稿层 → 目标文件落盘"与"外部文件变更 → 感知 → 冲突消解"两条链路。
- 图 MUST 与实现保持一致：改变组件边界、IPC 契约或数据流的代码变更，对应图源 MUST 在
  同一 PR 内更新；不一致视为文档缺陷（见原则 V）。

## 文档与代码同步提交约束（Docs-Code Sync Gate）

- 改变对外行为、IPC/数据契约或架构的代码变更，同一提交/PR 内 MUST 包含对应的文档与
  架构图更新；缺失者 MUST NOT 合并。
- 无行为变化的变更（纯重构、依赖升级、格式化）MUST 在提交说明中显式声明"无文档影响"，
  作为审查确认点。
- Code review 检查清单 MUST 包含文档同步项：审查者确认文档/图已更新或"无文档影响"
  声明成立后方可批准。
- 规格驱动产物（`specs/` 下的 spec/plan/tasks）状态变化 MUST 与对应实现进度一致，
  不得出现实现已完成而规格仍为过期描述的状态。

## Governance

- 本宪法效力高于仓库内其他实践约定；`AGENTS.md` 提供运行期开发指引，与本宪法冲突时
  以本宪法为准并同步修订 `AGENTS.md`。
- **修订流程**：提案（说明动机与影响范围）→ 影响评估（受影响的模板、文档、流程）→
  按语义化版本递增 → 更新文件顶部 Sync Impact Report → 提交。
- **版本判定**：MAJOR = 不向后兼容的原则删除或重定义；MINOR = 新增原则/章节或实质性
  扩展约束；PATCH = 澄清、措辞、排版等非语义修订。
- 所有 PR review MUST 校验宪法合规；违反项 MUST 在合并前修复，或以书面理由记录例外并
  限期回收。
- 提交与 PR 流程合规性以原则 VI 为准；例外 MUST 书面记录并限期回收。
- 复杂度与偏离（新增依赖、抽象层、权限扩张）MUST 有书面正当性说明，否则视为违规。

**Version**: 3.0.0 | **Ratified**: 2026-08-04 | **Last Amended**: 2026-08-12
