# IPC Contracts: Excalidraw Desktop（v5）

**Date**: 2026-10-10 | **架构**: [../architecture.md](../architecture.md)

本文件定义前端 ↔ Rust 后端的**当前**公开 IPC 边界（Tauri commands + events）。契约为强类型、显式、版本可感知。TypeScript 类型置于 `src/ipc/contracts.ts`，Rust 对应类型置于 `src-tauri/src/commands/dto.rs` 与 `src-tauri/src/commands/error.rs`，两侧字段名以本文件与 `contracts.ts` 为准（serde `camelCase`）。

v1 的 `dir_list` / `file_create` / `file_rename` / `file_delete` / `thumb_lookup` / `thumb_store` **已从产品契约中移除**，不得再写成活动命令。

## 0. 通用约定

### 版本与演进

- 契约版本常量 `IPC_CONTRACT_VERSION = 5`（TS/Rust），随 `app_handshake` 返回；不兼容变更须递增版本并在本文件记录迁移说明。
- 字段演进规则：新增可选字段 = 兼容；删除/改类型/改语义 = 不兼容。
- v1 → v2 不兼容变更：删除缩略图命令；用统一 Workspace Entry 命令替换 `dir_list` 与 `file_*`；`doc_close` 改为显式 `mode`（可丢弃失联文档而不再授权已缺失路径）。
- v3 当前公开 history command 为 `history_list`、`history_preview`、`history_mark`、`history_set_marked`、`history_replace`、`history_operation_status` 和 `history_delete`。v2 客户端不兼容此握手版本。
- v4 新增：`app_handshake` 响应字段 `preferredLanguages`（系统 UI 语言原始 BCP-47 标签）；命令 `native_menu_sync`（前端向 Rust 同步本地化菜单标签与菜单状态）；`native-menu-command` 事件新增语言、外观、画布偏好与帮助命令值。既有命令 `native_menu_set_enabled` 保留。详见 §1.1、§1.7 与 §2。
- v5 多窗口：`app_handshake` 按调用窗口返回 `window`（`WindowBootstrap`）；`workspace_list` 改为只返回调用窗口持有的 Workspace（0 或 1 项）；新增窗口归属、侧栏状态与偏好广播命令（§1.8）及窗口定向事件（§2）；新增错误码 `WORKSPACE_NOT_OWNED`。`workspace_add`、`workspace_remount` 保留为 deprecated，前端改用 `window_claim_workspace`。同一绘图至多由一个窗口打开：`doc_open` 响应改为带 `kind` 的联合（§1.4），写命令与 `doc_close` 检查调用窗口的归属；新增错误码 `DOCUMENT_NOT_OWNED`、`WINDOW_OWNERSHIP_CHANGED` 与嵌套 Workspace 的“关闭该窗口后在此打开”（§1.8）。

### 信任边界规则（所有命令统一执行）

1. 条目变更请求使用 `workspaceId + relativePath`（创建/重命名另加 `baseName`）。后端做词法穿越、符号链接 metadata、工作区包含性、根/保护项/名称/冲突检查。响应里的 `canonicalPath` 不得当作前端提交的授权证据。
2. 其余路径参数在后端 `canonicalize` 后校验工作区白名单（`security/`），越界返回 `PATH_ACCESS_DENIED`。
3. 一切 JSON 载荷做结构校验与尺寸上限（scene 默认 256MB），超限/非法返回 `INVALID_SCENE`。
4. 命令入口为薄层：反序列化 → 校验 → 调领域服务；不在命令层写业务规则。
5. 前端只按 `IpcError.code` 分流 UI，不解析 `message`。

### 统一错误形状

```typescript
interface IpcError {
  code: ErrorCode;
  message: string; // 人类可读（英文，UI 层负责本地化）
  retriable: boolean;
  context?: Record<string, string>;
}

type ErrorCode =
  | "PATH_ACCESS_DENIED"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_OVERLAP"
  | "INVALID_NAME"          // 空、畸形、保留名或超长
  | "NAME_CONFLICT"         // 同级已存在；不覆盖/合并
  | "ENTRY_PROTECTED"       // 工作区根、点号目录、托管目录、符号链接目标
  | "DIRECTORY_NOT_EMPTY"   // 真实目录含任意子项
  | "ENTRY_CHANGED"         // 协同预检后源路径/hash 已变
  | "FILE_NOT_FOUND"
  | "FILE_CORRUPTED"
  | "FILE_TOO_LARGE"
  | "INVALID_SCENE"
  | "CONFLICT_PENDING"
  | "DISK_FULL"
  | "IO_ERROR"
  | "DB_ERROR"
  | "HISTORY_UNAVAILABLE"
  | "HISTORY_RESOURCE_MISSING"
  | "HISTORY_STALE_DOCUMENT"
  | "HISTORY_OPERATION_PENDING"
  | "HISTORY_BUSY"
  | "WORKSPACE_NOT_OWNED"   // 调用窗口没有 Workspace（如 Welcome 窗口保存侧栏状态）
  | "DOCUMENT_NOT_OWNED"    // 绘图由另一个窗口打开；context.path 为该绘图
  | "WINDOW_OWNERSHIP_CHANGED" // 判定之后归属已变（retriable）
  | "INTERNAL";
```

