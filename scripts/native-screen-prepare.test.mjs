import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  NativeScreenPrepareError,
  prepareNativeScreenPlan,
  validateCapturePlan,
  validatePackageManifest,
  validateSemanticCollectorReport,
} from "./native-screen-prepare.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fsp.rm(root, { recursive: true, force: true })),
  );
});

async function setup(buildCommand = ["pnpm", "tauri", "build"]) {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), "native-screen-prepare-"),
  );
  roots.push(root);
  const runRoot = path.join(root, "run");
  await fsp.mkdir(runRoot);
  const appPath = path.join(root, "Excalidraw.app");
  await fsp.mkdir(appPath);
  const packageManifestPath = path.join(root, "package-manifest.json");
  await fsp.writeFile(
    packageManifestPath,
    `${JSON.stringify({
      schemaVersion: 1,
      gitCommit: "ab".repeat(20),
      artifactSha256: "cd".repeat(32),
      appPath,
      bundleIdentifier: "excalidraw-desktop",
      buildCommand,
      expectedWindowSize: { width: 1280, height: 760 },
    })}\n`,
  );
  const hf2Bytes = await fsp.readFile(
    "docs/design/desktop-shell/hf-2/manifest.json",
  );
  const hf2ManifestSha256 = crypto
    .createHash("sha256")
    .update(hf2Bytes)
    .digest("hex");
  const semanticCollectionPath = path.join(
    root,
    "semantic-collector-report.json",
  );
  await fsp.writeFile(
    semanticCollectionPath,
    `${JSON.stringify({
      schemaVersion: 1,
      collectionId: "VSL-001-light-pinned-browser",
      gateId: "VSL-001",
      binding: {
        productCommit: "ef".repeat(20),
        hf2ManifestSha256,
        fixtureDigest: "12".repeat(32),
        harnessVersion: "003-shell-v2",
      },
      collectionDigest: "34".repeat(32),
      result: "PASS",
    })}\n`,
  );
  return {
    root,
    runRoot,
    appPath,
    packageManifestPath,
    semanticCollectionPath,
    planPath: path.join(runRoot, "capture-plan.json"),
  };
}

