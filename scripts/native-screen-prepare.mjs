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
const ISOLATION_MODES = new Set([
  "disposable-macos-user",
  "ephemeral-vm",
  "verified-os-home-redirect",
]);

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

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function shellStateFingerprint(value) {
  return sha256Bytes(canonicalJson(value));
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

export function validatePackageManifest(value) {
  const manifest = assertObject(value, "package manifest");
  if (
    manifest.schemaVersion !== 1 ||
    !/^[0-9a-f]{40}$/u.test(manifest.gitCommit ?? "") ||
    !/^[0-9a-f]{64}$/u.test(
      manifest.artifactSha256 ?? manifest.packageSha256 ?? "",
    ) ||
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

function stateProjection(screen, fixtureDigest) {
  return {
    gateId: screen.gateId,
    theme: screen.theme,
    sessionState: screen.sessionState,
    sidebarState: screen.sidebarState,
    workspaceName: screen.workspaceName,
    selectedDirectory: screen.selectedDirectory,
    tabs: screen.tabs,
    activeDocument: screen.activeDocument,
    unsaved: screen.unsaved,
    fixtureDigest,
  };
}

export function validateCapturePlan(value) {
  const plan = assertObject(value, "capture plan");
  if (
    plan.schemaVersion !== 1 ||
    !["VSL", "FINAL"].includes(plan.checkpoint) ||
    typeof plan.runId !== "string" ||
    !/^[0-9a-f]{64}$/u.test(plan.runNonce ?? "") ||
    !/^[0-9a-f]{40}$/u.test(plan.productCommit ?? "") ||
    plan.stateFingerprintVersion !== "shell-state-v1" ||
    plan.normalizationAlgorithm !== "lanczos3-srgb-v1" ||
    !ISOLATION_MODES.has(plan.isolation?.mode) ||
    !path.isAbsolute(plan.nativeEntrypointProfileRoot ?? "") ||
    plan.nativeEntrypointRequest?.gateId !== "T023b" ||
    plan.nativeEntrypointRequest?.profileRoot !==
      plan.nativeEntrypointProfileRoot ||
    !/^[0-9a-f]{64}$/u.test(
      plan.nativeEntrypointRequest?.expectedStateFingerprint ?? "",
    ) ||
    !Array.isArray(plan.screens)
  ) {
    blocked("capture plan schema is invalid");
  }
  const expectedGates = plan.checkpoint === "VSL" ? ["VSL-001"] : FINAL_GATES;
  const observedGates = plan.screens.map((screen) => screen.gateId).sort();
  if (
    JSON.stringify(observedGates) !== JSON.stringify([...expectedGates].sort())
  ) {
    blocked("capture plan has missing or duplicate screen gates");
  }
  const profiles = new Set([plan.nativeEntrypointProfileRoot]);
  for (const screen of plan.screens) {
    if (!["fixture", "operator-assisted"].includes(screen.preparationMode)) {
      blocked(
        `capture plan screen ${screen.gateId ?? "unknown"} preparationMode is invalid`,
      );
    }
    if (
      !path.isAbsolute(screen.profileRoot ?? "") ||
      screen.viewport?.width !== 1280 ||
      screen.viewport?.height !== 760 ||
      !/^[0-9a-f]{64}$/u.test(screen.expectedStateFingerprint ?? "")
    ) {
      blocked(`capture plan screen ${screen.gateId ?? "unknown"} is invalid`);
    }
    if (profiles.has(screen.profileRoot))
      blocked("each screen must have a distinct profileRoot");
    profiles.add(screen.profileRoot);
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
      .flatMap((screen) => screen.tabs)
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
    schemaVersion: 1,
    fixtureId: "003-native-capture-v1",
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
  runRoot,
  planPath,
  isolationMode,
}) {
  if (
    !path.isAbsolute(packageManifestPath) ||
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
  const fixtureRegistryBytes = await fsp.readFile(FIXTURE_REGISTRY_PATH);
  const fixtureRegistry = assertObject(
    JSON.parse(fixtureRegistryBytes.toString("utf8")),
    "fixture registry",
  );
  if (
    fixtureRegistry.schemaVersion !== 1 ||
    !Array.isArray(fixtureRegistry.screens)
  )
    blocked("fixture registry schema is invalid");
  const requestedScreens = fixtureRegistry.screens.filter(
    (screen) => screen.checkpoint === checkpoint,
  );
  const hf2Bytes = await fsp.readFile(HF2_MANIFEST_PATH);
  const hf2 = assertObject(
    JSON.parse(hf2Bytes.toString("utf8")),
    "HF-2 manifest",
  );
  if (!Array.isArray(hf2.screens)) blocked("HF-2 manifest screens are missing");
  const fixture = await provisionFixture(runRoot, requestedScreens);
  const profilesRoot = path.join(runRoot, "profiles");
  const controlDir = path.join(runRoot, "control");
  await fsp.mkdir(controlDir, { recursive: true });
  const nativeEntrypointProfileRoot = path.join(profilesRoot, "T023b");
  await fsp.mkdir(nativeEntrypointProfileRoot, { recursive: true });
  const nativeEntrypointSource = fixtureRegistry.screens.find(
    (screen) => screen.gateId === "VSL-001",
  );
  if (!nativeEntrypointSource)
    blocked("fixture registry is missing T023b source state");
  const nativeEntrypointState = {
    ...nativeEntrypointSource,
    gateId: "T023b",
    fixtureDigest: fixture.digest,
  };
  delete nativeEntrypointState.checkpoint;
  delete nativeEntrypointState.baselinePath;
  delete nativeEntrypointState.manifestName;
  const nativeEntrypointRequest = {
    gateId: "T023b",
    profileRoot: nativeEntrypointProfileRoot,
    expectedStateFingerprint: shellStateFingerprint(nativeEntrypointState),
    viewport: { width: 1280, height: 760 },
    state: nativeEntrypointState,
  };
  const screens = [];
  for (const screen of requestedScreens) {
    const baseline = hf2.screens.find(
      (entry) => entry.path === screen.baselinePath,
    );
    if (!baseline || baseline.name !== screen.manifestName)
      blocked(`HF-2 baseline mismatch for ${screen.gateId}`);
    const profileRoot = path.join(profilesRoot, screen.gateId);
    await fsp.mkdir(profileRoot, { recursive: true });
    const expectedStateFingerprint = shellStateFingerprint(
      stateProjection(screen, fixture.digest),
    );
    screens.push({
      ...screen,
      profileRoot,
      baselineSha256: baseline.sha256,
      expectedStateFingerprint,
      viewport: { width: 1280, height: 760 },
    });
  }
  const plan = {
    schemaVersion: 1,
    checkpoint,
    runId: crypto.randomUUID(),
    runNonce: crypto.randomBytes(32).toString("hex"),
    productCommit: packageManifest.gitCommit,
    packageManifest: {
      path: packageManifestPath,
      sha256: sha256Bytes(packageBytes),
      artifactSha256:
        packageManifest.artifactSha256 ?? packageManifest.packageSha256,
    },
    hf2Manifest: { path: HF2_MANIFEST_PATH, sha256: sha256Bytes(hf2Bytes) },
    harnessVersion: "003-native-capture-v1",
    stateFingerprintVersion: "shell-state-v1",
    normalizationAlgorithm: "lanczos3-srgb-v1",
    isolation: {
      mode: isolationMode,
      root: profilesRoot,
      expectedAppDataRoot: profilesRoot,
      verification: "BLOCKED_UNTIL_RUNTIME_PATHS_ARE_OBSERVED",
    },
    controlDir,
    nativeEntrypointProfileRoot,
    nativeEntrypointRequest,
    fixture,
    screens,
  };
  validateCapturePlan(plan);
  await assertRealPathInside(
    runRoot,
    fixture.workspaceRoot,
    "fixture workspace",
  );
  await assertRealPathInside(runRoot, controlDir, "control directory");
  await writeJsonExclusive(planPath, plan);
  return plan;
}

function usage() {
  console.log(
    "Usage: pnpm native:screen:prepare -- --checkpoint VSL|FINAL --package-manifest <absolute.json> --run-root <absolute-empty-dir> --plan <absolute-new.json> --isolation-mode disposable-macos-user|ephemeral-vm|verified-os-home-redirect\nExit codes: 0=PASS, 1=FAIL, 2=BLOCKED, 64=invalid invocation.",
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
  const runRoot = option(args, "--run-root");
  const planPath = option(args, "--plan");
  const isolationMode = option(args, "--isolation-mode");
  if (
    !["VSL", "FINAL"].includes(checkpoint) ||
    !packageManifestPath ||
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
