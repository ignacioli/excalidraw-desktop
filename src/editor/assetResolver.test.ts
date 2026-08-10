import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import { describe, expect, it } from "vitest";
import {
  assetPathFor,
  hashFromReference,
  isAssetReference,
  resolveAssetFiles,
} from "./assetResolver";

const REFERENCE = `asset://${"a".repeat(64)}`;

function fileWith(dataUrl: string): BinaryFiles {
  return {
    "file-1": {
      id: "file-1" as BinaryFiles[string]["id"],
      mimeType: "image/png",
      dataURL: dataUrl as BinaryFiles[string]["dataURL"],
      created: 123,
    },
  };
}

describe("asset reference parsing", () => {
  it("recognizes internal references and extracts the hash", () => {
    expect(isAssetReference(REFERENCE)).toBe(true);
    expect(isAssetReference("data:image/png;base64,AAAA")).toBe(false);
    expect(hashFromReference(REFERENCE)).toBe("a".repeat(64));
    expect(hashFromReference("asset://short")).toBeNull();
    expect(hashFromReference("asset://".concat("z".repeat(64)))).toBeNull();
  });

  it("joins the asset store path under the workspace", () => {
    expect(assetPathFor("/tmp/workspace", "a".repeat(64))).toBe(
      `/tmp/workspace/.excalidraw_assets/${"a".repeat(64)}`,
    );
  });
});

describe("resolveAssetFiles", () => {
  it("leaves files untouched without a Tauri runtime", async () => {
    const files = fileWith(REFERENCE);
    const resolved = await resolveAssetFiles(
      files,
      "/tmp/workspace/doc.excalidraw",
    );
    expect(resolved).toBe(files);
    expect(resolved["file-1"].dataURL).toBe(REFERENCE);
  });

  it("leaves files untouched when there are no references", async () => {
    const files = fileWith("data:image/png;base64,AAAA");
    const resolved = await resolveAssetFiles(
      files,
      "/tmp/workspace/doc.excalidraw",
    );
    expect(resolved).toBe(files);
  });
});
