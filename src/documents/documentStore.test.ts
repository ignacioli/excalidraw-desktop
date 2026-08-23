import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../app/store";
import type { SceneSnapshot } from "../editor/sceneSerializer";
import type { ExpectedOpenDocument } from "../ipc/contracts";
import type { DocumentGateway } from "./documentGateway";
import {
  DocumentManager,
  registerDocumentFileChangeEvents,
} from "./documentStore";

const { serializeAsJSON } = vi.hoisted(() => ({
  serializeAsJSON: vi.fn(
    (elements: readonly object[], appState: object, files: object) =>
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        elements,
        appState,
        files,
      }),
  ),
}));

vi.mock("@excalidraw/excalidraw", () => ({
  getSceneVersion: (elements: ReadonlyArray<{ version?: number }>) =>
    elements.reduce((total, element) => total + (element.version ?? 0), 0),
  restore: (scene: SceneSnapshot) => scene,
  serializeAsJSON,
}));

function createGateway(): DocumentGateway {
  return {
    open: vi.fn(async () => ({
      scene: {
        type: "excalidraw",
        version: 2,
        elements: [],
        appState: {},
        files: {},
      },
      baseHash: "base",
      hasNewerDraft: false,
    })),
    saveDraft: vi.fn(async () => ({ contentHash: "draft", savedAt: 1 })),
    checkpoint: vi.fn(async () => ({ newBaseHash: "next", mtime: 1 })),
    resolveConflict: vi.fn(async () => ({ newBaseHash: "resolved" })),
    close: vi.fn(async () => undefined),
  };
}

