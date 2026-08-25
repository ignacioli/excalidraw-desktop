# ADR-009 桌面 UI 交互：标题栏选择 A、画布优先侧边栏、缩略图退休、IPC v2 WorkspaceEntry、统一菜单/对话框

**状态**：Accepted

**日期**：2026-08-19

## 背景/Context

应用已具备离线编辑、崩溃安全持久化、工作区挂载与外部冲突处理，但壳层仍按「左侧文件管理 / 右侧画布」组织，列表与缩略图走 `dir_list` / `file_*` / `thumb_lookup` / `thumb_store`，部分命名与确认依赖 WebView `prompt`/`confirm`。本决策要在不削弱 ADR-002 原子写、草稿、恢复快照与冲突阻塞的前提下，把工作区树、条目变更、标签关闭与原生窗口边界收口到单一权威层。

标题栏颜色、侧边栏占用画布的方式、以及无消费者的缩略图链路，都会扩大原生验收面或浪费 IPC/磁盘工作。ADR-005 曾写明传统左右分栏，并把导出与缩略图一并约束为 `light | dark`；其中壳层布局与缩略图句由本 ADR 取代，主题家族与内容 `light | dark | system` 边界仍以 ADR-005 为准。

## 决策/Decision

1. **原生标题栏选择 A**：生产窗口保持普通装饰、`Visible` 标题栏、系统控制标题栏颜色、正常堆叠。窗口标题为 **Excalidraw Whiteboard**（`src-tauri/tauri.conf.json`）。内容主题继续独立解析为 `light | dark | system`，不调用会改变 `NSApplication` appearance 的 app-wide Dark，不引入 Transparent / Overlay / hybrid / frameless。生产路径不 always-on-top；`e2e_harness` 仅在 `EXCALIDRAW_PERF_CONTROL_DIR` 存在时可为测量窗口置顶，不得泄漏到生产。
2. **画布优先侧边栏**：`AppShell` 默认画布占满。侧边栏 `hidden | overlay | pinned`（`src/app/sidebarController.ts`）：overlay 覆盖画布且不改变画布盒；pinned 进入布局并缩小画布列；无空右侧栏。首次启动未固定时默认隐藏。
3. **缩略图退休**：删除活动缩略图运行时（前端 worker/队列、`thumb_lookup` / `thumb_store`、Rust thumbnails 模块、运行时 `file_meta` 读写）。asset protocol 与 `.excalidraw_assets` 仅服务图纸内真实图片。历史 `file_meta` 表作为 ADR-002 热层的惰性兼容残留保留，不是活动缓存。本决策取代架构文档中 FileTree + `thumbnails/` 的现行描述，并取代 ADR-005 中把缩略图当作现行 IPC 的句子。
4. **IPC v2 WorkspaceEntry 边界**：`IPC_CONTRACT_VERSION = 2`。列表与变更为 `workspace_entry_list` / `create` / `rename` / `delete_preflight` / `delete` / `reveal`。授权键为 `workspaceId + relativePath`（及 `baseName`），不信任前端提交的 canonical path。新增 `INVALID_NAME`、`NAME_CONFLICT`、`ENTRY_PROTECTED`、`DIRECTORY_NOT_EMPTY`、`ENTRY_CHANGED`。`doc_close` 使用 `checkpointed | discardOrphan`。生产契约不再包含 `dir_list`、`file_create` / `file_rename` / `file_delete`、`thumb_lookup` / `thumb_store`。
5. **统一菜单与对话框**：全局至多一个菜单、一个对话框（`src/app/interaction/`）。命名、确认、阻断、失联关闭均走应用对话框，不使用 `window.prompt` / `window.confirm`。文件系统不变量仍只在 Rust `workspace_entries/` 裁决。

本决策不修改 ADR-002 的原子写流水线、草稿窗口或恢复快照，也不把 2026-08-14 参考性能测量的预算失败改写成产品回归。

## 后果/Consequences

**积极**：

- 标题栏留在操作系统控件内，避免 Overlay/Transparent 带来的拖动区、traffic lights 与主题污染验收。
- 画布保持首要工作面；固定侧边栏仍支持持续整理。
- 无消费者的缩略图 IPC/渲染从热路径消失；图纸图片资产协议保留。
- 条目变更、空性、Trash 与 rename 提交点只有一个权威层；前端按错误码分流，不解析 `message`。
- WKWebView 上失效的 `prompt`/`confirm` 不再出现在生产路径。

**消极**：

- 放弃「始终深黑标题栏」视觉目标；浅色系统外观下标题栏跟随系统。
- 历史 `file_meta` 行不会被本特性清理；降级/升级不额外做 drop-table。
- 废纸篓、Finder、真实指针设备与系统标题栏颜色只能由 macOS 原生证据证明，浏览器 Playwright 不能替代。

## 备选方案/Alternatives

- **Transparent 标题栏 + 自定义窗口背景**：可追求深黑外观，但改变 `Visible` 窗口模型并引入 AppKit 专用配置；否决。
- **Overlay / hybrid / frameless 标题栏**：最能自定义外观，但拖动区、命中测试、全屏与跨版本验收成本最高；否决。
- **app-wide Dark（`NSApplication.setAppearance`）**：会污染内容 `system` 主题；否决。
- **仅 CSS 隐藏缩略图、保留 `thumb_lookup`/`thumb_store`**：完整文档读取与 IPC 仍会运行；否决。
- **本轮 drop `file_meta` 并清理磁盘缓存**：无用户可见收益且增加升降级风险；否决。
- **继续使用 `window.prompt`/`confirm` 或 Tauri plugin-dialog 做命名**：macOS WKWebView 路径已证实 prompt 静默取消、confirm 静默接受；plugin-dialog 无文本输入且破坏统一焦点模型；否决。
- **保留 `dir_list`/`file_*` 并让前端拼接 canonical path**：把授权证据放在前端；否决。
