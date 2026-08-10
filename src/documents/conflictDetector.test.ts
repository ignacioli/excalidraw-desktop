import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../app/store";
import type { SceneSnapshot } from "../editor/sceneSerializer";
import type { EventName, EventPayload } from "../ipc/contracts";
import type { EventListener } from "../ipc/events";
import { ConflictDetector } from "./conflictDetector";
import type { DocumentGateway } from "./documentGateway";
import { DocumentManager } from "./documentStore";

vi.mock("@excalidraw/excalidraw", () => ({
  getSceneVersion: (elements: ReadonlyArray<{ version?: number }>) =>
    elements.reduce((total, element) => total + (element.version ?? 0), 0),
  restore: (scene: SceneSnapshot) => scene,
  serializeAsJSON: (
    elements: readonly object[],
    appState: object,
    files: object,
  ) =>
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements,
      appState,
      files,
    }),
}));

type EventHandler<Name extends EventName> = (
  event: { payload: EventPayload<Name> },
) => void;

function createGateway(initialScene: unknown): DocumentGateway {
  return {
    open: vi.fn(async () => ({
      scene: initialScene,
      baseHash: "external-hash",
      hasNewerDraft: false,
    })),
    saveDraft: vi.fn(async () => ({ contentHash: "draft", savedAt: 1 })),
    checkpoint: vi.fn(async () => ({ newBaseHash: "next", mtime: 1 })),
    resolveConflict: vi.fn(async () => ({ newBaseHash: "resolved" })),
    close: vi.fn(async () => undefined),
  };
}

const emptyScene = {
  type: "excalidraw",
  version: 2,
  elements: [] as unknown[],
  appState: {},
  files: {},
};

describe("ConflictDetector", () => {
  beforeEach(() => {
    useAppStore.setState({
      tabsById: {},
      tabOrder: [],
      activeTabId: null,
      hasMountedWorkspace: false,
    });
  });

  it("reloads a clean document automatically when it changes on disk", async () => {
    const gateway = createGateway(emptyScene);
    const manager = new DocumentManager(gateway);
    const documentId = await manager.open("/tmp/drawing.excalidraw");
    vi.mocked(gateway.open).mockResolvedValueOnce({
      scene: {
        ...emptyScene,
        elements: [{ version: 9 }],
      },
      baseHash: "external-hash",
      hasNewerDraft: false,
    });
    const fileChanged = new Map<string, EventHandler<"file-changed">>();
    const conflictDetected = new Map<
      string,
      EventHandler<"conflict-detected">
    >();
    const detector = new ConflictDetector(manager, {
      listenFileChanged: createListener(fileChanged),
      listenConflictDetected: createListener(conflictDetected),
    });
    const unlisten = await detector.start();

    fileChanged.get("file-changed")?.({
      payload: {
        path: "/tmp/drawing.excalidraw",
        change: "modified",
        newPath: undefined,
        mtime: 100,
        contentHash: "external-hash",
      },
    });
    await vi.waitFor(() => {
      const session = manager.store.getState().sessionsById[documentId];
      expect(session?.saveState).toBe("clean");
      expect(session?.baseHash).toBe("external-hash");
      expect(session?.sceneVersion).toBe(9);
      expect(session?.lastReloadedAt).not.toBeNull();
    });
    unlisten();
    manager.dispose();
  });

  it("enters the conflicted state when a dirty document changes on disk", async () => {
    const gateway = createGateway(emptyScene);
    const manager = new DocumentManager(gateway);
    const documentId = await manager.open("/tmp/drawing.excalidraw");
    vi.mocked(gateway.open).mockClear();
    const fileChanged = new Map<string, EventHandler<"file-changed">>();
    const conflictDetected = new Map<
      string,
      EventHandler<"conflict-detected">
    >();
    const detector = new ConflictDetector(manager, {
      listenFileChanged: createListener(fileChanged),
      listenConflictDetected: createListener(conflictDetected),
      now: () => 200,
    });
    const unlisten = await detector.start();

    manager.store.setState((state) => ({
      sessionsById: {
        ...state.sessionsById,
        [documentId]: {
          ...state.sessionsById[documentId]!,
          saveState: "dirty",
        },
      },
    }));
    fileChanged.get("file-changed")?.({
      payload: {
        path: "/tmp/drawing.excalidraw",
        change: "modified",
        newPath: undefined,
        mtime: 100,
      },
    });

    const session = manager.store.getState().sessionsById[documentId];
    expect(session?.saveState).toBe("conflicted");
    expect(session?.conflictInfo).toEqual({
      externalMtime: 100,
      localDraftUpdatedAt: 200,
    });
    expect(gateway.open).not.toHaveBeenCalled();
    unlisten();
    manager.dispose();
  });

  it("fills the conflict timestamps from the conflict-detected event", async () => {
    const gateway = createGateway(emptyScene);
    const manager = new DocumentManager(gateway);
    const documentId = await manager.open("/tmp/drawing.excalidraw");
    const fileChanged = new Map<string, EventHandler<"file-changed">>();
    const conflictDetected = new Map<
      string,
      EventHandler<"conflict-detected">
    >();
    const detector = new ConflictDetector(manager, {
      listenFileChanged: createListener(fileChanged),
      listenConflictDetected: createListener(conflictDetected),
    });
    await detector.start();

    conflictDetected.get("conflict-detected")?.({
      payload: {
        path: "/tmp/drawing.excalidraw",
        externalMtime: 111,
        localDraftUpdatedAt: 222,
      },
    });
    const session = manager.store.getState().sessionsById[documentId];
    expect(session?.conflictInfo).toEqual({
      externalMtime: 111,
      localDraftUpdatedAt: 222,
    });
    manager.dispose();
  });

  it("ignores events for documents that are not open", async () => {
    const gateway = createGateway(emptyScene);
    const manager = new DocumentManager(gateway);
    const fileChanged = new Map<string, EventHandler<"file-changed">>();
    const conflictDetected = new Map<
      string,
      EventHandler<"conflict-detected">
    >();
    const detector = new ConflictDetector(manager, {
      listenFileChanged: createListener(fileChanged),
      listenConflictDetected: createListener(conflictDetected),
    });
    await detector.start();

    fileChanged.get("file-changed")?.({
      payload: {
        path: "/tmp/closed.excalidraw",
        change: "modified",
        newPath: undefined,
      },
    });
    expect(gateway.open).not.toHaveBeenCalled();
    expect(manager.store.getState().sessionsById).toEqual({});
    manager.dispose();
  });
});

function createListener<Name extends EventName>(
  listeners: Map<string, EventHandler<Name>>,
): EventListener<Name> {
  return async (name, handler) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  };
}
