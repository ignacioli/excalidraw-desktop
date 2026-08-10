import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../app/store";
import type { SceneSnapshot } from "../editor/sceneSerializer";
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
    useAppStore.setState({
      tabsById: {},
      tabOrder: [],
      activeTabId: null,
      hasMountedWorkspace: false,
    });
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
    expect(useAppStore.getState().tabsById[documentId]).toMatchObject({
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
    expect(useAppStore.getState().tabsById[documentId]?.isOrphaned).toBe(true);
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
    });
    expect(useAppStore.getState().tabsById[documentId]?.isDirty).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(gateway.saveDraft).toHaveBeenCalledWith(
      "/tmp/recovered.excalidraw",
      expect.any(String),
    );
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
    expect(session?.lastReloadedAt).not.toBeNull();
    expect(useAppStore.getState().tabsById[documentId]?.isDirty).toBe(false);
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
    expect(useAppStore.getState().tabsById[documentId]?.isDirty).toBe(true);
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
    expect(gateway.close).toHaveBeenCalledWith("/tmp/gone.excalidraw", true);
    const session = manager.store.getState().sessionsById[documentId];
    expect(session?.saveState).toBe("clean");
    expect(session?.path).toBe("/tmp/saved.excalidraw");
    expect(useAppStore.getState().tabsById[documentId]?.isOrphaned).toBe(false);
    manager.dispose();
  });
});
