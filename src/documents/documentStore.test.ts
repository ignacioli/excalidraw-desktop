import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../app/store";
import type { SceneSnapshot } from "../editor/sceneSerializer";
import type { DocumentGateway } from "./documentGateway";
import { DocumentManager } from "./documentStore";

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
});
