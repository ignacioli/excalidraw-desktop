export const IPC_CONTRACT_VERSION = 3 as const;
/** The activated history boundary; retained as an explicit version marker. */
export const RESERVED_HISTORY_CONTRACT_VERSION = 3 as const;

/** History paging is an API bound, not a retention limit. */
export const HISTORY_DEFAULT_PAGE_LIMIT = 50 as const;
export const HISTORY_MAX_PAGE_LIMIT = 100 as const;
export const HISTORY_MAX_SCENE_BYTES = 256 * 1024 * 1024;
export const HISTORY_MAX_IDENTIFIER_LENGTH = 128 as const;
export const HISTORY_MAX_CURSOR_LENGTH = 4096 as const;
export const HISTORY_MAX_PATH_LENGTH = 4096 as const;

export type ErrorCode =
  | "PATH_ACCESS_DENIED"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_MOUNTED"
  | "WORKSPACE_OVERLAP"
  | "INVALID_NAME"
  | "NAME_CONFLICT"
  | "ENTRY_PROTECTED"
  | "DIRECTORY_NOT_EMPTY"
  | "ENTRY_CHANGED"
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
  | "INTERNAL";

export interface IpcError {
  code: ErrorCode;
  message: string;
  retriable: boolean;
  context?: Record<string, string>;
}

export type SceneData = unknown;
export type ColorScheme = "light" | "dark";
export type CheckpointReason =
  | "manualSave"
  | "saveAsNew"
  | "tabSwitch"
  | "tabClose"
  | "idle"
  | "appExit"
  | "maxWait";

export interface AppHandshakeResponse {
  contractVersion: number;
  appVersion: string;
  abnormalExit: boolean;
  pendingOpenPaths: string[];
}

export interface RecoveryCandidate {
  documentId: string;
  originalPath: string | null;
  displayName: string;
  snapshotSavedAt: number;
  coldFileMtime: number | null;
  snapshotNewer: boolean;
}

export type RecoveryAction = "restore" | "keepDisk" | "saveAsNew" | "discard";

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
}

export interface FileEntry {
  canonicalPath: string;
  workspaceId: string;
  displayName: string;
  relativePath: string;
  mtime: number;
  fileSize: number;
}

export type WorkspaceEntryKind = "drawing" | "directory";

export interface WorkspaceEntry {
  workspaceId: string;
  kind: WorkspaceEntryKind;
  canonicalPath: string;
  relativePath: string;
  parentRelativePath: string;
  name: string;
  displayName: string;
  mtime: number;
  fileSize: number;
}

export interface ExpectedOpenDocument {
  relativePath: string;
  baseHash: string;
}

export interface PathMigration {
  oldRelativePath: string;
  newRelativePath: string;
  oldCanonicalPath: string;
  newCanonicalPath: string;
}

export interface EntryMutationResult {
  operationId: string;
  entry: WorkspaceEntry;
}

export interface EntryRenameResult extends EntryMutationResult {
  oldRelativePath: string;
  newRelativePath: string;
  pathMigrations: PathMigration[];
}

export type EntryDeletePreflightResult =
  | { status: "confirmable"; entry: WorkspaceEntry }
  | { status: "directoryNotEmpty"; entry: WorkspaceEntry };

export interface EntryDeleteResult {
  operationId: string;
  kind: WorkspaceEntryKind;
  oldRelativePath: string;
  historyMaintenance?: "pendingReplay" | "cleanupPending";
}

export interface ExportOptions {
  scale?: 1 | 2 | 3;
  background?: "transparent" | "solid";
  theme?: ColorScheme;
}

/**
 * A history request is authorized by the current document authority. It must
 * never contain an app-data/history-store path. The opaque handle variant is
 * reserved for the persistent identity service; path remains useful while a
 * document is being resolved by the existing direct-file authority.
 */
export type HistoryDocumentLocator =
  { kind: "path"; path: string } | { kind: "handle"; documentId: string };

export type HistoryVersionSource = "automatic" | "manual" | "protected";
export type HistoryProtectedAction = "restore" | "clear" | "import";

export type HistoryVersionAvailability =
  { status: "available" } | { status: "unavailable"; error: IpcError };

export interface HistoryVersionItem {
  versionId: string;
  source: HistoryVersionSource;
  protectedAction?: HistoryProtectedAction;
  recordedAt: number;
  sequence: number;
  contentHash: string;
  availability: HistoryVersionAvailability;
}

export interface HistoryListRequest {
  document: HistoryDocumentLocator;
  cursor?: string;
  limit?: number;
}

