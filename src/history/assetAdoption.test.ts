import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import { describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "../editor/sceneSerializer";
import {
  adoptSceneAssets,
  AssetAdoptionError,
  fileIdForContentHash,
} from "./assetAdoption";

vi.mock("@excalidraw/excalidraw", () => ({}));

describe("assetAdoption", () => {
  it("derives IDs from bytes and rewrites only image references", async () => {
    const scene = sceneWithFiles({
      oldRed: dataFile("cmVk"),
      oldAlias: dataFile("cmVk"),
      oldBlue: dataFile("Ymx1ZQ=="),
    });

    const adopted = await adoptSceneAssets(scene);
    const redId = adopted.fileIdBySourceId.get("oldRed");
    const aliasId = adopted.fileIdBySourceId.get("oldAlias");
    const blueId = adopted.fileIdBySourceId.get("oldBlue");

    expect(redId).toMatch(/^sha256-[0-9a-f]{64}$/u);
    expect(aliasId).toBe(redId);
    expect(blueId).not.toBe(redId);
    expect(Object.keys(adopted.files)).toEqual(
      expect.arrayContaining([redId, blueId]),
    );
    expect(fileIdOf(adopted.elements[0])).toBe(redId);
    expect(fileIdOf(adopted.elements[1])).toBe(blueId);
    expect(adopted.elements[2]?.type).toBe("rectangle");
    expect(adopted.appState).toEqual({
      gridModeEnabled: true,
      gridSize: 20,
      gridStep: 5,
      viewBackgroundColor: "#fff",
    });
    expect(fileIdOf(scene.elements[0])).toBe("oldRed");
    expect(scene.files.oldRed?.dataURL).toContain("cmVk");
  });

  it("preserves unresolved workspace references for the unavailable state", async () => {
    const scene: SceneSnapshot = {
      elements: [
        {
          type: "image",
          id: "unresolved-element",
          fileId: "unresolved",
        } as SceneSnapshot["elements"][number],
      ],
      appState: {},
      files: {
        unresolved: {
          id: "unresolved" as BinaryFileData["id"],
          mimeType: "image/png",
          dataURL: "asset://".concat(
            "a".repeat(64),
          ) as BinaryFileData["dataURL"],
          created: 1,
        },
      },
    };
    const adopted = await adoptSceneAssets(scene);

    expect(fileIdOf(adopted.elements[0])).toBe("unresolved");
    expect(adopted.files.unresolved?.dataURL).toBe(
      scene.files.unresolved?.dataURL,
    );
  });

  it("rejects malformed data URLs instead of adopting arbitrary text", async () => {
    await expect(
      adoptSceneAssets(
        sceneWithFiles({
          broken: {
            id: "broken" as BinaryFileData["id"],
            mimeType: "image/png",
            dataURL: "data:image/png;base64,%%%" as BinaryFileData["dataURL"],
            created: 1,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(AssetAdoptionError);
  });

  it("validates canonical content hash IDs", () => {
    expect(fileIdForContentHash("a".repeat(64))).toBe(
      `sha256-${"a".repeat(64)}`,
    );
    expect(() => fileIdForContentHash("not-a-hash")).toThrow(
      AssetAdoptionError,
    );
  });
});

function sceneWithFiles(files: Record<string, BinaryFileData>): SceneSnapshot {
  return {
    elements: [
      {
        type: "image",
        id: "red-element",
        fileId: "oldRed",
      } as SceneSnapshot["elements"][number],
      {
        type: "image",
        id: "blue-element",
        fileId: "oldBlue",
      } as SceneSnapshot["elements"][number],
      {
        type: "rectangle",
        id: "shape-element",
      } as SceneSnapshot["elements"][number],
    ],
    appState: {
      gridModeEnabled: true,
      gridSize: 20,
      gridStep: 5,
      viewBackgroundColor: "#fff",
      scrollX: 120,
      viewModeEnabled: true,
      selectedElementIds: { transient: true },
    },
    files,
  };
}

function dataFile(payload: string): BinaryFileData {
  return {
    id: "source" as BinaryFileData["id"],
    mimeType: "image/png",
    dataURL: `data:image/png;base64,${payload}` as BinaryFileData["dataURL"],
    created: 1,
  };
}

function fileIdOf(
  element: SceneSnapshot["elements"][number] | undefined,
): string | null {
  return element !== undefined && "fileId" in element ? element.fileId : null;
}
