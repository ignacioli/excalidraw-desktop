import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  NativeScreenCaptureError,
  confirmationDigest,
  confirmationLine,
  confirmationMatches,
  createFailureBudget,
  nativeMasksForScreen,
  normalizationArgs,
  operatorPreparationMessage,
  parseAxWindowObservation,
  readPngDimensions,
  recordValidationAttempt,
  validateRawDimensions,
} from "./native-screen-capture.mjs";

function png(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  Buffer.from("IHDR", "ascii").copy(bytes, 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const screen = {
  gateId: "VSL-001",
  profileRoot: "/tmp/run/profiles/VSL-001",
  preparationMode: "operator-assisted",
  visualTarget: {
    summary: "03 · Workspace · Pinned · Light",
    operatorChecklist: [
      "Sidebar visually at the 360px reference",
      "flows selected and expanded",
      "Library panel visible",
    ],
  },
  nativeMasks: [
    {
      maskId: "sdk-canvas",
      selectorOrRect: "rect(360,74,626,686)",
      surface: "canvas",
      reason: "official SDK-owned editor interior below the native titlebar",
      perimeterChecked: true,
      approved: true,
    },
  ],
};

describe("native screen capture v2", () => {
  it("reads PNG dimensions and derives only an exact backing scale", () => {
    assert.deepEqual(readPngDimensions(png(2560, 1520)), {
      width: 2560,
      height: 1520,
    });
    assert.equal(validateRawDimensions({ width: 2560, height: 1520 }), 2);
    assert.throws(
      () => validateRawDimensions({ width: 2500, height: 1520 }),
      NativeScreenCaptureError,
    );
    assert.throws(
      () => readPngDimensions(Buffer.from("not png")),
      /valid PNG/u,
    );
  });

  it("uses exactly lanczos3-srgb-v1 normalization without crop or padding", () => {
    const args = normalizationArgs("raw.png", "actual.png", 2);
    assert.deepEqual(args, [
      "raw.png",
      "-colorspace",
      "sRGB",
      "-filter",
      "Lanczos",
      "-define",
      "filter:lobes=3",
      "-resize",
      "1280x760!",
      "-strip",
      "PNG32:actual.png",
    ]);
    assert.equal(args.includes("-crop"), false);
    assert.equal(args.includes("-extent"), false);
  });

  it("parses one Accessibility-owned 1280x760 window", () => {
    assert.deepEqual(parseAxWindowObservation("123, 1280, 760, 20, 30, 1"), {
      windowId: 123,
      logicalWidth: 1280,
      logicalHeight: 760,
      x: 20,
      y: 30,
      frontmost: true,
    });
    assert.throws(
      () => parseAxWindowObservation("123, 1200, 760, 20, 30, 1"),
      /logical geometry/u,
    );
  });

  it("accepts only the exact one-time terminal confirmation line", () => {
    const challenge = "ab".repeat(32);
    assert.equal(
      confirmationLine("VSL-001", challenge),
      `CAPTURE VSL-001 ${challenge}`,
    );
    assert.equal(
      confirmationMatches(`CAPTURE VSL-001 ${challenge}\n`, "VSL-001", challenge),
      true,
    );
    assert.equal(
      confirmationMatches(`CAPTURE VSL-001 ${challenge} extra`, "VSL-001", challenge),
      false,
    );
    assert.match(confirmationDigest(challenge), /^[0-9a-f]{64}$/u);
  });

  it("stops the same validation direction after three consecutive failures", () => {
    const budget = createFailureBudget();
    recordValidationAttempt(budget, "native-screen-capture-v2", "FAIL");
    recordValidationAttempt(budget, "native-screen-capture-v2", "FAIL");
    assert.equal(budget.stopped, false);
    recordValidationAttempt(budget, "native-screen-capture-v2", "FAIL");
    assert.equal(budget.stopped, true);
    recordValidationAttempt(budget, "native-screen-capture-v2", "PASS");
    assert.equal(budget.stopped, true);
  });

  it("prints only the visual target and does not project application state", () => {
    const message = operatorPreparationMessage(screen);
    assert.match(message, /VSL-001/u);
    assert.match(message, /flows selected and expanded/u);
    assert.match(message, /Operator actions establish state only/u);
    assert.equal(message.includes("shell-state-v2"), false);
    assert.equal(message.includes("sidebarWidth"), false);
    assert.deepEqual(nativeMasksForScreen(screen), screen.nativeMasks);
  });

  it("exposes fixed help and invalid-invocation exit semantics", () => {
    const help = spawnSync(
      process.execPath,
      ["scripts/native-screen-capture.mjs", "--help"],
      { encoding: "utf8" },
    );
    assert.equal(help.status, 0);
    assert.match(help.stdout, /CAPTURE <gate-id> <challenge>/u);
    assert.match(help.stdout, /confirmation controls timing only/u);
    assert.match(help.stdout, /0=PASS, 1=FAIL, 2=BLOCKED, 64=invalid invocation/u);
    const invalidRun = spawnSync(
      process.execPath,
      ["scripts/native-screen-capture.mjs"],
      { encoding: "utf8" },
    );
    assert.equal(invalidRun.status, 64);
  });
});
