import { createStore } from "zustand/vanilla";
import { describe, expect, it, vi } from "vitest";
import type { HistoryClient, HistoryOperationStatusResponse } from "./types";
import { HistoryCoordinator } from "./historyCoordinator";
import {
  HistoryReplacementBlockedError,
  HistoryReplacementCancelledError,
  HistoryReplacementRequiresSaveError,
} from "./historyCoordinator";
import { HistoryReplaceStatusError } from "./historyClient";
import { DocumentManager } from "../documents/documentStore";
import type { DocumentGateway } from "../documents/documentGateway";
import { serializeScene } from "../editor/sceneSerializer";

vi.mock("../editor/sceneSerializer", () => ({
  serializeScene: vi.fn(() => '{"type":"excalidraw","elements":[],"files":{}}'),
  deserializeSceneData: vi.fn((value) => value),
}));

vi.mock("@excalidraw/excalidraw", () => ({
  getSceneVersion: (elements: ReadonlyArray<{ version?: number }>) =>
    elements.reduce((total, element) => total + (element.version ?? 0), 0),
}));

const scene = {
  elements: [],
  appState: {},
  files: {},
};

function createManager(current = true) {
  const state = createStore(() => ({
    sessionsById: {
      doc: {
        id: "doc",
        historyDocumentId: "history-doc",
        path: "/workspace/doc.excalidraw",
        title: "doc.excalidraw",
        scene,
        sceneVersion: 0,
        sessionGeneration: 4,
        revision: 9,
        baseHash: "a".repeat(64),
        saveState: "dirty" as const,
        errorMessage: null,
        conflictInfo: null,
        lastReloadedAt: null,
      },
    },
    tabOrder: ["doc"],
    activeDocumentId: "doc",
  }));
  const context = {
    documentId: "doc",
    path: "/workspace/doc.excalidraw",
    baseHash: "a".repeat(64),
    sessionGeneration: 4,
    revision: 9,
    isCurrent: () => current,
  };
  const manager = {
    store: state,
    runHistoryReplacement: vi.fn(async (_id, operation) => operation(context)),
    runHistoryStatus: vi.fn(async (_id, operation) => operation(context)),
    runDocumentOperation: vi.fn(async (_id, operation) => operation(context)),
    retainHistoryPending: vi.fn(),
    releaseHistoryPending: vi.fn(),
    adoptHistoryScene: vi.fn().mockReturnValue(true),
  } as unknown as DocumentManager;
  return { manager, context };
}

function clientWith(
  response: Awaited<ReturnType<HistoryClient["replace"]>>,
): HistoryClient {
  return {
    list: vi.fn(),
    preview: vi.fn(),
    mark: vi.fn().mockResolvedValue({
      versionId: "marked-1",
      recordedAt: 123,
      source: "manual",
      contentHash: "content-hash",
    }),
    replace: vi.fn().mockResolvedValue(response),
    operationStatus: vi.fn(),
  };
}

