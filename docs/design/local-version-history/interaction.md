# Local Version History 低保真交互决策

**状态**：低保真已获产品负责人批准；必要高保真仍待审批

**批准日期**：2026-09-23

**设计载体**：OpenDesign Local Codex
**参考视口**：1280 × 760

## 目标与边界

Local Version History 是应用拥有的桌面文件工作流，不是 Excalidraw SDK 画布的一部分。历史界面必须保持 canvas-first，不复制或依赖 SDK 私有 DOM，也不引入常驻 SaaS dashboard。

低保真源文件位于 `low-fi/local-version-history-t004.html`。Review-only 状态导航器仅供设计验收，不属于 production UI。

## 批准的布局

- Version History 使用右侧 app-owned drawer。
- 默认宽度为 **360 px**。在 1280 px 窗口中为画布保留 920 px，约 71.9%，满足既有“画布至少保留 70%”约束。
- **300 px** 仅作为极窄降级状态验证，不是默认宽度。
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
   - CURRENT / READY / MANUAL · MARKED 等非纯颜色状态
3. **Selected version detail**
   - 始终可见：Preview、Restore this version
   - `More version actions` 垂直三点菜单：Mark/Unmark、Delete version
4. **Readonly preview**
   - 明示 `Preview — read only`
   - Preview write count = 0
   - Exit/Escape 返回触发版本行
5. **Confirmations**
   - Restore confirmation
   - Delete confirmation
   - Discard recovery 二次确认
   - Cancel 默认聚焦；关闭后焦点返回触发控制
6. **External recovery issue**
   - Preview recovery
   - Save As…
   - Keep current file（不清除 recovery issue）
   - Discard recovery（二次确认）
   - 未显式确认前不得自动删除

## Mark version 语义

`Mark version` 表示用户明确要求长期保留该历史版本：

- 不改变当前画布或磁盘文件；
- 不创建文件副本，也不是 Git commit；
- 将版本排除在自动/保护版本共享的 20 条淘汰池之外；
- 标记跨应用重启保留；
- 用户执行 `Unmark` 后，该版本重新受普通保留策略管理；
- 用户仍可通过 `Delete version` 显式删除这一条历史记录。

## 操作层级

默认 360 px drawer 中：

- `Preview`：始终可见的次级动作；
- `Restore this version`：始终可见的主动作；
- 垂直三点 `More version actions`：Mark/Unmark 与 Delete version；
- Delete 不直接执行，必须进入统一确认框；
- 菜单支持键盘、Escape 关闭和焦点返回。

300 px 降级状态保持相同三段动作布局，不产生横向滚动。

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
14. External recovery artifact
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

## 审批边界

本记录只确认低保真信息架构与交互。以下仍未批准：

- 精确颜色、排版、图标和阴影；
- Light/Dark 的最终 token；
- Penpot 高保真 screen baselines；
- production macOS 包的视觉结果。

下一阶段使用 Penpot SaaS official hosted Remote MCP 制作必要高保真状态。高保真批准前，不实施 T020 对应 UI。
