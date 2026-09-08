import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readPngMetadata } from "./verify-hf2-handoff.mjs";

describe("HF-2 handoff verifier", () => {
  it("reads exact PNG IHDR geometry and color metadata", () => {
    const header = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write("IHDR", 12, "ascii");
    header.writeUInt32BE(1280, 16);
    header.writeUInt32BE(760, 20);
    header.writeUInt8(8, 24);
    header.writeUInt8(6, 25);
    header.writeUInt8(0, 26);
    header.writeUInt8(0, 27);
    header.writeUInt8(0, 28);

    assert.deepEqual(readPngMetadata(header), {
      width: 1280,
      height: 760,
      bitDepth: 8,
      colorType: 6,
      colorModel: "RGBA",
      interlaceMethod: 0,
    });
  });

  it("rejects non-PNG input instead of treating manifest data as actual data", () => {
    assert.throws(
      () => readPngMetadata(Buffer.from("not a png")),
      /not a PNG/u,
    );
  });
});
