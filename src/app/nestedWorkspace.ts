import type { CommandInvoker } from "../ipc/client";
import type { ClaimWorkspaceOutcome, IpcEvents } from "../ipc/contracts";
import { defaultEventListener } from "../ipc/events";
import { containsOpenError } from "./workspaceClaim";

/** A folder being opened contains a Workspace open in another window. */
export interface NestedWorkspaceConflict {
  targetName: string;
  targetPath: string;
  /** The window that has the Workspace inside the folder. */
  label: string;
  workspaceId: string;
  openWorkspaceName: string;
  openWorkspacePath: string;
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/**
 * Name both folders for the nested-Workspace dialog. The Workspace inside is
 * looked up in the Recent list; without it the conflict is reported as an
 * error instead.
 */
export async function describeNestedConflict(
  invoker: Pick<CommandInvoker, "invoke">,
  targetPath: string,
  outcome: { label: string; workspaceId: string },
): Promise<NestedWorkspaceConflict> {
  const recent = await invoker.invoke("workspace_recent_list", {});
  const open = recent.find((workspace) => workspace.id === outcome.workspaceId);
  if (open === undefined) throw containsOpenError();
  return {
    targetName: baseName(targetPath),
    targetPath,
    label: outcome.label,
    workspaceId: outcome.workspaceId,
    openWorkspaceName: open.name,
    openWorkspacePath: open.rootPath,
  };
}

export type PeerClaimOutcome = IpcEvents["window-claim-result"]["outcome"];

export interface CloseOtherAndClaimOptions {
  invoker: Pick<CommandInvoker, "invoke">;
  conflict: Pick<NestedWorkspaceConflict, "label" | "targetPath">;
  /** Close every tab of this window; throws when a close is cancelled. */
  closeTabs: () => Promise<void>;
  listener?: (
    eventName: "window-claim-result",
    handler: (event: { payload: IpcEvents["window-claim-result"] }) => void,
  ) => Promise<() => void>;
}

/**
 * "Close it and open here": close this window's tabs, ask the other window
 * to close, and wait for the folder to open here once it has. `cancelled`
 * means that window stayed open and nothing opened.
 */
export async function closeOtherAndClaim({
  invoker,
  conflict,
  closeTabs,
  listener = defaultEventListener,
}: CloseOtherAndClaimOptions): Promise<
  ClaimWorkspaceOutcome | { kind: "cancelled" }
> {
  await closeTabs();
  // Results can arrive before the call returns its request id.
  const results = new Map<string, PeerClaimOutcome>();
  let waiting: {
    requestId: string;
    resolve(outcome: PeerClaimOutcome): void;
  } | null = null;
  const unlisten = await listener("window-claim-result", (event) => {
    const { requestId, outcome } = event.payload;
    if (waiting?.requestId === requestId) waiting.resolve(outcome);
    else results.set(requestId, outcome);
  });
  try {
    const { requestId } = await invoker.invoke("window_close_other_and_claim", {
      targetLabel: conflict.label,
      rootPath: conflict.targetPath,
    });
    const early = results.get(requestId);
    if (early !== undefined) return early;
    return await new Promise<PeerClaimOutcome>((resolve) => {
      waiting = { requestId, resolve };
    });
  } finally {
    unlisten();
  }
}
