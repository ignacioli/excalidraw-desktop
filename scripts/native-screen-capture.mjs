#!/usr/bin/env node

import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { validateCapturePlan } from "./native-screen-prepare.mjs";
import { inspectBundle } from "./native-macos-validation.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
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
const OPERATOR_READY_TIMEOUT_MS = 600_000;
const FAILURE_STOP_LIMIT = 3;

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

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(filePath) {
  return sha256Bytes(await fsp.readFile(filePath));
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
  if (values.length !== 6 || values.some((value) => !Number.isFinite(value)))
    blocked("Accessibility did not return one owned window observation");
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

export function confirmationLine(gateId, challenge) {
  return `CAPTURE ${gateId} ${challenge}`;
}

export function confirmationMatches(input, gateId, challenge) {
  return String(input).trimEnd() === confirmationLine(gateId, challenge);
}

export function confirmationDigest(challenge) {
  return sha256Bytes(Buffer.from(challenge, "utf8"));
}

export function createFailureBudget(limit = FAILURE_STOP_LIMIT) {
  return { limit, direction: null, consecutiveFailures: 0, stopped: false };
}

export function recordValidationAttempt(budget, direction, result) {
  if (budget.stopped) return budget;
  if (result === "PASS") {
    budget.direction = null;
    budget.consecutiveFailures = 0;
    return budget;
  }
  if (budget.direction === direction) budget.consecutiveFailures += 1;
  else {
    budget.direction = direction;
    budget.consecutiveFailures = 1;
  }
  if (budget.consecutiveFailures >= budget.limit) budget.stopped = true;
  return budget;
}

export function operatorPreparationMessage(screen) {
  return [
    "OPERATOR_SETUP_REQUIRED",
    `Gate: ${screen.gateId}`,
    `Visual target: ${screen.visualTarget.summary}`,
    ...screen.visualTarget.operatorChecklist.map((item) => `- ${item}`),
    "Operator actions establish state only; they are not interaction or visual evidence.",
  ].join("\n");
}

export function nativeMasksForScreen(screen) {
  return screen.nativeMasks;
}

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    blocked(
      `${label} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }
  return result.stdout;
}

function readBackingScale() {
  const script = [
    "import AppKit",
    "guard let screen = NSScreen.main else { exit(2) }",
    "print(screen.backingScaleFactor)",
  ].join("\n");
  const output = run(
    "/usr/bin/xcrun",
    ["swift", "-e", script],
    "backing-scale lookup",
  );
  const scale = Number(output.trim());
  if (![1, 2, 3].includes(scale)) blocked("backing scale is unavailable");
  return scale;
}

async function compileWindowHelper(runRoot) {
  const helper = path.join(runRoot, "native-screen-window");
  try {
    await fsp.access(helper, fsConstants.X_OK);
    return helper;
  } catch (error) {
    if (error?.code !== "ENOENT")
      blocked(`native window adapter is unavailable: ${String(error)}`);
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

function observeOwnedWindow(pid, helper) {
  return parseAxWindowObservation(
    run(helper, [String(pid), "window"], "owned-window lookup"),
  );
}

async function waitForStableOwnedWindow(pid, helper) {
  let previous = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = observeOwnedWindow(pid, helper);
    if (
      previous &&
      previous.windowId === current.windowId &&
      previous.logicalWidth === current.logicalWidth &&
      previous.logicalHeight === current.logicalHeight &&
      previous.x === current.x &&
      previous.y === current.y &&
      current.frontmost
    ) {
      return { ...current, stableSamples: 2 };
    }
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  blocked("owned window did not provide two stable samples");
}

function launchPackage(packageManifest, screen) {
  return spawn(packageManifest.executablePath, [], {
    cwd: path.dirname(packageManifest.executablePath),
    env: { ...process.env, HOME: screen.profileRoot },
    stdio: ["ignore", "ignore", "pipe"],
  });
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

async function waitForExactConfirmation(gateId, challenge, timeoutMs) {
  const input = process.stdin;
  const reader = readline.createInterface({ input, terminal: false });
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reader.close();
      reject(new NativeScreenCaptureError("terminal confirmation timed out", 2));
    }, timeoutMs);
    reader.once("line", (line) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reader.close();
      if (!confirmationMatches(line, gateId, challenge)) {
        reject(new NativeScreenCaptureError("terminal confirmation mismatch", 2));
        return;
      }
      resolve({
        mode: "terminal-exact-line",
        challengeSha256: confirmationDigest(challenge),
        confirmedAt: new Date().toISOString(),
      });
    });
    reader.once("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new NativeScreenCaptureError("terminal confirmation unavailable", 2));
    });
  });
}

async function copyExclusive(source, destination) {
  await fsp.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
}

async function loadInputs(planPath) {
  const planBytes = await fsp.readFile(planPath);
  const plan = validateCapturePlan(JSON.parse(planBytes.toString("utf8")));
  const runRoot = await fsp.realpath(plan.isolation.root);
  const ownedPaths = [
    ["fixture manifest", plan.fixture.manifestPath],
    ["fixture workspace", plan.fixture.workspaceRoot],
    ...plan.screens.map((screen) => [`${screen.gateId} profile`, screen.profileRoot]),
  ];
  for (const [label, candidate] of ownedPaths) {
    const resolved = await fsp.realpath(candidate);
    if (!inside(runRoot, resolved)) blocked(`${label} escapes the immutable run root`);
  }
  if (path.resolve(plan.hf2Manifest.path) !== HF2_MANIFEST_PATH)
    blocked("capture plan does not bind the repository HF-2 manifest");
  const packageBytes = await fsp.readFile(plan.packageManifest.path);
  const packageManifest = JSON.parse(packageBytes.toString("utf8"));
  if ((await sha256File(plan.packageManifest.path)) !== plan.packageManifest.sha256)
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

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function captureGate({ planPath, inputs, screen, collectionDir }) {
  if (process.platform !== "darwin") blocked("native screen capture requires macOS");
  if (!path.isAbsolute(collectionDir)) invalid("collection output must be absolute");
  if (!inside(inputs.runRoot, collectionDir))
    blocked("collection output must stay inside the immutable run root");
  await fsp.mkdir(path.dirname(collectionDir), { recursive: true });
  await fsp.mkdir(collectionDir);
  if ((await fsp.readdir(screen.profileRoot)).length !== 0)
    blocked(`${screen.gateId} profile is not empty`);

  const windowHelper = await compileWindowHelper(inputs.runRoot);
  const child = launchPackage(inputs.packageManifest, screen);
  let captureCount = 0;
  try {
    await resizeOwnedWindow(child.pid, windowHelper);
    const before = await waitForStableOwnedWindow(child.pid, windowHelper);
    const backingScaleBefore = readBackingScale();
    const challenge = crypto.randomBytes(32).toString("hex");
    console.log(operatorPreparationMessage(screen));
    console.log(`Enter exactly: ${confirmationLine(screen.gateId, challenge)}`);
    const operatorConfirmation = await waitForExactConfirmation(
      screen.gateId,
      challenge,
      OPERATOR_READY_TIMEOUT_MS,
    );
    const after = await waitForStableOwnedWindow(child.pid, windowHelper);
    if (
      after.windowId !== before.windowId ||
      after.logicalWidth !== 1280 ||
      after.logicalHeight !== 760
    ) {
      blocked("owned window changed before capture confirmation could be validated");
    }
    const backingScaleAfter = readBackingScale();
    if (backingScaleAfter !== backingScaleBefore)
      blocked("backing scale changed during capture readiness");
    if (!after.frontmost) blocked("owned window is not frontmost");

    const rawPath = path.join(collectionDir, "raw-window.png");
    if (captureCount !== 0) blocked("capture attempted more than once");
    captureCount += 1;
    run(
      "/usr/sbin/screencapture",
      ["-o", "-l", String(after.windowId), rawPath],
      "owned-window capture",
    );
    const rawDimensions = readPngDimensions(await fsp.readFile(rawPath));
    const backingScale = validateRawDimensions(rawDimensions);
    if (backingScale !== backingScaleAfter) blocked("captured scale does not match display scale");
    const actualPath = path.join(collectionDir, "actual.png");
    run(
      "magick",
      normalizationArgs(rawPath, actualPath, backingScale),
      "lanczos3-srgb-v1 normalization",
    );
    const actualDimensions = readPngDimensions(await fsp.readFile(actualPath));
    if (actualDimensions.width !== 1280 || actualDimensions.height !== 760)
      failed("normalized image is not 1280x760");

    const observedAppDataRoot = path.join(
      screen.profileRoot,
      "Library",
      "Application Support",
      inputs.packageManifest.bundleIdentifier,
    );
    const observedWebKitDataRoot = observedAppDataRoot;
    if (
      !inside(screen.profileRoot, observedAppDataRoot) ||
      !inside(screen.profileRoot, observedWebKitDataRoot)
    ) {
      blocked("resolved application data path escapes the isolated profile");
    }
    await fsp.access(observedAppDataRoot);
    const isolation = {
      schemaVersion: 1,
      mode: inputs.plan.isolation.mode,
      declaredRoot: inputs.plan.isolation.root,
      expectedAppDataRoot: inputs.plan.isolation.expectedAppDataRoot,
      profileRoot: screen.profileRoot,
      resolvedHome: screen.profileRoot,
      observedAppDataRoot,
      observedWebKitDataRoot,
      actualPathsObservedByCollector: true,
      operatorApplicationStateIsNotEvidence: true,
    };
    await writeJson(path.join(collectionDir, "isolation.json"), isolation);
    const isolationSha256 = await sha256File(path.join(collectionDir, "isolation.json"));
    const capturedAt = new Date().toISOString();
    const readiness = {
      schemaVersion: 1,
      runId: inputs.plan.runId,
      pid: child.pid,
      windowId: after.windowId,
      gateId: screen.gateId,
      productCommit: inputs.plan.productCommit,
      packageArtifactSha256: inputs.plan.packageManifest.artifactSha256,
      isolationEvidenceRef: "isolation.json",
      isolationEvidenceSha256: isolationSha256,
      operatorConfirmation,
      logicalWindow: {
        width: after.logicalWidth,
        height: after.logicalHeight,
        frontmost: after.frontmost,
        stableSamples: after.stableSamples,
      },
      backingScale,
      rawDimensions,
      capturedAt,
    };
    await writeJson(path.join(collectionDir, "capture-readiness.json"), readiness);
    await fsp.writeFile(path.join(collectionDir, "capture-plan.json"), inputs.planBytes, { flag: "wx" });
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
        version: "2",
        runIdentity: `${inputs.plan.runId}:${screen.gateId}`,
      },
      pid: child.pid,
      windowId: after.windowId,
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
      masks: nativeMasksForScreen(screen),
    });
    const artifactNames = [
      "actual.png",
      "baseline.sha256",
      "capture-plan.json",
      "capture-readiness.json",
      "environment.json",
      "fixture-manifest.json",
      "isolation.json",
      "mask.json",
      "raw-window.png",
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
        version: "2",
        runIdentity: `${inputs.plan.runId}:${screen.gateId}`,
      },
      preparationMode: screen.preparationMode,
      operatorActionsAreEvidence: false,
      applicationStateClaims: [],
      environmentPath: "environment.json",
      readinessPath: "capture-readiness.json",
      isolationPath: "isolation.json",
      maskPath: "mask.json",
      captureCount,
      claims: [
        {
          claimId: `${screen.gateId}-capture-integrity`,
          factClass: "repository-package-identity",
          primaryRoute: "shell-filesystem",
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
      `# ${screen.gateId} native capture collection\n\n- Result: **PASS**\n- Schema: \`v2\`\n- Operator confirmation: \`terminal-exact-line\`\n- Operator actions are evidence: \`false\`\n- Owned PID: \`${child.pid}\`\n- Window ID: \`${after.windowId}\`\n- Backing scale: \`${backingScale}\`\n- Capture count: \`${captureCount}\`\n- Normalization: \`lanczos3-srgb-v1\`\n- Application-state claims: none\n- Reviewer verdict: not authored by this collector\n`,
      { encoding: "utf8", flag: "wx" },
    );
    return report;
  } finally {
    await stopOwnedChild(child);
  }
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