Rust 侧以 `thiserror` 枚举实现并映射到该形状；`unwrap`/`expect` 禁止出现在命令可达路径。`ENTRY_CHANGED` 等可重试码的 `retriable` 由后端设置。

## 1. 命令契约（Tauri Commands）

### 1.1 会话与恢复

| 命令 | 请求 | 响应 | 说明 |
|------|------|------|------|
| `app_handshake` | `{}` | `AppHandshakeResponse` | `contractVersion` 为 5；按调用窗口返回；`abnormalExit=true` 时进入恢复；`pendingOpenPaths` 为本次启动文件关联/单实例转交路径；`preferredLanguages` 为系统 UI 语言列表 |
| `recovery_list` | `{}` | `RecoveryCandidate[]` | 列出可恢复草稿 |
| `recovery_apply` | `{ documentId; action; saveAsPath? }` | `{ scene?; newPath? }` | `action`: `restore` \| `keepDisk` \| `saveAsNew` \| `discard` |

```typescript
interface AppHandshakeResponse {
  contractVersion: number;
  appVersion: string;
  abnormalExit: boolean;        // 只有呈现 Recovery 的窗口为 true
  pendingOpenPaths: string[];   // 路由到本窗口的启动文件，每个窗口只交付一次
  preferredLanguages: string[]; // 原始 BCP-47 标签，用户顺序，最多 16 项
  window: WindowBootstrap;      // v5：调用窗口显示什么，由后端决定
}

interface WindowBootstrap {
  label: string;
  workspace: Workspace | null;            // null = Welcome
  unavailableWorkspace: Workspace | null; // 会话中的 Workspace 无法再打开
  restore: { tabs: string[]; activePath: string | null; skipped: number } | null;
  shell: WorkspaceShellState | null;      // 见 §1.8
  openWorkspaceNames: { workspaceId: string; name: string; rootPath: string }[];
}

interface RecoveryCandidate {
  documentId: string;
  originalPath: string | null;
  displayName: string;
  snapshotSavedAt: number;
  coldFileMtime: number | null;
  snapshotNewer: boolean;
}
```

`preferredLanguages` 在应用启动时由 Rust 读取一次（`src-tauri/src/locale.rs`）：macOS 取 `NSLocale.preferredLanguages`；其他平台取 `LC_ALL`，为空时取 `LANG`，转换为 BCP-47 后至多一项（`C`/`POSIX` 或畸形值不产出标签）。Rust 只转发原始标签，不决定 UI 语言；前端 `readSystemLanguages` 在首次渲染前读取，过滤非字符串项并截断到 16 项，握手失败或不在桌面壳内则为空列表。

UI 语言只由前端 `resolveLanguage` 决定：用户偏好为 `en` 或 `zh-CN` 时直接采用；偏好为 `system` 时按 `preferredLanguages` 顺序取第一个可识别标签——`en*` 解析为 English；`zh` 在无脚本且无地区、脚本为 `Hans`、或地区为 `CN`/`SG` 时解析为简体中文，其他 `zh` 标签（如 `zh-TW`、`zh-Hant`）与其他语言被跳过；无匹配时为 English。用户偏好 `system | en | zh-CN` 持久化在 WebView `localStorage` 键 `excalidraw-desktop.language`（版本化记录 `{ version: 1, preference }`），不经过 Rust。

### 1.2 工作区挂载

| 命令 | 请求 | 响应 | 说明 |
|------|------|------|------|
| `workspace_add` | `{ rootPath: string; name?: string }` | `Workspace` | 挂载并触发后台索引；匹配未挂载的 canonical root 时复用原记录 |
| `workspace_remove` | `{ workspaceId: string }` | `{}` | 取消挂载并保留 Recent；不删文件 |
| `workspace_list` | `{}` | `Workspace[]` | 只返回调用窗口持有的 Workspace（0 或 1 项）；侧栏只显示这一个 |
| `workspace_recent_list` | `{}` | `Workspace[]` | 返回全部保留记录；不探测 root 可访问性 |
| `workspace_remount` | `{ workspaceId: string }` | `Workspace` | 激活时重新校验 root/overlap 并挂载同一记录 |
| `workspace_recent_remove` | `{ workspaceId: string }` | `{}` | 仅删除未挂载记录的应用历史；不访问或修改磁盘 |

```typescript
interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
}
```

### 1.3 Workspace Entry（v2 列表与变更）

授权键是 `workspaceId + relativePath`，不是前端拼接的 canonical path。

```typescript
type WorkspaceEntryKind = "drawing" | "directory";

interface WorkspaceEntry {
  workspaceId: string;
  kind: WorkspaceEntryKind;
  canonicalPath: string;      // 响应用于打开/迁移；非授权输入
  relativePath: string;
  parentRelativePath: string; // 工作区根为空字符串
  name: string;               // 磁盘全名
  displayName: string;        // 图纸默认隐藏扩展名，同级可见名冲突时用全名
  mtime: number;
  fileSize: number;
}

interface ExpectedOpenDocument {
  relativePath: string;
  baseHash: string;
}

interface PathMigration {
  oldRelativePath: string;
  newRelativePath: string;
  oldCanonicalPath: string;
  newCanonicalPath: string;
}
```

