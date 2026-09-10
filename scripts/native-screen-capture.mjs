#!/usr/bin/env node

import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateCapturePlan } from "./native-screen-prepare.mjs";
import { inspectBundle } from "./native-macos-validation.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const FINAL_GATES = [
  "HF2-01",
  "HF2-02",
  "HF2-03",
  "HF2-04",
  "HF2-05",
  "HF2-06",
];
const READY_TIMEOUT_MS = 15_000;
const OPERATOR_READY_TIMEOUT_MS = 600_000;

export class NativeScreenCaptureError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "NativeScreenCaptureError";
    this.exitCode = exitCode;
  }
}

function blocked(message) {
  throw new NativeScreenCaptureError(message, 2);
}

function failed(message) {
  throw new NativeScreenCaptureError(message, 1);
}

function invalid(message) {
  throw new NativeScreenCaptureError(message, 64);
}

async function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(await fsp.readFile(filePath))
    .digest("hex");
}

function artifactDigest(artifacts) {
  return crypto
    .createHash("sha256")
    .update(
      [...artifacts]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((entry) => `${entry.path}\0${entry.sha256}`)
        .join("\n"),
    )
    .digest("hex");
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function readPngDimensions(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    blocked("capture output is not a valid PNG with IHDR dimensions");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export function validateRawDimensions(
  raw,
  logical = { width: 1280, height: 760 },
) {
  const scaleX = raw.width / logical.width;
  const scaleY = raw.height / logical.height;
  if (
    !Number.isInteger(scaleX) ||
    scaleX <= 0 ||
    scaleX !== scaleY ||
    ![1, 2, 3].includes(scaleX)
  ) {
    blocked("raw window dimensions cannot be explained by one backing scale");
  }
  return scaleX;
}

export function normalizationArgs(rawPath, actualPath, backingScale) {
  if (![1, 2, 3].includes(backingScale)) invalid("backing scale is invalid");
  return backingScale === 1
    ? [rawPath, "-colorspace", "sRGB", "-strip", `PNG32:${actualPath}`]
    : [
        rawPath,
        "-colorspace",
        "sRGB",
        "-filter",
        "Lanczos",
        "-define",
        "filter:lobes=3",
        "-resize",
        "1280x760!",
        "-strip",
        `PNG32:${actualPath}`,
      ];
}

export function parseAxWindowObservation(output) {
  const values = String(output)
    .trim()
    .split(/\s*,\s*/u)
    .map(Number);
  if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) {
    blocked("Accessibility did not return one owned window observation");
  }
  const [windowId, width, height, x, y, frontmost] = values;
  if (
    !Number.isInteger(windowId) ||
    windowId <= 0 ||
    width !== 1280 ||
    height !== 760
  ) {
    blocked("owned window identity or logical geometry is invalid");
  }
  return {
    windowId,
    logicalWidth: width,
    logicalHeight: height,
    x,
    y,
    frontmost: frontmost === 1,
  };
}

export function validateReadyCandidate(plan, screen, candidate, childPid) {
  if (
    candidate?.schemaVersion !== 1 ||
    candidate.runId !== plan.runId ||
    candidate.runNonce !== plan.runNonce ||
    candidate.pid !== childPid ||
    candidate.gateId !== screen.gateId ||
    candidate.productCommit !== plan.productCommit ||
    candidate.packageArtifactSha256 !== plan.packageManifest.artifactSha256 ||
    candidate.stateFingerprint !== screen.expectedStateFingerprint ||
    candidate.stateFingerprintVersion !== "shell-state-v1" ||
    candidate.fontReady !== true ||
    candidate.remoteFontRequests !== 0 ||
    candidate.pendingOperations !== 0 ||
    candidate.stableFrames < 2 ||
    !Number.isInteger(candidate.logicalWindow?.width) ||
    candidate.logicalWindow.width <= 0 ||
    !Number.isInteger(candidate.logicalWindow?.height) ||
    candidate.logicalWindow.height <= 0 ||
    candidate.logicalWindow?.frontmost !== true ||
    !inside(screen.profileRoot, candidate.resolvedPaths?.appData ?? "") ||
    !inside(screen.profileRoot, candidate.resolvedPaths?.webKitData ?? "")
  ) {
    blocked(
      "ready candidate does not match the plan, child, profile, or stable state",
    );
  }
  return candidate;
}

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    blocked(
      `${label} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }
  return result.stdout;
}

export function readyTimeoutForScreen(screen, defaultTimeoutMs) {
  return screen.preparationMode === "operator-assisted"
    ? Math.max(defaultTimeoutMs, OPERATOR_READY_TIMEOUT_MS)
    : defaultTimeoutMs;
}

export function operatorPreparationMessage(screen, workspaceRoot) {
  return [
    "OPERATOR_SETUP_REQUIRED",
    JSON.stringify({
      gateId: screen.gateId,
      workspaceRoot: workspaceRoot ?? null,
      theme: screen.theme,
      sessionState: screen.sessionState,
      sidebarState: screen.sidebarState,
      workspaceName: screen.workspaceName,
      selectedDirectory: screen.selectedDirectory,
      tabs: screen.tabs,
      activeDocument: screen.activeDocument,
      unsaved: screen.unsaved,
    }),
    "Use normal application UI to establish this state; operator actions are state setup, not evidence.",
  ].join("\n");
}

async function resizeOwnedWindow(pid, helper) {
  const deadline = Date.now() + 10_000;
  let detail = "application window did not become available";
  while (Date.now() < deadline) {
    const result = spawnSync(helper, [String(pid), "resize"], {
      encoding: "utf8",
    });
    if (result.status === 0) return;
    detail = (result.stderr || result.stdout || detail).trim();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  blocked(`native window sizing failed: ${detail}`);
}

function observeOwnedWindow(pid, helper) {
  return parseAxWindowObservation(
    run(helper, [String(pid), "window"], "owned-window lookup"),
  );
}

async function compileWindowHelper(controlDir) {
  const helper = path.join(controlDir, "native-screen-window");
  try {
    await fsp.access(helper, fsConstants.X_OK);
    return helper;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      blocked(`native window adapter is unavailable: ${String(error)}`);
    }
  }
  run(
    "/usr/bin/xcrun",
    [
      "swiftc",
      path.join(REPO_ROOT, "scripts/native-screen-window.swift"),
      "-o",
      helper,
    ],
    "compile native window adapter",
  );
  return helper;
}

async function waitForReadyCandidate(filePath, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fsp.readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT")
        blocked(
          `ready candidate is invalid: ${String(error.message ?? error)}`,
        );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  blocked("timed out waiting for nonce-bound ready candidate");
}

async function stopOwnedChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function copyExclusive(source, destination) {
  await fsp.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
}

async function loadInputs(planPath) {
  const planBytes = await fsp.readFile(planPath);
  const plan = validateCapturePlan(JSON.parse(planBytes.toString("utf8")));
  const runRoot = await fsp.realpath(path.dirname(planPath));
  const ownedPaths = [
    ["control directory", plan.controlDir],
    ["fixture manifest", plan.fixture.manifestPath],
    ["fixture workspace", plan.fixture.workspaceRoot],
    ["native entrypoint profile", plan.nativeEntrypointProfileRoot],
    ...plan.screens.map((screen) => [
      `${screen.gateId} profile`,
      screen.profileRoot,
    ]),
  ];
  for (const [label, candidate] of ownedPaths) {
    const resolved = await fsp.realpath(candidate);
    if (!inside(runRoot, resolved)) {
      blocked(`${label} escapes the immutable run root`);
    }
  }
  if (
    path.resolve(plan.hf2Manifest.path) !==
    path.join(REPO_ROOT, "docs/design/desktop-shell/hf-2/manifest.json")
  ) {
    blocked("capture plan does not bind the repository HF-2 manifest");
  }
  const packageBytes = await fsp.readFile(plan.packageManifest.path);
  const packageManifest = JSON.parse(packageBytes.toString("utf8"));
  if (
    (await sha256File(plan.packageManifest.path)) !==
    plan.packageManifest.sha256
  )
    blocked("sealed package manifest digest changed");
  if ((await sha256File(plan.hf2Manifest.path)) !== plan.hf2Manifest.sha256)
    blocked("HF-2 manifest digest changed");
  if ((await sha256File(plan.fixture.manifestPath)) !== plan.fixture.digest)
    blocked("fixture manifest digest changed");
  const bundle = await inspectBundle(packageManifest.appPath, REPO_ROOT);
  if (
    bundle.artifactSha256 !== plan.packageManifest.artifactSha256 ||
    packageManifest.gitCommit !== plan.productCommit ||
    packageManifest.executablePath !== bundle.executablePath
  ) {
    blocked("sealed production package identity changed");
  }
  return { plan, planBytes, packageManifest, packageBytes, runRoot };
}

function launchPackage(packageManifest, planPath, plan, screen) {
  return spawn(packageManifest.executablePath, [], {
    cwd: path.dirname(packageManifest.executablePath),
    env: {
      ...process.env,
      HOME: screen.profileRoot,
      EXCALIDRAW_NATIVE_CAPTURE_PLAN: planPath,
      EXCALIDRAW_NATIVE_CAPTURE_GATE: screen.gateId,
      EXCALIDRAW_NATIVE_CAPTURE_NONCE: plan.runNonce,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function captureGate({
  planPath,
  inputs,
  screen,
  collectionDir,
  timeoutMs,
}) {
  if (process.platform !== "darwin")
    blocked("native screen capture requires macOS");
  if (!path.isAbsolute(collectionDir))
    invalid("collection output must be absolute");
  if (!inside(inputs.runRoot, collectionDir)) {
    blocked("collection output must stay inside the immutable run root");
  }
  await fsp.mkdir(path.dirname(collectionDir), { recursive: true });
  await fsp.mkdir(collectionDir);
  if ((await fsp.readdir(screen.profileRoot)).length !== 0)
    blocked(`${screen.gateId} profile is not empty`);
  const windowHelper = await compileWindowHelper(inputs.plan.controlDir);
  const child = launchPackage(
    inputs.packageManifest,
    planPath,
    inputs.plan,
    screen,
  );
  let candidate;
  try {
    await resizeOwnedWindow(child.pid, windowHelper);
    if (screen.preparationMode === "operator-assisted") {
      console.log(
        operatorPreparationMessage(screen, inputs.plan.fixture.workspaceRoot),
      );
    }
    candidate = await waitForReadyCandidate(
      path.join(
        inputs.plan.controlDir,
        `${screen.gateId}.ready-candidate.json`,
      ),
      readyTimeoutForScreen(screen, timeoutMs),
    );
    validateReadyCandidate(inputs.plan, screen, candidate, child.pid);
    const window = observeOwnedWindow(child.pid, windowHelper);
    if (!window.frontmost) blocked("owned window is not frontmost");
    const rawPath = path.join(collectionDir, "raw-window.png");
    run(
      "/usr/sbin/screencapture",
      ["-o", "-l", String(window.windowId), rawPath],
      "owned-window capture",
    );
    const rawDimensions = readPngDimensions(await fsp.readFile(rawPath));
    const backingScale = validateRawDimensions(rawDimensions);
    const actualPath = path.join(collectionDir, "actual.png");
    const resizeArgs = normalizationArgs(rawPath, actualPath, backingScale);
    run("magick", resizeArgs, "lanczos3-srgb-v1 normalization");
    const actualDimensions = readPngDimensions(await fsp.readFile(actualPath));
    if (actualDimensions.width !== 1280 || actualDimensions.height !== 760)
      failed("normalized image is not 1280x760");
    const ready = {
      ...candidate,
      windowId: window.windowId,
      backingScale,
      rawDimensions,
      normalizationAlgorithm: "lanczos3-srgb-v1",
      readyAt: new Date().toISOString(),
    };
    await writeJson(path.join(collectionDir, "ready.json"), ready);
    await fsp.writeFile(
      path.join(collectionDir, "capture-plan.json"),
      inputs.planBytes,
      { flag: "wx" },
    );
    await fsp.writeFile(
      path.join(collectionDir, "sealed-package-manifest.json"),
      inputs.packageBytes,
      { flag: "wx" },
    );
    await copyExclusive(
      inputs.plan.fixture.manifestPath,
      path.join(collectionDir, "fixture-manifest.json"),
    );
    await writeJson(path.join(collectionDir, "environment.json"), {
      schemaVersion: 1,
      collectionId: `${screen.gateId}-native-capture`,
      gateId: screen.gateId,
      route: "fixed-capture-review",
      binding: {
        productCommit: inputs.plan.productCommit,
        hf2ManifestSha256: inputs.plan.hf2Manifest.sha256,
        fixtureDigest: inputs.plan.fixture.digest,
        harnessVersion: inputs.plan.harnessVersion,
        packageArtifactSha256: inputs.plan.packageManifest.artifactSha256,
      },
      os: process.platform,
      viewport: { width: 1280, height: 760 },
      browserOrAppBuild: inputs.packageManifest.appPath,
      fixture: inputs.plan.fixture.id,
      preparationMode: screen.preparationMode,
      operatorActionsAreEvidence: false,
      collector: {
        tool: "native-screen-capture",
        version: "1",
        runIdentity: `${inputs.plan.runId}:${screen.gateId}`,
      },
      window,
      backingScale,
      normalizationAlgorithm: "lanczos3-srgb-v1",
    });
    await fsp.writeFile(
      path.join(collectionDir, "baseline.sha256"),
      `${screen.baselinePath} ${screen.baselineSha256}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await writeJson(path.join(collectionDir, "mask.json"), {
      schemaVersion: 1,
      collectionId: `${screen.gateId}-native-capture`,
      gateId: screen.gateId,
      binding: {
        productCommit: inputs.plan.productCommit,
        hf2ManifestSha256: inputs.plan.hf2Manifest.sha256,
        fixtureDigest: inputs.plan.fixture.digest,
        harnessVersion: inputs.plan.harnessVersion,
        packageArtifactSha256: inputs.plan.packageManifest.artifactSha256,
      },
      masks: [],
    });
    const artifactNames = [
      "actual.png",
      "baseline.sha256",
      "capture-plan.json",
      "environment.json",
      "fixture-manifest.json",
      "mask.json",
      "raw-window.png",
      "ready.json",
      "sealed-package-manifest.json",
    ];
    const artifactDigests = await Promise.all(
      artifactNames.map(async (name) => ({
        path: name,
        sha256: await sha256File(path.join(collectionDir, name)),
      })),
    );
    const report = {
      schemaVersion: 1,
      collectionId: `${screen.gateId}-native-capture`,
      gateId: screen.gateId,
      route: "fixed-capture-review",
      binding: {
        productCommit: inputs.plan.productCommit,
        hf2ManifestSha256: inputs.plan.hf2Manifest.sha256,
        fixtureDigest: inputs.plan.fixture.digest,
        harnessVersion: inputs.plan.harnessVersion,
        packageArtifactSha256: inputs.plan.packageManifest.artifactSha256,
      },
      collector: {
        tool: "native-screen-capture",
        version: "1",
        runIdentity: `${inputs.plan.runId}:${screen.gateId}`,
      },
      preparationMode: screen.preparationMode,
      operatorActionsAreEvidence: false,
      environmentPath: "environment.json",
      maskPath: "mask.json",
      claims: [
        {
          claimId: `${screen.gateId}-owned-window-capture`,
          factClass: "visual-fidelity",
          primaryRoute: "fixed-capture-review",
          result: "PASS",
          artifactRefs: artifactNames,
        },
      ],
      artifactDigests,
      collectionDigest: artifactDigest(artifactDigests),
      result: "PASS",
    };
    await writeJson(path.join(collectionDir, "collector-report.json"), report);
    await fsp.writeFile(
      path.join(collectionDir, "collector-report.md"),
      `# ${screen.gateId} native capture collection\n\n- Result: **PASS**\n- Preparation mode: \`${screen.preparationMode}\`\n- Operator actions are evidence: \`false\`\n- Owned PID: \`${child.pid}\`\n- Window ID: \`${window.windowId}\`\n- Backing scale: \`${backingScale}\`\n- Normalization: \`lanczos3-srgb-v1\`\n- Reviewer verdict: not authored by this collector\n`,
      { encoding: "utf8", flag: "wx" },
    );
    return report;
  } finally {
    await stopOwnedChild(child);
  }
}

