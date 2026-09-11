import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  NativeScreenCaptureError,
  confirmationDigest,
  confirmationLine,
  confirmationMatches,
  createFailureBudget,
  nativeMasksForScreen,
  normalizationArgs,
  observeBackendIsolation,
  operatorPreparationMessage,
  parseAxWindowObservation,
  readPngDimensions,
  recordValidationAttempt,
  validateRawDimensions,
  validateSemanticEvidenceBytes,
} from "./native-screen-capture.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fsp.rm(root, { recursive: true, force: true })),
  );
});

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
      "flows expanded",
      "Architecture active and selected",
      "Library panel visible",
    ],
  },
  nativeMasks: [
    {
      maskId: "sdk-canvas",
      selectorOrRect: "rect(480,74,506,686)",
      surface: "canvas",
      reason:
        "conservative official SDK-owned editor interior beginning after the maximum allowed Sidebar width",
      perimeterChecked: true,
      approved: true,
    },
  ],
};

describe("native screen capture v4", () => {
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
      confirmationMatches(
        `CAPTURE VSL-001 ${challenge}\n`,
        "VSL-001",
        challenge,
      ),
      true,
    );
    assert.equal(
      confirmationMatches(
        `CAPTURE VSL-001 ${challenge} extra`,
        "VSL-001",
        challenge,
      ),
      false,
    );
    assert.match(confirmationDigest(challenge), /^[0-9a-f]{64}$/u);
  });

  it("stops the same validation direction after three consecutive failures", () => {
    const budget = createFailureBudget();
    recordValidationAttempt(budget, "native-screen-capture-v4", "FAIL");
    recordValidationAttempt(budget, "native-screen-capture-v4", "FAIL");
    assert.equal(budget.stopped, false);
    recordValidationAttempt(budget, "native-screen-capture-v4", "FAIL");
    assert.equal(budget.stopped, true);
    recordValidationAttempt(budget, "native-screen-capture-v4", "PASS");
    assert.equal(budget.stopped, true);
  });

  it("prints only the visual target and does not project application state", () => {
    const message = operatorPreparationMessage(screen);
    assert.match(message, /VSL-001/u);
    assert.match(message, /flows expanded/u);
    assert.match(message, /Architecture active and selected/u);
    assert.match(message, /Operator actions establish state only/u);
    assert.equal(message.includes("shell-state-v2"), false);
    assert.equal(message.includes("sidebarWidth"), false);
    assert.deepEqual(nativeMasksForScreen(screen), screen.nativeMasks);
  });

  it("observes backend SQLite without claiming or reporting a WebKit path", async () => {
    const root = await fsp.mkdtemp(
      path.join(os.tmpdir(), "capture-isolation-"),
    );
    roots.push(root);
    const profileRoot = path.join(root, "profiles", "VSL-001");
    const backendRoot = path.join(
      profileRoot,
      "Library",
      "Application Support",
      "excalidraw-desktop",
    );
    await fsp.mkdir(backendRoot, { recursive: true });
    await fsp.writeFile(
      path.join(backendRoot, "excalidraw-desktop.sqlite3"),
      "db",
    );
    const record = await observeBackendIsolation({
      mode: "backend-app-data-home-redirect",
      declaredRoot: root,
      expectedAppDataRoot: path.join(root, "profiles"),
      profileRoot,
      bundleIdentifier: "excalidraw-desktop",
    });
    assert.equal(record.scope, "backend-app-data-only");
    assert.equal(record.actualBackendPathsObservedByCollector, true);
    assert.equal(record.webkitFilesystemIsolationClaimed, false);
    assert.deepEqual(record.observedBackendPersistence, [
      "excalidraw-desktop.sqlite3",
    ]);
    assert.equal("observedWebKitDataRoot" in record, false);
    assert.equal("actualPathsObservedByCollector" in record, false);
    assert.equal(JSON.stringify(record).includes("Library/WebKit"), false);
  });

  it("binds semantic evidence by report bytes and collection digest", () => {
    const report = {
      schemaVersion: 1,
      collectionId: "VSL-001-light-pinned-browser",
      gateId: "VSL-001",
      binding: {
        productCommit: "ef".repeat(20),
        hf2ManifestSha256: "12".repeat(32),
        harnessVersion: "003-shell-v2",
      },
      collectionDigest: "34".repeat(32),
      result: "PASS",
    };
    const bytes = Buffer.from(`${JSON.stringify(report)}\n`);
    const reference = {
      collectorReportSha256: crypto
        .createHash("sha256")
        .update(bytes)
        .digest("hex"),
      collectorReportPath: "/tmp/semantic-collector-report.json",
      collectionId: report.collectionId,
      collectionDigest: report.collectionDigest,
      productCommit: report.binding.productCommit,
      harnessVersion: report.binding.harnessVersion,
      hf2ManifestSha256: report.binding.hf2ManifestSha256,
    };
    assert.deepEqual(validateSemanticEvidenceBytes(reference, bytes), report);
    assert.throws(
      () => validateSemanticEvidenceBytes(reference, Buffer.from("{}\n")),
      /digest changed/u,
    );
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
    assert.match(help.stdout, /WebKit filesystem isolation is not claimed/u);
    assert.match(
      help.stdout,
      /0=PASS, 1=FAIL, 2=BLOCKED, 64=invalid invocation/u,
    );
    const invalidRun = spawnSync(
      process.execPath,
      ["scripts/native-screen-capture.mjs"],
      { encoding: "utf8" },
    );
    assert.equal(invalidRun.status, 64);
  });
});