| 命令 | 请求 | 响应 | 说明 |
|------|------|------|------|
| `workspace_entry_list` | `{ workspaceId; parentRelativePath }` | `WorkspaceEntry[]` | 懒加载一层；隐藏点号与托管目录；拒绝符号链接；保留普通空目录 |
| `workspace_entry_create` | `{ workspaceId; parentRelativePath; kind; baseName }` | `{ operationId; entry }` | `baseName` 为单个路径分量。Drawing 由 Rust 追加 `.excalidraw`；Directory 使用校验后的完整名。冲突不覆盖 |
| `workspace_entry_rename` | `{ workspaceId; relativePath; baseName; expectedOpenDocuments }` | `EntryRenameResult` | Drawing 保留已有受支持扩展名。文件系统 rename 是提交点。`pathMigrations` 覆盖请求中的打开文档；Rust 不接收 session id |
| `workspace_entry_delete_preflight` | `{ workspaceId; relativePath }` | `EntryDeletePreflightResult` | 选择对话框；**不授予**删除权。保护项返回 `ENTRY_PROTECTED`。空性来自真实 `read_dir` |
| `workspace_entry_delete` | `{ workspaceId; relativePath; expectedOpenDocument? }` | `{ operationId; kind; oldRelativePath }` | 持锁复检后移入操作系统废纸篓。无递归/永久删除。Trash 失败则条目仍在 |
| `workspace_entry_reveal` | `{ workspaceId; relativePath }` | `{}` | 仅揭示已存在且已授权的条目（macOS Finder / 受支持 Linux 文件管理器）。不是通用 shell/URL 能力 |

```typescript
type EntryDeletePreflightResult =
  | { status: "confirmable"; entry: WorkspaceEntry }
  | { status: "directoryNotEmpty"; entry: WorkspaceEntry };

interface EntryRenameResult {
  operationId: string;
  entry: WorkspaceEntry;
  oldRelativePath: string;
  newRelativePath: string;
  pathMigrations: PathMigration[];
}
```

`workspace_entry_rename` / `workspace_entry_delete` 在协同预检后若路径或 `baseHash` 已变，返回 `ENTRY_CHANGED`。非空目录删除返回 `DIRECTORY_NOT_EMPTY`（或 preflight 的 `directoryNotEmpty`）。非法 `baseName` 返回 `INVALID_NAME`；同级占用返回 `NAME_CONFLICT`。

### 1.4 文档编辑与持久化

| 命令 | 请求 | 响应 | 说明 |
|------|------|------|------|
| `doc_open` | `{ path: string }` | `DocOpenResponse` | 由调用窗口打开并登记归属；`hasNewerDraft=true` 时提示载入草稿或磁盘版。绘图已由别的窗口打开、或位于别的窗口的 Workspace 内时返回 `ownedElsewhere`，不读取文件，并激活那个窗口、向其发 `window-activate-document` |
| `doc_save_draft` | `{ path: string; sceneJson: string }` | `{ contentHash; savedAt }` | L2 热层写入；`CONFLICT_PENDING` 时拒绝 |
| `doc_checkpoint` | `{ path; sceneJson; reason }` | `{ newBaseHash; mtime }` | L3 原子写冷层 |
| `doc_close` | `{ path; mode }` | `{}` | `mode`: `checkpointed` \| `discardOrphan` |
| `doc_resolve_conflict` | `{ path; resolution; saveAsPath? }` | `{ scene?; newBaseHash }` | `takeExternal` \| `keepLocal` \| `saveAsNew` |
| `doc_export` | `{ path; sceneJson; format; targetPath; options; bytes }` | `{ writtenPath }` | 前端渲染 PNG/SVG 字节，后端走原子写落盘；失败不留残件 |

```typescript
type DocOpenResponse =
  | { kind: "opened"; scene: SceneData; baseHash: string; hasNewerDraft: boolean }
  | { kind: "ownedElsewhere"; label: string };
```

归属按规范化路径（符号链接、`..`、大小写不敏感卷上的大小写写法都视为同一绘图）登记。`doc_save_draft`、`doc_checkpoint`、`doc_resolve_conflict` 与 `history_replace`（`path` 定位）写别的窗口打开的绘图时返回 `DOCUMENT_NOT_OWNED`；没有窗口打开的绘图（新建）由本次写入登记，写入失败则撤销登记。`doc_close` 由非持有窗口调用时返回 `DOCUMENT_NOT_OWNED`，不删除草稿与恢复记录。`recovery_apply` 由恢复窗口调用时不检查归属，否则检查原路径与另存路径。`doc_resolve_conflict` 的 `saveAsNew` 改为登记新路径并释放原路径。

```typescript
type CheckpointReason =
  "manualSave" | "tabSwitch" | "tabClose" | "idle" | "appExit" | "maxWait";

type CloseMode = "checkpointed" | "discardOrphan";
```

- `checkpointed`：有效路径的 Open Document 关闭前先 checkpoint。
- `discardOrphan`：仅当该精确路径已不可用；只删除该路径的 draft/recovery/session 记录，不创建、删除或授权另一文件系统路径。
- 失联文档另存走既有安全 save-as，再按普通会话关闭。

```typescript
interface ExportOptions {
  scale?: 1 | 2 | 3;
  background?: "transparent" | "solid";
  theme?: "light" | "dark";
}
type SceneData = unknown; // 官方 .excalidraw JSON；后端只做结构校验
```

