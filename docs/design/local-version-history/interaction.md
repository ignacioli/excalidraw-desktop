# Local Version History 交互与高保真决策

**当前状态**：T048 交互修订的低保真与六张 Penpot 高保真画板均已获产品负责人批准；对应实现与 production package 视觉验收待完成

**T004 基线批准日期**：2026-09-23

**T048 交互修订批准日期**：2026-09-27

**T048 高保真批准日期**：2026-09-28

**T004 低保真载体**：OpenDesign Local Codex

**T048 低保真载体**：仓库本地 HTML（本次修订的特例）

**高保真载体**：Penpot SaaS official hosted Remote MCP

**高保真 Page**：`05 · Local Version History · T004`

**T004 历史高保真基线**：`T004 · Local Version History · High-Fidelity Review Baseline · Compact action menu`

**参考视口**：1280 × 760

T004 的高保真批准只适用于当时的交互范围。T048 修订独立批准并冻结于 `high-fi/t048/`，其画板、token 映射与可编辑源是后续实现和 specs 的设计依据；不能把设计批准写成 production UI 或精确包视觉验收。

## T048 修订原因与验证时间线

T047 最初确实发现过一次原生菜单入口缺陷：`File > Version History` 被禁用。T047 的 `history-only` 原生采集对此记录为 FAIL；随后 `e873aac` 修复了菜单启用 IPC command 的注册名，`ipc-registration` 与之后的 `history-pass` 原生报告均记录菜单已启用。详见 `docs/evidence/local-version-history-t047/history-only/native-report.json`、`docs/evidence/local-version-history-t047/ipc-registration/collection/native-report.json`、`docs/evidence/local-version-history-t047/history-pass/collection/native-report.json`。

T048 最初两次“菜单灰色”发生在采集准备阶段：第一次窗口没有活动的已保存绘图；第二次代理给操作员的提示错误地要求使用产品并不存在的 `File > Open`。这句提示不是采集器输出，而是代理未核对产品菜单和 T047 已验证的启动入口便自行写出的操作路径。后来将已保存夹具作为应用启动参数打开，你确认菜单已启用并成功打开 History。该经历说明了采集指导和初始状态准备的问题，不是 `currentVersionId` 缺失的原因。T048 首次有效截图及其观察记录见 `docs/evidence/local-version-history-t048/README.md` 与 `history-01-pre-remediation/`。

首次有效截图另行暴露了两个实现问题：History drawer 因 `.app-shell-body` 的 grid 仍固定为两列而被排到左侧下一行；时间戳以 Unix 秒传入，却按 JavaScript 毫秒格式化，因而显示为 1970 年。这些应分别按原有右侧 drawer 设计修复，不能归因为需要重画交互。

`Current` 标签问题来自数据语义与界面假设不匹配：History list IPC 没有权威的 `currentVersionId`，`AppShell` 也没有向 `HistoryPanel` 提供该标识。内容哈希只表示快照内容相同，不能证明某条历史记录就是当前可继续编辑的绘图。因此，T048 选择把当前绘图状态独立展示，不将历史快照推断为 Current。这是当前需求下风险和改动范围较小的产品决策，并非所有产品都必须采用的唯一或普遍最优方案。相关契约见 `src/ipc/contracts.ts` 的 `HistoryListResponse`；入口接线见 `src/app/AppShell.tsx` 的 `HistoryPanel` 调用。

长列表中的目标混淆是之后经人工审查提出的独立需求：将 Mark/Unmark/Delete 放到各历史行的三点菜单，并让所选版本身份与 Preview/Restore 固定在一起，以便操作目标和动作始终可见。它改进的是长列表中的目标核对与误操作防护，不是菜单灰色、`currentVersionId` 决策或初始重画的根本原因。T048 低保真与高保真现均已批准；production package 视觉验收仍待完成。

## 目标与边界

Local Version History 是应用拥有的桌面文件工作流，不是 Excalidraw SDK 画布的一部分。历史界面必须保持 canvas-first，不复制或依赖 SDK 私有 DOM，也不引入常驻 SaaS dashboard。

T004 低保真源文件位于 `low-fi/local-version-history-t004.html`；T048 已批准的交互修订载体是 `low-fi/t048-interaction.html`，其身份与批准状态记录于同目录 manifest。Review-only 状态导航器仅供设计验收，不属于 production UI。

## 批准的布局

- Version History 使用右侧 app-owned drawer。
- 默认宽度为 **360 px**。在 1280 px 窗口中为画布保留 920 px，约 71.9%，满足既有“画布至少保留 70%”约束。
- **300 px** 是用户可选择的紧凑宽度，不是默认宽度。2026-09-29 产品负责人明确：默认 360 px，允许拖动 drawer 左边缘缩至 300 px；大窗口同样可用，不以 ≤420 px 或其他视口 breakpoint 作为进入条件。边缘提供可聚焦的 separator 与键盘调整；宽度只影响布局，不改变当前文档、历史选择或操作目标。1280×760 的原生验收尺寸保持不变。
- Drawer 从 36 px Tabs 下方延伸到底部；正常状态不增加常驻保存状态条。
- 左上保持已批准的 Sidebar 与 Back 紧凑控制；不新增品牌 rail、浏览器 chrome 或持久 File 按钮。
- File > Version History 是入口语义，不是新的常驻应用栏。

