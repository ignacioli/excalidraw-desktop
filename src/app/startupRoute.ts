import type {
  AppHandshakeResponse,
  RecoveryCandidate,
  Workspace,
} from "../ipc/contracts";

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