### 1.5 v3 版本历史类型

以下 DTO、validators、错误码和事件属于 v3 contract。所有六个 history command
均已注册并按当前文档授权执行。请求中的 locator 只能指向当前文档；前端不能提交
history store 或 object store 路径。

保留的 history error codes 为 `HISTORY_UNAVAILABLE`、`HISTORY_RESOURCE_MISSING`、
`HISTORY_STALE_DOCUMENT`、`HISTORY_OPERATION_PENDING` 和 `HISTORY_BUSY`；它们当前
会由已实现的 v3 history handler 返回。成功 cold checkpoint 后的普通历史失败还会
发出 `history-issue`；`history-changed` 暂未由后端发出。

历史请求只能携带当前文档授权 locator，不能携带 history store 路径。locator 是
`{ kind: "path"; path }` 或 `{ kind: "handle"; documentId }`；Rust 仍需重新解析
当前路径/工作区权限和持久身份。持久 `documentId`、前端 tab UUID 和 `versionId`
是不同标识，不能互相冒充。

所有 history 请求拒绝空字符串、NUL、超长 ID/path；scene JSON 上限为 256 MiB；
`history_list.limit` 默认 50、最大 100；cursor 是不透明字符串且最大 4096 bytes；
generation/revision 必须是非负整数；hash 必须是 64 位小写 SHA-256 hex。前端校验
只是早期错误反馈，Rust 必须重复校验并执行权限、版本归属和冲突检查。

| 命令 | 请求 | 响应 / 约束 |
|------|------|------|
| `history_list` | `{ document; cursor?; limit? }` | `documentId`、不含 scene bytes 的版本 metadata、`nextCursor?`、`listRevision`、`pendingIssue?` |
| `history_preview` | `{ document; versionId }` | 后端严格 hydration 后返回 `{ versionId; scene }`；不写 current file 或 draft |
| `history_mark` | `{ document; requestId; sessionGeneration; revision; currentSceneJson }` | 同文档已有完整场景及图片映射相同的 marked 版本时复用它，否则持久发布新 manual 记录；返回 `{ versionId; recordedAt; source: "automatic" \| "manual" \| "protected"; contentHash; reused }`，复用时保留原版本身份、来源与时间。manual mark 不进入非手动最新 20 条池 |
| `history_set_marked` | `{ document; requestId; versionId; marked }` | 幂等设置既有版本的 manual mark 状态；返回 `{ versionId; marked; retained }`。`retained=false` 表示 Unmark 后目标已按普通保留规则清理，前端不得继续指向它。`HistoryVersionItem.marked` 是列表中的权威状态；缺失版本返回 `HISTORY_RESOURCE_MISSING`，同一 requestId 冲突返回 `HISTORY_STALE_DOCUMENT`，保护操作占用时返回 `HISTORY_BUSY`，store 故障返回 `HISTORY_UNAVAILABLE` |
| `history_replace` | `{ document; requestId; sessionGeneration; revision; expectedBaseHash; currentSceneJson; target }` | `target` 为 `restore(versionId)`、`clear` 或 `import(candidateSceneJson)`；返回 `completed` 或 `pendingReconciliation` |
| `history_operation_status` | `{ document; requestId }` | 只查询既有操作；返回 state、`replacementCommitted: boolean \| null` 和完成时的 adoption payload |
| `history_delete` | `{ document; requestId; versionId }` | 在文档 history-operation lease 下删除一条语义版本；返回 `{ deletedVersionId }`；同一 `requestId` 重试幂等，活动操作引用的版本返回 `HISTORY_BUSY` |

`history_delete` 只改变 history metadata 和其之后的 best-effort object GC，不改变当前画布、冷文件、draft 或文档身份。版本不存在返回 `HISTORY_RESOURCE_MISSING`；同一 `requestId` 绑定到不同文档或版本返回 `HISTORY_STALE_DOCUMENT`；操作仍未到达终态返回 `HISTORY_OPERATION_PENDING`。共享对象和仍由 operation/hydration pin 引用的对象必须保留。

`history_replace` 完成响应包含 `protectionVersionId`、`adoptedScene`、`newBaseHash` 和
`newSessionGeneration`。不确定的发布结果必须为 `pendingReconciliation`，其中
`replacementCommitted` 为 `null`，不能用 after-rename 错误推断文件未改变。未来命令
实现必须幂等：传入同一个 requestId 只查询/返回原操作，不重新执行破坏性替换；同 requestId 携带不同 target 或 generation/revision/base identity 必须拒绝。
completed replacement 的 target scene/assets 在 history store 中保留为 GC root 24 小时，
用于延迟的 `history_operation_status` replay；TTL 到期后才允许在 GC 中释放该 root。
前端草稿与 checkpoint scheduler 必须把捕获时的 `sessionGeneration` 和 `revision` 与
scene 一起排队；replacement adoption 推进 generation/revision 后，旧 callback 必须在
调用 `doc_save_draft`／`doc_checkpoint` 前被拒绝，不能留下 stale dirty draft。

