# IPC Contracts: 跨平台 Excalidraw Desktop

**Date**: 2026-08-04 | **Plan**: [../plan.md](../plan.md) | **数据模型**: [../data-model.md](../data-model.md)

本文件定义前端 ↔ Rust 后端的全部 IPC 边界（Tauri commands + events）。契约为强类型、显式、版本可感知（宪法/AGENTS.md 约束）。TypeScript 类型置于 `src/ipc/contracts.ts`，Rust 对应类型置于 `src-tauri/src/commands/dto.rs`，两侧字段名以本文件为准（serde `camelCase`）。

## 0. 通用约定

### 版本与演进

- 契约版本常量 `IPC_CONTRACT_VERSION = 1`，随应用握手命令返回；不兼容变更须递增版本并在本文件记录迁移说明。
- 字段演进规则：新增可选字段 = 兼容；删除/改类型/改语义 = 不兼容。

### 信任边界规则（所有命令统一执行）

1. 一切路径参数在后端 `canonicalize` 后校验工作区白名单（`security/`），越界返回 `PATH_ACCESS_DENIED`。
2. 一切 JSON 载荷做结构校验与尺寸上限（scene 默认 256MB），超限/非法返回 `INVALID_SCENE`。
3. 命令入口为薄层：反序列化 → 校验 → 调领域服务；不在命令层写业务规则。

### 统一错误形状

```typescript
interface IpcError {
  code: ErrorCode;          // 稳定机器码，前端据此分流 UI
  message: string;          // 人类可读（英文，UI 层负责本地化）
  retriable: boolean;
  context?: Record<string, string>;  // 如 { path: "..." }
}

type ErrorCode =
  | "PATH_ACCESS_DENIED"    // 越界/穿越/符号链接逃逸
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_OVERLAP"     // 与已挂载工作区嵌套
  | "FILE_NOT_FOUND"
  | "FILE_CORRUPTED"        // JSON 解析/结构校验失败
  | "FILE_TOO_LARGE"
  | "INVALID_SCENE"
  | "CONFLICT_PENDING"      // Conflicted 状态下拒绝自动写入
  | "DISK_FULL"
  | "IO_ERROR"              // 其余 IO 失败（含 fsync/rename）
  | "DB_ERROR"
  | "INTERNAL";
```

Rust 侧以 `thiserror` 枚举实现并映射到该形状；`unwrap`/`expect` 禁止出现在命令可达路径。

## 1. 命令契约（Tauri Commands）

### 1.1 会话与恢复

| 命令 | 请求 | 响应 | 说明 |
|------|------|------|------|
| `app_handshake` | `{}` | `{ contractVersion: number; appVersion: string; abnormalExit: boolean }` | 启动握手；`abnormalExit=true` 时前端进入恢复流程 |
| `recovery_list` | `{}` | `RecoveryCandidate[]` | 列出可恢复草稿（已完成快照/冷层比对） |
| `recovery_apply` | `{ documentId: string; action: "restore" \| "keepDisk" \| "saveAsNew" \| "discard"; saveAsPath?: string }` | `{ scene?: SceneData; newPath?: string }` | 用户决策执行；`restore` 返回 scene 供前端载入 |

```typescript
interface RecoveryCandidate {
  documentId: string;
  originalPath: string | null;   // null = 未命名文档
  displayName: string;
  snapshotSavedAt: number;       // Unix 秒
  coldFileMtime: number | null;  // null = 冷层文件已不存在
  snapshotNewer: boolean;
}
```

### 1.2 工作区与文件管理

| 命令 | 请求 | 响应 | 说明 |
|------|------|------|------|
| `workspace_add` | `{ rootPath: string; name?: string }` | `Workspace` | 挂载并触发后台索引 |
| `workspace_remove` | `{ workspaceId: string }` | `{}` | 仅取消挂载，不删文件 |
| `workspace_list` | `{}` | `Workspace[]` | |
| `dir_list` | `{ workspaceId: string; relativePath: string }` | `DirEntry[]` | 懒加载一层目录 |
| `file_create` | `{ workspaceId: string; relativePath: string }` | `FileEntry` | 创建空白 `.excalidraw`（原子写） |
| `file_rename` | `{ path: string; newName: string }` | `FileEntry` | 同目录重命名；打开中的文档由 `file-changed` 事件跟随 |
| `file_delete` | `{ path: string }` | `{}` | 移入系统回收站（非物理删除） |

