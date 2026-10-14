import type { CommandInvoker } from "../ipc/client";
import type {
  WorkspaceEntry,
  Workspace,
  WorkspaceShellState,
} from "../ipc/contracts";
import { errorCodeOf } from "../i18n/describeError";
import type { DeclinedWorkspaceOutcome } from "./workspaceClaim";

/** Upper bound on `Untitled N` probes before the collision is reported. */
export const NEW_DRAWING_NAME_ATTEMPTS = 1000;

export interface NewDrawingRequest {
  invoker: Pick<CommandInvoker, "invoke">;
  selectDirectory: () => Promise<string | null>;
  untitledBaseName: string;
}

export type NewDrawingResult =
  | { status: "cancelled" }
  /**
   * Another window holds the folder or one nested with it. Nothing is
   * created; for `ownedBy` and `insideOpen` that window is now in front.
   */
  | { status: "declined"; outcome: DeclinedWorkspaceOutcome }
  | {
      status: "created";
      workspace: Workspace;
      /** The Workspace this window held before, when it was another one. */
      replaced: string | null;
      shell: WorkspaceShellState | null;
      entry: WorkspaceEntry;
    };

/**
 * Creates a Welcome New Drawing as an ordinary file: asks for a folder,
 * claims it as this window's Workspace, and creates the next free `Untitled`
 * there. A folder held by another window is not touched. The file is written by `workspace_entry_create`
 * (atomic, never overwrites), so the drawing is persisted like any other
 * workspace file from the start.
 */
export async function createNewDrawingFile({
  invoker,
  selectDirectory,
  untitledBaseName,
}: NewDrawingRequest): Promise<NewDrawingResult> {
  const rootPath = await selectDirectory();
  if (rootPath === null) return { status: "cancelled" };
  const outcome = await invoker.invoke("window_claim_workspace", { rootPath });
  if (outcome.kind !== "claimed") return { status: "declined", outcome };
  const { workspace, replaced, shell } = outcome;

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
      return {
        status: "created",
        workspace,
        replaced,
        shell,
        entry: created.entry,
      };
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