重启时若 `after_rename_before_parent_sync` 已完成文件 rename，但操作记录尚未写入
published file identity/hash，仅当当前文件 bytes 与 durable target scene 完全一致、scene/assets
对象及 operation pins 通过严格校验、且 canonical path 仍由 mounted workspace 授权时，才允许
将操作核实为 `completed`；否则保持 `pendingReconciliation` 或转为 conflict。此窄窗口没有
更强的 provenance 时，同 bytes 的外部重写只能按 content-equivalent 处理；不同 bytes 或已有
durable identity 不一致必须拒绝。main SQLite 与 history metadata 写入前后都必须重新确认同一
file identity 与 content hash，late external write 不得与旧 metadata 一起进入 `completed`。

`HistoryVersionItem.availability` 为 `available` 或带结构化 `IpcError` 的
`unavailable`；单个损坏版本不能伪装成空列表，也不能阻止其他有效版本显示。历史
对象内容由后端 hydrate，不能通过扩大 Tauri fs capability 让前端读取 app-data。

### 1.5.1 History 共同事务故障与重启判定

`history_replace` 的故障证据必须来自 native test-only process journey，而不是
browser mock。`e2e-harness` 仅在 `APP_E2E=1` 的 `--features e2e-harness` 构建中
注册；测试进程在屏障 ready marker 后才允许 `SIGKILL`，随后必须以同一隔离根启动
新的 process 查询状态。超时、进程仍存活、未知字节、临时文件残留或未绑定的目标
对象均为失败，不能解释为成功。

当前共同事务屏障及其状态含义为：

| 屏障 | 状态判定 |
|------|----------|
| `object_publish`、`protection_commit`、`intent_commit` | rename 尚未发生；完整旧文件必须保持权威，保护/意图失败须独立可见 |
| `after_rename_before_parent_sync` | 文件可能已经是完整新文件；只能返回 `pendingReconciliation` 或经重启核实的 `completed`，不得返回“未改变” |
| `metadata_complete_before_frontend_ack` | response 丢失时按原 `requestId` 查询，不能重放替换；新文件、目标 scene 和 assets 必须可读 |
| `eviction_delete_gc` | 统一保留池淘汰与 GC 不能删除 operation/request pins 仍引用的 scene/assets |
| `rename_delete_repair` | 重启修复只允许按实际文件身份和字节判定，不得用旧排队 autosave 覆盖外部结果 |

共同事务 native matrix 对缺失／损坏 scene 与图片、对象层 typed `ENOSPC`／`EACCES`、
SQLite commit 前 typed fault、部分发布 orphan、同一／不同 request 并发、旧 generation
autosave、外部写入和真实 retention-eviction／GC 强退记录隔离根、seed、二进制 digest、
旧／新 hash、asset hash、操作状态和清理结果。上述测试证据不改变 production IPC 的路径授权和状态机；如果
pre-rename 核对与目标发布之间发生外部写入，结果必须是 `HISTORY_STALE_DOCUMENT`
或独立 conflict，绝不能覆盖外部字节。

### 1.6 原生视觉验收边界

原生视觉 capture 不属于 production IPC contract。`native:screen:prepare` 生成 schema v2 的 immutable plan 和安全 fixture；`native:screen:capture` 在 collector 侧验证 isolation、owned PID/window、1280×760 bounds、backing scale、一次性 terminal confirmation、单次 capture、normalization 与 artifact digests。它不得通过 React、Rust command、隐藏 state channel 或 production diagnostic projection 读取或写入 app-owned UI state。

React/WebView 的 session、theme、Sidebar、workspace、selection、expanded rows、fonts、tokens、geometry 与 interaction facts 由 semantic browser evidence 证明；native collector 只记录 package/isolation/window/capture integrity。`CAPTURE <gate-id> <challenge>` 只控制 capture 时机，不构成交互或 UI 状态证据。详见 `contracts/native-screen-capture-contract.md` 与 `docs/quickstart.md`。

### 1.7 v4 原生菜单同步

原生菜单的标签文本由前端本地化后提供，Rust 只持有最近一次有效的标签与状态快照（`NativeMenuStore`）。应用启动时 Rust 先安装内置英文菜单（`install_menu`），前端首次同步后再替换。

| 命令 | 请求 | 响应 | 说明 |
|------|------|------|------|
| `native_menu_sync` | `NativeMenuSyncRequest` | `{}` | 同步本地化标签与菜单 checked/enabled 状态 |
| `native_menu_set_enabled` | `{ command: NativeMenuCommand; enabled: boolean }` | `{}` | 保留。仅 `command = "versionHistory"` 被接受，其他值被拒绝（该命令在 Rust 侧返回 `tauri::Result`，错误不走 `IpcError` 形状）；用于 Version History 项的可用状态，该状态在后续 `native_menu_sync` 重建/更新菜单时被保留 |

```typescript
interface NativeMenuSyncRequest {
  labels: Record<NativeMenuLabelId, string>; // 完整集合，含 predefined 项文本
  state: NativeMenuSyncState;
}

interface NativeMenuSyncState {
  language: "system" | "en" | "zh-CN";
  appearance: "system" | "light" | "dark";
  hasDocument: boolean;
  forcedReadOnly: boolean;
  toolLock: boolean;
  grid: boolean;
  snap: boolean;
  zen: boolean;
  viewMode: boolean; // 用户 View mode，不含强制只读
}
```

`NativeMenuLabelId` 共 37 个，类型见 `src/ipc/contracts.ts`，Rust 侧权威列表为 `native_menu_spec.rs` 的 `LABEL_IDS`。每个 ID `x` 对应前端语言资源键 `menu.native.x`，仅 `app.languageEn`、`app.languageZhCn` 取自 `language.autonym.*`。