export async function captureNativeScreens({
  planPath,
  gate,
  allFinal,
  collectionDir,
  collectionRoot,
  timeoutMs = READY_TIMEOUT_MS,
}) {
  if (typeof planPath !== "string" || !path.isAbsolute(planPath)) {
    invalid("--plan must be absolute");
  }
  const inputs = await loadInputs(planPath);
  if (allFinal) {
    if (
      inputs.plan.checkpoint !== "FINAL" ||
      !path.isAbsolute(collectionRoot ?? "")
    )
      invalid(
        "--all-final requires a FINAL plan and absolute --collection-root",
      );
    await fsp.mkdir(collectionRoot);
    const reports = [];
    for (const gateId of FINAL_GATES) {
      const screen = inputs.plan.screens.find(
        (entry) => entry.gateId === gateId,
      );
      if (!screen) blocked(`FINAL plan is missing ${gateId}`);
      reports.push(
        await captureGate({
          planPath,
          inputs,
          screen,
          collectionDir: path.join(
            collectionRoot,
            gateId,
            "collection",
            `${gateId}-native-capture`,
          ),
          timeoutMs,
        }),
      );
    }
    return reports;
  }
  if (!gate || !path.isAbsolute(collectionDir ?? ""))
    invalid("single capture requires --gate and absolute --collection-dir");
  const screen = inputs.plan.screens.find((entry) => entry.gateId === gate);
  if (!screen) blocked(`capture plan is missing ${gate}`);
  return [
    await captureGate({ planPath, inputs, screen, collectionDir, timeoutMs }),
  ];
}

function usage() {
  console.log(
    "Usage:\n  pnpm native:screen:capture -- --plan <absolute-plan> --gate VSL-001 --collection-dir <absolute-new-dir>\n  pnpm native:screen:capture -- --plan <absolute-final-plan> --all-final --collection-root <absolute-new-root>\nOperator-assisted screens print OPERATOR_SETUP_REQUIRED and wait up to 600 seconds for the observation-only ready signal; operator actions are not evidence.\nExit codes: 0=PASS, 1=FAIL, 2=BLOCKED, 64=invalid invocation. Capture is owned-window-only; content-GUI automation, full-screen capture, and coordinate search are prohibited.",
  );
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("help")) return usage();
  try {
    const reports = await captureNativeScreens({
      planPath: option(args, "--plan"),
      gate: option(args, "--gate"),
      allFinal: args.includes("--all-final"),
      collectionDir: option(args, "--collection-dir"),
      collectionRoot: option(args, "--collection-root"),
    });
    console.log(
      JSON.stringify(
        {
          result: "PASS",
          collections: reports.map((report) => report.collectionId),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exitCode =
      error instanceof NativeScreenCaptureError ? error.exitCode : 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH)
  await main();