export interface HistoryListResponse {
  documentId: string;
  items: HistoryVersionItem[];
  nextCursor?: string;
  pendingIssue?: IpcError;
  listRevision: number;
}

export interface HistoryPreviewRequest {
  document: HistoryDocumentLocator;
  versionId: string;
}

export interface HistoryPreviewResponse {
  versionId: string;
  scene: SceneData;
}

export interface HistoryMarkRequest {
  document: HistoryDocumentLocator;
  requestId: string;
  sessionGeneration: number;
  revision: number;
  currentSceneJson: string;
}

export interface HistoryMarkResponse {
  versionId: string;
  recordedAt: number;
  source: "manual";
  contentHash: string;
}

export type HistoryReplaceTarget =
  | { kind: "restore"; versionId: string }
  | { kind: "clear" }
  | { kind: "import"; candidateSceneJson: string };

export interface HistoryReplaceRequest {
  document: HistoryDocumentLocator;
  requestId: string;
  sessionGeneration: number;
  revision: number;
  expectedBaseHash: string;
  currentSceneJson: string;
  target: HistoryReplaceTarget;
}

export type HistoryOperationState =
  | "preparing"
  | "protected"
  | "intentCommitted"
  | "targetObserved"
  | "targetPublished"
  | "metadataCommitted"
  | "completed"
  | "aborted"
  | "reconcile"
  | "conflict"
  | "pendingReconciliation";

export type HistoryReplaceResponse =
  | {
      status: "completed";
      requestId: string;
      replacementCommitted: true;
      protectionVersionId: string;
      adoptedScene: SceneData;
      newBaseHash: string;
      newSessionGeneration: number;
    }
  | {
      status: "pendingReconciliation";
      requestId: string;
      replacementCommitted: null;
      operationState: "pendingReconciliation";
    };

export interface HistoryOperationStatusRequest {
  document: HistoryDocumentLocator;
  requestId: string;
}

export interface HistoryOperationStatusResponse {
  requestId: string;
  state: HistoryOperationState;
  replacementCommitted: boolean | null;
  protectionVersionId?: string;
  adoptedScene?: SceneData;
  newBaseHash?: string;
  newSessionGeneration?: number;
}

export interface HistoryDeleteRequest {
  document: HistoryDocumentLocator;
  requestId: string;
  versionId: string;
}

export interface HistoryDeleteResponse {
  deletedVersionId: string;
}

export type HistoryOperationKind = "mark" | "replace" | "delete" | "reconcile";
export type HistoryIssueSource =
  "automatic" | "manual" | "protected" | "reconciliation";
export type HistoryChangeKind =
  | "automatic"
  | "manual"
  | "protected"
  | "deleted"
  | "reconciled"
  | "invalidated";
export type HistoryCurrentFileSaveOutcome =
  "notAttempted" | "succeeded" | "failed" | "pending";

export interface HistoryChangedEvent {
  documentId: string;
  requestId?: string;
  listRevision: number;
  change: HistoryChangeKind;
}

export interface HistoryIssueEvent {
  documentId: string;
  operation?: HistoryOperationKind;
  source: HistoryIssueSource;
  error: IpcError;
  currentFileSaveOutcome?: HistoryCurrentFileSaveOutcome;
}

export interface CommandContract {
  request: unknown;
  response: unknown;
}