**Rust 信任边界校验**

- `labels` 必须恰好包含全部必需 ID：缺失或未知 ID 都被拒绝；每个值去除空白后非空、不超过 64 个字符、不含控制字符。
- `state` 的字段集合固定（`deny_unknown_fields`），`language`、`appearance` 只接受上表枚举值。
- 校验失败返回 `INTERNAL`；菜单保持上一次有效状态。菜单重建/更新失败时，Rust 回滚模型到同步前的标签与状态并返回 `INTERNAL`。
- 标签相对上次有变化 → 重建整个菜单；仅 `state` 变化 → 原地更新各项 `checked`/`enabled`。

**前端发送规则**（`src/app/nativeMenuSync.ts`、`src/app/AppShell.tsx`）

- 仅在桌面壳内发送；每次发送的是完整快照（标签 + 状态）。
- 与上一次**成功**发送序列化后完全相同的请求被跳过，因此普通画布编辑不会触达菜单；发送失败时清除去重记录，下一次相同快照会重试。
- 触发输入包括解析后的语言、语言偏好、外观偏好、活动文档是否存在、强制只读（冲突或 history 操作占用）以及活动文档的 toolLock/grid/snap/zen/viewMode。

**菜单项状态规则**（`item_state`，`hasDocument` 记为 D，`forcedReadOnly` 记为 R）

| 菜单项 | 可用 | 选中 |
|--------|------|------|
| Save、Help | D | — |
| Export Image | 始终 | — |
| Version History | 由 `native_menu_set_enabled` 设置（前端在存在带路径的活动文档时启用） | — |
| Language ×3、Appearance ×3 | 始终 | 等于 `state.language` / `state.appearance` |
| Grid、Zen | D | `grid` / `zen` |
| Tool Lock、Snap | D 且非 R | `toolLock` / `snap` |
| View Mode | D 且非 R | `forcedReadOnly \|\| viewMode` |

点击 check 项时系统会自行翻转选中态；Rust 先把已同步的状态重新应用到菜单，再发出 `native-menu-command`，由前端决定新状态并通过下一次 `native_menu_sync` 回写。

#### 1.7.1 按键归属

每个按键只有一个 owner。原生菜单只为 New Window、Open Workspace、Save 和 Export Image 注册 accelerator（`native_menu_spec.rs` 的 `registers_only_the_owned_file_accelerators` 测试断言集合恰为这四项，并断言不含 Cmd/Ctrl+O）。

| 按键 | Owner | 说明 |
|------|-------|------|
| Cmd/Ctrl+S | 原生菜单 Save | 桌面壳内前端不再监听该 keydown，避免一次按键保存两次；无原生窗口运行时（浏览器测试环境）由 window keydown 处理 |
| Cmd/Ctrl+Alt+E | 原生菜单 Export Image | 不与 SDK 的 Cmd/Ctrl+Shift+E 重合 |
| Cmd/Ctrl+Shift+N | 原生菜单 New Window | Rust 直接创建 Welcome 窗口，不经前端；SDK 没有 N 快捷键，工具快捷键不带 Cmd/Ctrl |
| Cmd/Ctrl+Shift+O | 原生菜单 Open Workspace… | 发往前台窗口；不用 Cmd/Ctrl+O，因为它属于 Version History 受保护输入的导入快捷键 |
| Q、Cmd+'、Alt+S、Alt+Z、? | Excalidraw SDK | 原生菜单对应的 Tool Lock、Grid、Snap、Zen、Help 项不注册 accelerator |
| Shift+Alt+D | Excalidraw SDK | 切换主题；编辑器宿主把 SDK 发起的主题变化写回应用外观偏好，原生 Appearance 子菜单不注册 accelerator |
| Alt+R | 编辑器宿主（`ExcalidrawEditor`） | 切换用户 View mode；SDK 自身的该快捷键因 `viewModeEnabled` 为受控 prop 而关闭；View Mode 菜单项不注册 accelerator |
| Edit 菜单（Undo/Redo/Cut/Copy/Paste/Select All） | 系统预定义菜单项 | 使用系统 predefined item，不由本契约自定义 accelerator |

### 1.8 v5 窗口与 Workspace 归属

每个 Workspace 至多被一个窗口持有，归属只由后端 `WindowRegistry` 决定；调用窗口由 Tauri 注入，前端不传 label。