```typescript
interface Workspace { id: string; name: string; rootPath: string; createdAt: number }
interface DirEntry  { name: string; relativePath: string; kind: "dir" | "file"; mtime: number; fileSize: number }
interface FileEntry { canonicalPath: string; workspaceId: string; displayName: string; relativePath: string; mtime: number; fileSize: number }
```

### 1.3 文档编辑与持久化

| 命令 | 请求 | 响应 | 说明 |
|------|------|------|------|
| `doc_open` | `{ path: string }` | `{ scene: SceneData; baseHash: string; hasNewerDraft: boolean }` | `hasNewerDraft=true` 时前端提示载入草稿或磁盘版 |
| `doc_save_draft` | `{ path: string; sceneJson: string }` | `{ contentHash: string; savedAt: number }` | L2 热层写入（300ms 防抖后调用）；`Conflicted` 态返回 `CONFLICT_PENDING` |
| `doc_checkpoint` | `{ path: string; sceneJson: string; reason: CheckpointReason }` | `{ newBaseHash: string; mtime: number }` | L3 原子写冷层；成功后 is_dirty=0 |
| `doc_close` | `{ path: string; discardDraft: boolean }` | `{}` | 关闭前必须先 checkpoint 或显式丢弃 |
| `doc_resolve_conflict` | `{ path: string; resolution: "takeExternal" \| "keepLocal" \| "saveAsNew"; saveAsPath?: string }` | `{ scene?: SceneData; newBaseHash: string }` | 冲突三选项（FR-019） |
| `doc_export` | `{ path: string \| null; sceneJson: string; format: "png" \| "svg"; targetPath: string; options: ExportOptions }` | `{ writtenPath: string }` | 前端渲染产物落盘走后端原子写；失败不留残件 |

```typescript
type CheckpointReason = "manualSave" | "tabSwitch" | "tabClose" | "idle" | "appExit" | "maxWait";
interface ExportOptions { scale?: 1 | 2 | 3; background?: "transparent" | "solid"; theme?: "light" | "dark" }
type SceneData = unknown; // 官方 .excalidraw JSON，后端只做结构校验不建模内部字段
```

### 1.4 缩略图

| 命令 | 请求 | 响应 | 说明 |
|------|------|------|------|
| `thumb_lookup` | `{ path: string; theme: "light" \| "dark" }` | `{ hit: boolean; webpPath?: string }` | 命中返回缓存路径（asset 协议加载） |
| `thumb_store` | `{ path: string; theme: string; key: string; webpBytes: number[] }` | `{ webpPath: string }` | Worker 生成后回存缓存与 file_meta |

## 2. 事件契约（后端 → 前端，`app_handle.emit`）

| 事件 | 载荷 | 触发 |
|------|------|------|
| `file-changed` | `{ path: string; change: "modified" \| "created" \| "removed" \| "renamed"; newPath?: string; mtime?: number; contentHash?: string }` | notify 去抖合并后，且已排除自身写入回声 |
| `index-progress` | `{ workspaceId: string; scanned: number; total: number \| null; done: boolean }` | 后台索引进度 |
| `draft-saved` | `{ path: string; savedAt: number }` | 热层写入成功（UI 保存状态标识） |
| `conflict-detected` | `{ path: string; externalMtime: number; localDraftUpdatedAt: number }` | 变更命中 isDirty 文档 |
| `open-file-request` | `{ paths: string[] }` | 单实例二次启动/系统文件关联转发（FR-028） |

事件仅通知状态事实，不携带业务决策；前端据 data-model 状态机分流。

## 3. 契约测试要求

- 每条命令必须有 Rust 集成测试覆盖：合法请求、越界路径、非法 JSON、超限载荷四类。
- TS 侧以 Vitest 对 `contracts.ts` 做类型级（`expectTypeOf`）与序列化往返测试。
- 契约变更 PR 必须同步更新本文件（宪法文档同步门禁），CI 校验 `IPC_CONTRACT_VERSION` 与文件头版本一致。
