import type {
  AppState,
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import { describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "../editor/sceneSerializer";
import {
  applyReadonlyPreview,
  createReadonlyPreviewInitialData,
  ReadonlyPreviewAdapter,
} from "./previewAdapter";

vi.mock("@excalidraw/excalidraw", () => ({}));

describe("readonly preview adapter", () => {
  it("prepares independent initial data without touching an API", async () => {
    const scene = previewScene();
    const initialData = await createReadonlyPreviewInitialData(scene);

    expect(initialData.appState.viewModeEnabled).toBe(true);
    expect(initialData.appState).toMatchObject({
      gridModeEnabled: true,
      gridSize: 20,
      gridStep: 5,
      viewBackgroundColor: "#fff",
    });
    expect(initialData.appState).not.toHaveProperty("scrollX");
    expect(initialData.appState).not.toHaveProperty("selectedElementIds");
    expect(fileIdOf(initialData.elements[0])).toMatch(/^sha256-/u);
    expect(fileIdOf(scene.elements[0])).toBe("history-file");
    expect(scene.files["history-file"]?.dataURL).toContain("cmVk");
  });

  it("adds files before elements and enables read-only mode", async () => {
    const order: string[] = [];
    const api = fakeApi({
      addFiles: () => order.push("files"),
      updateScene: (data) => {
        order.push("scene");
        if (
          data.appState !== undefined &&
          data.appState !== null &&
          "viewModeEnabled" in data.appState
        ) {
          expect(data.appState.viewModeEnabled).toBe(true);
        }
      },
    });

    const adopted = await applyReadonlyPreview(api, previewScene());
    expect(order).toEqual([
      "files",
      "scene",
      "scene",
      "scene",
      "scene",
      "scene",
      "scene",
    ]);
    expect(adopted.appState.viewModeEnabled).toBe(true);
  });

  it("keeps the preview surface limited to loading", async () => {
    const calls: string[] = [];
    const adapter = new ReadonlyPreviewAdapter(
      fakeApi({
        addFiles: () => calls.push("files"),
        updateScene: () => calls.push("scene"),
      }),
    );

    await adapter.load(previewScene());
    expect(calls).toEqual([
      "files",
      "scene",
      "scene",
      "scene",
      "scene",
      "scene",
      "scene",
    ]);
    expect(adapter).not.toHaveProperty("save");
    expect(adapter).not.toHaveProperty("subscribe");
  });
});

function previewScene(): SceneSnapshot {
  return {
    elements: [
      {
        type: "image",
        id: "preview-image",
        fileId: "history-file",
      } as SceneSnapshot["elements"][number],
    ],
    appState: {
      gridModeEnabled: true,
      gridSize: 20,
      gridStep: 5,
      viewBackgroundColor: "#fff",
      scrollX: 120,
      viewModeEnabled: false,
      selectedElementIds: { transient: true },
    },
    files: {
      "history-file": {
        id: "history-file" as BinaryFileData["id"],
        mimeType: "image/png",
        dataURL: "data:image/png;base64,cmVk" as BinaryFileData["dataURL"],
        created: 1,
      },
    },
  };
}

function fileIdOf(
  element: SceneSnapshot["elements"][number] | undefined,
): string | null {
  return element !== undefined && "fileId" in element ? element.fileId : null;
}

function fakeApi(
  overrides: Partial<{
    addFiles: ExcalidrawImperativeAPI["addFiles"];
    updateScene: ExcalidrawImperativeAPI["updateScene"];
  }>,
): ExcalidrawImperativeAPI {
  return {
    addFiles: overrides.addFiles ?? (() => undefined),
    updateScene: overrides.updateScene ?? (() => undefined),
    getSceneElementsIncludingDeleted: () => [],
    getSceneElements: () => [],
    getAppState: () => ({ viewModeEnabled: true }) as AppState,
    getFiles: () => ({}),
    history: { clear: () => undefined },
    updateLibrary: () => undefined,
    resetScene: () => undefined,
    getName: () => "",
    scrollToContent: () => undefined,
    registerAction: () => undefined,
    refresh: () => undefined,
    setToast: () => undefined,
    id: "preview-api",
    setActiveTool: () => undefined,
    setCursor: () => undefined,
    resetCursor: () => undefined,
    toggleSidebar: () => undefined,
    updateFrameRendering: () => undefined,
    onChange: () => () => undefined,
    onPointerDown: () => () => undefined,
    onPointerUp: () => () => undefined,
    onScrollChange: () => () => undefined,
    onUserFollow: () => () => undefined,
  } as unknown as ExcalidrawImperativeAPI;
}