## 核心元素

1. **Header**
   - Version History
   - 当前文件名
   - Close
2. **Version list**
   - 时间
   - 来源：Automatic / Before restore / Manual
   - 相邻版本粗略摘要；不可靠时使用 `Canvas changed`
   - READY / MANUAL · MARKED 等非纯颜色状态；历史版本行不推断或显示 `Current`
   - 每行垂直三点菜单：Mark/Unmark、Delete version；右键可作为同一菜单的可选镜像入口
3. **Selected version detail**
   - 始终显示所选版本的身份、时间和来源，并提供 Preview、Restore
4. **Readonly preview**
   - 明示 `Preview — read only`
   - Preview write count = 0
   - Exit/Escape 返回触发版本行
5. **Confirmations**
   - Restore confirmation
   - Delete confirmation
   - Cancel 默认聚焦；关闭后焦点返回触发控制
6. **既有 Recovery**
   - 2026-09-29 负责人决定沿用既有异常退出草稿 Recovery，不新增 History 专属 recovery artifact 或 Preview recovery/Keep current file/Discard recovery 流程。
   - 既有恢复、冲突、资源与安全检查保持原职责；History 不重新定义其操作语义。
   - 旧低/高保真中的 External recovery issue 保留为历史设计记录，不再是本功能新增生产界面的要求。

## Mark version 语义

`Mark version` 表示用户明确要求长期保留该历史版本：

- 不改变当前画布或磁盘文件；
- 不创建文件副本，也不是 Git commit；
- 将版本排除在自动/保护版本共享的 20 条淘汰池之外；
- 标记跨应用重启保留；
- 用户执行 `Unmark` 后，该版本重新受普通保留策略管理；
- 用户仍可通过 `Delete version` 显式删除这一条历史记录。

T048 补充了重复标记语义：若当前 normalized scene 未变化，Mark current 复用该文档中已有且对应当前 scene 的 marked snapshot，显示反馈并将焦点和列表视口移至该版本；若当前 scene 已变化，则创建新的快照。不得因连续点击 Mark current 为同一内容不断追加重复版本。此语义不改变 `Unmark` 与普通保留策略的既有关系。

## 操作层级

默认 360 px drawer 中：

- 每条历史行均有可见的垂直三点菜单，提供该行的 Mark/Unmark 与 Delete version；
- 固定的所选版本详情区显示目标身份、时间、来源，并始终提供 `Preview` 与 `Restore`；
- Restore 与 Delete 的确认步骤都再次标明目标版本；
- 菜单和确认框支持键盘操作、Escape 关闭与焦点返回；重复 Mark 的反馈将焦点移至已存在版本。

当前绘图状态单独展示，不属于历史版本列表中的一行。长列表滚动时，所选目标详情及 Preview/Restore 仍保持可见，避免用户需要在操作按钮与目标版本之间来回寻找。用户调整到 300 px 时保持可用的行操作和固定详情区，不产生横向滚动。旧原型中的自动 compact breakpoint 仅保留为历史设计实现，不再定义生产触发方式。

T004 高保真批准的 More actions menu 使用 180 × 84 px 紧凑浮层。T048 已批准的行级菜单保留浅灰色目标标题，因此是 180 × 116 px；两项操作约 40 px 行高，三点触发器 32 px。三点、空心 bookmark 与 trash 均使用 16 × 16 vector geometry，不使用字体 glyph。Delete version 保持危险色和独立分隔，不扩大为常驻按钮。精确尺寸与语义 token 角色见 `high-fi/t048/tokens.json`。

## 完整状态

低保真覆盖：

1. Loading
2. Empty
3. Available list
4. Selected + readonly preview
5. Restore confirmation
6. Restore processing
7. Pending reconciliation / response lost
8. Permission denied
9. Resource unavailable
10. Conflict / external change
11. Generic history error + safe read retry
12. Manual marked
13. Delete confirmation
14. 既有异常退出 Recovery（保留原职责，不新增 History 专属流程）
15. Dark structure
16. 1280 × 760 cramped / 300 px fallback
17. Reduced motion

## 键盘与可访问性

- Tab / Shift+Tab 遍历控制；
- Up / Down 浏览版本；
- Enter 打开版本预览；
- Escape 按 modal → preview → drawer 的最内层顺序关闭；
- Modal 约束焦点，Cancel 默认聚焦；
- Modal、Preview 与 More actions 关闭后均返回触发控制；
- 图标按钮必须有 accessible name；
- 状态不能只用颜色表达；
- loading、processing、error 使用适当 live region；
- reduced motion 不依赖动画表达状态。

## 高保真批准范围

2026-09-23 产品负责人批准以下必要高保真状态：

- 360 px 默认 Light history list；
- More actions menu 及紧凑间距、vector icons 和危险操作层级；
- 独立 readonly version preview；
- Restore confirmation；
- External recovery issue（历史批准画面；其新增流程已由 2026-09-29 负责人决定撤销，改为沿用既有 Recovery）；
- 300 px compact Dark fallback；
- 既有 Excalidraw semantic tokens、排版、边框、阴影和 Light/Dark 方向。

批准只解除 T020 的设计门槛。它不证明 production UI 已实现，也不代替 exact macOS production package 下的 Light/Dark、焦点、错误、裁切和 reduced-motion visual acceptance。
