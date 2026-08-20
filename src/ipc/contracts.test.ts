import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  CommandRequest,
  CommandResponse,
  EntryMutationResult,
  ErrorCode,
  ExpectedOpenDocument,
  IpcCommands,
  IpcEvents,
  PathMigration,
  WorkspaceEntriesChangedEvent,
  WorkspaceEntry,
} from "./contracts";

describe("IPC v2 migration contract", () => {
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

  it("types the new commands while retaining legacy callers during migration", () => {
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

    const legacyCommands = [
      "dir_list",
      "file_create",
      "file_rename",
      "file_delete",
      "thumb_lookup",
      "thumb_store",
    ] as const satisfies readonly (keyof IpcCommands)[];
    expect(legacyCommands).toHaveLength(6);
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
});
