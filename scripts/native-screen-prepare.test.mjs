import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  NativeScreenPrepareError,
  prepareNativeScreenPlan,
  shellStateFingerprint,
  validateCapturePlan,
  validatePackageManifest,
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
  return {
    root,
    runRoot,
    appPath,
    packageManifestPath,
    planPath: path.join(runRoot, "capture-plan.json"),
  };
}

describe("native screen prepare", () => {
  it("prepares one immutable VSL profile and fixture", async () => {
    const fixture = await setup();
    const plan = await prepareNativeScreenPlan({
      checkpoint: "VSL",
      packageManifestPath: fixture.packageManifestPath,
      runRoot: fixture.runRoot,
      planPath: fixture.planPath,
      isolationMode: "ephemeral-vm",
    });
    assert.equal(plan.screens.length, 1);
    assert.equal(plan.screens[0].gateId, "VSL-001");
    assert.equal(plan.screens[0].preparationMode, "operator-assisted");
    assert.equal(plan.stateFingerprintVersion, "shell-state-v2");
    assert.equal(plan.screens[0].sidebarWidth, 360);
    assert.deepEqual(plan.screens[0].expandedDirectories, ["flows"]);
    assert.equal(plan.screens[0].sdkPanelState, "library-open");
    assert.equal(plan.screens[0].nativeMasks.length, 2);
    assert.equal(plan.screens[0].nativeMasks[0].perimeterChecked, true);
    assert.equal(path.basename(plan.fixture.workspaceRoot), "Design Workspace");
    assert.equal(plan.screens[0].viewport.width, 1280);
    assert.match(plan.screens[0].expectedStateFingerprint, /^[0-9a-f]{64}$/u);
    assert.equal(
      plan.isolation.verification,
      "BLOCKED_UNTIL_RUNTIME_PATHS_ARE_OBSERVED",
    );
    assert.match(plan.nativeEntrypointProfileRoot, /profiles\/T023b$/u);
    assert.equal(plan.nativeEntrypointRequest.gateId, "T023b");
    assert.equal(validateCapturePlan(plan), plan);
    await assert.rejects(
      prepareNativeScreenPlan({
        checkpoint: "VSL",
        packageManifestPath: fixture.packageManifestPath,
        runRoot: fixture.runRoot,
        planPath: fixture.planPath,
        isolationMode: "ephemeral-vm",
      }),
      (error) =>
        error instanceof NativeScreenPrepareError && error.exitCode === 2,
    );
  });

  it("prepares six FINAL profiles with unique fingerprints", async () => {
    const fixture = await setup();
    const plan = await prepareNativeScreenPlan({
      checkpoint: "FINAL",
      packageManifestPath: fixture.packageManifestPath,
      runRoot: fixture.runRoot,
      planPath: fixture.planPath,
      isolationMode: "disposable-macos-user",
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
      new Set(plan.screens.map((screen) => screen.expectedStateFingerprint))
        .size,
      6,
    );
  });

  it("rejects test-only package manifests, unsafe paths, and duplicate profiles", async () => {
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
    await assert.rejects(
      prepareNativeScreenPlan({
        checkpoint: "VSL",
        packageManifestPath: testOnly.packageManifestPath,
        runRoot: testOnly.runRoot,
        planPath: path.join(testOnly.root, "escape.json"),
        isolationMode: "ephemeral-vm",
      }),
      NativeScreenPrepareError,
    );
    assert.throws(
      () =>
        validateCapturePlan({
          schemaVersion: 1,
          checkpoint: "FINAL",
          runId: "run",
          runNonce: "ab".repeat(32),
          productCommit: "cd".repeat(20),
          stateFingerprintVersion: "shell-state-v2",
          normalizationAlgorithm: "lanczos3-srgb-v1",
          isolation: { mode: "ephemeral-vm" },
          nativeEntrypointProfileRoot: "/tmp/same",
          nativeEntrypointRequest: {
            gateId: "T023b",
            profileRoot: "/tmp/same",
            expectedStateFingerprint: "34".repeat(32),
          },
          screens: [
            ...["HF2-01", "HF2-02", "HF2-03", "HF2-04", "HF2-05", "HF2-06"].map(
              (gateId) => ({
                gateId,
                profileRoot: "/tmp/same",
                preparationMode: "operator-assisted",
                sidebarWidth: 360,
                expandedDirectories: [],
                viewport: { width: 1280, height: 760 },
                expectedStateFingerprint: "ef".repeat(32),
              }),
            ),
          ],
        }),
      /distinct profileRoot/u,
    );
    assert.throws(
      () =>
        validateCapturePlan({
          ...manifest,
          schemaVersion: 1,
          checkpoint: "VSL",
          runId: "run",
          runNonce: "ab".repeat(32),
          productCommit: "cd".repeat(20),
          stateFingerprintVersion: "shell-state-v2",
          normalizationAlgorithm: "lanczos3-srgb-v1",
          isolation: { mode: "ephemeral-vm" },
          nativeEntrypointProfileRoot: "/tmp/native",
          nativeEntrypointRequest: {
            gateId: "T023b",
            profileRoot: "/tmp/native",
            expectedStateFingerprint: "34".repeat(32),
          },
          screens: [
            {
              gateId: "VSL-001",
              profileRoot: "/tmp/vsl",
              viewport: { width: 1280, height: 760 },
              expectedStateFingerprint: "ef".repeat(32),
            },
          ],
        }),
      /preparationMode/u,
    );
    assert.throws(
      () =>
        validateCapturePlan({
          schemaVersion: 1,
          checkpoint: "VSL",
          runId: "run",
          runNonce: "ab".repeat(32),
          productCommit: "cd".repeat(20),
          stateFingerprintVersion: "shell-state-v2",
          normalizationAlgorithm: "lanczos3-srgb-v1",
          isolation: { mode: "ephemeral-vm" },
          nativeEntrypointProfileRoot: "/tmp/native",
          nativeEntrypointRequest: {
            gateId: "T023b",
            profileRoot: "/tmp/native",
            expectedStateFingerprint: "34".repeat(32),
          },
          screens: [
            {
              gateId: "VSL-001",
              profileRoot: "/tmp/vsl",
              preparationMode: "operator-assisted",
              sidebarWidth: 360,
              expandedDirectories: ["flows"],
              nativeMasks: [
                {
                  maskId: "too-broad",
                  selectorOrRect: ".app-shell",
                  surface: "canvas",
                  reason: "invalid broad mask",
                  perimeterChecked: true,
                  approved: true,
                },
              ],
              viewport: { width: 1280, height: 760 },
              expectedStateFingerprint: "ef".repeat(32),
            },
          ],
        }),
      /invalid/u,
    );
  });

  it("fingerprints canonical shell state independently of key order", () => {
    assert.equal(
      shellStateFingerprint({ theme: "light", tabs: ["A"] }),
      shellStateFingerprint({ tabs: ["A"], theme: "light" }),
    );
  });
});
