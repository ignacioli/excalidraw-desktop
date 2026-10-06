# 本地版本历史：原生与视觉验收执行合同

**2026-10-04 owner范围修订：** Parallels Desktop已不可用；本轮004/T049跳过虚拟机，仅在M5 Pro物理机执行既定完整工作负载的基线／候选配对。保留历史VM记录，不移植或伪造VM PASS；环境、二进制、完整样本和真实diagnostic verdict仍必需，预算失败仍不升级为发布硬门槛。

本文件是本feature的当前执行合同，落实已批准的轻量验收决定；产品行为和设计权威不变。当前完成状态、实际包身份和下一步只在[验证索引](local-version-history-validation-index.md)维护，原始报告保持原身份。`.handoff/native-vision-validation-contract.md`是历史决策背景，其中当时的暂停、提交限制及候选包状态不作为当前状态复制。

## 默认执行入口

先从当前任务定位本合同和验证索引；使用[组件目录的五行执行记录](../design/components.md#最小执行记录)，在现有任务或实施说明中写明本次变更、仍适用的证据、受影响的复验范围及未就绪项。此记录由agent完成，不增加owner审批或新文件。视觉设计以批准的design/component spec为准，本合同决定证明分工，索引记录实际结果。

- 包、原生入口、状态准备各自报告结果；任何一项准备未完成，都不能据此邀请owner判断缺失的画面。技术就绪不等于视觉PASS或负责人接受。
- 修复只重新打开有具体影响的证据。仅文档/工具调整不自动要求重建产品或重验已接受画面；包复用仍须核对实际artifact与运行时输入，不能仅凭“看起来没改UI”。
- 原生会话按下面W1–W6组织，复用未变观察。准备问题先由agent定位，状态稳定后再协调桌面；不得用持续人工尝试替代准备。
- T049等待桌面不阻止T052整理现有事实/缺口。T054材料可同步准备，是否接受剩余事项由owner明确决定；暂停一项不自动暂停独立任务，接受决定也不把未执行测试变成完成。

## 事实分工与完成信号

| 检查什么 | 主要 owner / 层 | 状态准备与证据 | 完成信号 |
| --- | --- | --- | --- |
| 分页、选择/操作目标、键盘与焦点返回、错误角色、迟到响应、预览零写入 | browser semantic / unit | 现有 T023、T057/T059 fixtures 及 [原始报告](local-version-history-t059/README.md) | 对应断言 PASS；不产生 native 结论 |
| 宽度、颜色、按钮状态、布局/裁切、reduced-motion 样式 | computed styles / browser layout | 相同组件及真实 AppShell fixture，包含 50 行和 Light/Dark | 对应断言 PASS；原生画面仅检查平台呈现剩余事实 |
| History 原生入口及目标文档路由 | T047/T058 exact-package AX/menu probe | 保留现有窄 scope，不复跑旧 003 的完整菜单/物理按键矩阵 | 当前包的既定入口检查 PASS |
| 真实 WKWebView 的可读性、当前/预览区分、错误表达、焦点外观、裁切与整体体验 | T048 owner walkthrough | 下述集中 session 分组与状态准备；原生包与环境记录一次 | 所有必需观察有 owner 的明确 PASS，无未处理 FAIL/BLOCKED |
| 保存、恢复、资源、故障与重启 | Rust / process reliability | 复用各自适用证据；产品路径变更才定向复验 | 对应原有 gates PASS，不以视觉意见覆盖 |
| 资源和性能 | T049 paired measurements | 稳定的独立测试时段、同一 M5 Pro 物理机的基线／候选配对（2026-10-04 owner撤销本轮VM要求） | 有效报告及真实 verdict；不与 T048 合并 |
| 功能最终接受 | T054 product owner | T052 索引、各层实际结论和剩余限制 | 单独明确接受决定；T048 通过不自动完成 T054 |

## 一次 session，保留全部观察范围

下列是组织方式，不是减少检查项。每组可以包含多个状态，不要求每个状态重新启动 production 包或形成独立 collection。

| 组 | 包含的必要观察 | 原有范围对应 |
| --- | --- | --- |
| W1：Light 主路径 | 1280×760、默认 drawer、Current Drawing、时间/来源/摘要/标记、Mark 与固定 Preview/Restore；More Actions 与二次确认的可读性 | HISTORY-01、02 |
| W2：Preview 与恢复确认 | 只读预览和当前画布的视觉区分；Exit/Restore；Cancel 初始可见焦点与关闭后焦点外观；只在合成 fixture 上操作 | HISTORY-03、04 |
| W3：长列表与目标 | 至少 50 行列表顶部/中部/底部；重复 Mark 后目标可辨、固定详情与操作不裁切 | HISTORY-05；业务去重与写入次数仍归自动测试 |
| W4：Dark 与紧凑宽度 | 同一 1280×760 窗口的 Dark；左边缘拖至批准的紧凑宽度，核对对比、文字及操作；保留 Light/Dark 两种主题观察 | HISTORY-06 |
| W5：异常与 Recovery | error、conflict、pending/processing、resource-unavailable，以及实际受影响的既有异常退出草稿 Recovery 分别可辨且可读 | 异常观察分别记录；Recovery 沿用已有回归，只有共享 UI 变更实际影响时才追加原生复查，不新增 History 专属恢复流程 |
| W6：焦点与 reduced motion | 在上述路径中顺便观察行、菜单、Preview、Cancel、Close 的焦点及返回；系统 Reduce Motion 下状态仍可理解 | HISTORY-FOCUS、HISTORY-REDUCED-MOTION |

完整结果填写 [visual checklist](local-version-history-visual-checklist.md)。截图在有缺陷或明确需要图像佐证时采集；它是可选诊断材料，不再要求 12 份 capture collection，也不要求每屏独立 AI reviewer 签字。若选择运行既有 collector，仍遵守其 PID/window、ready 和隔离安全检查，不削弱 collector 本身。Owner 可以同时承担 T048 视觉判断与 T054 最终决定，但两种结论分别记录。

## 进入原生 session 的准备条件

- 当前 production 包、提交、路径/hash 已明确；代码未变时复用已封存包。文档和验收合同变化不自动要求重建。原生入口证据继续按实际包身份记录。
- 每组有合成数据、可执行步骤和可辨认目标状态；不能只写 `operator-assisted`。状态准备必须复用隔离的测试目录，不读写用户日常 profile，不把测试故障入口加入 production。
- 邀请 owner 前列出已经准备的组和仍然 BLOCKED 的组。不让 owner 在现场承担 50 次造数、随机碰撞错误或等待瞬态的工作。准备缺口单独处理，不能靠点击确认跳过。
- 预计一次 owner session 为 15–30 分钟；超过预算时说明未完成项与原因并重新安排，不超时判 PASS，也不重复全套。原生启动、焦点占用或 OS 设置变化均先与用户协调。负责人已于 2026-09-29 明确授权本轮原生验收，之前的暂停已解除。
- 状态准备的静态/离线检查不等于 production 中可达；未执行的实机确认明确写“未验证”，不能升级为 ready/PASS。

## 结果、失败和复验

### 已有准备工具

从选定 product worktree 运行，先查看对应 `--help`。下面参数均指实际已有 artifact 或新建隔离目录，不是新的验收门槛：

- `node scripts/native-macos-validation.mjs seal --manifest <已有manifest>`：验证实际包及 runtime inputs 后复用原身份；不因 docs/tool-only 修改重建，不覆盖不匹配的旧 manifest。
- `node scripts/native-macos-validation.mjs readiness --manifest <包manifest> --pid <owned PID> --fixture <ROOT/fixture-manifest.json> --scenario pendingIssue|unavailable|longList`：只读检查目标进程、合成 fixture、保存状态及 AX 页面；可用 `--report <新路径>` 保存结果。`preparation-only` 不表示视觉或 owner PASS。
- pending 在正常 Save 后被清除时，使用 `cargo run --manifest-path src-tauri/Cargo.toml --example prepare_history_visual_fixture -- refresh-pending <ROOT>`，随后重新打开 History 并检查 readiness；只允许工具创建的临时 fixture，不能对日常 profile 操作。
- `node scripts/performance-build.mjs --mode common|history --repo <目标checkout> --target-dir <所有worktree以外的新绝对目录>`：固定使用 Tauri CLI 构建独立测试 binary，检查协议、模式和内嵌资源。`BUILD_READY` 不表示 T049 测量已运行；执行真实构建或测量前仍遵守时长预告和桌面协调。

新增 readiness 的 AX 查询已通过编译与针对性测试，但尚未完成实际 WKWebView 运行确认；无法观察时返回 BLOCKED，不回填既有验收为新工具 PASS。

一次记录 package、系统版本、主题/逻辑窗口大小、fixture、时间和检查者；逐项记录 PASS/FAIL/BLOCKED 与具体问题。文件字节、operation ID、故障阶段等仅由其适用的 process 证据提供，不向普通视觉行强加无关字段。保留原始报告，不新增全链 publisher/aggregate 作为完成条件。

同一阻塞不原样重跑；先区分 product/harness/environment/specification。修复后的复验范围由实际影响决定：样式局部修复检查相应组件，公共 theme/font/layout 改动扩大到受影响状态，后端数据路径改动回到其可靠性 owner。任何 required 自动失败仍保留，人工意见不能覆盖。

只有具体新证据造成无法解决的证明归属、依赖或状态可达冲突时，才对该最小范围复审；不为获得“零发现”反复审查整个feature。

## Recovery 范围决定已落实

负责人于 2026-09-29 明确选择沿用既有异常退出草稿 Recovery，修正设计/验收中多出的 History 专属恢复流程；恢复与外部冲突的自动/进程安全检查完整保留。旧批准画板和历史报告原样保留，不因此要求新增 production API、artifact 存储或专属 Preview/Keep current/Discard UI。
