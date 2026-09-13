import { describe, expect, it } from "vitest";
import type { RecoveryCandidate } from "../ipc/contracts";
import { deriveStartupRoute, type StartupRouteInput } from "./startupRoute";

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
