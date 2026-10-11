import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import { describe, expect, it, vi } from "vitest";
import { ExcalidrawAdapter } from "./ExcalidrawAdapter";
import type { SceneSnapshot } from "./sceneSerializer";
import { deserializeScene, serializeScene } from "./sceneSerializer";

vi.mock("@excalidraw/excalidraw", () => ({
  serializeAsJSON: (
    elements: readonly unknown[],
    appState: Record<string, unknown>,
    files: Record<string, unknown>,
  ) =>
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements,
      appState,
      files,
    }),
  restore: (scene: {
    elements?: readonly SceneSnapshot["elements"][number][];
    appState?: Record<string, unknown>;
    files?: BinaryFiles;
  }) => ({
    elements: scene.elements ?? [],
    appState: scene.appState ?? {},
    files: scene.files ?? {},
  }),
}));

const OLD_FILE_ID = "sdk-file-id";
const OLD_BYTES = "data:image/png;base64,cmVk";
const NEW_BYTES = "data:image/png;base64,Ymx1ZQ==";

describe("ExcalidrawAdapter canvas preferences", () => {
  function preferenceApi(initial: Partial<AppState>) {
    let appState = {
      viewModeEnabled: false,
      gridModeEnabled: false,
      objectsSnapModeEnabled: false,
      zenModeEnabled: false,
      activeTool: { type: "rectangle", locked: false, customType: null },
      ...initial,
    } as AppState;
    const setActiveTool = vi.fn((tool: { type: string; locked?: boolean }) => {
      appState = {
        ...appState,
        activeTool: { ...appState.activeTool, ...tool },
      } as AppState;
    });
    const updateScene = vi.fn((data: { appState?: Partial<AppState> }) => {
      appState = { ...appState, ...data.appState } as AppState;
    });
    const api = {
      ...fakeApi(),
      getAppState: () => appState,
      setActiveTool,
      updateScene,
    } as unknown as ExcalidrawImperativeAPI;
    return { api, setActiveTool, updateScene };
  }

  it("turns Snap off when Grid turns on, and Grid off when Snap turns on", () => {
    const { api } = preferenceApi({ objectsSnapModeEnabled: true });
    const adapter = new ExcalidrawAdapter(api);

    adapter.togglePreference("grid");
    expect(adapter.readPreferences()).toMatchObject({
      grid: true,
      snap: false,
    });

    adapter.togglePreference("snap");
    expect(adapter.readPreferences()).toMatchObject({
      grid: false,
      snap: true,
    });

    adapter.togglePreference("snap");
    expect(adapter.readPreferences()).toMatchObject({
      grid: false,
      snap: false,
    });
  });

  it("toggles Tool lock through setActiveTool, keeping the current tool", () => {
    const { api, setActiveTool } = preferenceApi({});
    const adapter = new ExcalidrawAdapter(api);

    adapter.togglePreference("toolLock");

    expect(setActiveTool).toHaveBeenCalledWith({
      type: "rectangle",
      locked: true,
    });
    expect(adapter.readPreferences().toolLock).toBe(true);
  });

  it("toggles Zen mode through updateScene", () => {
    const { api, updateScene } = preferenceApi({});
    const adapter = new ExcalidrawAdapter(api);

    adapter.togglePreference("zen");

    expect(updateScene).toHaveBeenCalledWith({
      appState: { zenModeEnabled: true },
    });
    expect(adapter.readPreferences().zen).toBe(true);
  });

  it("opens the SDK Help dialog", () => {
    const { api, updateScene } = preferenceApi({});

    new ExcalidrawAdapter(api).openHelp();

    expect(updateScene).toHaveBeenCalledWith({
      appState: { openDialog: { name: "help" } },
    });
  });

  it("closes the canvas main menu", () => {
    const { api, updateScene } = preferenceApi({});

    new ExcalidrawAdapter(api).closeMainMenu();

    expect(updateScene).toHaveBeenCalledWith({
      appState: { openMenu: null },
    });
  });
});