| 命令 | 请求 | 响应 | 说明 |
|------|------|------|------|
| `window_new` | `{}` | `{ label }` | 新建 Welcome 窗口；原生菜单 New Window 在 Rust 内直接调用 |
| `window_probe_workspace` | `{ rootPath } \| { workspaceId }` | `ClaimWorkspaceOutcome` | 只读判定；`claimed` 表示可在本窗口打开，此时 `workspace`、`shell` 为 `null`。替换前先判定，再关闭 Tab |
| `window_claim_workspace` | `{ rootPath } \| { workspaceId }` | `ClaimWorkspaceOutcome` | 在本窗口打开（替换原 Workspace）；同一 Workspace 或其子目录已在别的窗口时激活那个窗口，本窗口不变 |
| `window_release_workspace` | `{}` | `{}` | 释放本窗口的 Workspace；前端须先关闭全部 Tab |
| `window_close_other_and_claim` | `{ targetLabel; rootPath }` | `{ status: "closing"; requestId }` | 嵌套冲突的“关闭该窗口后在此打开”：前端先关闭本窗口全部 Tab；后端确认 `targetLabel` 仍是 `rootPath` 内 Workspace 的持有者（否则 `WINDOW_OWNERSHIP_CHANGED`），向它发 `window-close-requested-by-peer`；它销毁后在本窗口认领 `rootPath`，结果经 `window-claim-result` 返回 |
| `window_peer_close_failed` | `{ requestId }` | `{}` | 被要求关闭的窗口关闭失败或取消；后端向发起窗口发 `window-claim-result` 的 `cancelled`。只有被要求的窗口能应答该请求 |
| `workspace_shell_state_save` | `{ sidebarPinned; sidebarWidth; expanded }` | `{}` | 保存本窗口 Workspace 的侧栏状态；窗口没有 Workspace 时返回 `WORKSPACE_NOT_OWNED` |
| `shell_preferences_migrate` | `{ sidebarPinned; sidebarWidth }` | `{ migrated }` | 一次性导入旧 localStorage 键 `excalidraw-desktop.shell` 的固定与宽度；只有第一次调用返回 `true`。旧键只读不删 |
| `app_preferences_broadcast` | `{ appearance?; language? }` | `{}` | 通知其他窗口应用级偏好已改变（见 §2 `app-preferences-changed`） |

```typescript
type ClaimWorkspaceOutcome =
  | { kind: "claimed"; workspace: Workspace; replaced: string | null; shell: WorkspaceShellState | null }
  | { kind: "ownedBy"; label: string; workspaceId: string }                         // 已激活该窗口
  | { kind: "insideOpen"; label: string; workspaceId: string; relativePath: string } // 已激活该窗口
  | { kind: "containsOpen"; label: string; workspaceId: string };                  // 目标包含别的窗口的 Workspace

interface WorkspaceShellState {
  sidebarPinned: boolean;
  sidebarWidth: number;   // 280–480，钳制规则在前端
  expanded: string[];     // 展开的目录相对路径；"" 为 Workspace 根行
}
```

`claimed.shell` 与握手 `window.shell` 取值相同：该 Workspace 自己的记录；没有时取最近一次保存的固定与宽度；再没有时取一次性导入的旧值；后两种情况 `expanded` 为 `[""]`；都没有时为 `null`（前端用默认值：不固定、宽度 360、根行展开）。

## 2. 事件契约（后端 → 前端）

| 事件 | 载荷 | 触发 |
|------|------|------|
| `workspace-entries-changed` | `WorkspaceEntriesChangedEvent` | 条目创建/重命名/删除，或无法可靠配对的外部目录批处理 |
| `file-changed` | `{ path; change; newPath?; mtime?; contentHash? }` | notify 去抖后且已排除自身写入回声；`change`: `modified` \| `created` \| `removed` \| `renamed` |
| `index-progress` | `{ workspaceId; scanned; total; done }` | 后台索引进度 |
| `draft-saved` | `{ path; savedAt }` | 热层写入成功 |
| `conflict-detected` | `{ path; externalMtime; localDraftUpdatedAt }` | 变更命中 isDirty 文档 |
| `open-file-request` | `{ paths: string[] }` | 单实例二次启动、启动参数与 Finder 打开（macOS `RunEvent::Opened`）的绘图，按路由发给一个窗口：已打开该绘图的窗口（改发 `window-activate-document`）→ Workspace 包含它的窗口 → 最近聚焦的窗口 → 新窗口。尚未读取启动数据的窗口改由握手 `pendingOpenPaths` 接收 |
| `window-activate-document` | `{ path }` | 绘图已在本窗口打开，另一处请求打开它：切换到该 Tab（本窗口没有该 Tab 时打开它） |
| `workspace-reveal-entry` | `{ relativePath; name }` | 别的窗口打开了本窗口 Workspace 内的文件夹：打开侧栏，展开到该文件夹并选中，显示定位提示 |
| `window-close-requested-by-peer` | `{ requestId }` | 别的窗口要在此打开包含本窗口 Workspace 的文件夹：走正常关闭（先 checkpoint）；失败时调用 `window_peer_close_failed` |
| `window-claim-result` | `{ requestId; outcome: ClaimWorkspaceOutcome \| { kind: "cancelled" } }` | `window_close_other_and_claim` 的结果，只发给发起窗口 |
| `native-menu-command` | `{ command: NativeMenuCommand; validationId? }` | 用户激活原生菜单项（仅 Rust 拥有的项）；发给前台窗口，没有前台窗口时发给最近聚焦的窗口 |
| `app-preferences-changed` | `{ appearance?; language? }` | 某窗口改变外观或语言后，发给除该窗口外的所有窗口；接收端只应用，不写回存储、不再广播 |
| `open-workspaces-changed` | `{ workspaces: { workspaceId; name; rootPath }[] }` | 任一窗口认领或释放 Workspace、窗口销毁后发给所有窗口；用于窗口标题同名区分 |

