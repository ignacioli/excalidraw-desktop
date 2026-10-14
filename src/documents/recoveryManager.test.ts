import type { AppHandshakeResponse } from "../ipc/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  RecoveryManager,
  type RecoveryDecision,
  type RecoveryGateway,
} from "./recoveryManager";

const welcomeWindow: AppHandshakeResponse["window"] = {
  label: "window-1",
  workspace: null,
  unavailableWorkspace: null,
  restore: null,
  shell: null,
  openWorkspaceNames: [],
};

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
      contractVersion: 2,
      appVersion: "0.1.0",
      abnormalExit: false,
      pendingOpenPaths: [],
      preferredLanguages: [],
      window: welcomeWindow,
    })),
    list: vi.fn(async () => []),
    apply: vi.fn(async () => ({ scene: undefined, newPath: undefined })),
    done: vi.fn(async () => undefined),
    ...overrides,
  };
}

function abnormalHandshake() {
  return vi.fn(async () => ({
    contractVersion: 2,
    appVersion: "0.1.0",
    abnormalExit: true,
    pendingOpenPaths: [],
    preferredLanguages: [],
    window: welcomeWindow,
  }));
}

describe("RecoveryManager", () => {
  it("never reports Recovery as done after a normal exit", async () => {
    const gateway = createGateway();
    const manager = new RecoveryManager(gateway);

    await manager.start();
    await manager.apply({ documentId: "document-1", action: "keepDisk" });

    expect(gateway.done).not.toHaveBeenCalled();
  });

  it("reports Recovery as done at once when nothing is recoverable", async () => {
    const gateway = createGateway({ handshake: abnormalHandshake() });
    const manager = new RecoveryManager(gateway);

    const result = await manager.start();

    expect(result.dialogRequired).toBe(false);
    expect(gateway.done).toHaveBeenCalledOnce();
  });

  it("reports Recovery as done once, after the last candidate is decided", async () => {
    const gateway = createGateway({
      handshake: abnormalHandshake(),
      list: vi.fn(async () => [
        candidate(),
        { ...candidate(), documentId: "document-2" },
      ]),
    });
    const manager = new RecoveryManager(gateway);
    await manager.start();

    await manager.apply({ documentId: "document-1", action: "keepDisk" });
    expect(gateway.done).not.toHaveBeenCalled();
    await manager.apply({
      documentId: "document-2",
      action: "saveAsNew",
      saveAsPath: "/elsewhere/copy.excalidraw",
    });
    await manager.apply({ documentId: "document-2", action: "discard" });

    expect(gateway.done).toHaveBeenCalledOnce();
  });

  it("reports Recovery as done only after the last result is open here", async () => {
    const order: string[] = [];
    const gateway = createGateway({
      handshake: abnormalHandshake(),
      list: vi.fn(async () => [candidate()]),
      done: vi.fn(async () => {
        order.push("done");
      }),
    });
    const manager = new RecoveryManager(gateway);
    await manager.start();

    await manager.apply({ documentId: "document-1", action: "restore" }, () => {
      order.push("adopted");
    });

    expect(order).toEqual(["adopted", "done"]);
  });

  it("keeps a candidate undecided when its result cannot be opened", async () => {
    const gateway = createGateway({
      handshake: abnormalHandshake(),
      list: vi.fn(async () => [candidate()]),
    });
    const manager = new RecoveryManager(gateway);
    await manager.start();

    await expect(
      manager.apply({ documentId: "document-1", action: "restore" }, () => {
        throw new Error("open elsewhere");
      }),
    ).rejects.toThrow("open elsewhere");
    expect(gateway.done).not.toHaveBeenCalled();

    await manager.apply({ documentId: "document-1", action: "restore" });
    expect(gateway.done).toHaveBeenCalledOnce();
  });

  it("does not report Recovery as done while a candidate is undecided", async () => {
    const gateway = createGateway({
      handshake: abnormalHandshake(),
      list: vi.fn(async () => [candidate()]),
    });
    const manager = new RecoveryManager(gateway);

    await manager.run({ chooseDecision: async () => null });

    expect(gateway.done).not.toHaveBeenCalled();
  });

  it("rejects the last decision when reporting Recovery as done fails", async () => {
    const done = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("offline"));
    const gateway = createGateway({
      handshake: abnormalHandshake(),
      list: vi.fn(async () => [candidate()]),
      done,
    });
    const manager = new RecoveryManager(gateway);
    await manager.start();

    await expect(
      manager.apply({ documentId: "document-1", action: "keepDisk" }),
    ).rejects.toThrow("offline");
    expect(done).toHaveBeenCalledOnce();
  });

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
        contractVersion: 2,
        appVersion: "0.1.0",
        abnormalExit: true,
        pendingOpenPaths: [],
        preferredLanguages: [],
        window: welcomeWindow,
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
        contractVersion: 2,
        appVersion: "0.1.0",
        abnormalExit: true,
        pendingOpenPaths: [],
        preferredLanguages: [],
        window: welcomeWindow,
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

  it("does not apply a recovery decision while startup reconciliation is pending", async () => {
    let releaseHandshake!: () => void;
    const handshakeReady = new Promise<void>((resolve) => {
      releaseHandshake = resolve;
    });
    const apply = vi.fn(async () => ({ scene: null, newPath: undefined }));
    const gateway = createGateway({
      handshake: vi.fn(async () => {
        await handshakeReady;
        return {
          contractVersion: 2,
          appVersion: "0.1.0",
          abnormalExit: false,
          pendingOpenPaths: [],
          preferredLanguages: [],
          window: welcomeWindow,
        };
      }),
      apply,
    });
    const manager = new RecoveryManager(gateway);
    const startup = manager.start();
    const applied = manager.apply({
      documentId: "document-1",
      action: "keepDisk",
    });

    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();
    releaseHandshake();
    await startup;
    await applied;
    expect(apply).toHaveBeenCalledOnce();
  });
});
