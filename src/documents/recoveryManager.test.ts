import { describe, expect, it, vi } from "vitest";
import {
  RecoveryManager,
  type RecoveryDecision,
  type RecoveryGateway,
} from "./recoveryManager";

function candidate() {
  return {
    documentId: "document-1",
    originalPath: "/workspace/drawing.excalidraw",
    displayName: "drawing.excalidraw",
    snapshotSavedAt: 1_720_000_000,
    coldFileMtime: 1_719_999_000,
    snapshotNewer: true,
  };
}

function createGateway(
  overrides: Partial<RecoveryGateway> = {},
): RecoveryGateway {
  return {
    handshake: vi.fn(async () => ({
      contractVersion: 1,
      appVersion: "0.1.0",
      abnormalExit: false,
    })),
    list: vi.fn(async () => []),
    apply: vi.fn(async () => ({ scene: undefined, newPath: undefined })),
    ...overrides,
  };
}

describe("RecoveryManager", () => {
  it("does not enumerate recovery snapshots after a normal exit", async () => {
    const gateway = createGateway();
    const manager = new RecoveryManager(gateway);

    const result = await manager.start();

    expect(result.dialogRequired).toBe(false);
    expect(gateway.list).not.toHaveBeenCalled();
  });

  it("runs handshake, list, apply, and scene loading in order after an abnormal exit", async () => {
    const scene = { type: "excalidraw", elements: [], appState: {}, files: {} };
    const gateway = createGateway({
      handshake: vi.fn(async () => ({
        contractVersion: 1,
        appVersion: "0.1.0",
        abnormalExit: true,
      })),
      list: vi.fn(async () => [candidate()]),
      apply: vi.fn(async () => ({ scene, newPath: undefined })),
    });
    const loadScene = vi.fn();
    const manager = new RecoveryManager(gateway, { onSceneLoaded: loadScene });
    const decision: RecoveryDecision = {
      documentId: "document-1",
      action: "restore",
    };

    const result = await manager.run({
      chooseDecision: async () => decision,
    });

    expect(gateway.list).toHaveBeenCalledOnce();
    expect(gateway.apply).toHaveBeenCalledWith(decision);
    expect(loadScene).toHaveBeenCalledWith("document-1", scene, undefined);
    expect(result.applied?.decision).toEqual(decision);
    expect(result.dialogRequired).toBe(false);
  });

  it("leaves the dialog open when the user cancels without applying a snapshot", async () => {
    const gateway = createGateway({
      handshake: vi.fn(async () => ({
        contractVersion: 1,
        appVersion: "0.1.0",
        abnormalExit: true,
      })),
      list: vi.fn(async () => [candidate()]),
    });
    const manager = new RecoveryManager(gateway);

    const result = await manager.run({
      chooseDecision: async () => null,
    });

    expect(result.dialogRequired).toBe(true);
    expect(result.cancelled).toBe(true);
    expect(gateway.apply).not.toHaveBeenCalled();
  });

  it("does not load a scene when the Rust response serializes an absent scene as null", async () => {
    const gateway = createGateway({
      apply: vi.fn(async () => ({ scene: null, newPath: undefined })),
    });
    const loadScene = vi.fn();
    const manager = new RecoveryManager(gateway, { onSceneLoaded: loadScene });

    await manager.apply({ documentId: "document-1", action: "keepDisk" });

    expect(loadScene).not.toHaveBeenCalled();
  });
});
