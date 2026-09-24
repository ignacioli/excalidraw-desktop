import { afterEach, describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "../editor/sceneSerializer";
import { createHistoryFrontendEvidence } from "./historyFrontendEvidence";

const request = { requestId: "request-a", targetVersionId: "version-a" };
const png = "data:image/png;base64,aW1hZ2U=";
function scene(file: string | null = png): SceneSnapshot {
  return {
    elements: [
      {
        id: "label",
        type: "text",
        text: "Version A",
        originalText: "Version A",
        x: 10,
        y: 20,
        width: 80,
        height: 24,
        angle: 0,
      },
      {
        id: "image",
        type: "image",
        fileId: "asset",
        x: 40,
        y: 50,
        width: 64,
        height: 32,
        angle: 0,
      },
    ],
    appState: { viewBackgroundColor: "#ffffff" },
    files:
      file === null
        ? {}
        : {
            asset: {
              id: "asset",
              dataURL: file,
              mimeType: "image/png",
              created: 1,
            },
          },
  } as unknown as SceneSnapshot;
}
function mockDecode(error?: Error) {
  const decode = error
    ? vi.fn().mockRejectedValue(error)
    : vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      naturalWidth = 64;
      naturalHeight = 32;
      decode = decode;
    },
  );
  vi.stubGlobal("crypto", {
    subtle: {
      digest: vi.fn(async (_algorithm: string, bytes: Uint8Array) => {
        expect(Array.from(bytes)).toEqual([105, 109, 97, 103, 101]);
        return Uint8Array.from([1, 2, 3]).buffer;
      }),
    },
  });
  return decode;
}
afterEach(() => vi.unstubAllGlobals());

describe("history frontend canvas evidence", () => {
  it("records content, geometry, reference and decoded bytes for every referenced image", async () => {
    const decode = mockDecode();
    const evidence = await createHistoryFrontendEvidence(
      request,
      "doc",
      scene(),
    );
    expect(evidence.canvasReadback.elements).toMatchObject([
      { id: "label", text: "Version A", x: 10, y: 20, width: 80, height: 24 },
      { id: "image", fileId: "asset", x: 40, y: 50, width: 64, height: 32 },
    ]);
    expect(evidence.canvasReadback.assetHashes).toEqual({
      asset: "010203",
    });
    expect(evidence.canvasReadback.decodedImages).toEqual({
      asset: { width: 64, height: 32 },
    });
    expect(decode).toHaveBeenCalledOnce();
  });
  it.each([null, "asset://unresolved"])(
    "rejects unresolved referenced image %s",
    async (file) => {
      mockDecode();
      await expect(
        createHistoryFrontendEvidence(request, "doc", scene(file)),
      ).rejects.toThrow(/asset/);
    },
  );
  it("rejects image bytes that the browser cannot decode", async () => {
    mockDecode(new Error("invalid image"));
    await expect(
      createHistoryFrontendEvidence(request, "doc", scene()),
    ).rejects.toThrow(/decode.*asset/);
  });
  it("excludes deleted elements and their unresolved images", async () => {
    mockDecode();
    const input = scene(null);
    input.elements = input.elements.map((element) => ({
      ...element,
      isDeleted: true,
    }));
    const evidence = await createHistoryFrontendEvidence(request, "doc", input);
    expect(evidence.canvasReadback.elements).toEqual([]);
    expect(evidence.canvasReadback.assetHashes).toEqual({});
  });

  it("does not include unreferenced SDK files", async () => {
    mockDecode();
    const input = scene();
    input.files.orphan = {
      ...input.files.asset,
      id: input.files.asset.id,
      dataURL: input.files.asset.dataURL,
    };
    const evidence = await createHistoryFrontendEvidence(request, "doc", input);
    expect(Object.keys(evidence.canvasReadback.assetHashes)).toEqual(["asset"]);
  });
});