describe("HistoryCoordinator", () => {
  it("captures the click state and reports success only after history_mark replies", async () => {
    const { manager } = createManager();
    const client = clientWith({
      status: "pendingReconciliation",
      requestId: "unused",
      replacementCommitted: null,
      operationState: "pendingReconciliation",
    });
    const mark = vi.mocked(client.mark);
    const coordinator = new HistoryCoordinator(manager, client, vi.fn());

    const result = await coordinator.mark("doc", { requestId: "mark-1" });

    expect(result.status).toBe("marked");
    expect(mark).toHaveBeenCalledWith({
      document: { kind: "handle", documentId: "history-doc" },
      requestId: "mark-1",
      sessionGeneration: 4,
      revision: 9,
      currentSceneJson: serializeScene(scene),
    });
    expect(manager.store.getState().sessionsById.doc.scene).toBe(scene);
  });

  it("does not change the canvas when mark fails", async () => {
    const { manager } = createManager();
    const client = clientWith({
      status: "pendingReconciliation",
      requestId: "unused",
      replacementCommitted: null,
      operationState: "pendingReconciliation",
    });
    const error = new Error("history is unavailable");
    client.mark = vi.fn().mockRejectedValue(error);
    const coordinator = new HistoryCoordinator(manager, client, vi.fn());

    await expect(
      coordinator.mark("doc", { requestId: "mark-failed" }),
    ).rejects.toBe(error);
    expect(manager.store.getState().sessionsById.doc.scene).toBe(scene);
  });

  it("keeps the current canvas when an untitled first-save flow is cancelled", async () => {
    const { manager } = createManager();
    manager.store.setState((state) => ({
      ...state,
      sessionsById: {
        ...state.sessionsById,
        doc: {
          ...state.sessionsById.doc,
          path: "",
          historyDocumentId: undefined,
        },
      },
    }));
    const client = clientWith({
      status: "pendingReconciliation",
      requestId: "unused",
      replacementCommitted: null,
      operationState: "pendingReconciliation",
    });
    const prepareUnsaved = vi
      .fn()
      .mockResolvedValue({ status: "cancelled" as const });
    const coordinator = new HistoryCoordinator(manager, client, vi.fn());

    await expect(
      coordinator.mark("doc", { prepareUnsaved }),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(prepareUnsaved).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "",
        scene,
        sceneJson: serializeScene(scene),
      }),
    );
    expect(client.mark).not.toHaveBeenCalled();
    expect(manager.store.getState().sessionsById.doc.scene).toBe(scene);
  });

  it("marks the captured untitled scene after the existing first-save flow", async () => {
    const { manager } = createManager();
    manager.store.setState((state) => ({
      ...state,
      sessionsById: {
        ...state.sessionsById,
        doc: {
          ...state.sessionsById.doc,
          path: "",
          historyDocumentId: undefined,
        },
      },
    }));
    const client = clientWith({
      status: "pendingReconciliation",
      requestId: "unused",
      replacementCommitted: null,
      operationState: "pendingReconciliation",
    });
    const prepareUnsaved = vi.fn().mockResolvedValue({
      status: "saved" as const,
      document: { kind: "path" as const, path: "/workspace/new.excalidraw" },
      sessionGeneration: 1,
      revision: 10,
    });
    const coordinator = new HistoryCoordinator(manager, client, vi.fn());

    await coordinator.mark("doc", {
      requestId: "mark-unsaved",
      prepareUnsaved,
    });

    expect(client.mark).toHaveBeenCalledWith({
      document: { kind: "path", path: "/workspace/new.excalidraw" },
      requestId: "mark-unsaved",
      sessionGeneration: 1,
      revision: 10,
      currentSceneJson: serializeScene(scene),
    });
  });

  it("routes clear and reset through the same history_replace target", async () => {
    const { manager } = createManager();
    const client = clientWith({
      status: "completed",
      requestId: "clear-1",
      replacementCommitted: true,
      protectionVersionId: "protected-clear",
      adoptedScene: { type: "excalidraw", elements: [], files: {} },
      newBaseHash: "b".repeat(64),
      newSessionGeneration: 5,
    });
    const coordinator = new HistoryCoordinator(manager, client, vi.fn());

    await coordinator.clear("doc", "clear-1");
    await coordinator.reset("doc", "reset-1");

    expect(client.replace).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        requestId: "clear-1",
        target: { kind: "clear" },
      }),
    );
    expect(client.replace).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        requestId: "reset-1",
        target: { kind: "clear" },
      }),
    );
  });

  it("accepts only a parsed import candidate on the import target path", async () => {
    const { manager } = createManager();
    const client = clientWith({
      status: "completed",
      requestId: "import-1",
      replacementCommitted: true,
      protectionVersionId: "protected-import",
      adoptedScene: { type: "excalidraw", elements: [], files: {} },
      newBaseHash: "b".repeat(64),
      newSessionGeneration: 5,
    });
    const coordinator = new HistoryCoordinator(manager, client, vi.fn());
    const candidate = {
      kind: "import" as const,
      format: "excalidraw" as const,
      sourceName: "drawing.excalidraw",
      scene,
      candidateSceneJson:
        '{"type":"excalidraw","version":2,"elements":[],"files":{}}',
    };

    await coordinator.replaceImportedScene("doc", candidate, "import-1");

    expect(client.replace).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "import-1",
        target: {
          kind: "import",
          candidateSceneJson: candidate.candidateSceneJson,
        },
      }),
    );
  });

  it("blocks an untitled replacement when the existing first-save flow is cancelled", async () => {
    const { manager } = createManager();
    manager.store.setState((state) => ({
      ...state,
      sessionsById: {
        ...state.sessionsById,
        doc: {
          ...state.sessionsById.doc,
          path: "",
          historyDocumentId: undefined,
        },
      },
    }));
    const client = clientWith({
      status: "completed",
      requestId: "cancelled-replace",
      replacementCommitted: true,
      protectionVersionId: "never-created",
      adoptedScene: { type: "excalidraw", elements: [], files: {} },
      newBaseHash: "b".repeat(64),
      newSessionGeneration: 5,
    });
    const prepareUnsaved = vi
      .fn()
      .mockResolvedValue({ status: "cancelled" as const });
    const coordinator = new HistoryCoordinator(manager, client, vi.fn());

    await expect(
      coordinator.clear("doc", "cancelled-replace", { prepareUnsaved }),
    ).rejects.toBeInstanceOf(HistoryReplacementCancelledError);
    expect(client.replace).not.toHaveBeenCalled();
  });

  it("requires a successful first save before replacing an untitled drawing", async () => {
    const { manager } = createManager();
    manager.store.setState((state) => ({
      ...state,
      sessionsById: {
        ...state.sessionsById,
        doc: {
          ...state.sessionsById.doc,
          path: "",
          historyDocumentId: undefined,
        },
      },
    }));
    const coordinator = new HistoryCoordinator(
      manager,
      clientWith({
        status: "completed",
        requestId: "requires-save",
        replacementCommitted: true,
        protectionVersionId: "never-created",
        adoptedScene: { type: "excalidraw", elements: [], files: {} },
        newBaseHash: "b".repeat(64),
        newSessionGeneration: 5,
      }),
      vi.fn(),
    );

    await expect(
      coordinator.clear("doc", "requires-save"),
    ).rejects.toBeInstanceOf(HistoryReplacementRequiresSaveError);
  });

  it("reuses the first-save document locator even when the caller owns session binding", async () => {
    const { manager } = createManager();
    manager.store.setState((state) => ({
      ...state,
      sessionsById: {
        ...state.sessionsById,
        doc: {
          ...state.sessionsById.doc,
          path: "",
          historyDocumentId: undefined,
        },
      },
    }));
    const client = clientWith({
      status: "completed",
      requestId: "saved-replace",
      replacementCommitted: true,
      protectionVersionId: "protected-saved-replace",
      adoptedScene: { type: "excalidraw", elements: [], files: {} },
      newBaseHash: "b".repeat(64),
      newSessionGeneration: 5,
    });
    const coordinator = new HistoryCoordinator(manager, client, vi.fn());

    await coordinator.clear("doc", "saved-replace", {
      prepareUnsaved: vi.fn().mockResolvedValue({
        status: "saved" as const,
        document: { kind: "path" as const, path: "/workspace/new.excalidraw" },
      }),
    });

    expect(client.replace).toHaveBeenCalledWith(
      expect.objectContaining({
        document: { kind: "path", path: "/workspace/new.excalidraw" },
      }),
    );
  });

  it("blocks replacement before history_replace when the document is conflicted", async () => {
    const { manager } = createManager();
    manager.store.setState((state) => ({
      ...state,
      sessionsById: {
        ...state.sessionsById,
        doc: { ...state.sessionsById.doc, saveState: "conflicted" as const },
      },
    }));
    const client = clientWith({
      status: "completed",
      requestId: "conflict-replace",
      replacementCommitted: true,
      protectionVersionId: "never-created",
      adoptedScene: { type: "excalidraw", elements: [], files: {} },
      newBaseHash: "b".repeat(64),
      newSessionGeneration: 5,
    });
    const coordinator = new HistoryCoordinator(manager, client, vi.fn());

    await expect(coordinator.clear("doc", "conflict-replace")).rejects.toEqual(
      expect.any(HistoryReplacementBlockedError),
    );
    expect(client.replace).not.toHaveBeenCalled();
  });

  it("captures one document version and adopts one completed response", async () => {
    const { manager, context } = createManager();
    const adopt = vi.fn((_scene, context) => context.commit(_scene));
    const coordinator = new HistoryCoordinator(
      manager,
      clientWith({
        status: "completed",
        requestId: "request-1",
        replacementCommitted: true,
        protectionVersionId: "protected-1",
        adoptedScene: { type: "excalidraw", elements: [], files: {} },
        newBaseHash: "b".repeat(64),
        newSessionGeneration: 5,
      }),
      adopt,
    );

    const result = await coordinator.replace(
      "doc",
      { kind: "clear" },
      "request-1",
    );

    expect(result.adopted).toBe(true);
    expect(adopt).toHaveBeenCalledOnce();
    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({ elements: [], files: {} }),
      expect.objectContaining({
        documentId: "doc",
        capturedVersion: context,
      }),
    );
  });

  it("uses the real DocumentManager commit seam and accepts its generation advance", async () => {
    const gateway: DocumentGateway = {
      open: vi.fn(async () => ({
        scene,
        baseHash: "a".repeat(64),
        hasNewerDraft: false,
      })),
      saveDraft: vi.fn(async () => ({ contentHash: "draft", savedAt: 1 })),
      checkpoint: vi.fn(async () => ({
        newBaseHash: "b".repeat(64),
        mtime: 1,
      })),
      resolveConflict: vi.fn(async () => ({ newBaseHash: "b".repeat(64) })),
      close: vi.fn(async () => undefined),
    };
    const manager = new DocumentManager(gateway);
    const documentId = await manager.open("/tmp/real-commit.excalidraw");
    const response = {
      status: "completed" as const,
      requestId: "request-real-commit",
      replacementCommitted: true as const,
      protectionVersionId: "protected-real-commit",
      adoptedScene: {
        type: "excalidraw",
        elements: [{ id: "new" }],
        files: {},
      },
      newBaseHash: "c".repeat(64),
      newSessionGeneration: 1,
    };
    const adopt = vi.fn(async (nextScene, context) =>
      context.commit(nextScene),
    );
    const coordinator = new HistoryCoordinator(
      manager,
      clientWith(response),
      adopt,
    );

    await expect(
      coordinator.replace(documentId, { kind: "clear" }, "request-real-commit"),
    ).resolves.toMatchObject({ adopted: true });
    expect(manager.store.getState().sessionsById[documentId]).toMatchObject({
      sessionGeneration: 1,
      baseHash: "c".repeat(64),
      saveState: "clean",
    });
    manager.dispose();
  });

  it("rejects an autosave callback captured before replacement adoption", async () => {
    const gateway: DocumentGateway = {
      open: vi.fn(async () => ({
        scene,
        baseHash: "a".repeat(64),
        hasNewerDraft: false,
      })),
      saveDraft: vi.fn(async () => ({ contentHash: "draft", savedAt: 1 })),
      checkpoint: vi.fn(async () => ({
        newBaseHash: "b".repeat(64),
        mtime: 1,
      })),
      resolveConflict: vi.fn(async () => ({ newBaseHash: "b".repeat(64) })),
      close: vi.fn(async () => undefined),
    };
    const manager = new DocumentManager(gateway);
    const documentId = await manager.open(
      "/tmp/history-coordinator-stale.excalidraw",
    );
    const probe = manager.prepareHistoryAutosaveProbe(documentId);
    expect(probe).toBeDefined();
    const response = {
      status: "completed" as const,
      requestId: "request-stale-autosave",
      replacementCommitted: true as const,
      protectionVersionId: "protected-stale-autosave",
      adoptedScene: {
        type: "excalidraw",
        elements: [{ id: "adopted" }],
        files: {},
      },
      newBaseHash: "c".repeat(64),
      newSessionGeneration: 1,
    };
    const coordinator = new HistoryCoordinator(
      manager,
      clientWith(response),
      async (nextScene, context) => context.commit(nextScene),
    );

    await expect(
      coordinator.replace(
        documentId,
        { kind: "clear" },
        "request-stale-autosave",
      ),
    ).resolves.toMatchObject({ adopted: true });
    await expect(probe!.queue()).resolves.toMatchObject({
      status: "rejected",
      rejection: "sessionGeneration",
    });
    expect(gateway.saveDraft).not.toHaveBeenCalled();
    expect(manager.store.getState().sessionsById[documentId]).toMatchObject({
      saveState: "clean",
      sessionGeneration: 1,
    });
    manager.dispose();
  });

  it("does not write a late response after the captured version is stale", async () => {
    const { manager } = createManager(false);
    const adopt = vi.fn((_scene, context) => context.commit(_scene));
    const coordinator = new HistoryCoordinator(
      manager,
      clientWith({
        status: "completed",
        requestId: "request-2",
        replacementCommitted: true,
        protectionVersionId: "protected-2",
        adoptedScene: { type: "excalidraw", elements: [], files: {} },
        newBaseHash: "c".repeat(64),
        newSessionGeneration: 6,
      }),
      adopt,
    );

    await expect(
      coordinator.replace("doc", { kind: "clear" }, "request-2"),
    ).resolves.toMatchObject({ adopted: false });
    expect(adopt).not.toHaveBeenCalled();
  });

  it("adopts a completed status once and never replays replace", async () => {
    const { manager } = createManager();
    const adopt = vi.fn((_scene, context) => context.commit(_scene));
    const status: HistoryOperationStatusResponse = {
      requestId: "request-3",
      state: "completed",
      replacementCommitted: true,
      protectionVersionId: "protected-3",
      adoptedScene: { type: "excalidraw", elements: [], files: {} },
      newBaseHash: "d".repeat(64),
      newSessionGeneration: 7,
    };
    const client = clientWith({
      status: "pendingReconciliation",
      requestId: "request-3",
      replacementCommitted: null,
      operationState: "pendingReconciliation",
    });
    client.operationStatus = vi.fn().mockResolvedValue(status);
    const coordinator = new HistoryCoordinator(manager, client, adopt);

    await coordinator.replace("doc", { kind: "clear" }, "request-3");
    await coordinator.resolvePending("doc", "request-3");
    await coordinator.resolvePending("doc", "request-3");

    expect(client.replace).toHaveBeenCalledOnce();
    expect(client.operationStatus).toHaveBeenCalledTimes(2);
    expect(adopt).toHaveBeenCalledOnce();
  });

  it("retains pending when disk committed but display access is unavailable", async () => {
    const { manager } = createManager();
    const client = clientWith({
      status: "pendingReconciliation",
      requestId: "display-retry",
      replacementCommitted: null,
      operationState: "pendingReconciliation",
    });
    client.operationStatus = vi.fn().mockResolvedValue({
      requestId: "display-retry",
      state: "pendingReconciliation",
      replacementCommitted: true,
    } satisfies HistoryOperationStatusResponse);
    const adopt = vi.fn();
    const coordinator = new HistoryCoordinator(manager, client, adopt);
    await coordinator.replace("doc", { kind: "clear" }, "display-retry");
    await coordinator.resolvePending("doc", "display-retry");
    expect(manager.retainHistoryPending).toHaveBeenLastCalledWith(
      "doc",
      "display-retry",
    );
    expect(manager.releaseHistoryPending).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
    expect(client.replace).toHaveBeenCalledOnce();
  });

  it("does not freeze the document after a structured replacement error", async () => {
    const { manager } = createManager();
    const error = { code: "HISTORY_BUSY", message: "busy", retriable: true };
    const client = clientWith({
      status: "pendingReconciliation",
      requestId: "request-error",
      replacementCommitted: null,
      operationState: "pendingReconciliation",
    });
    client.replace = vi.fn().mockRejectedValue(error);
    const coordinator = new HistoryCoordinator(manager, client, vi.fn());

    await expect(
      coordinator.replace("doc", { kind: "clear" }, "request-error"),
    ).rejects.toEqual(error);
    expect(manager.retainHistoryPending).not.toHaveBeenCalled();
    expect(manager.releaseHistoryPending).toHaveBeenCalledWith(
      "doc",
      "request-error",
    );
  });

  it("surfaces an aborted pending operation and releases its freeze", async () => {
    const { manager } = createManager();
    const client = clientWith({
      status: "pendingReconciliation",
      requestId: "request-aborted",
      replacementCommitted: null,
      operationState: "pendingReconciliation",
    });
    client.operationStatus = vi.fn().mockResolvedValue({
      requestId: "request-aborted",
      state: "aborted",
      replacementCommitted: false,
    });
    const coordinator = new HistoryCoordinator(manager, client, vi.fn());

    await coordinator.replace("doc", { kind: "clear" }, "request-aborted");
    await expect(
      coordinator.resolvePending("doc", "request-aborted"),
    ).rejects.toBeInstanceOf(HistoryReplaceStatusError);
    expect(manager.releaseHistoryPending).toHaveBeenCalledWith(
      "doc",
      "request-aborted",
    );
  });

  it("defers completed adoption while inactive and converges after tab switch", async () => {
    const { manager } = createManager();
    const adopt = vi.fn((_scene, context) => context.commit(_scene));
    const completed = {
      status: "completed" as const,
      requestId: "request-inactive",
      replacementCommitted: true as const,
      protectionVersionId: "protected-inactive",
      adoptedScene: { type: "excalidraw", elements: [], files: {} },
      newBaseHash: "e".repeat(64),
      newSessionGeneration: 5,
    };
    const client = clientWith(completed);
    client.replace = vi.fn(async () => {
      manager.store.setState({ activeDocumentId: "other" });
      return completed;
    });
    const coordinator = new HistoryCoordinator(manager, client, adopt);

    const result = await coordinator.replace(
      "doc",
      { kind: "clear" },
      "request-inactive",
    );
    expect(result.adopted).toBe(false);
    expect(adopt).not.toHaveBeenCalled();

    manager.store.setState({ activeDocumentId: "doc" });
    await expect(coordinator.adoptDeferred("doc")).resolves.toBe(true);
    expect(adopt).toHaveBeenCalledOnce();
    expect(manager.releaseHistoryPending).toHaveBeenCalledWith(
      "doc",
      "request-inactive",
    );
  });

  it("keeps the freeze when async adoption loses the tab or fails", async () => {
    const { manager } = createManager();
    const completed = {
      status: "completed" as const,
      requestId: "request-async",
      replacementCommitted: true as const,
      protectionVersionId: "protected-async",
      adoptedScene: { type: "excalidraw", elements: [], files: {} },
      newBaseHash: "f".repeat(64),
      newSessionGeneration: 5,
    };
    let finishAdoption: () => void = () => undefined;
    const adopt = vi.fn(
      (_scene, context) =>
        new Promise<boolean>((resolve) => {
          finishAdoption = () => resolve(context.commit(_scene));
        }),
    );
    const coordinator = new HistoryCoordinator(
      manager,
      clientWith(completed),
      adopt,
    );
    const replacement = coordinator.replace(
      "doc",
      { kind: "clear" },
      "request-async",
    );
    await Promise.resolve();
    manager.store.setState({ activeDocumentId: "other" });
    finishAdoption();
    await expect(replacement).resolves.toMatchObject({ adopted: false });
    expect(manager.retainHistoryPending).toHaveBeenCalledWith(
      "doc",
      "request-async",
    );

    manager.store.setState({ activeDocumentId: "doc" });
    const failingCoordinator = new HistoryCoordinator(
      manager,
      clientWith({ ...completed, requestId: "request-failure" }),
      vi.fn().mockRejectedValue(new Error("asset adoption failed")),
    );
    await expect(
      failingCoordinator.replace("doc", { kind: "clear" }, "request-failure"),
    ).resolves.toMatchObject({ adopted: false });
    expect(manager.retainHistoryPending).toHaveBeenCalledWith(
      "doc",
      "request-failure",
    );
  });
});