v5 起 `workspace-entries-changed`、`index-progress` 只发给持有该 Workspace 的窗口（无持有者则不发）；`file-changed`、`conflict-detected`、`draft-saved`、`history-issue` 只发给持有该文档的窗口（由 `doc_open` 或首次写入登记；无持有者则不发）；前端仍按 path 过滤。前端监听必须以当前窗口为目标（`{ target: { kind: "WebviewWindow", label } }`），否则目标为 `Any` 的监听会收到发给其他窗口的事件。

```typescript
interface WorkspaceEntriesChangedEvent {
  workspaceId: string;
  operationId?: string;
  change: "created" | "renamed" | "removed" | "invalidated";
  relativePath: string;
  newRelativePath?: string;
}
```

应用发起的变更加命令响应为权威；匹配 `operationId` 的事件是 watcher 回声，必须幂等。无法自信配对的外部目录批处理对最近已知父目录发 `invalidated`，不虚构精确 rename。

事件只通知状态事实，不携带业务决策。

```typescript
type NativeMenuCommand =
  | "save" | "exportImage" | "versionHistory"
  | "appearanceSystem" | "appearanceLight" | "appearanceDark"
  | "languageSystem" | "languageEn" | "languageZhCn"
  | "help"
  | "toggleToolLock" | "toggleGrid" | "toggleSnap" | "toggleZen" | "toggleViewMode";
```

v4 之前的值为 `save`、`exportImage`、`versionHistory`、`appearanceSystem`、`appearanceLight`、`appearanceDark`；v4 新增 `languageSystem`、`languageEn`、`languageZhCn`、`help` 与五个 `toggle*`。前端处理：语言/外观命令写入各自的偏好控制器；`toggle*` 命令作用于活动编辑器；`help` 打开活动编辑器的帮助。`validationId` 仅在原生 macOS 验收 harness 启动的包中出现，用于关联原生事件与前端路由，不是产品 IPC 命令；生产路径不依赖它。事件只表达“用户激活了哪个菜单项”，状态变更由前端裁决后经 `native_menu_sync` 回写。

### 2.1 v3 版本历史事件结构

`history-issue` 已用于普通历史失败且与当前文件保存结果分离；`history-changed` 类型已冻结，但当前后端尚未发送。

```typescript
interface HistoryChangedEvent {
  documentId: string;
  requestId?: string;
  listRevision: number;
  change: "automatic" | "manual" | "protected" | "deleted" | "reconciled" | "invalidated";
}

interface HistoryIssueEvent {
  documentId: string;
  operation?: "mark" | "replace" | "delete" | "reconcile";
  source: "automatic" | "manual" | "protected" | "reconciliation";
  error: IpcError;
  currentFileSaveOutcome?: "notAttempted" | "succeeded" | "failed" | "pending";
}
```

事件只通知后端确认的状态事实，不携带 scene/image bytes 或 history-store path。前端
可合并 `history-changed` 的列表刷新，但不得丢弃 `history-issue`；晚到事件必须按
documentId 和当前 tab/session generation 丢弃，不能把结果应用到另一个 tab。

## 3. 已退休、不得再文档化为活动产品 IPC

以下名称**不是** v2 产品命令。测试可断言它们未被生产 handler 注册，但公开契约不得把它们写成可调用 API：

- `dir_list`（及 v1 `DirEntry` 列表模型）
- `file_create` / `file_rename` / `file_delete`
- `thumb_lookup` / `thumb_store`

asset protocol 与 `.excalidraw_assets` 仍用于图纸内嵌图片，与缩略图缓存无关。历史 v1 `file_meta` 表惰性保留，不是契约 v2 的一部分。

## 4. 契约测试要求

- 每条命令必须有 Rust 集成测试覆盖：合法请求、越界路径、非法 JSON、超限载荷；条目命令另覆盖名称/冲突/保护项/非空目录/Trash/`ENTRY_CHANGED`。
- TS 侧以 Vitest 对 `contracts.ts` 做类型级与序列化往返测试。
- 契约变更必须同步更新本文件；CI 校验 `IPC_CONTRACT_VERSION` 与握手返回值一致。
- 生产与 e2e 生产路径不得注册缩略图命令；bundle 不得包含缩略图 worker chunk。
- v4 握手：`src-tauri/src/commands/dto.rs` 的序列化测试断言 `contractVersion` 为 4 且 `preferredLanguages` 以 camelCase 往返；`src-tauri/src/locale.rs` 测试 POSIX locale → BCP-47 转换与 16 项上限；前端 `src/i18n/systemLanguages.test.ts`、`resolveLanguage.test.ts`、`localeController.test.ts` 覆盖语言列表读取、解析规则与偏好持久化。
- v4 原生菜单：`src-tauri/src/native_menu_spec.rs` 测试覆盖菜单项 ID 集合、check 项、仅 Save/Export Image 注册 accelerator、标签集合校验（缺失/未知/空/过长/控制字符）、`NativeMenuSyncState` 反序列化与各文档状态下的 enabled/checked；`src-tauri/src/native_menu.rs` 测试覆盖前端 `native_menu_sync` / `native_menu_set_enabled` 调用名与已注册 Tauri 命令一致、事件载荷序列化与 Export Image accelerator 不占用 SDK 键；前端 `src/app/nativeMenuSync.test.ts` 覆盖完整标签集本地化、相同快照不重发、语言变化重发、失败后重试，`src/app/nativeMenu.test.ts` 覆盖命令路由。
