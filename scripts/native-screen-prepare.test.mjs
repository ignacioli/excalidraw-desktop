import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  NativeScreenPrepareError,
  prepareNativeScreenPlan,
  HISTORY_GATES,
  validateCapturePlan,
  validateHistoryPlanScope,
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
  it("prepares the approved HISTORY matrix without HF2 or menu scope", async () => {
    const fixture = await setup();
    await assert.rejects(
      prepareNativeScreenPlan({
        checkpoint: "HISTORY",
        packageManifestPath: fixture.packageManifestPath,
        semanticCollectionPath: fixture.semanticCollectionPath,
        runRoot: fixture.runRoot,
        planPath: fixture.planPath,
        isolationMode: "backend-app-data-home-redirect",
      }),
      /does not accept semantic collection/u,
    );
    const plan = await prepareNativeScreenPlan({
      checkpoint: "HISTORY",
      packageManifestPath: fixture.packageManifestPath,
      runRoot: fixture.runRoot,
      planPath: fixture.planPath,
      isolationMode: "backend-app-data-home-redirect",
    });
    assert.deepEqual(
      plan.screens.map((screen) => screen.gateId),
      HISTORY_GATES,
    );
    assert.equal(plan.harnessVersion, "004-history-capture-v1");
    const t048ManifestPath = path.resolve(
      "docs/design/local-version-history/high-fi/manifest.json",
    );
    const t048ManifestBytes = await fsp.readFile(t048ManifestPath);
    assert.deepEqual(plan.historyScope.highFi, {
      path: t048ManifestPath,
      sha256: crypto
        .createHash("sha256")
        .update(t048ManifestBytes)
        .digest("hex"),
    });
    assert.equal(plan.hf2Manifest, undefined);
    assert.equal(plan.nativeValidation, undefined);
    assert.equal(plan.semanticEvidence, undefined);
    assert.equal(
      plan.screens[0].designReference.kind,
      "approved-high-fi-frame",
    );
    assert.equal(
      plan.screens[1].manifestName,
      "T048 · 02 · Row Actions · Light",
    );
    assert.match(
      plan.screens[1].visualTarget.operatorChecklist.join(" "),
      /180 × 116 px menu/u,
    );
    assert.equal(
      plan.screens[4].manifestName,
      "T048 · 05 · Repeated Mark · Long List · Light",
    );
    assert.equal(plan.screens[6].designReference.state, "generic-error");
    assert.equal(
      plan.screens[10].designReference.state,
      "visible-focus-and-return",
    );
    assert.equal(plan.screens[10].visualTarget.operatorChecklist.length, 1);
    assert.equal(plan.screens[10].visualTarget.humanLiveObservations.length, 3);
    assert.equal(plan.screens[4].visualTarget.humanLiveObservations.length, 0);
    const launchSource = await fsp.readFile(
      "e2e/native/004-history-launch.excalidraw",
    );
    const launchDigest = crypto
      .createHash("sha256")
      .update(launchSource)
      .digest("hex");
    assert.equal(plan.fixture.launchDocument, undefined);
    assert.equal(
      new Set(plan.screens.map((screen) => screen.launchDocument)).size,
      HISTORY_GATES.length,
    );
    for (const screen of plan.screens) {
      assert.deepEqual(await fsp.readFile(screen.launchDocument), launchSource);
      assert.equal(screen.launchDocumentSha256, launchDigest);
      assert.match(
        screen.launchDocument,
        new RegExp(
          `/native-entrypoints/${screen.gateId}/004-history-launch\\.excalidraw$`,
          "u",
        ),
      );
    }
    const fixtureManifest = JSON.parse(
      await fsp.readFile(plan.fixture.manifestPath, "utf8"),
    );
    assert.deepEqual(
      fixtureManifest.files,
      plan.screens.map((screen) => ({
        path: `native-entrypoints/${screen.gateId}/004-history-launch.excalidraw`,
        sha256: launchDigest,
      })),
    );
    assert.throws(
      () =>
        validateCapturePlan({
          ...plan,
          fixture: {
            ...plan.fixture,
            launchDocument: "/tmp/outside.excalidraw",
          },
        }),
      /HISTORY plan contains a shared launch document/u,
    );
    assert.throws(
      () =>
        validateCapturePlan({
          ...plan,
          screens: [
            {
              ...plan.screens[0],
              launchDocument: plan.screens[1].launchDocument,
            },
            ...plan.screens.slice(1),
          ],
        }),
      /HISTORY launch document binding is invalid/u,
    );
    assert.ok(
      plan.screens.every(
        (screen) =>
          screen.preparationMode === "operator-assisted" &&
          !screen.baselineSha256,
      ),
    );
    assert.equal(
      (await fsp.readdir(path.join(fixture.runRoot, "profiles"))).length,
      HISTORY_GATES.length,
    );
    const registry = JSON.parse(
      await fsp.readFile(
        "e2e/native/004-history-capture-fixtures.json",
        "utf8",
      ),
    );
    const highFi = JSON.parse(t048ManifestBytes.toString("utf8"));
    assert.equal(highFi.frames.length, 7);
    assert.equal(validateHistoryPlanScope(plan, registry, highFi), plan);
    assert.deepEqual(
      plan.screens.slice(0, 6).map((screen) => screen.designReference.shapeId),
      highFi.frames.slice(0, 6).map((frame) => frame.shapeId),
    );
    assert.throws(
      () =>
        validateHistoryPlanScope(plan, registry, {
          ...highFi,
          status: "PENDING",
        }),
      /T048 high-fi authority is invalid/u,
    );
    assert.throws(
      () =>
        validateHistoryPlanScope(
          {
            ...plan,
            screens: [
              {
                ...plan.screens[0],
                visualTarget: {
                  ...plan.screens[0].visualTarget,
                  operatorChecklist: ["wrong"],
                },
              },
              ...plan.screens.slice(1),
            ],
          },
          registry,
          highFi,
        ),
      /scope mismatch/u,
    );
    assert.throws(
      () => validateCapturePlan({ ...plan, screens: plan.screens.slice(1) }),
      /missing or duplicate/u,
    );
    assert.throws(
      () =>
        validateCapturePlan({
          ...plan,
          hf2Manifest: { path: "/tmp/hf2", sha256: "ab".repeat(32) },
        }),
      /schema is invalid/u,
    );
  });
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
    assert.equal(plan.nativeValidation.launchDocument, undefined);
    const manifest = JSON.parse(
      await fsp.readFile(plan.fixture.manifestPath, "utf8"),
    );
    for (const entry of manifest.files) {
      assert.equal(
        await fsp.readFile(
          path.join(plan.fixture.workspaceRoot, entry.path),
          "utf8",
        ),
        `${JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} })}\n`,
      );
    }
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

  it("copies the explicit FINAL launch fixture byte-for-byte without changing screen fixtures", async () => {
    const fixture = await setup();
    const nativeLaunchFixturePath = path.resolve(
      "e2e/native/004-history-launch.excalidraw",
    );
    const source = await fsp.readFile(nativeLaunchFixturePath);
    assert.equal(source.length, 235);
    assert.notEqual(source.at(-1), 10);
    const plan = await prepareNativeScreenPlan({
      ...fixture,
      checkpoint: "FINAL",
      nativeLaunchFixturePath,
      isolationMode: "backend-app-data-home-redirect",
    });
    const target = path.join(
      plan.fixture.workspaceRoot,
      "native-entrypoints",
      path.basename(nativeLaunchFixturePath),
    );
    assert.equal(plan.nativeValidation.launchDocument, target);
    assert.deepEqual(await fsp.readFile(target), source);
    const manifest = JSON.parse(
      await fsp.readFile(plan.fixture.manifestPath, "utf8"),
    );
    assert.equal(
      manifest.files.find(
        (entry) =>
          entry.path === "native-entrypoints/004-history-launch.excalidraw",
      ).sha256,
      crypto.createHash("sha256").update(source).digest("hex"),
    );
    for (const entry of manifest.files.filter(
      (entry) => !entry.path.startsWith("native-entrypoints/"),
    )) {
      assert.equal(
        await fsp.readFile(
          path.join(plan.fixture.workspaceRoot, entry.path),
          "utf8",
        ),
        `${JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} })}\n`,
      );
    }
    assert.throws(
      () =>
        validateCapturePlan({
          ...plan,
          nativeValidation: {
            ...plan.nativeValidation,
            launchDocument: path.join(fixture.root, "outside.excalidraw"),
          },
        }),
      /native launch document/u,
    );
  });

  it("rejects invalid launch fixture input before provisioning", async () => {
    const fixture = await setup();
    const badJson = path.join(fixture.root, "invalid.excalidraw");
    await fsp.writeFile(badJson, "invalid");
    const badDrawing = path.join(fixture.root, "not-drawing.excalidraw");
    await fsp.writeFile(badDrawing, JSON.stringify({ type: "other" }));
    const link = path.join(fixture.root, "linked.excalidraw");
    await fsp.symlink(badDrawing, link);
    for (const [checkpoint, nativeLaunchFixturePath] of [
      ["VSL", path.resolve("e2e/native/004-history-launch.excalidraw")],
      ["FINAL", "relative.excalidraw"],
      ["FINAL", path.join(fixture.root, "missing.excalidraw")],
      ["FINAL", fixture.packageManifestPath],
      ["FINAL", badJson],
      ["FINAL", badDrawing],
      ["FINAL", link],
    ]) {
      await assert.rejects(
        prepareNativeScreenPlan({
          ...fixture,
          checkpoint,
          nativeLaunchFixturePath,
          isolationMode: "backend-app-data-home-redirect",
        }),
        NativeScreenPrepareError,
      );
      assert.deepEqual(await fsp.readdir(fixture.runRoot), []);
    }
  });
});
