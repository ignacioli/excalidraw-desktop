export const IPC_CONTRACT_VERSION = 1 as const;

export type ErrorCode =
  | "PATH_ACCESS_DENIED"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_OVERLAP"
  | "FILE_NOT_FOUND"
  | "FILE_CORRUPTED"
  | "FILE_TOO_LARGE"
  | "INVALID_SCENE"
  | "CONFLICT_PENDING"
  | "DISK_FULL"
  | "IO_ERROR"
  | "DB_ERROR"
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
  "manualSave" | "tabSwitch" | "tabClose" | "idle" | "appExit" | "maxWait";

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

export interface DirEntry {
  name: string;
  relativePath: string;
  kind: "dir" | "file";
  mtime: number;
  fileSize: number;
}

export interface FileEntry {
  canonicalPath: string;
  workspaceId: string;
  displayName: string;
  relativePath: string;
  mtime: number;
  fileSize: number;
}

export interface ExportOptions {
  scale?: 1 | 2 | 3;
  background?: "transparent" | "solid";
  theme?: ColorScheme;
}

export interface CommandContract {
  request: unknown;
  response: unknown;
}

export interface IpcCommands {
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
  dir_list: {
    request: { workspaceId: string; relativePath: string };
    response: DirEntry[];
  };
  file_create: {
    request: { workspaceId: string; relativePath: string };
    response: FileEntry;
  };
  file_rename: {
    request: { path: string; newName: string };
    response: FileEntry;
  };
  file_delete: {
    request: { path: string };
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
    request: { path: string; discardDraft: boolean };
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
  thumb_lookup: {
    request: { path: string; theme: ColorScheme };
    response: { hit: boolean; webpPath?: string };
  };
  thumb_store: {
    request: { path: string; theme: string; key: string; webpBytes: number[] };
    response: { webpPath: string };
  };
}

export type CommandName = keyof IpcCommands;
export type CommandRequest<Name extends CommandName> =
  IpcCommands[Name]["request"];
export type CommandResponse<Name extends CommandName> =
  IpcCommands[Name]["response"];

export interface IpcEvents {
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
}

export type EventName = keyof IpcEvents;
export type EventPayload<Name extends EventName> = IpcEvents[Name];