export async function captureNativeScreens({
  planPath,
  gate,
  allFinal,
  collectionDir,
  collectionRoot,
}) {
  if (typeof planPath !== "string" || !path.isAbsolute(planPath))
    invalid("--plan must be absolute");
  const inputs = await loadInputs(planPath);
  const budget = createFailureBudget();
  if (allFinal) {
    if (
      inputs.plan.checkpoint !== "FINAL" ||
      !path.isAbsolute(collectionRoot ?? "") ||
      (await fsp.lstat(collectionRoot).catch(() => null)) !== null
    ) {
      invalid("--all-final requires a FINAL plan and a new absolute --collection-root");
    }
    if (!inside(inputs.runRoot, collectionRoot))
      blocked("collection root must stay inside the immutable run root");
    await fsp.mkdir(collectionRoot);
    const reports = [];
    for (const gateId of FINAL_GATES) {
      const screen = inputs.plan.screens.find((entry) => entry.gateId === gateId);
      if (!screen) blocked(`FINAL plan is missing ${gateId}`);
      try {
        const report = await captureGate({
          planPath,
          inputs,
          screen,
          collectionDir: path.join(
            collectionRoot,
            gateId,
            "collection",
            `${gateId}-native-capture`,
          ),
        });
        recordValidationAttempt(budget, "native-screen-capture-v2", report.result);
        reports.push(report);
      } catch (error) {
        recordValidationAttempt(budget, "native-screen-capture-v2", "FAIL");
        if (budget.stopped)
          blocked("three consecutive native capture failures; stop for direction review");
        throw error;
      }
    }
    return reports;
  }
  if (!gate || !path.isAbsolute(collectionDir ?? ""))
    invalid("single capture requires --gate and absolute --collection-dir");
  const screen = inputs.plan.screens.find((entry) => entry.gateId === gate);
  if (!screen) blocked(`capture plan is missing ${gate}`);
  return [await captureGate({ planPath, inputs, screen, collectionDir })];
}

function usage() {
  console.log(
    "Usage:\n  pnpm native:screen:capture -- --plan <absolute-plan> --gate VSL-001 --collection-dir <absolute-new-dir>\n  pnpm native:screen:capture -- --plan <absolute-final-plan> --all-final --collection-root <absolute-new-root>\nEach gate prints the declared visual checklist and one exact CAPTURE <gate-id> <challenge> line; confirmation controls timing only and is not evidence.\nExit codes: 0=PASS, 1=FAIL, 2=BLOCKED, 64=invalid invocation. Capture is owned-window-only; content-GUI automation, full-screen capture, coordinate search and visual repair are prohibited.",
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
        { result: "PASS", collections: reports.map((report) => report.collectionId) },
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
