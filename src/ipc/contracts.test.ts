import { describe, expect, expectTypeOf, it } from "vitest";
import {
  IPC_CONTRACT_VERSION,
  type CommandRequest,
  type CommandResponse,
  type EntryMutationResult,
  type ErrorCode,
  type ExpectedOpenDocument,
  type HistoryChangedEvent,
  type HistoryDeleteRequest,
  type HistoryDeleteResponse,
  type HistoryIssueEvent,
  type HistoryListRequest,
  type HistoryMarkResponse,
  type HistoryReplaceRequest,
  type HistorySetMarkedRequest,
  type HistorySetMarkedResponse,
  type HistoryVersionItem,
  type IpcCommands,
  type IpcEvents,
  type NativeMenuCommandEvent,
  type PathMigration,
  type WorkspaceEntriesChangedEvent,
  type WorkspaceEntry,
} from "./contracts";

describe("IPC v3 history contract", () => {
  it("defines the complete WorkspaceEntry wire shape", () => {
    expectTypeOf<WorkspaceEntry>().toEqualTypeOf<{
      workspaceId: string;
      kind: "drawing" | "directory";
      canonicalPath: string;
      relativePath: string;
      parentRelativePath: string;
      name: string;
      displayName: string;
      mtime: number;
      fileSize: number;
    }>();
    expectTypeOf<ExpectedOpenDocument>().toEqualTypeOf<{
      relativePath: string;
      baseHash: string;
    }>();
    expectTypeOf<PathMigration>().toEqualTypeOf<{
      oldRelativePath: string;
      newRelativePath: string;
      oldCanonicalPath: string;
      newCanonicalPath: string;
    }>();
    expectTypeOf<EntryMutationResult>().toEqualTypeOf<{
      operationId: string;
      entry: WorkspaceEntry;
    }>();
  });

  it("adds stable Workspace Entry errors without removing existing errors", () => {
    const newCodes = [
      "INVALID_NAME",
      "NAME_CONFLICT",
      "ENTRY_PROTECTED",
      "DIRECTORY_NOT_EMPTY",
      "ENTRY_CHANGED",
    ] as const satisfies readonly ErrorCode[];
    const existingCodes = [
      "PATH_ACCESS_DENIED",
      "WORKSPACE_NOT_FOUND",
      "CONFLICT_PENDING",
      "DISK_FULL",
      "IO_ERROR",
      "DB_ERROR",
      "INTERNAL",
    ] as const satisfies readonly ErrorCode[];

    expect(newCodes).toHaveLength(5);
    expect(existingCodes).toContain("PATH_ACCESS_DENIED");
  });

  it("types Workspace Entry commands and proves migrated legacy callers are gone", () => {
    expect(IPC_CONTRACT_VERSION).toBe(3);
    expectTypeOf<CommandRequest<"workspace_entry_list">>().toEqualTypeOf<{
      workspaceId: string;
      parentRelativePath: string;
    }>();
    expectTypeOf<CommandResponse<"workspace_entry_list">>().toEqualTypeOf<
      WorkspaceEntry[]
    >();
    expectTypeOf<CommandRequest<"workspace_entry_create">>().toEqualTypeOf<{
      workspaceId: string;
      parentRelativePath: string;
      kind: "drawing" | "directory";
      baseName: string;
    }>();
    expectTypeOf<CommandRequest<"workspace_entry_rename">>().toEqualTypeOf<{
      workspaceId: string;
      relativePath: string;
      baseName: string;
      expectedOpenDocuments: ExpectedOpenDocument[];
    }>();
    expectTypeOf<
      CommandRequest<"workspace_entry_delete_preflight">
    >().toEqualTypeOf<{
      workspaceId: string;
      relativePath: string;
    }>();
    expectTypeOf<CommandRequest<"workspace_entry_reveal">>().toEqualTypeOf<{
      workspaceId: string;
      relativePath: string;
    }>();

    type LegacyCommands =
      | "dir_list"
      | "file_create"
      | "file_rename"
      | "file_delete"
      | "thumb_lookup"
      | "thumb_store";
    expectTypeOf<
      Extract<keyof IpcCommands, LegacyCommands>
    >().toEqualTypeOf<never>();
  });

  it("types the retained Recent Workspace lifecycle commands", () => {
    expectTypeOf<CommandRequest<"workspace_recent_list">>().toEqualTypeOf<
      Record<string, never>
    >();
    expectTypeOf<CommandResponse<"workspace_recent_list">>().toEqualTypeOf<
      import("./contracts").Workspace[]
    >();
    expectTypeOf<CommandRequest<"workspace_remount">>().toEqualTypeOf<{
      workspaceId: string;
    }>();
    expectTypeOf<CommandResponse<"workspace_remount">>().toEqualTypeOf<
      import("./contracts").Workspace
    >();
    expectTypeOf<CommandRequest<"workspace_recent_remove">>().toEqualTypeOf<{
      workspaceId: string;
    }>();
  });

  it("defines the Workspace Entry event shape and operation echo", () => {
    expectTypeOf<WorkspaceEntriesChangedEvent>().toEqualTypeOf<{
      workspaceId: string;
      operationId?: string;
      change: "created" | "renamed" | "removed" | "invalidated";
      relativePath: string;
      newRelativePath?: string;
    }>();
    expectTypeOf<
      IpcEvents["workspace-entries-changed"]
    >().toEqualTypeOf<WorkspaceEntriesChangedEvent>();
  });

  it("defines the narrow native menu event payload", () => {
    expectTypeOf<NativeMenuCommandEvent>().toEqualTypeOf<{
      command:
        | "save"
        | "exportImage"
        | "versionHistory"
        | "appearanceSystem"
        | "appearanceLight"
        | "appearanceDark";
      validationId?: number;
    }>();
    expectTypeOf<
      IpcEvents["native-menu-command"]
    >().toEqualTypeOf<NativeMenuCommandEvent>();
  });

  it("defines history commands without exposing store paths", () => {
    expectTypeOf<HistoryVersionItem>().toMatchTypeOf<{ marked: boolean }>();
    expectTypeOf<HistoryListRequest>().toEqualTypeOf<{
      document:
        { kind: "path"; path: string } | { kind: "handle"; documentId: string };
      cursor?: string;
      limit?: number;
    }>();
    expectTypeOf<HistoryReplaceRequest>().toMatchTypeOf<{
      document:
        { kind: "path"; path: string } | { kind: "handle"; documentId: string };
      requestId: string;
      sessionGeneration: number;
      revision: number;
      expectedBaseHash: string;
      currentSceneJson: string;
      target:
        | { kind: "restore"; versionId: string }
        | { kind: "clear" }
        | { kind: "import"; candidateSceneJson: string };
    }>();
    expectTypeOf<HistoryDeleteRequest>().toEqualTypeOf<{
      document:
        { kind: "path"; path: string } | { kind: "handle"; documentId: string };
      requestId: string;
      versionId: string;
    }>();
    expectTypeOf<HistoryDeleteResponse>().toEqualTypeOf<{
      deletedVersionId: string;
    }>();
    expectTypeOf<HistorySetMarkedRequest>().toEqualTypeOf<{
      document:
        { kind: "path"; path: string } | { kind: "handle"; documentId: string };
      requestId: string;
      versionId: string;
      marked: boolean;
    }>();
    expectTypeOf<HistorySetMarkedResponse>().toEqualTypeOf<{
      versionId: string;
      marked: boolean;
      retained: boolean;
    }>();
    expectTypeOf<HistoryMarkResponse>().toEqualTypeOf<{
      versionId: string;
      recordedAt: number;
      source: "automatic" | "manual" | "protected";
      contentHash: string;
      reused: boolean;
    }>();
    expectTypeOf<
      keyof Pick<
        IpcCommands,
        | "history_list"
        | "history_preview"
        | "history_mark"
        | "history_set_marked"
        | "history_replace"
        | "history_operation_status"
        | "history_delete"
      >
    >().toEqualTypeOf<
      | "history_list"
      | "history_preview"
      | "history_mark"
      | "history_set_marked"
      | "history_replace"
      | "history_operation_status"
      | "history_delete"
    >();
  });

  it("defines history change and issue event payloads", () => {
    expectTypeOf<HistoryChangedEvent>().toMatchTypeOf<{
      documentId: string;
      requestId?: string;
      listRevision: number;
      change:
        | "automatic"
        | "manual"
        | "protected"
        | "deleted"
        | "reconciled"
        | "invalidated";
    }>();
    expectTypeOf<HistoryIssueEvent>().toMatchTypeOf<{
      documentId: string;
      source: "automatic" | "manual" | "protected" | "reconciliation";
      error: import("./contracts").IpcError;
    }>();
    expectTypeOf<
      IpcEvents["history-changed"]
    >().toEqualTypeOf<HistoryChangedEvent>();
    expectTypeOf<
      IpcEvents["history-issue"]
    >().toEqualTypeOf<HistoryIssueEvent>();
  });
});
