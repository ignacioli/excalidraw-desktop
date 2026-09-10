import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  NativeScreenCaptureError,
  nativeStateActions,
  normalizationArgs,
  parseAxWindowObservation,
  readPngDimensions,
  validateRawDimensions,
  validateReadyCandidate,
} from "./native-screen-capture.mjs";

function png(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  Buffer.from("IHDR", "ascii").copy(bytes, 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const profileRoot = "/tmp/run/profiles/VSL-001";
const plan = {
  runId: "run-001",
  runNonce: "ab".repeat(32),
  productCommit: "cd".repeat(20),
  packageManifest: { artifactSha256: "ef".repeat(32) },
};
const screen = {
  gateId: "VSL-001",
  profileRoot,
  expectedStateFingerprint: "12".repeat(32),
};

function candidate(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: plan.runId,
    runNonce: plan.runNonce,
    pid: 42,
    gateId: screen.gateId,
    productCommit: plan.productCommit,
    packageArtifactSha256: plan.packageManifest.artifactSha256,
    resolvedPaths: {
      appData: `${profileRoot}/Library/Application Support/app`,
      webKitData: `${profileRoot}/Library/WebKit/app`,
    },
    stateFingerprint: screen.expectedStateFingerprint,
    stateFingerprintVersion: "shell-state-v1",
    fontReady: true,
    remoteFontRequests: 0,
    pendingOperations: 0,
    stableFrames: 2,
    logicalWindow: { width: 1280, height: 760, frontmost: true },
    ...overrides,
  };
}

describe("native screen capture", () => {
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
    assert.deepEqual(normalizationArgs("raw.png", "actual.png", 1), [
      "raw.png",
      "-colorspace",
      "sRGB",
      "-strip",
      "PNG32:actual.png",
    ]);
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

  it("rejects stale nonce, wrong PID, path escape, and unready state", () => {
    assert.equal(validateReadyCandidate(plan, screen, candidate(), 42).pid, 42);
    for (const invalidCandidate of [
      candidate({ runNonce: "34".repeat(32) }),
      candidate({ pid: 43 }),
      candidate({
        resolvedPaths: {
          appData: "/Users/operator/data",
          webKitData: `${profileRoot}/webkit`,
        },
      }),
      candidate({ stableFrames: 1 }),
      candidate({ remoteFontRequests: 1 }),
    ]) {
      assert.throws(
        () => validateReadyCandidate(plan, screen, invalidCandidate, 42),
        NativeScreenCaptureError,
      );
    }
  });

  it("drives VSL state only through declared user-facing entrypoints", () => {
    assert.deepEqual(
      nativeStateActions(
        { fixture: { workspaceRoot: "/tmp/run/fixture/Design Workspace" } },
        {
          sessionState: "workspace",
          sidebarState: "pinned",
          selectedDirectory: "flows",
          tabs: [
            "Architecture.excalidraw",
            "Migration.excalidraw",
            "Research.excalidraw",
          ],
          activeDocument: "Architecture.excalidraw",
        },
      ),
      [
        { type: "press", name: "Open Workspace" },
        {
          type: "choose-directory",
          path: "/tmp/run/fixture/Design Workspace",
        },
        { type: "press", name: "Toggle workspace sidebar" },
        { type: "press", name: "flows" },
        { type: "press", name: "Architecture" },
        { type: "press", name: "Migration" },
        { type: "press", name: "Research" },
        { type: "press", name: "flows" },
        { type: "press", name: "Architecture.excalidraw" },
        { type: "press", name: "Toggle workspace sidebar" },
        { type: "press", name: "Library" },
      ],
    );
  });

  it("exposes fixed help and invalid-invocation exit semantics", () => {
    const help = spawnSync(
      process.execPath,
      ["scripts/native-screen-capture.mjs", "--help"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(help.status, 0);
    assert.match(
      help.stdout,
      /0=PASS, 1=FAIL, 2=BLOCKED, 64=invalid invocation/u,
    );
    const invalidRun = spawnSync(
      process.execPath,
      ["scripts/native-screen-capture.mjs"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(invalidRun.status, 64);
  });
});
