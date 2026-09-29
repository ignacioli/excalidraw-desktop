import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  NativeScreenCaptureError,
  captureNativeScreens,
  confirmationDigest,
  confirmationLine,
  confirmationMatches,
  createFailureBudget,
  launchArgumentsForPlan,
  nativeMasksForScreen,
  normalizationArgs,
  observeBackendIsolation,
  operatorPreparationMessage,
  parseAxWindowObservation,
  readPngDimensions,
  recordValidationAttempt,
  validateRawDimensions,
  validateHistoryLaunchDocument,
  validateSemanticEvidenceBytes,
  waitForStableOwnedWindow,
} from "./native-screen-capture.mjs";
import { prepareNativeScreenPlan } from "./native-screen-prepare.mjs";

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
  it("rejects a changed HISTORY design binding before native launch", async () => {
    const root = await fsp.mkdtemp(
      path.join(os.tmpdir(), "history-capture-bind-"),
    );
    roots.push(root);
    const runRoot = path.join(root, "run");
    await fsp.mkdir(runRoot);
    const appPath = path.join(root, "Excalidraw.app");
    await fsp.mkdir(appPath);
    const packageManifestPath = path.join(root, "package.json");
    await fsp.writeFile(
      packageManifestPath,
      JSON.stringify({
        schemaVersion: 1,
        gitCommit: "ab".repeat(20),
        artifactSha256: "cd".repeat(32),
        appPath,
        bundleIdentifier: "excalidraw-desktop",
        expectedWindowSize: { width: 1280, height: 760 },
      }),
    );
    const planPath = path.join(runRoot, "plan.json");
    const plan = await prepareNativeScreenPlan({
      checkpoint: "HISTORY",
      packageManifestPath,
      runRoot,
      planPath,
      isolationMode: "backend-app-data-home-redirect",
    });
    assert.deepEqual(launchArgumentsForPlan(plan, plan.screens[0]), [
      plan.screens[0].launchDocument,
    ]);
    const approvedDigest = plan.historyScope.highFi.sha256;
    plan.historyScope.highFi.sha256 = "ee".repeat(32);
    await fsp.writeFile(planPath, JSON.stringify(plan));
    await assert.rejects(
      captureNativeScreens({
        planPath,
        gate: "HISTORY-01",
        collectionDir: path.join(runRoot, "collection"),
      }),
      /HISTORY highFi manifest identity changed/u,
    );
    plan.historyScope.highFi.sha256 = approvedDigest;
    await fsp.writeFile(planPath, JSON.stringify(plan));
    const fixtureManifest = JSON.parse(
      await fsp.readFile(plan.fixture.manifestPath, "utf8"),
    );
    await fsp.writeFile(plan.screens[0].launchDocument, "changed");
    assert.equal(
      await validateHistoryLaunchDocument(
        plan,
        plan.screens[1],
        fixtureManifest,
        await fsp.realpath(runRoot),
      ),
      await fsp.realpath(plan.screens[1].launchDocument),
    );
    await assert.rejects(
      captureNativeScreens({
        planPath,
        gate: "HISTORY-01",
        collectionDir: path.join(runRoot, "collection"),
      }),
      /HISTORY launch document fixture digest changed/u,
    );
    await fsp.unlink(plan.screens[1].launchDocument);
    await fsp.symlink(
      plan.screens[2].launchDocument,
      plan.screens[1].launchDocument,
    );
    await assert.rejects(
      validateHistoryLaunchDocument(
        plan,
        plan.screens[1],
        fixtureManifest,
        await fsp.realpath(runRoot),
      ),
      /real gate-owned file/u,
    );
  });
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

  it("retries only a transient zero on-screen window and still requires two stable samples", async () => {
    const observation = {
      windowId: 123,
      logicalWidth: 1280,
      logicalHeight: 760,
      x: 20,
      y: 30,
      frontmost: true,
    };
    const samples = [
      observation,
      new NativeScreenCaptureError(
        "owned-window lookup failed: expected exactly one CoreGraphics owned window (onscreen=0, all=1, active=0)",
      ),
      observation,
      observation,
    ];
    let calls = 0;
    const result = await waitForStableOwnedWindow(
      100,
      "helper",
      () => {
        const next = samples[calls++];
        if (next instanceof Error) throw next;
        return next;
      },
      async () => {},
    );
    assert.deepEqual(result, { ...observation, stableSamples: 2 });
    assert.equal(calls, 4);
  });

  it("blocks immediately on multiple windows or invalid geometry", async () => {
    for (const message of [
      "owned-window lookup failed: expected exactly one CoreGraphics owned window (onscreen=2, all=2, active=1)",
      "owned window identity or logical geometry is invalid",
    ]) {
      let calls = 0;
      await assert.rejects(
        waitForStableOwnedWindow(
          100,
          "helper",
          () => {
            calls += 1;
            throw new NativeScreenCaptureError(message);
          },
          async () => {},
        ),
        (error) => {
          assert.equal(error.message, message);
          return true;
        },
      );
      assert.equal(calls, 1);
    }
  });

  it("reports the final zero-window observation after bounded retries", async () => {
    let calls = 0;
    await assert.rejects(
      waitForStableOwnedWindow(
        100,
        "helper",
        () => {
          calls += 1;
          throw new NativeScreenCaptureError(
            "owned-window lookup failed: expected exactly one CoreGraphics owned window (onscreen=0, all=0, active=1)",
          );
        },
        async () => {},
      ),
      /last zero-window observation:.*onscreen=0, all=0, active=1/u,
    );
    assert.equal(calls, 20);
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
    const historyMessage = operatorPreparationMessage({
      ...screen,
      gateId: "HISTORY-01",
      launchDocument: "/tmp/fixture/History.excalidraw",
    });
    assert.match(
      historyMessage,
      /app was launched with the gate-owned saved drawing: \/tmp\/fixture\/History.excalidraw/u,
    );
    assert.doesNotMatch(historyMessage, /File > Open/u);
    assert.match(historyMessage, /Version History is enabled/u);
    assert.deepEqual(
      launchArgumentsForPlan(
        { checkpoint: "HISTORY" },
        { launchDocument: "/tmp/fixture/History.excalidraw" },
      ),
      ["/tmp/fixture/History.excalidraw"],
    );
    assert.deepEqual(launchArgumentsForPlan({ checkpoint: "VSL" }), []);
    assert.deepEqual(launchArgumentsForPlan({ checkpoint: "FINAL" }), []);
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
