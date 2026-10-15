import type { CommandInvoker } from "../ipc/client";
import type {
  ClaimWorkspaceOutcome,
  ClaimWorkspaceTarget,
  Workspace,
  WorkspaceShellState,
} from "../ipc/contracts";
import type { DocumentManager } from "../documents/documentStore";
import { DescribedError, LocalizedError } from "../i18n/describeError";

export type DeclinedWorkspaceOutcome = Exclude<
  ClaimWorkspaceOutcome,
  { kind: "claimed" }
>;

export type OpenWorkspaceResult =
  | {
      status: "claimed";
      workspace: Workspace;
      replaced: string | null;
      shell: WorkspaceShellState | null;
    }
  /**
   * Another window holds the Workspace or one nested with it. For `ownedBy`
   * and `insideOpen` that window is now in front; this window is unchanged.
   */
  | { status: "declined"; outcome: DeclinedWorkspaceOutcome };

export interface OpenWorkspaceInWindowOptions {
  invoker: CommandInvoker;
  target: ClaimWorkspaceTarget;
  /**
   * Close every tab of this window before its Workspace is replaced. Throws
   * when a close is cancelled or fails; the current Workspace is then kept.
   */
  closeTabs: () => Promise<void>;
}

function toResult(outcome: ClaimWorkspaceOutcome): OpenWorkspaceResult {
  return outcome.kind === "claimed"
    ? {
        status: "claimed",
        workspace: outcome.workspace,
        replaced: outcome.replaced,
        shell: outcome.shell,
      }
    : { status: "declined", outcome };
}

/**
 * Open a Workspace in this window. The decision is probed first so tabs are
 * closed only when the Workspace will actually open here: a Workspace held
 * by another window brings that window to the front and leaves this window
 * and its tabs as they were.
 */
export async function openWorkspaceInWindow({
  invoker,
  target,
  closeTabs,
}: OpenWorkspaceInWindowOptions): Promise<OpenWorkspaceResult> {
  const probe = await invoker.invoke("window_probe_workspace", target);
  if (probe.kind === "containsOpen") {
    return { status: "declined", outcome: probe };
  }
  if (probe.kind === "claimed") {
    await closeTabs();
  }
  // For `ownedBy` and `insideOpen` the claim changes nothing here and
  // brings the owner window to the front.
  return toResult(await invoker.invoke("window_claim_workspace", target));
}

/** Close every tab in tab order, as replacing a Workspace requires. */
export async function closeAllTabsForWorkspaceSwitch(
  manager: Pick<DocumentManager, "closeMany" | "store">,
): Promise<void> {
  const tabOrder = manager.store.getState().tabOrder;
  const outcome = await manager.closeMany(tabOrder);
  if (outcome.status !== "closed") {
    throw outcome.status === "failed"
      ? new DescribedError(outcome.message)
      : new LocalizedError("error.closeBeforeWorkspaceSwitch");
  }
}

/**
 * The error shown until the nested-Workspace dialog handles a folder that
 * contains a Workspace open in another window.
 */
export function containsOpenError(): LocalizedError {
  return new LocalizedError("error.WORKSPACE_OVERLAP");
}
