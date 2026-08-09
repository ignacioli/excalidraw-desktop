import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { describe, expect, it, vi } from "vitest";
import {
  deserializeScene,
  SceneSerializationError,
  serializeScene,
} from "./sceneSerializer";

vi.mock("@excalidraw/excalidraw", () => ({
  convertToExcalidrawElements: (
    elements: ReadonlyArray<Record<string, unknown>>,
  ) => elements,
  restore: (scene: {
    elements?: ReadonlyArray<Record<string, unknown>>;
    appState?: Record<string, unknown>;
    files?: Record<string, unknown>;
  }) => ({
    elements: scene.elements ?? [],
    appState: scene.appState ?? {},
    files: scene.files ?? {},
  }),
  serializeAsJSON: (
    elements: ReadonlyArray<Record<string, unknown>>,
    appState: Record<string, unknown>,
    files: Record<string, unknown>,
  ) =>
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements,
      appState,
      files,
    }),
}));

describe("sceneSerializer", () => {
  it("writes standard Excalidraw JSON and restores the scene", () => {
    const elements = convertToExcalidrawElements([
      { type: "rectangle", x: 20, y: 30, width: 120, height: 80 },
    ]);
    const serialized = serializeScene({
      elements,
      appState: { viewBackgroundColor: "#f8f9fa" },
      files: {},
    });

    const json: unknown = JSON.parse(serialized);
    expect(json).toMatchObject({
      type: "excalidraw",
      version: 2,
      elements: [{ type: "rectangle", x: 20, y: 30 }],
    });

    const restored = deserializeScene(serialized);
    expect(restored.elements).toHaveLength(1);
    expect(restored.elements[0]).toMatchObject({
      type: "rectangle",
      x: 20,
      y: 30,
    });
    expect(restored.appState.viewBackgroundColor).toBe("#f8f9fa");
    expect(restored.files).toEqual({});
  });

  it.each([
    "not-json",
    JSON.stringify({ type: "other", version: 2, elements: [] }),
    JSON.stringify({ type: "excalidraw", version: 2, elements: {} }),
  ])("rejects malformed scene data without leaking parser errors", (value) => {
    expect(() => deserializeScene(value)).toThrow(SceneSerializationError);
  });

  it("does not restore a document theme into application appearance", () => {
    const restored = deserializeScene(
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        elements: [],
        appState: { theme: "dark", viewBackgroundColor: "#ffffff" },
        files: {},
      }),
    );

    expect(restored.appState).not.toHaveProperty("theme");
    expect(restored.appState.viewBackgroundColor).toBe("#ffffff");
  });
});
