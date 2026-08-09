import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentManager } from "../documents/documentStore";
import type { DocumentGateway } from "../documents/documentGateway";
import { useAppStore } from "./store";
import { createFileDialogActions, type FileDialogAdapter } from "./fileDialogs";

vi.mock("@excalidraw/excalidraw", () => ({
  getSceneVersion: (elements: ReadonlyArray<{ version?: number }>) =>
    elements.reduce((total, element) => total + (element.version ?? 0), 0),
  restore: (scene: {
    elements: readonly object[];
    appState?: object;
    files?: object;
  }) => ({
    elements: scene.elements,
    appState: scene.appState ?? {},
    files: scene.files ?? {},
  }),
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

function createHarness(paths: { open?: string | null; save?: string | null }) {
  const gateway: DocumentGateway = {
    open: vi.fn(async () => ({
      scene: {
        type: "excalidraw",
        version: 2,
        elements: [],
        appState: {},
        files: {},
      },
      baseHash: "open-hash",
      hasNewerDraft: false,
    })),
    saveDraft: vi.fn(async () => ({ contentHash: "draft", savedAt: 1 })),
    checkpoint: vi.fn(async () => ({ newBaseHash: "new-hash", mtime: 1 })),
    close: vi.fn(async () => undefined),
  };
  const dialogs: FileDialogAdapter = {
    openDrawing: vi.fn(async () => paths.open ?? null),
    chooseNewDrawingPath: vi.fn(async () => paths.save ?? null),
  };
  const manager = new DocumentManager(gateway);
  return {
    actions: createFileDialogActions(dialogs, manager),
    dialogs,
    gateway,
    manager,
  };
}

describe("file dialog actions", () => {
  beforeEach(() => {
    useAppStore.setState({
      tabsById: {},
      tabOrder: [],
      activeTabId: null,
      hasMountedWorkspace: false,
    });
  });

  it("opens the selected drawing through the document gateway", async () => {
    const { actions, gateway, manager } = createHarness({
      open: "/drawings/plan.excalidraw",
    });

    const documentId = await actions.openDocument();

    expect(gateway.open).toHaveBeenCalledWith("/drawings/plan.excalidraw");
    expect(documentId).not.toBeNull();
    expect(useAppStore.getState().activeTabId).toBe(documentId);
    manager.dispose();
  });

  it("adds the standard extension and checkpoints a newly named drawing", async () => {
    const { actions, gateway, manager } = createHarness({
      save: "/drawings/untitled",
    });

    await actions.createDocument();

    expect(gateway.checkpoint).toHaveBeenCalledWith(
      "/drawings/untitled.excalidraw",
      expect.any(String),
      "manualSave",
    );
    manager.dispose();
  });

  it("does not invoke document commands when the dialog is cancelled", async () => {
    const { actions, gateway, manager } = createHarness({});

    await expect(actions.openDocument()).resolves.toBeNull();
    await expect(actions.createDocument()).resolves.toBeNull();

    expect(gateway.open).not.toHaveBeenCalled();
    expect(gateway.checkpoint).not.toHaveBeenCalled();
    manager.dispose();
  });
});
