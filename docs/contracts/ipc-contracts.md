# IPC Contracts: Excalidraw Desktop（v2）

**Date**: 2026-08-23 | **架构**: [../architecture.md](../architecture.md)

本文件定义前端 ↔ Rust 后端的**当前**公开 IPC 边界（Tauri commands + events）。契约为强类型、显式、版本可感知。TypeScript 类型置于 `src/ipc/contracts.ts`，Rust 对应类型置于 `src-tauri/src/commands/dto.rs` 与 `src-tauri/src/commands/error.rs`，两侧字段名以本文件与 `contracts.ts` 为准（serde `camelCase`）。

v1 的 `dir_list` / `file_create` / `file_rename` / `file_delete` / `thumb_lookup` / `thumb_store` **已从产品契约中移除**，不得再写成活动命令。

## 0. 通用约定

### 版本与演进

- 契约版本常量 `IPC_CONTRACT_VERSION = 2`（TS）/ `IPC_CONTRACT_VERSION`（Rust），随 `app_handshake` 返回；不兼容变更须递增版本并在本文件记录迁移说明。
- 字段演进规则：新增可选字段 = 兼容；删除/改类型/改语义 = 不兼容。
- v1 → v2 不兼容变更：删除缩略图命令；用统一 Workspace Entry 命令替换 `dir_list` 与 `file_*`；`doc_close` 改为显式 `mode`（可丢弃失联文档而不再授权已缺失路径）。

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
| `workspace_add` | `{ rootPath: string; name?: string }` | `Workspace` | 挂载并触发后台索引 |
| `workspace_remove` | `{ workspaceId: string }` | `{}` | 仅取消挂载，不删文件 |
| `workspace_list` | `{}` | `Workspace[]` | |

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

### 1.5 原生视觉验收的 observation-only ready probe

以下两个 command 编译进普通 production binary，但默认完全 inert。只有受控 launcher 同时提供 `EXCALIDRAW_NATIVE_CAPTURE_PLAN`、`EXCALIDRAW_NATIVE_CAPTURE_GATE` 与 `EXCALIDRAW_NATIVE_CAPTURE_NONCE`，且 Rust 能验证 plan、nonce、disposable profile（一次性配置目录）和实际 app-data/WebKit 路径时，bootstrap 才返回非空值。

| 命令 | 请求 | 响应 | 说明 |
|------|------|------|------|
| `native_capture_bootstrap` | `{}` | `NativeCaptureBootstrap \| null` | 未启用时返回 `null`；启用时只返回 immutable binding（不可变绑定），不设置 UI 状态 |
| `native_capture_publish_ready` | `{ ready: NativeCaptureReadyInput }` | `{}` | 仅接受 nonce、commit、package、state fingerprint、字体、pending operation、稳定帧与 1280×760 window observation 全部匹配的报告 |

```typescript
interface NativeCaptureBootstrap {
  schemaVersion: 1;
  runId: string;
  runNonce: string;
  gateId: string;
  productCommit: string;
  packageArtifactSha256: string;
  fixtureDigest: string;
  expectedStateFingerprint: string;
  stateFingerprintVersion: "shell-state-v1";
}

interface NativeCaptureReadyInput {
  schemaVersion: 1;
  runId: string;
  runNonce: string;
  gateId: string;
  productCommit: string;
  packageArtifactSha256: string;
  stateFingerprint: string;
  stateFingerprintVersion: "shell-state-v1";
  fontReady: true;
  remoteFontRequests: 0;
  stableFrames: number;       // >= 2
  pendingOperations: 0;
  logicalWindow: { width: 1280; height: 760 };
  frontmost: true;
}
```

Frontend 只能提交 observation，不能提交 fixture path、任意 filesystem path、theme/sidebar setter 或 privileged command。Rust 从 launcher-owned plan 获取 expected binding，重新验证实际 storage path 位于当前 gate 的 disposable profile 后，以 atomic create + rename 写 `<gate>.ready-candidate.json`。该 candidate 仍不包含 native window ID（identifier）或 backing scale；capture driver 必须通过 owned PID（process identifier，进程标识）确定这些原生事实并生成最终 `ready.json`。缺失、重复、stale、path escape 或不匹配均为 `BLOCKED`，不得由截图猜测。

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
