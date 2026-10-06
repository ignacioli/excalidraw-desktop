import { describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "../editor/sceneSerializer";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import { adoptSceneAssets } from "./assetAdoption";
import {
  importTarget,
  ImportProtectionError,
  parseImportCandidate,
  prepareImport,
} from "./importProtection";

const { scene, loadFromBlob } = vi.hoisted(() => ({
  scene: {
    elements: [],
    appState: { viewBackgroundColor: "#fff" },
    files: {},
  } satisfies SceneSnapshot,
  loadFromBlob: vi.fn(),
}));

vi.mock("../editor/sceneSerializer", () => ({
  deserializeScene: vi.fn(() => scene),
  documentAppState: vi.fn((value) => value),
  serializeScene: vi.fn(
    () => '{"type":"excalidraw","version":2,"elements":[],"files":{}}',
  ),
}));

vi.mock("@excalidraw/excalidraw", () => ({
  loadFromBlob,
}));

function file(name: string, contents = "{}", type = ""): File {
  return new File([contents], name, { type });
}

describe("importProtection", () => {
  it("treats chooser cancellation and empty selection as non-destructive", async () => {
    await expect(prepareImport(null)).resolves.toEqual({
      status: "cancelled",
    });
    await expect(prepareImport([])).resolves.toEqual({
      status: "cancelled",
    });
    expect(loadFromBlob).not.toHaveBeenCalled();
  });

  it("rejects multi-file selection without parsing or choosing the first file", async () => {
    await expect(
      prepareImport([file("a.excalidraw"), file("b.excalidraw")]),
    ).resolves.toEqual({ status: "multiple", count: 2 });
    expect(loadFromBlob).not.toHaveBeenCalled();
  });

  it("parses an Excalidraw file and emits canonical scene JSON", async () => {
    const result = await prepareImport(file("drawing.excalidraw", "raw"));

    expect(result.status).toBe("candidate");
    if (result.status !== "candidate") return;
    expect(result.candidate).toMatchObject({
      kind: "import",
      format: "excalidraw",
      sourceName: "drawing.excalidraw",
      scene,
      candidateSceneJson:
        '{"type":"excalidraw","version":2,"elements":[],"files":{}}',
    });
    expect(importTarget(result.candidate)).toEqual({
      kind: "import",
      candidateSceneJson:
        '{"type":"excalidraw","version":2,"elements":[],"files":{}}',
    });
  });

  it.each([
    ["scene.png", "image/png"],
    ["scene.svg", "image/svg+xml"],
  ])(
    "parses an embedded %s scene with the official loader",
    async (name, type) => {
      loadFromBlob.mockResolvedValueOnce({
        elements: [],
        appState: { viewBackgroundColor: "#eee" },
        files: {},
      });

      const result = await parseImportCandidate(file(name, "bytes", type));

      expect(result).toMatchObject({
        kind: "import",
        format: name.endsWith(".png") ? "png" : "svg",
        candidateSceneJson:
          '{"type":"excalidraw","version":2,"elements":[],"files":{}}',
      });
      expect(loadFromBlob).toHaveBeenLastCalledWith(
        expect.any(File),
        null,
        null,
      );
    },
  );

  it("leaves an ordinary PNG on the normal image insertion path", async () => {
    loadFromBlob.mockRejectedValueOnce(
      new DOMException("no embedded scene", "EncodingError"),
    );

    await expect(
      prepareImport(file("photo.png", "bytes", "image/png")),
    ).resolves.toMatchObject({ status: "ordinaryImage" });
  });

  it("reports malformed embedded data instead of inserting it as an ordinary image", async () => {
    loadFromBlob.mockRejectedValueOnce(new Error("invalid embedded payload"));

    await expect(
      prepareImport(file("broken.png", "bytes", "image/png")),
    ).rejects.toThrow("does not contain an Excalidraw scene");
  });

  it("adopts embedded import bytes through the shared content-derived asset path", async () => {
    const sourceFileId = "shared-image";
    const newDataUrl = "data:image/png;base64,bmV3LWJ5dGVz";
    loadFromBlob.mockResolvedValueOnce({
      elements: [{ id: "import-image", type: "image", fileId: sourceFileId }],
      appState: {},
      files: {
        [sourceFileId]: {
          id: sourceFileId as BinaryFileData["id"],
          mimeType: "image/png",
          dataURL: newDataUrl as BinaryFileData["dataURL"],
          created: 1,
        },
      },
    });

    const result = await parseImportCandidate(
      file("embedded.png", "bytes", "image/png"),
    );
    expect(result).toMatchObject({ kind: "import" });
    if (!("kind" in result)) return;
    const adopted = await adoptSceneAssets(result.scene);
    const adoptedId = adopted.fileIdBySourceId.get(sourceFileId);

    expect(adoptedId).toMatch(/^sha256-[0-9a-f]{64}$/u);
    if (adoptedId === undefined) throw new Error("asset was not adopted");
    expect(adoptedId).not.toBe(sourceFileId);
    expect(adopted.files[adoptedId]?.dataURL).toBe(newDataUrl);
    expect(result.scene.files[sourceFileId]?.dataURL).toBe(newDataUrl);
    expect(
      "fileId" in adopted.elements[0]! ? adopted.elements[0].fileId : null,
    ).toBe(adoptedId);
  });

  it("fails malformed Excalidraw data before any replacement target exists", async () => {
    const { deserializeScene } = await import("../editor/sceneSerializer");
    vi.mocked(deserializeScene).mockImplementationOnce(() => {
      throw new Error("invalid");
    });

    await expect(
      parseImportCandidate(file("broken.excalidraw", "invalid")),
    ).rejects.toBeInstanceOf(ImportProtectionError);
  });

  it("rejects unsupported file formats", async () => {
    await expect(parseImportCandidate(file("notes.txt"))).rejects.toThrow(
      ImportProtectionError,
    );
  });
});
