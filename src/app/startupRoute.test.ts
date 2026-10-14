import { describe, expect, it, vi } from "vitest";
import { registerOpenFileHandler } from "./openFileHandler";
import { createRecoveryGateway } from "../documents/recoveryManager";
import type { CommandInvoker } from "../ipc/client";
import type { AppHandshakeResponse, RecoveryCandidate } from "../ipc/contracts";
import {
  deriveStartupRoute,
  loadStartupHandshake,
  type StartupRouteInput,
} from "./startupRoute";

const recoveryCandidate: RecoveryCandidate = {
  documentId: "document-1",
  originalPath: "/workspace/sketches/first.excalidraw",
  displayName: "first.excalidraw",
  snapshotSavedAt: 20,
  coldFileMtime: 10,
  snapshotNewer: true,
};

const emptyFixture: StartupRouteInput = {
  handshake: { abnormalExit: false, pendingOpenPaths: [] },
  recoveryCandidates: [],
  currentWorkspaceId: null,
  workspaces: [],
  openDocumentCount: 0,
};

const cleanSessionFixture: StartupRouteInput = {
  handshake: { abnormalExit: false, pendingOpenPaths: [] },
  recoveryCandidates: [],
  currentWorkspaceId: "workspace-1",
  workspaces: [{ id: "workspace-1" }],
  openDocumentCount: 1,
};

const abnormalExitFixture: StartupRouteInput = {
  handshake: { abnormalExit: true, pendingOpenPaths: [] },
  recoveryCandidates: [recoveryCandidate],
  currentWorkspaceId: null,
  workspaces: [],
  openDocumentCount: 0,
};

describe("deriveStartupRoute", () => {
  it("routes an empty startup to Welcome", () => {
    const input = structuredClone(emptyFixture);

    expect(deriveStartupRoute(input)).toEqual({ kind: "welcome" });
    expect(input).toEqual(emptyFixture);
    expect(Object.keys(deriveStartupRoute(input))).toEqual(["kind"]);
  });

  it("does not restore Welcome as a persisted document or tab", () => {
    expect(
      deriveStartupRoute({
        ...emptyFixture,
        workspaces: [{ id: "recent-only" }],
      }),
    ).toEqual({ kind: "welcome" });
  });

  it("routes a clean session to Restored", () => {
    expect(deriveStartupRoute(cleanSessionFixture)).toEqual({
      kind: "restored",
    });
  });

  it("routes abnormal exit with candidates to Recovery before Restored", () => {
    expect(deriveStartupRoute(abnormalExitFixture)).toEqual({
      kind: "recovery",
    });
  });

  it("keeps an existing session behind Recovery until every candidate resolves", () => {
    expect(
      deriveStartupRoute({
        ...cleanSessionFixture,
        handshake: { abnormalExit: true, pendingOpenPaths: [] },
        recoveryCandidates: [recoveryCandidate],
      }),
    ).toEqual({ kind: "recovery" });
    expect(
      deriveStartupRoute({
        ...cleanSessionFixture,
        handshake: { abnormalExit: true, pendingOpenPaths: [] },
        recoveryCandidates: [],
      }),
    ).toEqual({ kind: "restored" });
  });

  it("does not treat a missing current workspace id as a restored session", () => {
    expect(
      deriveStartupRoute({
        ...emptyFixture,
        currentWorkspaceId: "missing-workspace",
        workspaces: [{ id: "workspace-1" }],
      }),
    ).toEqual({ kind: "welcome" });
  });

  it("routes pending paths to Restored even before documents are opened", () => {
    expect(
      deriveStartupRoute({
        ...emptyFixture,
        handshake: {
          abnormalExit: false,
          pendingOpenPaths: ["/workspace/sketches/first.excalidraw"],
        },
      }),
    ).toEqual({ kind: "restored" });
  });
});

function handshakeResponse(
  pendingOpenPaths: string[] = [],
): AppHandshakeResponse {
  return {
    contractVersion: 5,
    appVersion: "0.5.0",
    abnormalExit: false,
    pendingOpenPaths,
    preferredLanguages: ["en-US"],
    window: {
      label: "window-1",
      workspace: null,
      unavailableWorkspace: null,
      restore: null,
      shell: null,
      openWorkspaceNames: [],
    },
  };
}

function countingInvoker(
  respond: () => Promise<AppHandshakeResponse>,
): CommandInvoker & { calls: () => number } {
  const invoke = vi.fn(async (command: string) => {
    if (command !== "app_handshake") {
      throw new Error(`Unexpected command ${command}`);
    }
    return respond();
  });
  return {
    invoke: invoke as unknown as CommandInvoker["invoke"],
    calls: () => invoke.mock.calls.length,
  };
}

describe("loadStartupHandshake", () => {
  it("calls app_handshake once and shares the result with every consumer", async () => {
    const invoker = countingInvoker(async () =>
      handshakeResponse(["/startup.excalidraw"]),
    );
    const opened: string[] = [];

    const [direct, recovery] = await Promise.all([
      loadStartupHandshake(invoker),
      createRecoveryGateway(invoker).handshake(),
      registerOpenFileHandler(
        {
          open: async (path) => {
            opened.push(path);
            return path;
          },
        },
        { invoker, listener: async () => () => undefined },
      ),
    ]);

    await vi.waitFor(() => {
      expect(opened).toEqual(["/startup.excalidraw"]);
    });
    expect(recovery).toBe(direct);
    expect(invoker.calls()).toBe(1);
  });

  it("does not cache a failed handshake", async () => {
    let attempt = 0;
    const invoker = countingInvoker(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("not ready");
      return handshakeResponse();
    });

    await expect(loadStartupHandshake(invoker)).rejects.toThrow("not ready");
    await expect(loadStartupHandshake(invoker)).resolves.toMatchObject({
      contractVersion: 5,
    });
    expect(invoker.calls()).toBe(2);
  });
});