describe("DocumentManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    serializeAsJSON.mockClear();
    useAppStore.setState({ hasMountedWorkspace: false });
  });

  it("does not serialize high-frequency scene or viewport changes", async () => {
    const gateway = createGateway();
    const manager = new DocumentManager(gateway);
    const documentId = await manager.open("/tmp/drawing.excalidraw");
    const initial = manager.store.getState().sessionsById[documentId]?.scene;
    expect(initial).toBeDefined();

    manager.updateScene(documentId, {
      ...initial!,
      appState: { ...initial!.appState, scrollX: 100 },
      files: {},
    });
    expect(serializeAsJSON).not.toHaveBeenCalled();

    const edited: SceneSnapshot = {
      ...initial!,
      elements: [{ version: 1 } as SceneSnapshot["elements"][number]],
    };
    manager.updateScene(documentId, edited);
    expect(serializeAsJSON).not.toHaveBeenCalled();
    expect(gateway.saveDraft).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(serializeAsJSON).toHaveBeenCalledOnce();
    expect(gateway.saveDraft).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("checkpoints the active dirty document before opening another tab", async () => {
    const gateway = createGateway();
    const manager = new DocumentManager(gateway);
    const firstId = await manager.open("/tmp/first.excalidraw");
    const firstScene = manager.store.getState().sessionsById[firstId]?.scene;
    expect(firstScene).toBeDefined();
    manager.updateScene(firstId, {
      ...firstScene!,
      elements: [{ version: 1 } as SceneSnapshot["elements"][number]],
    });

    await manager.open("/tmp/second.excalidraw");

    expect(gateway.checkpoint).toHaveBeenCalledWith(
      "/tmp/first.excalidraw",
      expect.any(String),
      "tabSwitch",
    );
    expect(manager.store.getState().sessionsById[firstId]?.saveState).toBe(
      "clean",
    );
    manager.dispose();
  });

  it("reuses the existing session when the same file is opened twice", async () => {
    const gateway = createGateway();
    const manager = new DocumentManager(gateway);

    const firstId = await manager.open("/tmp/drawing.excalidraw");
    const secondId = await manager.open("/tmp/drawing.excalidraw");

    expect(secondId).toBe(firstId);
    expect(gateway.open).toHaveBeenCalledOnce();
    expect(Object.keys(manager.store.getState().sessionsById)).toEqual([
      firstId,
    ]);
    manager.dispose();
  });

  it("owns tab order, active identity, and derived path-title-dirty-orphan facts", async () => {
    const gateway = createGateway();
    const manager = new DocumentManager(gateway);
    const firstId = await manager.open("/tmp/first.excalidraw");
    const secondId = await manager.open("/tmp/second.excalidraw");
    const state = manager.store.getState() as typeof manager.store extends {
      getState(): infer State;
    }
      ? State & { tabOrder: string[]; activeDocumentId: string | null }
      : never;

    expect(state.tabOrder).toEqual([firstId, secondId]);
    expect(state.activeDocumentId).toBe(secondId);
    expect(state.sessionsById[firstId]).toMatchObject({
      path: "/tmp/first.excalidraw",
      title: "first.excalidraw",
      saveState: "clean",
    });
    expect(useAppStore.getState()).not.toHaveProperty("tabsById");
    expect(useAppStore.getState()).not.toHaveProperty("tabOrder");
    expect(useAppStore.getState()).not.toHaveProperty("activeTabId");
    manager.dispose();
  });

  it("checkpoints descendants and applies returned path migrations atomically", async () => {
    const gateway = createGateway();
    const manager = new DocumentManager(gateway);
    const firstId = await manager.open("/workspace/folder/first.excalidraw");
    const secondId = await manager.open("/workspace/folder/second.excalidraw");
    for (const id of [firstId, secondId]) {
      const scene = manager.store.getState().sessionsById[id]?.scene;
      manager.updateScene(id, {
        ...scene!,
        elements: [{ version: 2 } as SceneSnapshot["elements"][number]],
      });
    }
    const execute = vi.fn(
      async (expectedOpenDocuments: ExpectedOpenDocument[]) => ({
        pathMigrations: expectedOpenDocuments.map((document) => ({
          oldRelativePath: document.relativePath,
          newRelativePath: document.relativePath.replace("folder/", "renamed/"),
          oldCanonicalPath: `/workspace/${document.relativePath}`,
          newCanonicalPath: `/workspace/${document.relativePath.replace("folder/", "renamed/")}`,
        })),
      }),
    );

    await manager.coordinateEntryRename(
      "/workspace",
      "/workspace/folder",
      execute,
    );

    expect(execute).toHaveBeenCalledWith([
      { relativePath: "folder/first.excalidraw", baseHash: "next" },
      { relativePath: "folder/second.excalidraw", baseHash: "next" },
    ]);
    expect(manager.store.getState().sessionsById[firstId]?.path).toBe(
      "/workspace/renamed/first.excalidraw",
    );
    expect(manager.store.getState().sessionsById[secondId]?.path).toBe(
      "/workspace/renamed/second.excalidraw",
    );
    manager.dispose();
  });

  it("cancels rename before the backend when a prepared revision changes", async () => {
    const gateway = createGateway();
    const manager = new DocumentManager(gateway);
    const id = await manager.open("/workspace/folder/drawing.excalidraw");
    const initial = manager.store.getState().sessionsById[id]?.scene;
    manager.updateScene(id, {
      ...initial!,
      elements: [{ version: 1 } as SceneSnapshot["elements"][number]],
    });
    vi.mocked(gateway.checkpoint).mockImplementationOnce(async () => {
      manager.updateScene(id, {
        ...initial!,
        elements: [{ version: 2 } as SceneSnapshot["elements"][number]],
      });
      return { newBaseHash: "changed", mtime: 2 };
    });
    const execute = vi.fn(async () => ({ pathMigrations: [] }));

    await expect(
      manager.coordinateEntryRename("/workspace", "/workspace/folder", execute),
    ).rejects.toThrow("changed during rename preparation");
    expect(execute).not.toHaveBeenCalled();
    expect(manager.store.getState().sessionsById[id]?.path).toBe(
      "/workspace/folder/drawing.excalidraw",
    );
    manager.dispose();
  });

  it("blocks dirty deletion and disposes a clean session only after commit", async () => {
    const gateway = createGateway();
    const manager = new DocumentManager(gateway);
    const id = await manager.open("/workspace/drawing.excalidraw");
    const scene = manager.store.getState().sessionsById[id]?.scene;
    manager.updateScene(id, {
      ...scene!,
      elements: [{ version: 1 } as SceneSnapshot["elements"][number]],
    });
    expect(manager.entryDeleteBlock("/workspace/drawing.excalidraw")).toBe(id);
    await manager.checkpoint(id);
    const execute = vi.fn(async () => ({ operationId: "delete-1" }));

    await manager.coordinateCleanEntryDelete(
      "/workspace",
      "/workspace/drawing.excalidraw",
      execute,
    );

    expect(execute).toHaveBeenCalledWith({
      relativePath: "drawing.excalidraw",
      baseHash: "next",
    });
    expect(manager.store.getState().sessionsById[id]).toBeUndefined();
    expect(gateway.close).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("retargets future saves after a file is renamed", async () => {
    const gateway = createGateway();
    const manager = new DocumentManager(gateway);
    const documentId = await manager.open("/tmp/before.excalidraw");
    const scene = manager.store.getState().sessionsById[documentId]?.scene;
    expect(scene).toBeDefined();

    manager.handleFileRenamed(
      "/tmp/before.excalidraw",
      "/tmp/after.excalidraw",
    );
    manager.updateScene(documentId, {
      ...scene!,
      elements: [{ version: 1 } as SceneSnapshot["elements"][number]],
    });
    await manager.checkpoint(documentId);

    expect(manager.store.getState().sessionsById[documentId]).toMatchObject({
      path: "/tmp/after.excalidraw",
      title: "after.excalidraw",
    });
    expect(gateway.checkpoint).toHaveBeenCalledWith(
      "/tmp/after.excalidraw",
      expect.any(String),
      "manualSave",
    );
    manager.dispose();
  });

  it("marks an open document as orphaned when its file is removed", async () => {
    const gateway = createGateway();
    const manager = new DocumentManager(gateway);
    const documentId = await manager.open("/tmp/drawing.excalidraw");

    manager.handleFileRemoved("/tmp/drawing.excalidraw");

    expect(manager.store.getState().sessionsById[documentId]?.saveState).toBe(
      "orphaned",
    );
    manager.dispose();
  });

  it("connects rename and removal events to open document sessions", async () => {
    const gateway = createGateway();
    const manager = new DocumentManager(gateway);
    const documentId = await manager.open("/tmp/before.excalidraw");
    let handleEvent:
      | ((event: {
          payload: {
            path: string;
            change: "removed" | "renamed";
            newPath?: string;
          };
        }) => void)
      | undefined;
    const unlisten = vi.fn();

    await registerDocumentFileChangeEvents(manager, async (_name, handler) => {
      handleEvent = handler;
      return unlisten;
    });
    handleEvent?.({
      payload: {
        path: "/tmp/before.excalidraw",
        change: "renamed",
        newPath: "/tmp/after.excalidraw",
      },
    });
    handleEvent?.({
      payload: {
        path: "/tmp/after.excalidraw",
        change: "removed",
      },
    });

    expect(manager.store.getState().sessionsById[documentId]).toMatchObject({
      path: "/tmp/after.excalidraw",
      saveState: "orphaned",
    });
    manager.dispose();
  });

  it("loads a recovered snapshot as dirty and immediately resumes draft protection", async () => {
    const gateway = createGateway();
    const manager = new DocumentManager(gateway);
    const recoveredScene = {
      type: "excalidraw",
      version: 2,
      elements: [{ version: 7 }],
      appState: { name: "Recovered" },
      files: {},
    };

    const documentId = await manager.restore(
      "/tmp/recovered.excalidraw",
      recoveredScene,
    );

    expect(manager.store.getState().sessionsById[documentId]).toMatchObject({
      path: "/tmp/recovered.excalidraw",
      saveState: "dirty",
      revision: 0,
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(gateway.saveDraft).toHaveBeenCalledWith(
      "/tmp/recovered.excalidraw",
      expect.any(String),
    );
    manager.dispose();
  });

  it("increments revision when restoring a snapshot onto an open document", async () => {
    const gateway = createGateway();
    const manager = new DocumentManager(gateway);
    const documentId = await manager.open("/tmp/recovered.excalidraw");
    expect(manager.store.getState().sessionsById[documentId]?.revision).toBe(0);

    const restoredId = await manager.restore("/tmp/recovered.excalidraw", {
      type: "excalidraw",
      version: 2,
      elements: [{ version: 7 }],
      appState: { name: "Recovered" },
      files: {},
    });

    expect(restoredId).toBe(documentId);
    expect(manager.store.getState().sessionsById[documentId]).toMatchObject({
      saveState: "dirty",
      sceneVersion: 7,
      revision: 1,
    });
    manager.dispose();
  });

  it("reloads a clean document from disk and resets the base hash", async () => {
    const gateway = createGateway();
    const manager = new DocumentManager(gateway);
    const documentId = await manager.open("/tmp/drawing.excalidraw");
    vi.mocked(gateway.open).mockResolvedValueOnce({
      scene: {
        type: "excalidraw",
        version: 2,
        elements: [{ version: 9 }],
        appState: {},
        files: {},
      },
      baseHash: "external-hash",
      hasNewerDraft: false,
    });

    await manager.reloadFromDisk(documentId);

    const session = manager.store.getState().sessionsById[documentId];
    expect(session?.saveState).toBe("clean");
    expect(session?.baseHash).toBe("external-hash");
    expect(session?.sceneVersion).toBe(9);
    expect(session?.revision).toBe(1);
    expect(session?.lastReloadedAt).not.toBeNull();
    manager.dispose();
  });

  it("resolves takeExternal by adopting the external scene as clean", async () => {
    const gateway = createGateway();
    const manager = new DocumentManager(gateway);
    const documentId = await manager.open("/tmp/drawing.excalidraw");
    manager.beginConflict(documentId, {
      externalMtime: 1,
      localDraftUpdatedAt: 2,
    });
    vi.mocked(gateway.resolveConflict).mockResolvedValueOnce({
      scene: {
        type: "excalidraw",
        version: 2,
        elements: [{ version: 5 }],
        appState: {},
        files: {},
      },
      newBaseHash: "external",
    });

    await manager.resolveConflict(documentId, "takeExternal");

    const session = manager.store.getState().sessionsById[documentId];
    expect(session?.saveState).toBe("clean");
    expect(session?.baseHash).toBe("external");
    expect(session?.sceneVersion).toBe(5);
    expect(session?.revision).toBe(1);
    expect(session?.conflictInfo).toBeNull();
    manager.dispose();
  });

  it("resolves keepLocal by keeping the draft and rebasing on the external version", async () => {
    const gateway = createGateway();
    const manager = new DocumentManager(gateway);
    const documentId = await manager.open("/tmp/drawing.excalidraw");
    const initial = manager.store.getState().sessionsById[documentId]?.scene;
    manager.updateScene(documentId, {
      ...initial!,
      elements: [{ version: 3 } as SceneSnapshot["elements"][number]],
    });
    manager.beginConflict(documentId, {
      externalMtime: 1,
      localDraftUpdatedAt: 2,
    });
    vi.mocked(gateway.resolveConflict).mockResolvedValueOnce({
      newBaseHash: "external",
    });

    await manager.resolveConflict(documentId, "keepLocal");

    const session = manager.store.getState().sessionsById[documentId];
    expect(session?.saveState).toBe("dirty");
    expect(session?.baseHash).toBe("external");
    expect(session?.conflictInfo).toBeNull();
    manager.dispose();
  });

  it("resolves saveAsNew by rebasing the session onto the new path as clean", async () => {
    const gateway = createGateway();
    const manager = new DocumentManager(gateway);
    const documentId = await manager.open("/tmp/drawing.excalidraw");
    manager.beginConflict(documentId, {
      externalMtime: 1,
      localDraftUpdatedAt: 2,
    });
    vi.mocked(gateway.resolveConflict).mockResolvedValueOnce({
      newBaseHash: "copy-hash",
    });

    await manager.resolveConflict(
      documentId,
      "saveAsNew",
      "/tmp/copy.excalidraw",
    );

    expect(gateway.resolveConflict).toHaveBeenCalledWith(
      "/tmp/drawing.excalidraw",
      "saveAsNew",
      "/tmp/copy.excalidraw",
    );
    const session = manager.store.getState().sessionsById[documentId];
    expect(session?.saveState).toBe("clean");
    expect(session?.path).toBe("/tmp/copy.excalidraw");
    expect(session?.title).toBe("copy.excalidraw");
    expect(session?.baseHash).toBe("copy-hash");
    manager.dispose();
  });

  it("saves an orphaned document to a new location and marks it clean", async () => {
    const gateway = createGateway();
    const manager = new DocumentManager(gateway);
    const documentId = await manager.open("/tmp/gone.excalidraw");
    manager.handleFileRemoved("/tmp/gone.excalidraw");
    vi.mocked(gateway.checkpoint).mockResolvedValueOnce({
      newBaseHash: "orphan-copy",
      mtime: 3,
    });

    await manager.saveOrphanedAs(documentId, "/tmp/saved.excalidraw");

    expect(gateway.checkpoint).toHaveBeenCalledWith(
      "/tmp/saved.excalidraw",
      expect.any(String),
      "manualSave",
    );
    expect(gateway.close).toHaveBeenCalledWith(
      "/tmp/gone.excalidraw",
      "discardOrphan",
    );
    const session = manager.store.getState().sessionsById[documentId];
    expect(session?.saveState).toBe("clean");
    expect(session?.path).toBe("/tmp/saved.excalidraw");
    manager.dispose();
  });

  describe("US3 close and activation", () => {
    type CloseOutcome =
      | { status: "closed" }
      | { status: "orphaned"; documentId: string }
      | { status: "failed"; documentId: string; message: string }
      | { status: "cancelled" }
      | { status: "inFlight" };

    function getCloseMany(
      manager: DocumentManager,
    ): (documentIds: readonly string[]) => Promise<CloseOutcome> {
      const closeMany = Reflect.get(manager, "closeMany");
      if (typeof closeMany !== "function") {
        throw new Error("DocumentManager.closeMany is not implemented");
      }
      return (closeMany as (documentIds: readonly string[]) => Promise<CloseOutcome>).bind(
        manager,
      );
    }

    function getConfirmOrphanClose(
      manager: DocumentManager,
    ): (
      documentId: string,
      decision: "saveAs" | "discard" | "cancel",
      saveAsPath?: string,
    ) => Promise<CloseOutcome> {
      const confirmOrphanClose = Reflect.get(manager, "confirmOrphanClose");
      if (typeof confirmOrphanClose !== "function") {
        throw new Error(
          "DocumentManager.confirmOrphanClose is not implemented",
        );
      }
      return (
        confirmOrphanClose as (
          documentId: string,
          decision: "saveAs" | "discard" | "cancel",
          saveAsPath?: string,
        ) => Promise<CloseOutcome>
      ).bind(manager);
    }

    function markDirty(manager: DocumentManager, documentId: string): void {
      const scene = manager.store.getState().sessionsById[documentId]?.scene;
      expect(scene).toBeDefined();
      manager.updateScene(documentId, {
        ...scene!,
        elements: [{ version: 1 } as SceneSnapshot["elements"][number]],
      });
    }

    it("joins a repeated close of the same document into one in-flight operation", async () => {
      const gateway = createGateway();
      const manager = new DocumentManager(gateway);
      const documentId = await manager.open("/tmp/drawing.excalidraw");
      let finishClose: () => void = () => undefined;
      vi.mocked(gateway.close).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishClose = resolve;
          }),
      );

      const first = manager.close(documentId);
      await Promise.resolve();
      await Promise.resolve();
      const duplicate = await manager.close(documentId);

      expect(duplicate).toEqual({ status: "inFlight" });
      expect(gateway.close).toHaveBeenCalledOnce();
      expect(gateway.close).toHaveBeenCalledWith(
        "/tmp/drawing.excalidraw",
        "checkpointed",
      );
      finishClose();
      await expect(first).resolves.toEqual({ status: "closed" });
      expect(manager.store.getState().sessionsById[documentId]).toBeUndefined();
      manager.dispose();
    });

    it("checkpoints a dirty available document with tabClose before closing", async () => {
      const gateway = createGateway();
      const manager = new DocumentManager(gateway);
      const documentId = await manager.open("/tmp/drawing.excalidraw");
      markDirty(manager, documentId);

      await expect(manager.close(documentId)).resolves.toEqual({
        status: "closed",
      });

      expect(gateway.checkpoint).toHaveBeenCalledWith(
        "/tmp/drawing.excalidraw",
        expect.any(String),
        "tabClose",
      );
      expect(gateway.close).toHaveBeenCalledWith(
        "/tmp/drawing.excalidraw",
        "checkpointed",
      );
      expect(manager.store.getState().tabOrder).not.toContain(documentId);
      manager.dispose();
    });

    it("returns failed and keeps the tab open when checkpoint throws", async () => {
      const gateway = createGateway();
      const manager = new DocumentManager(gateway);
      const documentId = await manager.open("/tmp/drawing.excalidraw");
      markDirty(manager, documentId);
      vi.mocked(gateway.checkpoint).mockRejectedValueOnce(
        new Error("disk is full"),
      );

      await expect(manager.close(documentId)).resolves.toEqual({
        status: "failed",
        documentId,
        message: expect.stringMatching(/disk is full/i),
      });
      expect(gateway.close).not.toHaveBeenCalled();
      expect(manager.store.getState().sessionsById[documentId]).toBeDefined();
      expect(manager.store.getState().tabOrder).toEqual([documentId]);
      manager.dispose();
    });

    it("returns orphaned without checkpointing or closing a missing path", async () => {
      const gateway = createGateway();
      const manager = new DocumentManager(gateway);
      const documentId = await manager.open("/tmp/gone.excalidraw");
      markDirty(manager, documentId);
      manager.handleFileRemoved("/tmp/gone.excalidraw");
      vi.mocked(gateway.checkpoint).mockClear();
      vi.mocked(gateway.close).mockClear();

      await expect(manager.close(documentId)).resolves.toEqual({
        status: "orphaned",
        documentId,
      });
      expect(gateway.checkpoint).not.toHaveBeenCalled();
      expect(gateway.close).not.toHaveBeenCalled();
      expect(manager.store.getState().sessionsById[documentId]?.saveState).toBe(
        "orphaned",
      );
      manager.dispose();
    });

    it("saves an orphaned document as a new file then closes it", async () => {
      const gateway = createGateway();
      const manager = new DocumentManager(gateway);
      const documentId = await manager.open("/tmp/gone.excalidraw");
      manager.handleFileRemoved("/tmp/gone.excalidraw");
      vi.mocked(gateway.checkpoint).mockClear();
      vi.mocked(gateway.close).mockClear();
      vi.mocked(gateway.checkpoint).mockResolvedValue({
        newBaseHash: "orphan-copy",
        mtime: 3,
      });

      await expect(
        getConfirmOrphanClose(manager)(
          documentId,
          "saveAs",
          "/tmp/saved.excalidraw",
        ),
      ).resolves.toEqual({ status: "closed" });
      expect(gateway.checkpoint).toHaveBeenCalledWith(
        "/tmp/saved.excalidraw",
        expect.any(String),
        "manualSave",
      );
      expect(
        vi.mocked(gateway.checkpoint).mock.calls.every(
          (call) => call[0] !== "/tmp/gone.excalidraw",
        ),
      ).toBe(true);
      expect(manager.store.getState().sessionsById[documentId]).toBeUndefined();
      manager.dispose();
    });

    it("discards an orphaned document without checkpointing the missing path", async () => {
      const gateway = createGateway();
      const manager = new DocumentManager(gateway);
      const documentId = await manager.open("/tmp/gone.excalidraw");
      manager.handleFileRemoved("/tmp/gone.excalidraw");
      vi.mocked(gateway.checkpoint).mockClear();
      vi.mocked(gateway.close).mockClear();

      await expect(
        getConfirmOrphanClose(manager)(documentId, "discard"),
      ).resolves.toEqual({ status: "closed" });
      expect(gateway.checkpoint).not.toHaveBeenCalled();
      expect(gateway.close).toHaveBeenCalledWith(
        "/tmp/gone.excalidraw",
        "discardOrphan",
      );
      expect(manager.store.getState().sessionsById[documentId]).toBeUndefined();
      manager.dispose();
    });

    it("cancels an orphaned close and leaves the session open", async () => {
      const gateway = createGateway();
      const manager = new DocumentManager(gateway);
      const documentId = await manager.open("/tmp/gone.excalidraw");
      manager.handleFileRemoved("/tmp/gone.excalidraw");
      vi.mocked(gateway.checkpoint).mockClear();
      vi.mocked(gateway.close).mockClear();

      await expect(
        getConfirmOrphanClose(manager)(documentId, "cancel"),
      ).resolves.toEqual({ status: "cancelled" });
      expect(gateway.close).not.toHaveBeenCalled();
      expect(manager.store.getState().sessionsById[documentId]).toBeDefined();
      manager.dispose();
    });

    it("closes a batch in visual tab order even when ids are requested out of order", async () => {
      const gateway = createGateway();
      const manager = new DocumentManager(gateway);
      const firstId = await manager.open("/tmp/a.excalidraw");
      const secondId = await manager.open("/tmp/b.excalidraw");
      const thirdId = await manager.open("/tmp/c.excalidraw");
      let finishFirst: () => void = () => undefined;
      vi.mocked(gateway.close).mockImplementation(async (path) => {
        if (path === "/tmp/a.excalidraw") {
          await new Promise<void>((resolve) => {
            finishFirst = resolve;
          });
        }
      });

      const pending = getCloseMany(manager)([thirdId, firstId, secondId]);
      await Promise.resolve();
      await Promise.resolve();
      expect(vi.mocked(gateway.close).mock.calls.map((call) => call[0])).toEqual(
        ["/tmp/a.excalidraw"],
      );

      finishFirst();
      await expect(pending).resolves.toEqual({ status: "closed" });
      expect(vi.mocked(gateway.close).mock.calls.map((call) => call[0])).toEqual(
        ["/tmp/a.excalidraw", "/tmp/b.excalidraw", "/tmp/c.excalidraw"],
      );
      expect(manager.store.getState().tabOrder).toEqual([]);
      manager.dispose();
    });

    it("stops a batch on the first failure and leaves unprocessed tabs open", async () => {
      const gateway = createGateway();
      const manager = new DocumentManager(gateway);
      const firstId = await manager.open("/tmp/a.excalidraw");
      const secondId = await manager.open("/tmp/b.excalidraw");
      const thirdId = await manager.open("/tmp/c.excalidraw");
      markDirty(manager, secondId);
      vi.mocked(gateway.checkpoint).mockImplementation(
        async (path, _scene, reason) => {
          if (path === "/tmp/b.excalidraw" && reason === "tabClose") {
            throw new Error("checkpoint failed");
          }
          return { newBaseHash: "next", mtime: 1 };
        },
      );

      await expect(
        getCloseMany(manager)([firstId, secondId, thirdId]),
      ).resolves.toEqual({
        status: "failed",
        documentId: secondId,
        message: expect.stringMatching(/checkpoint failed/i),
      });
      expect(manager.store.getState().tabOrder).toEqual([secondId, thirdId]);
      expect(gateway.close).toHaveBeenCalledWith(
        "/tmp/a.excalidraw",
        "checkpointed",
      );
      expect(gateway.close).not.toHaveBeenCalledWith(
        "/tmp/c.excalidraw",
        "checkpointed",
      );
      manager.dispose();
    });

    it("stops a batch at an orphaned tab until cancel, leaving remaining tabs open", async () => {
      const gateway = createGateway();
      const manager = new DocumentManager(gateway);
      const firstId = await manager.open("/tmp/a.excalidraw");
      const secondId = await manager.open("/tmp/b.excalidraw");
      const thirdId = await manager.open("/tmp/c.excalidraw");
      manager.handleFileRemoved("/tmp/b.excalidraw");

      await expect(
        getCloseMany(manager)([firstId, secondId, thirdId]),
      ).resolves.toEqual({ status: "orphaned", documentId: secondId });
      expect(manager.store.getState().tabOrder).toEqual([secondId, thirdId]);

      await expect(
        getConfirmOrphanClose(manager)(secondId, "cancel"),
      ).resolves.toEqual({ status: "cancelled" });
      expect(manager.store.getState().tabOrder).toEqual([secondId, thirdId]);
      expect(gateway.close).not.toHaveBeenCalledWith(
        "/tmp/c.excalidraw",
        "checkpointed",
      );
      manager.dispose();
    });

    it("resumes the remaining batch after an orphaned tab is discarded", async () => {
      const gateway = createGateway();
      const manager = new DocumentManager(gateway);
      const firstId = await manager.open("/tmp/a.excalidraw");
      const secondId = await manager.open("/tmp/b.excalidraw");
      const thirdId = await manager.open("/tmp/c.excalidraw");
      manager.handleFileRemoved("/tmp/b.excalidraw");

      await expect(
        getCloseMany(manager)([firstId, secondId, thirdId]),
      ).resolves.toEqual({ status: "orphaned", documentId: secondId });

      await expect(
        getConfirmOrphanClose(manager)(secondId, "discard"),
      ).resolves.toEqual({ status: "closed" });
      expect(gateway.close).toHaveBeenCalledWith(
        "/tmp/b.excalidraw",
        "discardOrphan",
      );
      expect(gateway.close).toHaveBeenCalledWith(
        "/tmp/c.excalidraw",
        "checkpointed",
      );
      expect(manager.store.getState().tabOrder).toEqual([]);
      manager.dispose();
    });

    it("activates the right neighbor after closing the active tab", async () => {
      const gateway = createGateway();
      const manager = new DocumentManager(gateway);
      const firstId = await manager.open("/tmp/a.excalidraw");
      const secondId = await manager.open("/tmp/b.excalidraw");
      const thirdId = await manager.open("/tmp/c.excalidraw");
      await manager.activate(secondId);

      await expect(manager.close(secondId)).resolves.toEqual({
        status: "closed",
      });
      expect(manager.store.getState().activeDocumentId).toBe(thirdId);
      expect(manager.store.getState().tabOrder).toEqual([firstId, thirdId]);
      manager.dispose();
    });

    it("activates the left neighbor when the closed active tab has no right neighbor", async () => {
      const gateway = createGateway();
      const manager = new DocumentManager(gateway);
      const firstId = await manager.open("/tmp/a.excalidraw");
      const secondId = await manager.open("/tmp/b.excalidraw");
      const thirdId = await manager.open("/tmp/c.excalidraw");
      expect(manager.store.getState().activeDocumentId).toBe(thirdId);

      await expect(manager.close(thirdId)).resolves.toEqual({
        status: "closed",
      });
      expect(manager.store.getState().activeDocumentId).toBe(secondId);
      expect(manager.store.getState().tabOrder).toEqual([firstId, secondId]);
      manager.dispose();
    });

    it("clears the active document after closing the last tab without quitting", async () => {
      const gateway = createGateway();
      const manager = new DocumentManager(gateway);
      const documentId = await manager.open("/tmp/only.excalidraw");

      await expect(manager.close(documentId)).resolves.toEqual({
        status: "closed",
      });
      expect(manager.store.getState().activeDocumentId).toBeNull();
      expect(manager.store.getState().tabOrder).toEqual([]);
      expect(manager.store.getState().sessionsById).toEqual({});
      manager.dispose();
    });

    it("activates only the latest intent after an in-flight activation completes", async () => {
      const gateway = createGateway();
      const manager = new DocumentManager(gateway);
      const firstId = await manager.open("/tmp/a.excalidraw");
      const secondId = await manager.open("/tmp/b.excalidraw");
      const thirdId = await manager.open("/tmp/c.excalidraw");
      markDirty(manager, thirdId);
      let finishCheckpoint: () => void = () => undefined;
      vi.mocked(gateway.checkpoint).mockImplementation(
        () =>
          new Promise((resolve) => {
            finishCheckpoint = () =>
              resolve({ newBaseHash: "next", mtime: 1 });
          }),
      );

      const seenActive: string[] = [];
      const unsubscribe = manager.store.subscribe((state) => {
        if (state.activeDocumentId !== null) {
          seenActive.push(state.activeDocumentId);
        }
      });

      const inFlight = manager.activate(firstId);
      await Promise.resolve();
      void manager.activate(secondId);
      void manager.activate(thirdId);
      finishCheckpoint();
      await inFlight;
      await Promise.resolve();
      await Promise.resolve();
      unsubscribe();

      expect(manager.store.getState().activeDocumentId).toBe(thirdId);
      expect(seenActive).not.toContain(secondId);
      manager.dispose();
    });
  });
});

