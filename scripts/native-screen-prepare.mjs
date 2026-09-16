#!/usr/bin/env node

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const FIXTURE_REGISTRY_PATH = path.join(
  REPO_ROOT,
  "e2e/native/003-native-capture-fixtures.json",
);
const HF2_MANIFEST_PATH = path.join(
  REPO_ROOT,
  "docs/design/desktop-shell/hf-2/manifest.json",
);
const FINAL_GATES = [
  "HF2-01",
  "HF2-02",
  "HF2-03",
  "HF2-04",
  "HF2-05",
  "HF2-06",
];
const ISOLATION_MODES = new Set(["backend-app-data-home-redirect"]);
const NATIVE_MASK_SURFACES = new Set([
  "canvas",
  "editor-toolbar",
  "library",
  "presentation",
]);
const HEX = {
  commit: /^[0-9a-f]{40}$/u,
  digest: /^[0-9a-f]{64}$/u,
};

export class NativeScreenPrepareError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "NativeScreenPrepareError";
    this.exitCode = exitCode;
  }
}

function blocked(message) {
  throw new NativeScreenPrepareError(message, 2);
}

function invalid(message) {
  throw new NativeScreenPrepareError(message, 64);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    blocked(`${label} must be an object`);
  return value;
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(filePath) {
  return sha256Bytes(await fsp.readFile(filePath));
}

function pathInside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function assertRealPathInside(root, target, label) {
  const resolvedRoot = await fsp.realpath(root);
  const resolvedTarget = await fsp.realpath(target);
  if (!pathInside(resolvedRoot, resolvedTarget))
    blocked(`${label} escapes the run root`);
}

function validateMask(mask, label) {
  if (
    !mask ||
    typeof mask.maskId !== "string" ||
    !/^rect\(\d+,\d+,\d+,\d+\)$/u.test(mask.selectorOrRect ?? "") ||
    !NATIVE_MASK_SURFACES.has(mask.surface) ||
    typeof mask.reason !== "string" ||
    mask.reason.length === 0 ||
    mask.perimeterChecked !== true ||
    mask.approved !== true
  ) {
    blocked(`${label} is invalid`);
  }
}

export function validatePackageManifest(value) {
  const manifest = assertObject(value, "package manifest");
  if (
    manifest.schemaVersion !== 1 ||
    !HEX.commit.test(manifest.gitCommit ?? "") ||
    !HEX.digest.test(manifest.artifactSha256 ?? manifest.packageSha256 ?? "") ||
    typeof manifest.appPath !== "string" ||
    !path.isAbsolute(manifest.appPath) ||
    typeof manifest.bundleIdentifier !== "string" ||
    manifest.bundleIdentifier.length === 0 ||
    manifest.expectedWindowSize?.width !== 1280 ||
    manifest.expectedWindowSize?.height !== 760
  ) {
    blocked(
      "package manifest does not describe an exact 1280x760 production package",
    );
  }
  const buildCommand = Array.isArray(manifest.buildCommand)
    ? manifest.buildCommand.join(" ")
    : "";
  if (/e2e-harness|VITE_E2E_HARNESS/u.test(buildCommand)) {
    blocked("test-only package manifests are not valid native capture inputs");
  }
  return manifest;
}

export function validateSemanticCollectorReport(value, hf2ManifestSha256) {
  const report = assertObject(value, "semantic collector report");
  if (
    report.schemaVersion !== 1 ||
    report.gateId !== "VSL-001" ||
    report.result !== "PASS" ||
    typeof report.collectionId !== "string" ||
    report.collectionId.length === 0 ||
    !HEX.digest.test(report.collectionDigest ?? "") ||
    !assertObject(report.binding, "semantic collector binding").productCommit ||
    !HEX.commit.test(report.binding.productCommit) ||
    report.binding.hf2ManifestSha256 !== hf2ManifestSha256 ||
    typeof report.binding.harnessVersion !== "string" ||
    report.binding.harnessVersion.length === 0
  ) {
    blocked("semantic collector report is not a bound PASS for VSL-001");
  }
  return report;
}

function validateScreenRequest(
  screen,
  label = `screen ${screen?.gateId ?? "unknown"}`,
) {
  if (
    !screen ||
    typeof screen.gateId !== "string" ||
    typeof screen.manifestName !== "string" ||
    typeof screen.baselinePath !== "string" ||
    !HEX.digest.test(screen.baselineSha256 ?? "") ||
    !path.isAbsolute(screen.profileRoot ?? "") ||
    !["fixture", "operator-assisted"].includes(screen.preparationMode) ||
    !assertObject(screen.visualTarget, `${label}.visualTarget`).summary ||
    !Array.isArray(screen.visualTarget.operatorChecklist) ||
    screen.visualTarget.operatorChecklist.some(
      (item) => typeof item !== "string" || item.length === 0,
    ) ||
    screen.operatorConfirmation?.mode !== "terminal-exact-line" ||
    screen.operatorConfirmation?.timeoutSeconds !== 600 ||
    screen.viewport?.width !== 1280 ||
    screen.viewport?.height !== 760 ||
    !Array.isArray(screen.nativeMasks)
  ) {
    blocked(`${label} is invalid`);
  }
  for (const mask of screen.nativeMasks) validateMask(mask, `${label} mask`);
  if (["VSL-001", "HF2-03"].includes(screen.gateId)) {
    const canvasMask = screen.nativeMasks.find(
      (mask) => mask.surface === "canvas",
    );
    const match = /^rect\((\d+),(\d+),(\d+),(\d+)\)$/u.exec(
      canvasMask?.selectorOrRect ?? "",
    );
    if (!match || Number(match[1]) < 480) {
      blocked(
        `${label} canvas mask must begin after the 480px Sidebar maximum`,
      );
    }
  }
  return screen;
}

export function validateCapturePlan(value) {
  const plan = assertObject(value, "capture plan");
  if (
    plan.schemaVersion !== 2 ||
    !["VSL", "FINAL"].includes(plan.checkpoint) ||
    typeof plan.runId !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(plan.runId) ||
    !HEX.commit.test(plan.productCommit ?? "") ||
    !assertObject(plan.packageManifest, "capture plan packageManifest").path ||
    !path.isAbsolute(plan.packageManifest.path) ||
    !HEX.digest.test(plan.packageManifest.sha256 ?? "") ||
    !HEX.digest.test(plan.packageManifest.artifactSha256 ?? "") ||
    !assertObject(plan.hf2Manifest, "capture plan hf2Manifest").path ||
    !path.isAbsolute(plan.hf2Manifest.path) ||
    !HEX.digest.test(plan.hf2Manifest.sha256 ?? "") ||
    typeof plan.harnessVersion !== "string" ||
    plan.harnessVersion.length === 0 ||
    plan.normalizationAlgorithm !== "lanczos3-srgb-v1" ||
    !assertObject(plan.isolation, "capture plan isolation") ||
    !ISOLATION_MODES.has(plan.isolation.mode) ||
    !path.isAbsolute(plan.isolation.root ?? "") ||
    !path.isAbsolute(plan.isolation.expectedAppDataRoot ?? "") ||
    typeof plan.isolation.evidence !== "string" ||
    !path.isAbsolute(plan.isolation.evidence) ||
    !pathInside(plan.isolation.root, plan.isolation.evidence) ||
    plan.isolation.webkitFilesystemIsolationClaimed !== false ||
    !assertObject(plan.fixture, "capture plan fixture").id ||
    !path.isAbsolute(plan.fixture.manifestPath ?? "") ||
    !HEX.digest.test(plan.fixture.digest ?? "") ||
    !path.isAbsolute(plan.fixture.workspaceRoot ?? "") ||
    !Array.isArray(plan.screens)
  ) {
    blocked("capture plan schema is invalid");
  }
  if (
    "stateFingerprintVersion" in plan ||
    "nativeEntrypointRequest" in plan ||
    "nativeEntrypointProfileRoot" in plan ||
    "controlDir" in plan
  ) {
    blocked("capture plan contains removed diagnostic state or control fields");
  }
  if (plan.checkpoint === "VSL") {
    const semantic = assertObject(
      plan.semanticEvidence,
      "capture plan semanticEvidence",
    );
    if (
      !path.isAbsolute(semantic.collectorReportPath ?? "") ||
      !HEX.digest.test(semantic.collectorReportSha256 ?? "") ||
      typeof semantic.collectionId !== "string" ||
      semantic.collectionId.length === 0 ||
      !HEX.digest.test(semantic.collectionDigest ?? "") ||
      !HEX.commit.test(semantic.productCommit ?? "") ||
      typeof semantic.harnessVersion !== "string" ||
      semantic.harnessVersion.length === 0 ||
      !HEX.digest.test(semantic.hf2ManifestSha256 ?? "")
    ) {
      blocked("capture plan semantic evidence binding is invalid");
    }
  }
  const expectedGates = plan.checkpoint === "VSL" ? ["VSL-001"] : FINAL_GATES;
  const observedGates = plan.screens.map((screen) => screen.gateId).sort();
  if (
    JSON.stringify(observedGates) !== JSON.stringify([...expectedGates].sort())
  )
    blocked("capture plan has missing or duplicate screen gates");
  const profiles = new Set();
  for (const screen of plan.screens) {
    validateScreenRequest(screen);
    if (profiles.has(screen.profileRoot))
      blocked("each screen must have a distinct profileRoot");
    profiles.add(screen.profileRoot);
  }
  if (plan.checkpoint === "FINAL") {
    const nativeValidation = assertObject(
      plan.nativeValidation,
      "capture plan nativeValidation",
    );
    if (
      !path.isAbsolute(nativeValidation.profileRoot ?? "") ||
      !path.isAbsolute(nativeValidation.filesystemTargets?.save ?? "") ||
      !path.isAbsolute(nativeValidation.filesystemTargets?.png ?? "") ||
      !path.isAbsolute(nativeValidation.filesystemTargets?.svg ?? "")
    ) {
      blocked("FINAL capture plan native validation targets are invalid");
    }
  }
  return plan;
}

async function writeJsonExclusive(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function visualTargetForScreen(screen) {
  const checklist = [
    `Establish the declared ${screen.manifestName} composition through ordinary UI`,
  ];
  if (screen.gateId === "VSL-001") {
    checklist.push(
      "Sidebar visually at the 360px reference",
      "flows expanded",
      "Architecture/Migration/Research visible",
      "Architecture active and selected",
      "Library panel visible",
    );
  }
  return {
    summary: screen.manifestName,
    operatorChecklist: checklist,
  };
}

async function provisionFixture(runRoot, screens) {
  const declaredWorkspaceName =
    screens.length === 1 && typeof screens[0]?.workspaceName === "string"
      ? screens[0].workspaceName
      : "workspace";
  if (
    declaredWorkspaceName === "." ||
    declaredWorkspaceName === ".." ||
    /[\\/\0]/u.test(declaredWorkspaceName)
  ) {
    blocked("fixture workspace name is not a safe path component");
  }
  const workspaceRoot = path.join(runRoot, "fixture", declaredWorkspaceName);
  await fsp.mkdir(path.join(workspaceRoot, "flows"), { recursive: true });
  const drawingNames = new Set(
    screens
      .flatMap((screen) => screen.tabs ?? [])
      .filter((name) => typeof name === "string"),
  );
  const files = [];
  for (const name of [...drawingNames].sort()) {
    const relative =
      name.includes("流程") || name.includes("总览")
        ? path.join("流程", name)
        : path.join("flows", name);
    const absolute = path.join(workspaceRoot, relative);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    const scene = `${JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} })}\n`;
    await fsp.writeFile(absolute, scene, { encoding: "utf8", flag: "wx" });
    files.push({
      path: relative.split(path.sep).join("/"),
      sha256: sha256Bytes(scene),
    });
  }
  const manifest = {
    schemaVersion: 2,
    fixtureVersion: "003-native-capture-v4",
    fixtureId: "003-native-capture-v4",
    workspaceRoot,
    screens: screens.map(({ gateId, preparationMode }) => ({
      gateId,
      preparationMode,
    })),
    files,
  };
  const manifestPath = path.join(runRoot, "fixture", "fixture-manifest.json");
  await writeJsonExclusive(manifestPath, manifest);
  return {
    id: manifest.fixtureId,
    manifestPath,
    digest: await sha256File(manifestPath),
    workspaceRoot,
  };
}

export async function prepareNativeScreenPlan({
  checkpoint,
  packageManifestPath,
  semanticCollectionPath,
  runRoot,
  planPath,
  isolationMode,
}) {
  if (
    !path.isAbsolute(packageManifestPath) ||
    (checkpoint === "VSL" && !path.isAbsolute(semanticCollectionPath ?? "")) ||
    !path.isAbsolute(runRoot) ||
    !path.isAbsolute(planPath)
  ) {
    invalid("package manifest, run root, and plan paths must be absolute");
  }
  if (!ISOLATION_MODES.has(isolationMode))
    invalid("--isolation-mode is required and invalid");
  const runStats = await fsp.lstat(runRoot).catch(() => null);
  if (runStats === null || !runStats.isDirectory() || runStats.isSymbolicLink())
    blocked("run root must be an existing real directory");
  if ((await fsp.readdir(runRoot)).length !== 0)
    blocked("run root must be empty");
  if (!pathInside(runRoot, planPath))
    blocked("plan path must be inside the run root");

  const packageBytes = await fsp.readFile(packageManifestPath);
  const packageManifest = validatePackageManifest(
    JSON.parse(packageBytes.toString("utf8")),
  );
  const fixtureRegistry = assertObject(
    JSON.parse(await fsp.readFile(FIXTURE_REGISTRY_PATH, "utf8")),
    "fixture registry",
  );
  if (
    fixtureRegistry.schemaVersion !== 2 ||
    fixtureRegistry.fixtureVersion !== "003-native-capture-v4" ||
    !Array.isArray(fixtureRegistry.screens)
  ) {
    blocked("fixture registry schema is invalid");
  }
  const requestedScreens = fixtureRegistry.screens.filter(
    (screen) => screen.checkpoint === checkpoint,
  );
  const expectedGates = checkpoint === "VSL" ? ["VSL-001"] : FINAL_GATES;
  if (
    JSON.stringify(requestedScreens.map((screen) => screen.gateId).sort()) !==
    JSON.stringify([...expectedGates].sort())
  ) {
    blocked("fixture registry does not declare the requested checkpoint");
  }
  const hf2Bytes = await fsp.readFile(HF2_MANIFEST_PATH);
  const hf2 = assertObject(
    JSON.parse(hf2Bytes.toString("utf8")),
    "HF-2 manifest",
  );
  if (!Array.isArray(hf2.screens)) blocked("HF-2 manifest screens are missing");
  let semanticEvidence;
  if (checkpoint === "VSL") {
    const semanticBytes = await fsp.readFile(semanticCollectionPath);
    const hf2ManifestSha256 = sha256Bytes(hf2Bytes);
    const semanticReport = validateSemanticCollectorReport(
      JSON.parse(semanticBytes.toString("utf8")),
      hf2ManifestSha256,
    );
    semanticEvidence = {
      collectorReportPath: semanticCollectionPath,
      collectorReportSha256: sha256Bytes(semanticBytes),
      collectionId: semanticReport.collectionId,
      collectionDigest: semanticReport.collectionDigest,
      productCommit: semanticReport.binding.productCommit,
      harnessVersion: semanticReport.binding.harnessVersion,
      hf2ManifestSha256,
    };
  }

  const fixture = await provisionFixture(runRoot, requestedScreens);
  const profilesRoot = path.join(runRoot, "profiles");
  await fsp.mkdir(profilesRoot, { recursive: true });
  await fsp.mkdir(path.join(profilesRoot, "T023b"));
  const screens = [];
  for (const screen of requestedScreens) {
    const baseline = hf2.screens.find(
      (entry) => entry.path === screen.baselinePath,
    );
    if (!baseline || baseline.name !== screen.manifestName)
      blocked(`HF-2 baseline mismatch for ${screen.gateId}`);
    const profileRoot = path.join(profilesRoot, screen.gateId);
    await fsp.mkdir(profileRoot);
    screens.push({
      gateId: screen.gateId,
      profileRoot,
      preparationMode: screen.preparationMode,
      manifestName: screen.manifestName,
      baselinePath: screen.baselinePath,
      baselineSha256: baseline.sha256,
      visualTarget: visualTargetForScreen(screen),
      operatorConfirmation: {
        mode: "terminal-exact-line",
        timeoutSeconds: 600,
      },
      nativeMasks: screen.nativeMasks ?? [],
      viewport: { width: 1280, height: 760 },
    });
  }
  const plan = {
    schemaVersion: 2,
    checkpoint,
    runId: crypto.randomUUID(),
    productCommit: packageManifest.gitCommit,
    packageManifest: {
      path: packageManifestPath,
      sha256: sha256Bytes(packageBytes),
      artifactSha256:
        packageManifest.artifactSha256 ?? packageManifest.packageSha256,
    },
    hf2Manifest: { path: HF2_MANIFEST_PATH, sha256: sha256Bytes(hf2Bytes) },
    ...(semanticEvidence ? { semanticEvidence } : {}),
    harnessVersion: "003-native-capture-v4",
    normalizationAlgorithm: "lanczos3-srgb-v1",
    isolation: {
      mode: isolationMode,
      root: runRoot,
      expectedAppDataRoot: profilesRoot,
      evidence: path.join(runRoot, "isolation.json"),
      webkitFilesystemIsolationClaimed: false,
    },
    fixture,
    ...(checkpoint === "FINAL"
      ? {
          nativeValidation: {
            profileRoot: path.join(profilesRoot, "T023b"),
            filesystemTargets: {
              save: path.join(
                fixture.workspaceRoot,
                "flows",
                "Architecture.excalidraw",
              ),
              png: path.join(runRoot, "native-outcomes", "Architecture.png"),
              svg: path.join(runRoot, "native-outcomes", "Architecture.svg"),
            },
          },
        }
      : {}),
    screens,
  };
  validateCapturePlan(plan);
  await assertRealPathInside(
    runRoot,
    fixture.workspaceRoot,
    "fixture workspace",
  );
  await assertRealPathInside(runRoot, profilesRoot, "profile root");
  await writeJsonExclusive(planPath, plan);
  return plan;
}

function usage() {
  console.log(
    "Usage: pnpm native:screen:prepare -- --checkpoint VSL|FINAL --package-manifest <absolute.json> [--semantic-collection <absolute-T031-collector-report.json> for VSL] --run-root <absolute-empty-dir> --plan <absolute-new.json> --isolation-mode backend-app-data-home-redirect\nPlan schema: v2. VSL binds one PASS semantic collection by file and collection digest. FINAL also binds one empty T023b profile, six untouched capture profiles, and Save/PNG/SVG filesystem targets. Backend app-data only; WebKit filesystem isolation is not claimed. Exit codes: 0=PASS, 1=FAIL, 2=BLOCKED, 64=invalid invocation.",
  );
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("help")) return usage();
  const checkpoint = option(args, "--checkpoint");
  const packageManifestPath = option(args, "--package-manifest");
  const semanticCollectionPath = option(args, "--semantic-collection");
  const runRoot = option(args, "--run-root");
  const planPath = option(args, "--plan");
  const isolationMode = option(args, "--isolation-mode");
  if (
    !["VSL", "FINAL"].includes(checkpoint) ||
    !packageManifestPath ||
    (checkpoint === "VSL" && !semanticCollectionPath) ||
    !runRoot ||
    !planPath ||
    !isolationMode
  ) {
    usage();
    process.exitCode = 64;
    return;
  }
  try {
    const plan = await prepareNativeScreenPlan({
      checkpoint,
      packageManifestPath,
      semanticCollectionPath,
      runRoot,
      planPath,
      isolationMode,
    });
    console.log(
      JSON.stringify(
        { result: "PASS", plan: planPath, runId: plan.runId },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exitCode =
      error instanceof NativeScreenPrepareError ? error.exitCode : 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH)
  await main();