export interface IpcCommands {
  native_menu_set_enabled: {
    request: { command: NativeMenuCommand; enabled: boolean };
    response: Record<string, never>;
  };
  app_handshake: {
    request: Record<string, never>;
    response: AppHandshakeResponse;
  };
  recovery_list: {
    request: Record<string, never>;
    response: RecoveryCandidate[];
  };
  recovery_apply: {
    request: {
      documentId: string;
      action: RecoveryAction;
      saveAsPath?: string;
    };
    response: { scene?: SceneData; newPath?: string };
  };
  workspace_add: {
    request: { rootPath: string; name?: string };
    response: Workspace;
  };
  workspace_remove: {
    request: { workspaceId: string };
    response: Record<string, never>;
  };
  workspace_list: {
    request: Record<string, never>;
    response: Workspace[];
  };
  workspace_recent_list: {
    request: Record<string, never>;
    response: Workspace[];
  };
  workspace_remount: {
    request: { workspaceId: string };
    response: Workspace;
  };
  workspace_recent_remove: {
    request: { workspaceId: string };
    response: Record<string, never>;
  };
  workspace_entry_list: {
    request: { workspaceId: string; parentRelativePath: string };
    response: WorkspaceEntry[];
  };
  workspace_entry_create: {
    request: {
      workspaceId: string;
      parentRelativePath: string;
      kind: WorkspaceEntryKind;
      baseName: string;
    };
    response: EntryMutationResult;
  };
  workspace_entry_rename: {
    request: {
      workspaceId: string;
      relativePath: string;
      baseName: string;
      expectedOpenDocuments: ExpectedOpenDocument[];
    };
    response: EntryRenameResult;
  };
  workspace_entry_delete_preflight: {
    request: { workspaceId: string; relativePath: string };
    response: EntryDeletePreflightResult;
  };
  workspace_entry_delete: {
    request: {
      workspaceId: string;
      relativePath: string;
      expectedOpenDocument?: ExpectedOpenDocument;
    };
    response: EntryDeleteResult;
  };
  workspace_entry_reveal: {
    request: { workspaceId: string; relativePath: string };
    response: Record<string, never>;
  };
  doc_open: {
    request: { path: string };
    response: { scene: SceneData; baseHash: string; hasNewerDraft: boolean };
  };
  doc_save_draft: {
    request: { path: string; sceneJson: string };
    response: { contentHash: string; savedAt: number };
  };
  doc_checkpoint: {
    request: { path: string; sceneJson: string; reason: CheckpointReason };
    response: { newBaseHash: string; mtime: number };
  };
  doc_close: {
    request: { path: string; mode: "checkpointed" | "discardOrphan" };
    response: Record<string, never>;
  };
  doc_resolve_conflict: {
    request: {
      path: string;
      resolution: "takeExternal" | "keepLocal" | "saveAsNew";
      saveAsPath?: string;
    };
    response: { scene?: SceneData; newBaseHash: string };
  };
  doc_export: {
    request: {
      path: string | null;
      sceneJson: string;
      format: "png" | "svg";
      targetPath: string;
      options: ExportOptions;
      bytes: number[];
    };
    response: { writtenPath: string };
  };
  history_list: {
    request: HistoryListRequest;
    response: HistoryListResponse;
  };
  history_preview: {
    request: HistoryPreviewRequest;
    response: HistoryPreviewResponse;
  };
  history_mark: {
    request: HistoryMarkRequest;
    response: HistoryMarkResponse;
  };
  history_replace: {
    request: HistoryReplaceRequest;
    response: HistoryReplaceResponse;
  };
  history_operation_status: {
    request: HistoryOperationStatusRequest;
    response: HistoryOperationStatusResponse;
  };
  history_delete: {
    request: HistoryDeleteRequest;
    response: HistoryDeleteResponse;
  };
}

export type CommandName = keyof IpcCommands;
export type HistoryCommandName = Extract<CommandName, `history_${string}`>;
export type CommandRequest<Name extends CommandName> =
  IpcCommands[Name]["request"];
export type CommandResponse<Name extends CommandName> =
  IpcCommands[Name]["response"];

export interface IpcEvents {
  "native-menu-command": NativeMenuCommandEvent;
  "workspace-entries-changed": WorkspaceEntriesChangedEvent;
  "file-changed": {
    path: string;
    change: "modified" | "created" | "removed" | "renamed";
    newPath?: string;
    mtime?: number;
    contentHash?: string;
  };
  "index-progress": {
    workspaceId: string;
    scanned: number;
    total: number | null;
    done: boolean;
  };
  "draft-saved": { path: string; savedAt: number };
  "conflict-detected": {
    path: string;
    externalMtime: number;
    localDraftUpdatedAt: number;
  };
  "open-file-request": { paths: string[] };
  "history-changed": HistoryChangedEvent;
  "history-issue": HistoryIssueEvent;
}

export interface WorkspaceEntriesChangedEvent {
  workspaceId: string;
  operationId?: string;
  change: "created" | "renamed" | "removed" | "invalidated";
  relativePath: string;
  newRelativePath?: string;
}

export type NativeMenuCommand =
  | "save"
  | "exportImage"
  | "versionHistory"
  | "appearanceSystem"
  | "appearanceLight"
  | "appearanceDark";

export interface NativeMenuCommandEvent {
  command: NativeMenuCommand;
  /**
   * Present only when the packaged app is launched by the native macOS
   * validation harness. It lets the harness correlate the native menu event
   * with the already-tested frontend command router without relying on a
   * screenshot or exposing a production IPC command.
   */
  validationId?: number;
}

export type EventName = keyof IpcEvents;
export type EventPayload<Name extends EventName> = IpcEvents[Name];