describe("ExcalidrawAdapter scene adoption", () => {
  it("registers content-derived files before adopting elements", async () => {
    const calls: string[] = [];
    let appliedElements: SceneSnapshot["elements"] = [];
    let appliedAppState: Partial<AppState> = {};
    let registeredFiles: BinaryFiles = {};
    const api = fakeApi({
      addFiles(files) {
        calls.push("addFiles");
        registeredFiles = Object.fromEntries(
          files.map((file) => [file.id, file]),
        );
      },
      updateScene(data) {
        calls.push("updateScene");
        if (data.elements !== undefined) {
          appliedElements = data.elements;
        }
        if (data.appState !== undefined) {
          appliedAppState = { ...appliedAppState, ...data.appState };
        }
      },
    });
    const adapter = new ExcalidrawAdapter(api);
    const original = sceneWithImage(NEW_BYTES);

    await adapter.replaceScene(original);

    expect(calls).toEqual([
      "addFiles",
      "updateScene",
      "updateScene",
      "updateScene",
      "updateScene",
      "updateScene",
    ]);
    const adoptedId = String(fileIdOf(appliedElements[0]));
    expect(adoptedId).toMatch(/^sha256-[0-9a-f]{64}$/u);
    expect(registeredFiles[adoptedId]?.dataURL).toBe(NEW_BYTES);
    expect(appliedAppState.viewBackgroundColor).toBe("#fff");
    expect(appliedAppState.gridModeEnabled).toBe(true);
    expect(appliedAppState.gridSize).toBe(20);
    expect(appliedAppState.gridStep).toBe(5);
    expect(appliedAppState).not.toHaveProperty("scrollX");
    expect(appliedAppState).not.toHaveProperty("viewModeEnabled");
    expect(appliedAppState).not.toHaveProperty("selectedElementIds");
    expect(fileIdOf(original.elements[0])).toBe(OLD_FILE_ID);
    expect(original.files[OLD_FILE_ID]?.dataURL).toBe(NEW_BYTES);
  });

  it("avoids stale same-ID bytes and keeps save/read bytes stable", async () => {
    const existingFiles: BinaryFiles = {
      [OLD_FILE_ID]: file(OLD_BYTES),
    };
    const scene = sceneWithImage(NEW_BYTES);
    const calls: Array<{
      kind: "add" | "update";
      files?: BinaryFiles;
      scene?: SceneSnapshot;
    }> = [];
    const api = fakeApi({
      addFiles(files) {
        for (const next of files) {
          // This is the SDK behavior we are protecting against: same IDs keep
          // their old bytes. The adopted ID must therefore be different.
          if (existingFiles[next.id] === undefined) {
            existingFiles[next.id] = next;
          }
        }
        calls.push({
          kind: "add",
          files: Object.fromEntries(files.map((next) => [next.id, next])),
        });
      },
      updateScene(data) {
        calls.push({
          kind: "update",
          scene: {
            elements: data.elements ?? [],
            appState: data.appState ?? {},
            files: existingFiles,
          },
        });
      },
    });

    await new ExcalidrawAdapter(api).replaceScene(scene);
    const applied = calls.find((call) => call.kind === "update")?.scene;
    expect(applied).toBeDefined();
    const appliedFileId = String(fileIdOf(applied?.elements[0]));
    expect(appliedFileId).not.toBe(OLD_FILE_ID);
    expect(applied?.files[appliedFileId]?.dataURL).toBe(NEW_BYTES);

    const persisted = serializeScene({
      elements: applied?.elements ?? [],
      appState: applied?.appState ?? {},
      files: applied?.files ?? {},
    });
    const reread = deserializeScene(persisted);
    expect(fileIdOf(reread.elements[0])).toBe(appliedFileId);
    expect(reread.files[appliedFileId]?.dataURL).toBe(NEW_BYTES);
  });

  it("uses one stable ID for repeated content to bound the file cache", async () => {
    const ids: string[] = [];
    const api = fakeApi({
      addFiles(files) {
        ids.push(...files.map((entry) => String(entry.id)));
      },
    });
    const adapter = new ExcalidrawAdapter(api);
    await adapter.replaceScene(sceneWithImage(NEW_BYTES, "first-source"));
    await adapter.replaceScene(sceneWithImage(NEW_BYTES, "second-source"));

    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("exposes host-owned protected input installation with cleanup", () => {
    const root = document.createElement("div");
    const canvas = document.createElement("div");
    root.append(canvas);
    document.body.append(root);
    const onClear = vi.fn();
    const adapter = new ExcalidrawAdapter(fakeApi());

    adapter.installProtectedInput(root, { onClear });
    canvas.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Delete",
        metaKey: true,
      }),
    );
    expect(onClear).toHaveBeenCalledOnce();

    adapter.dispose();
    canvas.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Delete",
        metaKey: true,
      }),
    );
    expect(onClear).toHaveBeenCalledOnce();
  });
});

function sceneWithImage(dataURL: string, fileId = OLD_FILE_ID): SceneSnapshot {
  return {
    elements: [
      {
        type: "image",
        id: "image-element",
        fileId,
      } as SceneSnapshot["elements"][number],
    ],
    appState: {
      viewBackgroundColor: "#fff",
      gridModeEnabled: true,
      gridSize: 20,
      gridStep: 5,
      scrollX: 120,
      viewModeEnabled: true,
      selectedElementIds: { transient: true },
    },
    files: { [fileId]: file(dataURL) },
  };
}

function file(dataURL: string): BinaryFileData {
  return {
    id: OLD_FILE_ID as BinaryFileData["id"],
    mimeType: "image/png",
    dataURL: dataURL as BinaryFileData["dataURL"],
    created: 1,
  };
}

function fileIdOf(
  element: SceneSnapshot["elements"][number] | undefined,
): string | null {
  return element !== undefined && "fileId" in element ? element.fileId : null;
}

function fakeApi(
  overrides: Partial<{
    addFiles: (files: BinaryFileData[]) => void;
    updateScene: (data: {
      elements?: readonly SceneSnapshot["elements"][number][];
      appState?: Partial<AppState>;
    }) => void;
  }> = {},
): ExcalidrawImperativeAPI {
  return {
    addFiles: overrides.addFiles ?? (() => undefined),
    updateScene: overrides.updateScene ?? (() => undefined),
    getSceneElementsIncludingDeleted: () => [],
    getSceneElements: () => [],
    getAppState: () => ({ viewModeEnabled: false }) as AppState,
    getFiles: () => ({}),
    history: { clear: () => undefined },
    updateLibrary: () => undefined,
    resetScene: () => undefined,
    getName: () => "",
    scrollToContent: () => undefined,
    registerAction: () => undefined,
    refresh: () => undefined,
    setToast: () => undefined,
    id: "test-api",
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
