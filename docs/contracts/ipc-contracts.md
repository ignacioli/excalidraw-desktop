# IPC Contracts: Excalidraw Desktop（v3）

**Date**: 2026-09-22 | **架构**: [../architecture.md](../architecture.md)

本文件定义前端 ↔ Rust 后端的**当前**公开 IPC 边界（Tauri commands + events）。契约为强类型、显式、版本可感知。TypeScript 类型置于 `src/ipc/contracts.ts`，Rust 对应类型置于 `src-tauri/src/commands/dto.rs` 与 `src-tauri/src/commands/error.rs`，两侧字段名以本文件与 `contracts.ts` 为准（serde `camelCase`）。

v1 的 `dir_list` / `file_create` / `file_rename` / `file_delete` / `thumb_lookup` / `thumb_store` **已从产品契约中移除**，不得再写成活动命令。

## 0. 通用约定

### 版本与演进

- 契约版本常量 `IPC_CONTRACT_VERSION = 3`（TS/Rust），随 `app_handshake` 返回；不兼容变更须递增版本并在本文件记录迁移说明。
- 字段演进规则：新增可选字段 = 兼容；删除/改类型/改语义 = 不兼容。
- v1 → v2 不兼容变更：删除缩略图命令；用统一 Workspace Entry 命令替换 `dir_list` 与 `file_*`；`doc_close` 改为显式 `mode`（可丢弃失联文档而不再授权已缺失路径）。
- v3 首批公开 history command 为 `history_list`、`history_preview`、`history_replace` 和 `history_operation_status`；`history_mark` 与 `history_delete` 仍是 reserved，未注册且不可调用。v2 客户端不兼容此握手版本。

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
  | "INTERNAL";
```

Rust 侧以 `thiserror` 枚举实现并映射到该形状；`unwrap`/`expect` 禁止出现在命令可达路径。`ENTRY_CHANGED` 等可重试码的 `retriable` 由后端设置。

## 1. 命令契约（Tauri Commands）

### 1.1 会话与恢复

| 命令 | 请求 | 响应 | 说明 |
|------|------|------|------|
| `app_handshake` | `{}` | `AppHandshakeResponse` | `contractVersion` 为 2；`abnormalExit=true` 时进入恢复；`pendingOpenPaths` 为本次启动文件关联/单实例转交路径 |
| `recovery_list` | `{}` | `RecoveryCandidate[]` | 列出可恢复草稿 |
| `recovery_apply` | `{ documentId; action; saveAsPath? }` | `{ scene?; newPath? }` | `action`: `restore` \| `keepDisk` \| `saveAsNew` \| `discard` |

```typescript
interface AppHandshakeResponse {
  contractVersion: number;
  appVersion: string;
  abnormalExit: boolean;
  pendingOpenPaths: string[];
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

### 1.2 工作区挂载

| 命令 | 请求 | 响应 | 说明 |
|------|------|------|------|
| `workspace_add` | `{ rootPath: string; name?: string }` | `Workspace` | 挂载并触发后台索引；匹配未挂载的 canonical root 时复用原记录 |
| `workspace_remove` | `{ workspaceId: string }` | `{}` | 取消挂载并保留 Recent；不删文件 |
| `workspace_list` | `{}` | `Workspace[]` | 仅返回已挂载的授权记录 |
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
| `doc_open` | `{ path: string }` | `{ scene; baseHash; hasNewerDraft }` | `hasNewerDraft=true` 时提示载入草稿或磁盘版 |
| `doc_save_draft` | `{ path: string; sceneJson: string }` | `{ contentHash; savedAt }` | L2 热层写入；`CONFLICT_PENDING` 时拒绝 |
| `doc_checkpoint` | `{ path; sceneJson; reason }` | `{ newBaseHash; mtime }` | L3 原子写冷层 |
| `doc_close` | `{ path; mode }` | `{}` | `mode`: `checkpointed` \| `discardOrphan` |
| `doc_resolve_conflict` | `{ path; resolution; saveAsPath? }` | `{ scene?; newBaseHash }` | `takeExternal` \| `keepLocal` \| `saveAsNew` |
| `doc_export` | `{ path; sceneJson; format; targetPath; options; bytes }` | `{ writtenPath }` | 前端渲染 PNG/SVG 字节，后端走原子写落盘；失败不留残件 |

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

### 1.5 v3 版本历史类型（部分可用）

以下 DTO、validators、错误码和事件属于 v3 contract。`history_list` 与
`history_preview`、`history_replace` 与 `history_operation_status` 已注册并按当前
文档授权执行；`history_mark` 与 `history_delete` 仍是 reserved，调用会得到
Tauri 的未知 command 错误。

保留的 history error codes 为 `HISTORY_UNAVAILABLE`、`HISTORY_RESOURCE_MISSING`、
`HISTORY_STALE_DOCUMENT`、`HISTORY_OPERATION_PENDING` 和 `HISTORY_BUSY`；它们当前
会由已实现的 v3 history handler 返回；事件仍只保留为后续 mutation service 的
reserved 结构。

未来历史请求只能携带当前文档授权 locator，不能携带 history store 路径。locator 是
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
| `history_mark` | reserved（当前未注册） | 调用会得到 Tauri 的未知 command 错误 |
| `history_replace` | `{ document; requestId; sessionGeneration; revision; expectedBaseHash; currentSceneJson; target }` | `target` 为 `restore(versionId)`、`clear` 或 `import(candidateSceneJson)`；返回 `completed` 或 `pendingReconciliation` |
| `history_operation_status` | `{ document; requestId }` | 只查询既有操作；返回 state、`replacementCommitted: boolean \| null` 和完成时的 adoption payload |
| `history_delete` | reserved（当前未注册） | 调用会得到 Tauri 的未知 command 错误 |

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

## 2. 事件契约（后端 → 前端）

| 事件 | 载荷 | 触发 |
|------|------|------|
| `workspace-entries-changed` | `WorkspaceEntriesChangedEvent` | 条目创建/重命名/删除，或无法可靠配对的外部目录批处理 |
| `file-changed` | `{ path; change; newPath?; mtime?; contentHash? }` | notify 去抖后且已排除自身写入回声；`change`: `modified` \| `created` \| `removed` \| `renamed` |
| `index-progress` | `{ workspaceId; scanned; total; done }` | 后台索引进度 |
| `draft-saved` | `{ path; savedAt }` | 热层写入成功 |
| `conflict-detected` | `{ path; externalMtime; localDraftUpdatedAt }` | 变更命中 isDirty 文档 |
| `open-file-request` | `{ paths: string[] }` | 单实例二次启动/系统文件关联转发 |

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

### 2.1 Reserved v3 版本历史事件结构（尚未注册）

以下事件属于 reserved v3 contract；当前后端不会发送它们。

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
