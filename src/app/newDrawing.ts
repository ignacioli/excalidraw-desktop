import type { CommandInvoker } from "../ipc/client";
import type { WorkspaceEntry, Workspace } from "../ipc/contracts";
import { errorCodeOf } from "../i18n/describeError";

/** Upper bound on `Untitled N` probes before the collision is reported. */
export const NEW_DRAWING_NAME_ATTEMPTS = 1000;

export interface NewDrawingRequest {
  invoker: Pick<CommandInvoker, "invoke">;
  mountedWorkspaces: readonly Workspace[];
  preferredWorkspaceId: string | null;
  selectDirectory: () => Promise<string | null>;
  untitledBaseName: string;
}

export type NewDrawingResult =
  | { status: "cancelled" }
  | {
      status: "created";
      workspace: Workspace;
      /** True when this call mounted the workspace. */
      mounted: boolean;
      entry: WorkspaceEntry;
    };

/**
 * Creates a Welcome New Drawing as an ordinary file in the remembered
 * new-drawing workspace, asking for that folder on first use. The file is
 * written by `workspace_entry_create` (atomic, never overwrites), so the
 * drawing is persisted like any other workspace file from the start.
 */
export async function createNewDrawingFile({
  invoker,
  mountedWorkspaces,
  preferredWorkspaceId,
  selectDirectory,
  untitledBaseName,
}: NewDrawingRequest): Promise<NewDrawingResult> {
  let workspace = mountedWorkspaces.find(
    (item) => item.id === preferredWorkspaceId,
  );
  let mounted = false;
  if (workspace === undefined) {
    const rootPath = await selectDirectory();
    if (rootPath === null) return { status: "cancelled" };
    workspace = mountedWorkspaces.find((item) => item.rootPath === rootPath);
    if (workspace === undefined) {
      workspace = await invoker.invoke("workspace_add", { rootPath });
      mounted = true;
    }
  }

  for (let attempt = 1; ; attempt += 1) {
    const baseName =
      attempt === 1 ? untitledBaseName : `${untitledBaseName} ${attempt}`;
    try {
      const created = await invoker.invoke("workspace_entry_create", {
        workspaceId: workspace.id,
        parentRelativePath: "",
        kind: "drawing",
        baseName,
      });
      return { status: "created", workspace, mounted, entry: created.entry };
    } catch (error) {
      if (
        errorCodeOf(error) !== "NAME_CONFLICT" ||
        attempt >= NEW_DRAWING_NAME_ATTEMPTS
      ) {
        throw error;
      }
    }
  }
}
