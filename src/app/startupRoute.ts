import { createTauriCommandInvoker, type CommandInvoker } from "../ipc/client";
import type {
  AppHandshakeResponse,
  RecoveryCandidate,
  Workspace,
  WorkspaceShellState,
} from "../ipc/contracts";

const handshakes = new WeakMap<CommandInvoker, Promise<AppHandshakeResponse>>();
let defaultHandshake: Promise<AppHandshakeResponse> | null = null;

/**
 * The window's single `app_handshake`. The backend hands out launch files
 * and restore data once per window, so every startup consumer (system
 * languages, Recovery, launch files) shares this one result instead of
 * calling the command again. A failed handshake is not cached, so a later
 * caller can retry.
 */
export function loadStartupHandshake(
  invoker?: CommandInvoker,
): Promise<AppHandshakeResponse> {
  if (invoker === undefined) {
    if (defaultHandshake === null) {
      const pending = createTauriCommandInvoker().invoke("app_handshake", {});
      defaultHandshake = pending;
      pending.catch(() => {
        if (defaultHandshake === pending) defaultHandshake = null;
      });
    }
    return defaultHandshake;
  }
  const cached = handshakes.get(invoker);
  if (cached !== undefined) return cached;
  const pending = invoker.invoke("app_handshake", {});
  handshakes.set(invoker, pending);
  pending.catch(() => {
    if (handshakes.get(invoker) === pending) handshakes.delete(invoker);
  });
  return pending;
}

/**
 * The backend labels windows `window-1`, `window-2`, … in creation order, so
 * the window created at launch is always `window-1`.
 */
export const FIRST_WINDOW_LABEL = "window-1";

/** Whether this window is the one created at launch. */
export async function isLaunchWindow(
  invoker?: CommandInvoker,
): Promise<boolean> {
  try {
    const handshake = await loadStartupHandshake(invoker);
    return handshake.window.label === FIRST_WINDOW_LABEL;
  } catch {
    return false;
  }
}

/**
 * The sidebar state the backend handed this window for the Workspace it
 * starts with, or `null`.
 */
export async function bootstrapShellState(
  invoker?: CommandInvoker,
): Promise<WorkspaceShellState | null> {
  try {
    const handshake = await loadStartupHandshake(invoker);
    // Handshake test doubles from before the per-window bootstrap omit it.
    return handshake.window?.shell ?? null;
  } catch {
    return null;
  }
}

export type StartupRouteKind = "welcome" | "recovery" | "restored";

export interface StartupRouteInput {
  handshake: Pick<AppHandshakeResponse, "abnormalExit" | "pendingOpenPaths">;
  recoveryCandidates: readonly RecoveryCandidate[];
  currentWorkspaceId: string | null;
  workspaces: readonly Pick<Workspace, "id">[];
  openDocumentCount: number;
}

export interface StartupRoute {
  kind: StartupRouteKind;
}

export function deriveStartupRoute({
  handshake,
  recoveryCandidates,
  currentWorkspaceId,
  workspaces,
  openDocumentCount,
}: StartupRouteInput): StartupRoute {
  if (handshake.abnormalExit && recoveryCandidates.length > 0) {
    return { kind: "recovery" };
  }

  const hasCurrentWorkspace =
    currentWorkspaceId !== null &&
    workspaces.some((workspace) => workspace.id === currentWorkspaceId);
  const hasReopenableDocuments =
    openDocumentCount > 0 || handshake.pendingOpenPaths.length > 0;

  if (hasCurrentWorkspace || hasReopenableDocuments) {
    return { kind: "restored" };
  }

  return { kind: "welcome" };
}
