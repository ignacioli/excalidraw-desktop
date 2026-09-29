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
const HISTORY_REGISTRY_PATH = path.join(
  REPO_ROOT,
  "e2e/native/004-history-capture-fixtures.json",
);
const HISTORY_HIGH_FI_PATH = path.join(
  REPO_ROOT,
  "docs/design/local-version-history/high-fi/t048/manifest.json",
);
const HISTORY_LOW_FI_PATH = path.join(
  REPO_ROOT,
  "docs/design/local-version-history/low-fi/manifest.json",
);
const HISTORY_LAUNCH_FIXTURE_PATH = path.join(
  REPO_ROOT,
  "e2e/native/004-history-launch.excalidraw",
);
export const HISTORY_GATES = [
  "HISTORY-01",
  "HISTORY-02",
  "HISTORY-03",
  "HISTORY-04",
  "HISTORY-05",
  "HISTORY-06",
  "HISTORY-ERROR",
  "HISTORY-CONFLICT",
  "HISTORY-PENDING",
  "HISTORY-UNAVAILABLE",
  "HISTORY-FOCUS",
  "HISTORY-REDUCED-MOTION",
];
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
  checkpoint,
  label = `screen ${screen?.gateId ?? "unknown"}`,
) {
  if (
    !screen ||
    typeof screen.gateId !== "string" ||
    (checkpoint === "HISTORY"
      ? typeof (screen.manifestName ?? screen.designReference?.state) !==
        "string"
      : typeof screen.manifestName !== "string") ||
    (checkpoint === "HISTORY"
      ? screen.designReference?.kind === "approved-high-fi-frame"
        ? !/^[0-9a-f-]{36}$/u.test(screen.designReference.shapeId ?? "")
        : screen.designReference?.kind !== "approved-low-fi-state"
      : typeof screen.baselinePath !== "string" ||
        !HEX.digest.test(screen.baselineSha256 ?? "")) ||
    !path.isAbsolute(screen.profileRoot ?? "") ||
    !["fixture", "operator-assisted"].includes(screen.preparationMode) ||
    !assertObject(screen.visualTarget, `${label}.visualTarget`).summary ||
    !Array.isArray(screen.visualTarget.operatorChecklist) ||
    screen.visualTarget.operatorChecklist.some(
      (item) => typeof item !== "string" || item.length === 0,
    ) ||
    (checkpoint === "HISTORY" &&
      (!Array.isArray(screen.visualTarget.humanLiveObservations) ||
        screen.visualTarget.humanLiveObservations.some(
          (item) => typeof item !== "string" || item.length === 0,
        ))) ||
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
    !["VSL", "FINAL", "HISTORY"].includes(plan.checkpoint) ||
    typeof plan.runId !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(plan.runId) ||
    !HEX.commit.test(plan.productCommit ?? "") ||
    !assertObject(plan.packageManifest, "capture plan packageManifest").path ||
    !path.isAbsolute(plan.packageManifest.path) ||
    !HEX.digest.test(plan.packageManifest.sha256 ?? "") ||
    !HEX.digest.test(plan.packageManifest.artifactSha256 ?? "") ||
    (plan.checkpoint === "HISTORY"
      ? !plan.historyScope || plan.hf2Manifest !== undefined
      : !assertObject(plan.hf2Manifest, "capture plan hf2Manifest").path ||
        !path.isAbsolute(plan.hf2Manifest.path) ||
        !HEX.digest.test(plan.hf2Manifest.sha256 ?? "") ||
        plan.historyScope !== undefined) ||
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
  if (plan.checkpoint === "HISTORY") {
    for (const [name, expected] of [
      ["registry", HISTORY_REGISTRY_PATH],
      ["highFi", HISTORY_HIGH_FI_PATH],
      ["lowFi", HISTORY_LOW_FI_PATH],
    ]) {
      const binding = plan.historyScope[name];
      if (binding?.path !== expected || !HEX.digest.test(binding.sha256 ?? ""))
        blocked(`HISTORY ${name} binding is invalid`);
    }
    if (
      plan.semanticEvidence !== undefined ||
      plan.nativeValidation !== undefined ||
      plan.harnessVersion !== "004-history-capture-v1"
    )
      blocked("HISTORY plan contains another checkpoint scope");
    if (
      plan.fixture.launchDocument !== undefined ||
      plan.fixture.launchDocumentSha256 !== undefined
    )
      blocked("HISTORY plan contains a shared launch document");
  }
  const expectedGates =
    plan.checkpoint === "VSL"
      ? ["VSL-001"]
      : plan.checkpoint === "HISTORY"
        ? HISTORY_GATES
        : FINAL_GATES;
  const observedGates = plan.screens.map((screen) => screen.gateId).sort();
  if (
    JSON.stringify(observedGates) !== JSON.stringify([...expectedGates].sort())
  )
    blocked("capture plan has missing or duplicate screen gates");
  const profiles = new Set();
  const launchDocuments = new Set();
  for (const screen of plan.screens) {
    validateScreenRequest(screen, plan.checkpoint);
    if (plan.checkpoint === "HISTORY") {
      if (
        screen.profileRoot !==
        path.join(plan.isolation.expectedAppDataRoot, screen.gateId)
      )
        blocked(`HISTORY profile binding is invalid for ${screen.gateId}`);
      const expected = path.join(
        plan.fixture.workspaceRoot,
        "native-entrypoints",
        screen.gateId,
        path.basename(HISTORY_LAUNCH_FIXTURE_PATH),
      );
      if (
        screen.launchDocument !== expected ||
        !pathInside(plan.isolation.root, screen.launchDocument) ||
        !HEX.digest.test(screen.launchDocumentSha256 ?? "") ||
        launchDocuments.has(screen.launchDocument)
      )
        blocked(
          `HISTORY launch document binding is invalid for ${screen.gateId}`,
        );
      launchDocuments.add(screen.launchDocument);
    } else if (
      screen.launchDocument !== undefined ||
      screen.launchDocumentSha256 !== undefined
    ) {
      blocked("003 screen contains HISTORY launch document");
    }
    if (
      plan.checkpoint === "HISTORY" &&
      (screen.baselinePath !== undefined || screen.baselineSha256 !== undefined)
    )
      blocked("HISTORY cannot use a 003 pixel baseline");
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
    if (
      nativeValidation.launchDocument !== undefined &&
      (!path.isAbsolute(nativeValidation.launchDocument) ||
        !pathInside(
          plan.fixture.workspaceRoot,
          nativeValidation.launchDocument,
        ) ||
        !pathInside(plan.isolation.root, nativeValidation.launchDocument))
    ) {
      blocked(
        "FINAL native launch document must be inside the fixture workspace and run root",
      );
    }
  }
  return plan;
}

export function validateHistoryPlanScope(plan, registry, highFi) {
  if (plan.checkpoint !== "HISTORY") blocked("capture plan is not HISTORY");
  if (
    registry.fixtureVersion !== "004-history-capture-v1" ||
    !Array.isArray(registry.screens)
  )
    blocked("HISTORY fixture registry is invalid");
  if (
    highFi.schemaVersion !== 1 ||
    highFi.task !== "T048/T055" ||
    highFi.status !== "APPROVED_HIGH_FIDELITY" ||
    highFi.viewport?.width !== 1280 ||
    highFi.viewport?.height !== 760 ||
    highFi.frames?.length !== 6
  )
    blocked("HISTORY T048 high-fi authority is invalid");
  for (const screen of plan.screens) {
    const declared = registry.screens.find(
      (entry) => entry.gateId === screen.gateId,
    );
    if (
      !declared ||
      JSON.stringify(screen.visualTarget.operatorChecklist) !==
        JSON.stringify(declared.checklist) ||
      JSON.stringify(screen.visualTarget.humanLiveObservations) !==
        JSON.stringify(declared.humanLiveObservations ?? []) ||
      screen.visualTarget.summary !==
        (declared.manifestName ?? declared.state) ||
      screen.preparationMode !== "operator-assisted" ||
      screen.nativeMasks.length !== 0
    )
      blocked(`HISTORY scope mismatch for ${screen.gateId}`);
    const expectedReference = declared.shapeId
      ? {
          kind: "approved-high-fi-frame",
          shapeId: declared.shapeId,
          name: declared.manifestName,
        }
      : { kind: "approved-low-fi-state", state: declared.state };
    if (
      JSON.stringify(screen.designReference) !==
      JSON.stringify(expectedReference)
    )
      blocked(`HISTORY design reference mismatch for ${screen.gateId}`);
    if (declared.shapeId) {
      const frame = highFi.frames?.find(
        (entry) => entry.shapeId === declared.shapeId,
      );
      if (
        !frame ||
        frame.name !== declared.manifestName ||
        !/^screens\/[a-z0-9-]+\.png$/u.test(frame.path ?? "") ||
        !HEX.digest.test(frame.sha256 ?? "")
      )
        blocked(`HISTORY high-fi frame mismatch for ${screen.gateId}`);
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

function visualTargetForScreen(screen, checkpoint) {
  if (checkpoint === "HISTORY")
    return {
      summary: screen.manifestName ?? screen.state,
      operatorChecklist: screen.checklist,
      humanLiveObservations: screen.humanLiveObservations ?? [],
    };
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

async function provisionFixture(
  runRoot,
  screens,
  nativeLaunchFixture,
  checkpoint,
) {
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
  if (nativeLaunchFixture && checkpoint === "HISTORY") {
    for (const screen of screens) {
      const relative = path.join(
        "native-entrypoints",
        screen.gateId,
        nativeLaunchFixture.name,
      );
      const absolute = path.join(workspaceRoot, relative);
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, nativeLaunchFixture.bytes, { flag: "wx" });
      files.push({
        path: relative.split(path.sep).join("/"),
        sha256: sha256Bytes(nativeLaunchFixture.bytes),
      });
    }
  } else if (nativeLaunchFixture) {
    const relative = path.join("native-entrypoints", nativeLaunchFixture.name);
    const absolute = path.join(workspaceRoot, relative);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, nativeLaunchFixture.bytes, { flag: "wx" });
    files.push({
      path: relative.split(path.sep).join("/"),
      sha256: sha256Bytes(nativeLaunchFixture.bytes),
    });
  }
  const manifest = {
    schemaVersion: 2,
    fixtureVersion:
      checkpoint === "HISTORY"
        ? "004-history-capture-v1"
        : "003-native-capture-v4",
    fixtureId:
      checkpoint === "HISTORY"
        ? "004-history-capture-v1"
        : "003-native-capture-v4",
    workspaceRoot,
    screens: screens.map(({ gateId, preparationMode }) => ({
      gateId,
      preparationMode:
        checkpoint === "HISTORY" ? "operator-assisted" : preparationMode,
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
  nativeLaunchFixturePath,
  runRoot,
  planPath,
  isolationMode,
}) {
  if (checkpoint === "HISTORY" && semanticCollectionPath !== undefined)
    invalid("HISTORY does not accept semantic collection evidence");
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
  let nativeLaunchFixture;
  if (checkpoint === "HISTORY") {
    const stats = await fsp.lstat(HISTORY_LAUNCH_FIXTURE_PATH);
    if (!stats.isFile() || stats.isSymbolicLink())
      blocked("HISTORY launch fixture must be a real drawing file");
    const bytes = await fsp.readFile(HISTORY_LAUNCH_FIXTURE_PATH);
    let scene;
    try {
      scene = JSON.parse(bytes.toString("utf8"));
    } catch {
      blocked("HISTORY launch fixture must contain valid drawing JSON");
    }
    if (
      scene?.type !== "excalidraw" ||
      scene.version !== 2 ||
      !Array.isArray(scene.elements) ||
      !scene.appState ||
      typeof scene.appState !== "object" ||
      !scene.files ||
      typeof scene.files !== "object"
    )
      blocked("HISTORY launch fixture must contain an Excalidraw v2 drawing");
    nativeLaunchFixture = {
      name: path.basename(HISTORY_LAUNCH_FIXTURE_PATH),
      bytes,
    };
  }
  if (nativeLaunchFixturePath !== undefined) {
    if (
      checkpoint !== "FINAL" ||
      !path.isAbsolute(nativeLaunchFixturePath) ||
      path.extname(nativeLaunchFixturePath) !== ".excalidraw"
    )
      invalid(
        "native launch fixture requires FINAL and an absolute .excalidraw path",
      );
    const sourceStats = await fsp
      .lstat(nativeLaunchFixturePath)
      .catch(() => null);
    if (!sourceStats?.isFile() || sourceStats.isSymbolicLink())
      blocked("native launch fixture must be a real drawing file");
    const bytes = await fsp.readFile(nativeLaunchFixturePath);
    let scene;
    try {
      scene = JSON.parse(bytes.toString("utf8"));
    } catch {
      blocked("native launch fixture must contain valid drawing JSON");
    }
    if (
      scene?.type !== "excalidraw" ||
      scene.version !== 2 ||
      !Array.isArray(scene.elements) ||
      !scene.appState ||
      typeof scene.appState !== "object" ||
      Array.isArray(scene.appState) ||
      !scene.files ||
      typeof scene.files !== "object" ||
      Array.isArray(scene.files)
    )
      blocked("native launch fixture must contain an Excalidraw v2 drawing");
    nativeLaunchFixture = {
      name: path.basename(nativeLaunchFixturePath),
      bytes,
    };
  }
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
    JSON.parse(
      await fsp.readFile(
        checkpoint === "HISTORY"
          ? HISTORY_REGISTRY_PATH
          : FIXTURE_REGISTRY_PATH,
        "utf8",
      ),
    ),
    "fixture registry",
  );
  if (
    fixtureRegistry.schemaVersion !== (checkpoint === "HISTORY" ? 1 : 2) ||
    fixtureRegistry.fixtureVersion !==
      (checkpoint === "HISTORY"
        ? "004-history-capture-v1"
        : "003-native-capture-v4") ||
    !Array.isArray(fixtureRegistry.screens)
  ) {
    blocked("fixture registry schema is invalid");
  }
  const requestedScreens =
    checkpoint === "HISTORY"
      ? fixtureRegistry.screens
      : fixtureRegistry.screens.filter(
          (screen) => screen.checkpoint === checkpoint,
        );
  const expectedGates =
    checkpoint === "VSL"
      ? ["VSL-001"]
      : checkpoint === "HISTORY"
        ? HISTORY_GATES
        : FINAL_GATES;
  if (
    JSON.stringify(requestedScreens.map((screen) => screen.gateId).sort()) !==
    JSON.stringify([...expectedGates].sort())
  ) {
    blocked("fixture registry does not declare the requested checkpoint");
  }
  let hf2Bytes, hf2, historyScope, highFi;
  if (checkpoint === "HISTORY") {
    const highFiBytes = await fsp.readFile(HISTORY_HIGH_FI_PATH);
    const lowFiBytes = await fsp.readFile(HISTORY_LOW_FI_PATH);
    highFi = assertObject(
      JSON.parse(highFiBytes.toString("utf8")),
      "History high-fi manifest",
    );
    const lowFi = assertObject(
      JSON.parse(lowFiBytes.toString("utf8")),
      "History low-fi manifest",
    );
    if (
      highFi.task !== "T048/T055" ||
      highFi.status !== "APPROVED_HIGH_FIDELITY" ||
      highFi.viewport?.width !== 1280 ||
      highFi.viewport?.height !== 760 ||
      highFi.frames?.length !== 6 ||
      lowFi.feature !== "local-version-history" ||
      lowFi.ownerDecision?.lowFidelity !== "APPROVED" ||
      lowFi.viewport?.width !== 1280 ||
      lowFi.viewport?.height !== 760
    )
      blocked("History design approval or geometry is invalid");
    historyScope = {
      registry: {
        path: HISTORY_REGISTRY_PATH,
        sha256: await sha256File(HISTORY_REGISTRY_PATH),
      },
      highFi: { path: HISTORY_HIGH_FI_PATH, sha256: sha256Bytes(highFiBytes) },
      lowFi: { path: HISTORY_LOW_FI_PATH, sha256: sha256Bytes(lowFiBytes) },
    };
    for (const screen of requestedScreens) {
      if (
        !Array.isArray(screen.checklist) ||
        screen.checklist.length === 0 ||
        screen.checklist.some(
          (item) => typeof item !== "string" || item.length === 0,
        )
      )
        blocked(`HISTORY checklist missing for ${screen.gateId}`);
      if (screen.shapeId) {
        const frame = highFi.frames.find(
          (entry) => entry.shapeId === screen.shapeId,
        );
        if (
          !frame ||
          frame.name !== screen.manifestName ||
          !/^screens\/[a-z0-9-]+\.png$/u.test(frame.path ?? "") ||
          !HEX.digest.test(frame.sha256 ?? "")
        )
          blocked(`History high-fi frame mismatch for ${screen.gateId}`);
        if (
          (await sha256File(
            path.join(path.dirname(HISTORY_HIGH_FI_PATH), frame.path),
          )) !== frame.sha256
        )
          blocked(`History high-fi screen digest changed for ${screen.gateId}`);
      } else if (typeof screen.state !== "string" || !screen.state)
        blocked(`History low-fi state missing for ${screen.gateId}`);
    }
  } else {
    hf2Bytes = await fsp.readFile(HF2_MANIFEST_PATH);
    hf2 = assertObject(JSON.parse(hf2Bytes.toString("utf8")), "HF-2 manifest");
    if (!Array.isArray(hf2.screens))
      blocked("HF-2 manifest screens are missing");
  }
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

  const fixture = await provisionFixture(
    runRoot,
    requestedScreens,
    nativeLaunchFixture,
    checkpoint,
  );
  const profilesRoot = path.join(runRoot, "profiles");
  await fsp.mkdir(profilesRoot, { recursive: true });
  if (checkpoint === "FINAL") await fsp.mkdir(path.join(profilesRoot, "T023b"));
  const screens = [];
  for (const screen of requestedScreens) {
    const baseline = hf2?.screens.find(
      (entry) => entry.path === screen.baselinePath,
    );
    if (
      checkpoint !== "HISTORY" &&
      (!baseline || baseline.name !== screen.manifestName)
    )
      blocked(`HF-2 baseline mismatch for ${screen.gateId}`);
    const profileRoot = path.join(profilesRoot, screen.gateId);
    await fsp.mkdir(profileRoot);
    screens.push({
      gateId: screen.gateId,
      profileRoot,
      preparationMode:
        checkpoint === "HISTORY" ? "operator-assisted" : screen.preparationMode,
      ...(checkpoint === "HISTORY"
        ? {
            launchDocument: path.join(
              fixture.workspaceRoot,
              "native-entrypoints",
              screen.gateId,
              nativeLaunchFixture.name,
            ),
            launchDocumentSha256: sha256Bytes(nativeLaunchFixture.bytes),
          }
        : {}),
      manifestName: screen.manifestName,
      ...(checkpoint === "HISTORY"
        ? {
            designReference: screen.shapeId
              ? {
                  kind: "approved-high-fi-frame",
                  shapeId: screen.shapeId,
                  name: screen.manifestName,
                }
              : { kind: "approved-low-fi-state", state: screen.state },
          }
        : {
            baselinePath: screen.baselinePath,
            baselineSha256: baseline.sha256,
          }),
      visualTarget: visualTargetForScreen(screen, checkpoint),
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
    ...(checkpoint === "HISTORY"
      ? { historyScope }
      : {
          hf2Manifest: {
            path: HF2_MANIFEST_PATH,
            sha256: sha256Bytes(hf2Bytes),
          },
        }),
    ...(semanticEvidence ? { semanticEvidence } : {}),
    harnessVersion:
      checkpoint === "HISTORY"
        ? "004-history-capture-v1"
        : "003-native-capture-v4",
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
            ...(nativeLaunchFixture
              ? {
                  launchDocument: path.join(
                    fixture.workspaceRoot,
                    "native-entrypoints",
                    nativeLaunchFixture.name,
                  ),
                }
              : {}),
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
  if (checkpoint === "HISTORY")
    validateHistoryPlanScope(plan, fixtureRegistry, highFi);
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
    "Usage: pnpm native:screen:prepare -- --checkpoint VSL|FINAL|HISTORY --package-manifest <absolute.json> [--semantic-collection <absolute-T031-collector-report.json> for VSL] [--native-launch-fixture <absolute.excalidraw> for FINAL] --run-root <absolute-empty-dir> --plan <absolute-new.json> --isolation-mode backend-app-data-home-redirect\nPlan schema: v2. VSL binds one PASS semantic collection. FINAL binds T023b and six HF2 capture profiles. HISTORY binds twelve History visual targets and approved design manifests without a pixel baseline or menu graph. Operator-assisted preparation is not proof of application state. Backend app-data only; WebKit filesystem isolation is not claimed. Exit codes: 0=PASS, 1=FAIL, 2=BLOCKED, 64=invalid invocation.",
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
  const nativeLaunchFixturePath = option(args, "--native-launch-fixture");
  const runRoot = option(args, "--run-root");
  const planPath = option(args, "--plan");
  const isolationMode = option(args, "--isolation-mode");
  if (
    !["VSL", "FINAL", "HISTORY"].includes(checkpoint) ||
    !packageManifestPath ||
    (checkpoint === "VSL" && !semanticCollectionPath) ||
    !runRoot ||
    !planPath ||
    !isolationMode ||
    (args.includes("--native-launch-fixture") && !nativeLaunchFixturePath)
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
      nativeLaunchFixturePath,
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