describe("native screen prepare", () => {
  it("rejects semantic reports that are not a bound VSL PASS", () => {
    assert.throws(
      () =>
        validateSemanticCollectorReport(
          {
            schemaVersion: 1,
            collectionId: "VSL-001-light-pinned-browser",
            gateId: "VSL-001",
            binding: {
              productCommit: "ef".repeat(20),
              hf2ManifestSha256: "12".repeat(32),
              harnessVersion: "003-shell-v2",
            },
            collectionDigest: "34".repeat(32),
            result: "BLOCKED",
          },
          "12".repeat(32),
        ),
      /bound PASS/u,
    );
  });

  it("prepares one immutable v2 VSL plan without application-state projection", async () => {
    const fixture = await setup();
    const plan = await prepareNativeScreenPlan({
      checkpoint: "VSL",
      packageManifestPath: fixture.packageManifestPath,
      semanticCollectionPath: fixture.semanticCollectionPath,
      runRoot: fixture.runRoot,
      planPath: fixture.planPath,
      isolationMode: "backend-app-data-home-redirect",
    });
    assert.equal(plan.schemaVersion, 2);
    assert.equal(plan.screens.length, 1);
    assert.equal(plan.screens[0].gateId, "VSL-001");
    assert.equal(plan.screens[0].preparationMode, "operator-assisted");
    assert.equal(plan.screens[0].operatorConfirmation.timeoutSeconds, 600);
    assert.equal(
      plan.screens[0].visualTarget.summary,
      "03 · Workspace · Pinned · Light",
    );
    assert.equal(plan.screens[0].nativeMasks.length, 2);
    assert.equal(
      plan.screens[0].nativeMasks.find((mask) => mask.surface === "canvas")
        .selectorOrRect,
      "rect(480,74,506,686)",
    );
    assert.match(
      plan.screens[0].visualTarget.operatorChecklist.join("\n"),
      /Architecture active and selected/u,
    );
    assert.equal(plan.isolation.mode, "backend-app-data-home-redirect");
    assert.equal(plan.isolation.webkitFilesystemIsolationClaimed, false);
    assert.equal(plan.harnessVersion, "003-native-capture-v4");
    assert.equal(
      plan.semanticEvidence.collectionId,
      "VSL-001-light-pinned-browser",
    );
    assert.equal(plan.semanticEvidence.collectionDigest, "34".repeat(32));
    assert.equal(plan.fixture.schemaVersion, undefined);
    assert.equal("stateFingerprintVersion" in plan, false);
    assert.equal("nativeEntrypointRequest" in plan, false);
    assert.equal("controlDir" in plan, false);
    assert.equal(path.basename(plan.fixture.workspaceRoot), "Design Workspace");
    assert.equal(path.basename(plan.isolation.evidence), "isolation.json");
    assert.equal(validateCapturePlan(plan), plan);
    await assert.rejects(
      prepareNativeScreenPlan({
        checkpoint: "VSL",
        packageManifestPath: fixture.packageManifestPath,
        semanticCollectionPath: fixture.semanticCollectionPath,
        runRoot: fixture.runRoot,
        planPath: fixture.planPath,
        isolationMode: "backend-app-data-home-redirect",
      }),
      (error) =>
        error instanceof NativeScreenPrepareError && error.exitCode === 2,
    );
  });

  it("prepares six distinct FINAL profiles and a dedicated T023b profile", async () => {
    const fixture = await setup();
    const plan = await prepareNativeScreenPlan({
      checkpoint: "FINAL",
      packageManifestPath: fixture.packageManifestPath,
      runRoot: fixture.runRoot,
      planPath: fixture.planPath,
      isolationMode: "backend-app-data-home-redirect",
    });
    assert.deepEqual(plan.screens.map((screen) => screen.gateId).sort(), [
      "HF2-01",
      "HF2-02",
      "HF2-03",
      "HF2-04",
      "HF2-05",
      "HF2-06",
    ]);
    assert.equal(
      new Set(plan.screens.map((screen) => screen.profileRoot)).size,
      6,
    );
    assert.equal(
      await fsp
        .stat(path.join(fixture.runRoot, "profiles", "T023b"))
        .then((stat) => stat.isDirectory()),
      true,
    );
    assert.equal(
      plan.nativeValidation.profileRoot,
      path.join(fixture.runRoot, "profiles", "T023b"),
    );
    assert.deepEqual(plan.nativeValidation.filesystemTargets, {
      save: path.join(
        fixture.runRoot,
        "fixture",
        "workspace",
        "flows",
        "Architecture.excalidraw",
      ),
      png: path.join(fixture.runRoot, "native-outcomes", "Architecture.png"),
      svg: path.join(fixture.runRoot, "native-outcomes", "Architecture.svg"),
    });
  });

  it("rejects schema v1, test-only packages, unsafe paths, and duplicate profiles", async () => {
    const testOnly = await setup([
      "pnpm",
      "tauri",
      "build",
      "--features",
      "e2e-harness",
    ]);
    const manifest = JSON.parse(
      await fsp.readFile(testOnly.packageManifestPath, "utf8"),
    );
    assert.throws(() => validatePackageManifest(manifest), /test-only/u);

    const valid = await setup();
    const plan = await prepareNativeScreenPlan({
      checkpoint: "VSL",
      packageManifestPath: valid.packageManifestPath,
      semanticCollectionPath: valid.semanticCollectionPath,
      runRoot: valid.runRoot,
      planPath: valid.planPath,
      isolationMode: "backend-app-data-home-redirect",
    });
    assert.throws(
      () => validateCapturePlan({ ...plan, schemaVersion: 1 }),
      /capture plan schema is invalid/u,
    );
    assert.throws(
      () => validateCapturePlan({ ...plan, semanticEvidence: undefined }),
      /semanticEvidence/u,
    );
    assert.throws(
      () =>
        validateCapturePlan({
          ...plan,
          isolation: {
            ...plan.isolation,
            mode: "verified-os-home-redirect",
          },
        }),
      /capture plan schema is invalid/u,
    );
    assert.throws(
      () =>
        validateCapturePlan({
          ...plan,
          screens: [
            {
              ...plan.screens[0],
              nativeMasks: plan.screens[0].nativeMasks.map((mask) =>
                mask.surface === "canvas"
                  ? { ...mask, selectorOrRect: "rect(360,74,626,686)" }
                  : mask,
              ),
            },
          ],
        }),
      /480px Sidebar maximum/u,
    );
    assert.throws(
      () =>
        validateCapturePlan({
          ...plan,
          isolation: {
            ...plan.isolation,
            webkitFilesystemIsolationClaimed: true,
          },
        }),
      /capture plan schema is invalid/u,
    );
    assert.throws(
      () =>
        validateCapturePlan({
          ...plan,
          screens: [
            { ...plan.screens[0], profileRoot: plan.screens[0].profileRoot },
          ],
          stateFingerprintVersion: "legacy",
        }),
      /removed diagnostic/u,
    );
  });
});
