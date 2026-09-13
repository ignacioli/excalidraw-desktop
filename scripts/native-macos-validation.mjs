#!/usr/bin/env node

/**
 * Deterministic T023b validation for the production macOS bundle.
 *
 * The script deliberately does not take screenshots.  Package identity is
 * checked from the bundle and its contents, native menu semantics are read
 * through System Events, and command routing is checked from the structured
 * stderr probes emitted by the production build.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

export const NATIVE_VALIDATION_PREFIX = "EXCALIDRAW_NATIVE_MENU_VALIDATION ";
export const EXPECTED_WINDOW_SIZE = Object.freeze({ width: 1280, height: 760 });
export const EXPECTED_MENU_ITEMS = Object.freeze([
  Object.freeze({
    path: Object.freeze(["File", "Save"]),
    command: "save",
    enabled: true,
    keyboard: Object.freeze({
      character: "s",
      modifiers: Object.freeze(["command"]),
    }),
  }),
  Object.freeze({
    path: Object.freeze(["File", "Export Image"]),
    command: "exportImage",
    enabled: true,
    keyboard: Object.freeze({
      character: "e",
      modifiers: Object.freeze(["command", "option"]),
    }),
  }),
  Object.freeze({
    path: Object.freeze(["View", "Appearance", "System"]),
    command: "appearanceSystem",
    enabled: true,
    keyboard: null,
  }),
  Object.freeze({
    path: Object.freeze(["View", "Appearance", "Light"]),
    command: "appearanceLight",
    enabled: true,
    keyboard: null,
  }),
  Object.freeze({
    path: Object.freeze(["View", "Appearance", "Dark"]),
    command: "appearanceDark",
    enabled: true,
    keyboard: null,
  }),
]);

const VALID_STAGES = new Set(["nativeEntry", "applicationRoute"]);
const VALID_COMMANDS = new Set(EXPECTED_MENU_ITEMS.map((item) => item.command));
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

export class NativeValidationBlockedError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "NativeValidationBlockedError";
  }
}

export function parseNativeValidationLine(line) {
  if (typeof line !== "string" || !line.startsWith(NATIVE_VALIDATION_PREFIX))
    return null;
  const payload = line.slice(NATIVE_VALIDATION_PREFIX.length).trim();
  let value;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    !VALID_STAGES.has(value.stage) ||
    !Number.isInteger(value.validationId) ||
    value.validationId <= 0 ||
    !VALID_COMMANDS.has(value.command)
  ) {
    return null;
  }
  return {
    stage: value.stage,
    validationId: value.validationId,
    command: value.command,
  };
}

export function parseNativeValidationEvents(text) {
  return String(text ?? "")
    .split(/\r?\n/u)
    .map(parseNativeValidationLine)
    .filter((event) => event !== null);
}

export function validationPair(events, command, ignoredIds = new Set()) {
  const byId = new Map();
  for (const event of events) {
    if (event.command !== command || ignoredIds.has(event.validationId))
      continue;
    const stages = byId.get(event.validationId) ?? new Set();
    stages.add(event.stage);
    byId.set(event.validationId, stages);
  }
  for (const [validationId, stages] of byId) {
    if (stages.has("nativeEntry") && stages.has("applicationRoute")) {
      return { validationId, command, stages: [...stages].sort() };
    }
  }
  return null;
}

export function aggregateStatus(statuses) {
  const values = statuses.map((status) =>
    typeof status === "string" ? status : status.status,
  );
  if (values.includes("FAIL")) return "FAIL";
  if (values.includes("BLOCKED")) return "BLOCKED";
  return "PASS";
}

export function makeCheck(id, label, status, details = {}) {
  if (!new Set(["PASS", "FAIL", "BLOCKED"]).has(status)) {
    throw new TypeError(`Invalid check status: ${status}`);
  }
  return { id, label, ...details, status };
}

export function buildReport({
  checks = [],
  command,
  manifestPath = null,
  startedAt,
  finishedAt,
  ...rest
}) {
  return {
    schemaVersion: 1,
    command,
    status: aggregateStatus(checks),
    startedAt: startedAt ?? new Date().toISOString(),
    finishedAt: finishedAt ?? new Date().toISOString(),
    manifestPath,
    checks,
    ...rest,
  };
}

export function validatePreparedNativeProfile(plan, manifest) {
  const profileRoot = path.join(plan?.isolation?.root ?? "", "profiles", "T023b");
  if (
    !plan ||
    typeof plan !== "object" ||
    plan.schemaVersion !== 2 ||
    !path.isAbsolute(plan.isolation?.root ?? "") ||
    path.relative(plan.isolation.root, profileRoot).startsWith("..") ||
    !/^[0-9a-f-]{36}$/u.test(plan.runId ?? "") ||
    plan.productCommit !== manifest.gitCommit ||
    plan.packageManifest?.artifactSha256 !==
      (manifest.artifactSha256 ?? manifest.packageSha256) ||
    !Array.isArray(plan.screens)
  ) {
    throw new NativeValidationBlockedError(
      "capture plan does not provide a matching disposable T023b profile",
    );
  }
  return {
    profileRoot,
    environment: {
      HOME: profileRoot,
    },
  };
}

function nativeCollectionDigest(artifacts) {
  const canonical = [...artifacts]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((artifact) => `${artifact.path}\0${artifact.sha256}`)
    .join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function requireNativeAdapterBinding(value) {
  if (!value || typeof value !== "object") {
    throw new NativeValidationBlockedError(
      "native evidence binding must be an object",
    );
  }
  for (const [key, pattern] of [
    ["productCommit", /^[0-9a-f]{40}$/u],
    ["hf2ManifestSha256", /^[0-9a-f]{64}$/u],
    ["fixtureDigest", /^[0-9a-f]{64}$/u],
    ["packageArtifactSha256", /^[0-9a-f]{64}$/u],
  ]) {
    if (!pattern.test(value[key] ?? "")) {
      throw new NativeValidationBlockedError(
        `native evidence binding.${key} is invalid`,
      );
    }
  }
  if (typeof value.harnessVersion !== "string" || value.harnessVersion === "") {
    throw new NativeValidationBlockedError(
      "native evidence binding.harnessVersion is invalid",
    );
  }
  return value;
}

export function adaptNativeValidationReport(report, bindingValue) {
  const binding = requireNativeAdapterBinding(bindingValue);
  if (!report || typeof report !== "object" || !Array.isArray(report.checks)) {
    throw new NativeValidationBlockedError(
      "native validation report is malformed",
    );
  }
  const actions = report.checks
    .filter((check) => /^(?:save|export|appearance)-/u.test(check.id))
    .map((check) => ({
      checkId: check.id,
      command: check.command,
      validationId: check.validationId,
      result: check.status,
    }));
  const filesystemChecks = report.checks
    .filter((check) => /(?:filesystem|outcome|partial-target)/u.test(check.id))
    .map((check) => ({ checkId: check.id, result: check.status }));
  const environment = {
    schemaVersion: 1,
    collectionId: "native-entrypoints",
    gateId: "T023b",
    route: "macos-accessibility",
    binding,
    os: report.environment?.productVersion ?? "unknown macOS",
    browserOrAppBuild:
      report.manifest?.appPath ?? report.manifestPath ?? "unknown package",
    fixture: "T023b-disposable-profile",
    collector: {
      tool: "native-macos-validation",
      version: "2",
      runIdentity: `${binding.productCommit}:T023b`,
    },
  };
  return {
    environment,
    routeAcknowledgements: {
      schemaVersion: 1,
      collectionId: "native-entrypoints",
      gateId: "T023b",
      binding,
      actions,
    },
    filesystemOutcomes: {
      schemaVersion: 1,
      collectionId: "native-entrypoints",
      gateId: "T023b",
      binding,
      checks: filesystemChecks,
      result:
        filesystemChecks.length === 0
          ? "BLOCKED"
          : aggregateStatus(filesystemChecks),
    },
  };
}

export async function writeNativeValidationCollection(
  collectionDir,
  report,
  bindingValue,
) {
  const records = adaptNativeValidationReport(report, bindingValue);
  try {
    await fsp.mkdir(collectionDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      await fsp.mkdir(path.dirname(collectionDir), { recursive: true });
      await fsp.mkdir(collectionDir);
    } else if (error?.code === "EEXIST") {
      throw new NativeValidationBlockedError(
        "native collection destination already exists",
        error,
      );
    } else {
      throw error;
    }
  }
  const payloads = {
    "environment.json": records.environment,
    "route-acknowledgements.json": records.routeAcknowledgements,
    "filesystem-outcomes.json": records.filesystemOutcomes,
    "native-report.json": report,
  };
  for (const [name, value] of Object.entries(payloads)) {
    await fsp.writeFile(
      path.join(collectionDir, name),
      `${JSON.stringify(value, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  }
  const artifactDigests = [];
  for (const name of Object.keys(payloads)) {
    artifactDigests.push({
      path: name,
      sha256: await sha256File(path.join(collectionDir, name)),
    });
  }
  const result = aggregateStatus([
    report.status,
    records.filesystemOutcomes.result,
  ]);
  const collectorReport = {
    schemaVersion: 1,
    collectionId: "native-entrypoints",
    gateId: "T023b",
    route: "macos-accessibility",
    binding: records.environment.binding,
    collector: records.environment.collector,
    environmentPath: "environment.json",
    claims: [
      {
        claimId: "native-menu-entrypoints",
        factClass: "native-menu-action",
        primaryRoute: "macos-accessibility",
        result: report.status,
        artifactRefs: ["native-report.json", "route-acknowledgements.json"],
      },
      {
        claimId: "native-filesystem-outcomes",
        factClass: "application-route-outcome",
        primaryRoute: "macos-accessibility",
        result: records.filesystemOutcomes.result,
        artifactRefs: ["filesystem-outcomes.json"],
      },
    ],
    artifactDigests,
    collectionDigest: nativeCollectionDigest(artifactDigests),
    result,
  };
  await fsp.writeFile(
    path.join(collectionDir, "collector-report.json"),
    `${JSON.stringify(collectorReport, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return collectorReport;
}

export function decodeAXModifiers(value) {
  if (value === "" || value === null || value === undefined) return [];
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return [];
  const modifiers = [];
  if (number & 1) modifiers.push("shift");
  if (number & 2) modifiers.push("option");
  if (number & 4) modifiers.push("control");
  if (!(number & 8)) modifiers.unshift("command");
  return modifiers;
}

export function normalizeKeyboardObservation(observation) {
  if (!observation || typeof observation !== "object") return null;
  const character =
    observation.character == null
      ? ""
      : String(observation.character).toLowerCase();
  const modifiers = Array.isArray(observation.modifiers)
    ? [
        ...new Set(
          observation.modifiers.map((modifier) =>
            String(modifier).toLowerCase(),
          ),
        ),
      ].sort()
    : decodeAXModifiers(observation.modifiers).sort();
  return { character, modifiers };
}

export function compareMenuObservation(expected, observed) {
  const keyboard = expected.keyboard;
  const normalizedObservedKeyboard = normalizeKeyboardObservation(
    observed.keyboard,
  );
  const observedKeyboard =
    normalizedObservedKeyboard &&
    normalizedObservedKeyboard.character === "" &&
    normalizedObservedKeyboard.modifiers.length === 0
      ? null
      : normalizedObservedKeyboard;
  const expectedKeyboard = keyboard
    ? {
        character: keyboard.character,
        modifiers: [...keyboard.modifiers].sort(),
      }
    : null;
  const enabled = observed.enabled === expected.enabled;
  const keyboardMatches =
    JSON.stringify(observedKeyboard) === JSON.stringify(expectedKeyboard);
  return {
    pass: observed.label === expected.path.at(-1) && enabled && keyboardMatches,
    labelMatches: observed.label === expected.path.at(-1),
    enabled,
    keyboardMatches,
    expected: {
      label: expected.path.at(-1),
      enabled: expected.enabled,
      keyboard: expectedKeyboard,
    },
    observed: {
      label: observed.label,
      enabled: observed.enabled,
      keyboard: observedKeyboard,
    },
  };
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function listArtifactEntries(root) {
  const entries = [];
  async function walk(current) {
    const names = (await fsp.readdir(current, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of names) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile()) entries.push({ fullPath, kind: "file" });
      else if (entry.isSymbolicLink())
        entries.push({
          fullPath,
          kind: "symlink",
          target: await fsp.readlink(fullPath),
        });
    }
  }
  await walk(root);
  return entries;
}

/** Hashes a package tree deterministically, including relative names. */
export async function sha256Path(targetPath) {
  const stat = await fsp.lstat(targetPath);
  if (stat.isFile()) return sha256File(targetPath);
  if (stat.isSymbolicLink()) {
    return crypto
      .createHash("sha256")
      .update("symlink\0")
      .update(await fsp.readlink(targetPath))
      .digest("hex");
  }
  if (!stat.isDirectory())
    throw new Error(`Unsupported artifact type: ${targetPath}`);
  const hash = crypto.createHash("sha256");
  for (const entry of await listArtifactEntries(targetPath)) {
    const relativePath = path
      .relative(targetPath, entry.fullPath)
      .split(path.sep)
      .join("/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(entry.kind);
    hash.update("\0");
    if (entry.kind === "file") hash.update(await fsp.readFile(entry.fullPath));
    else hash.update(entry.target);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
    error: result.error,
  };
}

function runRequired(command, args, options = {}) {
  const result = runSync(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function gitState(repoRoot) {
  const commitResult = runSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  const statusResult = runSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    {
      cwd: repoRoot,
    },
  );
  return {
    commit: commitResult.status === 0 ? commitResult.stdout.trim() : null,
    status: statusResult.status === 0 ? statusResult.stdout.trim() : null,
    clean:
      commitResult.status === 0 &&
      statusResult.status === 0 &&
      statusResult.stdout.trim() === "",
  };
}

function readPlistValue(plistPath, key) {
  const result = runSync("plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    plistPath,
  ]);
  if (result.status !== 0)
    throw new Error(
      `Unable to read ${key} from ${plistPath}: ${result.stderr.trim()}`,
    );
  return result.stdout.trim();
}

export async function inspectBundle(appPath, repoRoot = REPO_ROOT) {
  const absolutePath = path.resolve(appPath);
  const plistPath = path.join(absolutePath, "Contents", "Info.plist");
  const bundleIdentifier = readPlistValue(plistPath, "CFBundleIdentifier");
  const version = readPlistValue(plistPath, "CFBundleShortVersionString");
  const buildVersion = readPlistValue(plistPath, "CFBundleVersion");
  const executable = readPlistValue(plistPath, "CFBundleExecutable");
  const executablePath = path.join(
    absolutePath,
    "Contents",
    "MacOS",
    executable,
  );
  const [packageSha256, executableSha256] = await Promise.all([
    sha256Path(absolutePath),
    sha256Path(executablePath),
  ]);
  const bundleDirectory = path.dirname(absolutePath);
  const siblingArtifacts = (
    await fsp.readdir(bundleDirectory, { withFileTypes: true })
  )
    .filter(
      (entry) =>
        entry.isFile() || (entry.isDirectory() && entry.name.endsWith(".app")),
    )
    .map((entry) => path.join(bundleDirectory, entry.name))
    .sort();
  const artifacts = [];
  for (const artifactPath of siblingArtifacts) {
    artifacts.push({
      path: artifactPath,
      sha256: await sha256Path(artifactPath),
      kind: artifactPath.endsWith(".app") ? "app" : "file",
    });
  }
  return {
    appPath: absolutePath,
    bundleIdentifier,
    version,
    buildVersion,
    executable,
    executablePath,
    executableSha256,
    packageSha256,
    artifactSha256: packageSha256,
    artifacts,
    repositoryCommit: gitState(repoRoot).commit,
  };
}

export function compareManifest(manifest, observed) {
  const mismatches = [];
  const fields = [
    ["appPath", manifest.appPath, observed.appPath],
    ["bundleIdentifier", manifest.bundleIdentifier, observed.bundleIdentifier],
    ["version", manifest.version, observed.version],
    ["buildVersion", manifest.buildVersion, observed.buildVersion],
    ["executable", manifest.executable, observed.executable],
    ["executableSha256", manifest.executableSha256, observed.executableSha256],
    ["packageSha256", manifest.packageSha256, observed.packageSha256],
    ["artifactSha256", manifest.artifactSha256, observed.artifactSha256],
  ];
  for (const [field, expected, actual] of fields) {
    if (expected !== actual) mismatches.push({ field, expected, actual });
  }
  if (Array.isArray(manifest.artifacts)) {
    const observedArtifacts = new Map(
      (observed.artifacts ?? []).map((artifact) => [
        artifact.path,
        artifact.sha256,
      ]),
    );
    if (manifest.artifacts.length !== observedArtifacts.size) {
      mismatches.push({
        field: "artifacts:count",
        expected: manifest.artifacts.length,
        actual: observedArtifacts.size,
      });
    }
    for (const artifact of manifest.artifacts) {
      if (observedArtifacts.get(artifact.path) !== artifact.sha256) {
        mismatches.push({
          field: `artifacts:${artifact.path}`,
          expected: artifact.sha256,
          actual: observedArtifacts.get(artifact.path) ?? null,
        });
      }
    }
  }
  return mismatches;
}

export function compareBundleContract(expected, observed) {
  const mismatches = [];
  for (const [field, expectedValue, actualValue] of [
    ["appPath", expected.appPath, observed.appPath],
    ["bundleIdentifier", expected.bundleIdentifier, observed.bundleIdentifier],
    ["version", expected.version, observed.version],
    ["executable", expected.executable, observed.executable],
  ]) {
    if (expectedValue !== actualValue) {
      mismatches.push({ field, expected: expectedValue, actual: actualValue });
    }
  }
  return mismatches;
}

async function productionBundleContract(repoRoot) {
  const configPath = path.join(repoRoot, "src-tauri", "tauri.conf.json");
  const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
  const bundleRoot = path.join(
    repoRoot,
    "src-tauri",
    "target",
    "release",
    "bundle",
    "macos",
  );
  return {
    appPath: path.join(bundleRoot, `${config.productName}.app`),
    bundleIdentifier: config.identifier,
    version: config.version,
    executable: config.mainBinaryName,
  };
}

function macOSVersion() {
  return runRequired("sw_vers", ["-productVersion"]);
}

function displayScale() {
  const script = [
    "import AppKit",
    "import Foundation",
    "guard let screen = NSScreen.main else {",
    '  FileHandle.standardError.write(Data("no main display is available\\n".utf8))',
    "  exit(2)",
    "}",
    "print(screen.backingScaleFactor)",
  ].join("\n");
  const moduleCache = path.join(
    os.tmpdir(),
    "excalidraw-desktop-native-validation-swift-cache",
  );
  const result = runSync("xcrun", ["swift", "-e", script], {
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: moduleCache,
      SWIFT_MODULECACHE_PATH: moduleCache,
    },
  });
  if (result.status !== 0)
    throw new NativeValidationBlockedError(
      result.stderr.trim() || "Unable to read backing scale",
    );
  const scale = Number(result.stdout.trim());
  if (!Number.isFinite(scale) || scale <= 0)
    throw new NativeValidationBlockedError("Invalid backing scale result");
  return scale;
}

function appleScriptQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function appleScriptLabels(labels) {
  return `{${labels.map(appleScriptQuote).join(", ")}}`;
}

function runAppleScript(script) {
  const result = runSync("osascript", ["-e", script]);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || "System Events rejected the request";
    if (
      /assistive access|not authorized to send Apple events|not allowed assistive|\(-1743\)/iu.test(
        detail,
      )
    ) {
      throw new NativeValidationBlockedError(detail);
    }
    throw new Error(detail);
  }
  return result.stdout.trim();
}

export function resolveMenuItemAppleScript(pid, labels, operation) {
  const labelsLiteral = appleScriptLabels(labels);
  return `
on resolveMenuItem(appProcess, menuPath)
  using terms from application "System Events"
    tell appProcess
      set currentMenu to menu 1 of menu bar item (item 1 of menuPath) of menu bar 1
      repeat with pathIndex from 2 to count of menuPath
        set currentItem to menu item (item pathIndex of menuPath) of currentMenu
        if pathIndex is (count of menuPath) then return currentItem
        set currentMenu to menu 1 of currentItem
      end repeat
    end tell
  end using terms from
end resolveMenuItem

tell application "System Events"
  set appProcess to first application process whose unix id is ${Number(pid)}
  tell appProcess
    set frontmost to true
    set targetItem to my resolveMenuItem(appProcess, ${labelsLiteral})
    ${operation}
  end tell
end tell
`;
}

export function inspectMenuItemAppleScript(pid, expected) {
  return resolveMenuItemAppleScript(
    pid,
    expected.path,
    `
    set itemLabel to name of targetItem
    set itemEnabled to enabled of targetItem
    set itemCharacter to ""
    set itemModifiers to ""
    try
      set observedCharacter to value of attribute "AXMenuItemCmdChar" of targetItem
      if observedCharacter is not missing value then set itemCharacter to observedCharacter
    end try
    try
      set observedModifiers to value of attribute "AXMenuItemCmdModifiers" of targetItem
      if observedModifiers is not missing value then set itemModifiers to observedModifiers
    end try
    return itemLabel & tab & itemEnabled & tab & itemCharacter & tab & itemModifiers
    `,
  );
}

function inspectMenuItem(pid, expected) {
  const script = inspectMenuItemAppleScript(pid, expected);
  const [label, enabled, character, modifiers] =
    runAppleScript(script).split("\t");
  return {
    label,
    enabled: enabled === "true",
    keyboard: { character, modifiers: decodeAXModifiers(modifiers) },
  };
}

function invokeMenuItem(pid, labels) {
  runAppleScript(resolveMenuItemAppleScript(pid, labels, "click targetItem"));
}

function invokeKeyboard(pid, character, modifiers) {
  const modifierNames = modifiers
    .map((modifier) => `${modifier} down`)
    .join(", ");
  runAppleScript(`
tell application "System Events"
  set appProcess to first application process whose unix id is ${Number(pid)}
  tell appProcess
    set frontmost to true
    keystroke ${appleScriptQuote(character)} using {${modifierNames}}
  end tell
end tell
`);
}

function dismissWebViewDialog(pid) {
  runAppleScript(`
tell application "System Events"
  set appProcess to first application process whose unix id is ${Number(pid)}
  tell appProcess
    set frontmost to true
    key code 53
  end tell
end tell
`);
}

function measureWindow(pid) {
  const script = `
tell application "System Events"
  set appProcess to first application process whose unix id is ${Number(pid)}
  tell appProcess
    set targetWindow to front window
    set launchPosition to position of targetWindow
    set launchSize to size of targetWindow
    set position of targetWindow to {0, 0}
    set size of targetWindow to {${EXPECTED_WINDOW_SIZE.width}, ${EXPECTED_WINDOW_SIZE.height}}
    set measuredPosition to position of targetWindow
    set measuredSize to size of targetWindow
    return (item 1 of launchPosition) & tab & (item 2 of launchPosition) & tab & (item 1 of launchSize) & tab & (item 2 of launchSize) & tab & (item 1 of measuredPosition) & tab & (item 2 of measuredPosition) & tab & (item 1 of measuredSize) & tab & (item 2 of measuredSize)
  end tell
end tell
`;
  const [launchX, launchY, launchWidth, launchHeight, x, y, width, height] =
    runAppleScript(script).split("\t").map(Number);
  return {
    launch: {
      x: launchX,
      y: launchY,
      width: launchWidth,
      height: launchHeight,
    },
    requested: { x, y, width, height },
  };
}

function processMatchesApp(line, executablePath, executable) {
  const text = line.trim();
  if (!text) return false;
  const parts = text.split(/\s+/u);
  const command = parts.slice(2).join(" ");
  const comm = parts[1] ?? "";
  return (
    command.startsWith(executablePath) ||
    comm === executable ||
    command.includes(`/${executable} `)
  );
}

export function ambiguousAppProcesses(
  executablePath,
  executable,
  processListing,
) {
  return String(processListing ?? "")
    .split(/\r?\n/u)
    .filter((line) => processMatchesApp(line, executablePath, executable))
    .map((line) => line.trim());
}

function listAmbiguousProcesses(executablePath, executable) {
  const result = runSync("ps", ["-axo", "pid=,comm=,command="]);
  if (result.status !== 0)
    throw new NativeValidationBlockedError(
      result.stderr.trim() || "Unable to inspect processes",
    );
  return ambiguousAppProcesses(executablePath, executable, result.stdout);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForValidationPair(events, command, ignoredIds, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const pair = validationPair(events, command, ignoredIds);
      if (pair) return resolve(pair);
      if (Date.now() - started >= timeoutMs) {
        return reject(
          new Error(
            `Timed out waiting for nativeEntry/applicationRoute probe: ${command}`,
          ),
        );
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

function spawnBundle(executablePath, launchEnvironment = {}) {
  const child = spawn(executablePath, [], {
    cwd: path.dirname(executablePath),
    env: {
      ...process.env,
      ...launchEnvironment,
      EXCALIDRAW_NATIVE_MENU_VALIDATION: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const events = [];
  const stderr = readline.createInterface({ input: child.stderr });
  stderr.on("line", (line) => {
    const event = parseNativeValidationLine(line);
    if (event) events.push(event);
  });
  return { child, events, stderr };
}

async function stopOwnedChild(processHandle) {
  const child = processHandle?.child ?? processHandle;
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    wait(3000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function defaultManifestPath(repoRoot, commit) {
  return path.join(
    repoRoot,
    "src-tauri",
    "target",
    "native-validation",
    commit,
    "manifest.json",
  );
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function discoverApp(repoRoot) {
  const bundleRoot = path.join(
    repoRoot,
    "src-tauri",
    "target",
    "release",
    "bundle",
    "macos",
  );
  const apps = (await fsp.readdir(bundleRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => path.join(bundleRoot, entry.name));
  if (apps.length !== 1)
    throw new Error(
      `Expected exactly one production .app, found ${apps.length}`,
    );
  return apps[0];
}

export async function createManifest({
  repoRoot = REPO_ROOT,
  appPath,
  buildCommand = ["pnpm", "tauri", "build"],
}) {
  const state = gitState(repoRoot);
  if (!state.commit || !state.clean) {
    throw new Error(
      "Refusing to seal: the build repository must be at a clean commit",
    );
  }
  const expectedBundle = await productionBundleContract(repoRoot);
  const bundle = await inspectBundle(appPath, repoRoot);
  const contractMismatches = compareBundleContract(expectedBundle, bundle);
  if (contractMismatches.length > 0) {
    throw new Error(
      `Built app does not match tauri.conf.json: ${JSON.stringify(contractMismatches)}`,
    );
  }
  let osVersion = null;
  if (process.platform === "darwin") {
    osVersion = macOSVersion();
  }
  return {
    schemaVersion: 1,
    gitCommit: state.commit,
    buildCommand,
    builtAt: new Date().toISOString(),
    repositoryRoot: repoRoot,
    expectedWindowSize: EXPECTED_WINDOW_SIZE,
    buildEnvironment: {
      productVersion: osVersion,
      architecture: process.arch,
    },
    ...bundle,
  };
}

export async function sealProductionBundle({
  repoRoot = REPO_ROOT,
  manifestPath,
} = {}) {
  const startedAt = new Date().toISOString();
  const initialState = gitState(repoRoot);
  const checks = [];
  if (process.platform !== "darwin") {
    checks.push(
      makeCheck("platform", "macOS host", "BLOCKED", {
        reason: "T023b requires macOS",
      }),
    );
    return buildReport({ command: "seal", manifestPath, startedAt, checks });
  }
  if (!initialState.clean) {
    checks.push(
      makeCheck("clean-commit", "clean git commit", "BLOCKED", {
        gitStatus: initialState.status,
      }),
    );
    return buildReport({ command: "seal", manifestPath, startedAt, checks });
  }
  const build = runSync("pnpm", ["tauri", "build"], {
    cwd: repoRoot,
    inherit: true,
  });
  if (build.status !== 0) {
    checks.push(
      makeCheck("production-build", "pnpm tauri build", "FAIL", {
        exitCode: build.status,
      }),
    );
    return buildReport({ command: "seal", manifestPath, startedAt, checks });
  }
  try {
    const resolvedApp = await discoverApp(repoRoot);
    const expectedBundle = await productionBundleContract(repoRoot);
    if (path.resolve(resolvedApp) !== path.resolve(expectedBundle.appPath)) {
      throw new Error(
        `Production build output must be ${expectedBundle.appPath}, got ${resolvedApp}`,
      );
    }
    const state = gitState(repoRoot);
    const manifest = await createManifest({ repoRoot, appPath: resolvedApp });
    const outputPath =
      manifestPath ?? defaultManifestPath(repoRoot, state.commit);
    await writeJson(outputPath, manifest);
    checks.push(
      makeCheck("clean-commit", "clean git commit", "PASS", {
        gitCommit: state.commit,
      }),
    );
    checks.push(makeCheck("production-build", "pnpm tauri build", "PASS"));
    checks.push(
      makeCheck("manifest", "sealed package manifest", "PASS", {
        path: outputPath,
      }),
    );
    return buildReport({
      command: "seal",
      manifestPath: outputPath,
      startedAt,
      checks,
      manifest,
    });
  } catch (error) {
    checks.push(
      makeCheck("manifest", "sealed package manifest", "FAIL", {
        error: String(error.message ?? error),
      }),
    );
    return buildReport({ command: "seal", manifestPath, startedAt, checks });
  }
}

function manifestCheck(manifest, observed) {
  const mismatches = compareManifest(manifest, observed);
  return mismatches.length === 0
    ? makeCheck("artifact-identity", "manifest and package identity", "PASS", {
        observed,
      })
    : makeCheck("artifact-identity", "manifest and package identity", "FAIL", {
        mismatches,
        observed,
      });
}

async function runNativeChecks(manifest, processInfo, checks, timeoutMs) {
  const { child, events } = processInfo;
  let menuObservations = [];
  try {
    let lastError;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const attemptObservations = [];
        for (const expected of EXPECTED_MENU_ITEMS) {
          const observed = inspectMenuItem(child.pid, expected);
          const result = compareMenuObservation(expected, observed);
          attemptObservations.push({ path: expected.path, ...result });
        }
        menuObservations = attemptObservations;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await wait(250);
      }
    }
    if (lastError) throw lastError;
    const allMenuItemsPass =
      menuObservations.length === EXPECTED_MENU_ITEMS.length &&
      menuObservations.every((item) => item.pass);
    checks.push(
      makeCheck(
        "native-menu",
        "native menu hierarchy, labels, enabled state, keyboard equivalents",
        allMenuItemsPass ? "PASS" : "FAIL",
        { items: menuObservations },
      ),
    );
  } catch (error) {
    checks.push(
      makeCheck(
        "native-menu",
        "native menu hierarchy, labels, enabled state, keyboard equivalents",
        error instanceof NativeValidationBlockedError ? "BLOCKED" : "FAIL",
        { error: String(error.message ?? error) },
      ),
    );
    return;
  }

  try {
    const geometry = measureWindow(child.pid);
    const matches =
      geometry.requested.width === EXPECTED_WINDOW_SIZE.width &&
      geometry.requested.height === EXPECTED_WINDOW_SIZE.height;
    checks.push(
      makeCheck(
        "window-geometry",
        "requested native window geometry",
        matches ? "PASS" : "FAIL",
        {
          expected: EXPECTED_WINDOW_SIZE,
          observed: geometry,
        },
      ),
    );
  } catch (error) {
    checks.push(
      makeCheck(
        "window-geometry",
        "native window geometry",
        error instanceof NativeValidationBlockedError ? "BLOCKED" : "FAIL",
        { error: String(error.message ?? error) },
      ),
    );
  }

  const actionSteps = [
    { id: "save-menu", command: "save", kind: "menu", path: ["File", "Save"] },
    {
      id: "save-keyboard",
      command: "save",
      kind: "keyboard",
      character: "s",
      modifiers: ["command"],
    },
    {
      id: "export-menu",
      command: "exportImage",
      kind: "menu",
      path: ["File", "Export Image"],
    },
    {
      id: "export-keyboard",
      command: "exportImage",
      kind: "keyboard",
      character: "e",
      modifiers: ["command", "option"],
    },
    {
      id: "appearance-system",
      command: "appearanceSystem",
      kind: "menu",
      path: ["View", "Appearance", "System"],
    },
    {
      id: "appearance-light",
      command: "appearanceLight",
      kind: "menu",
      path: ["View", "Appearance", "Light"],
    },
    {
      id: "appearance-dark",
      command: "appearanceDark",
      kind: "menu",
      path: ["View", "Appearance", "Dark"],
    },
  ];
  const consumedIds = new Set();
  for (const action of actionSteps) {
    try {
      const before = new Set(events.map((event) => event.validationId));
      if (action.kind === "menu") invokeMenuItem(child.pid, action.path);
      else invokeKeyboard(child.pid, action.character, action.modifiers);
      const pair = await waitForValidationPair(
        events,
        action.command,
        new Set([...consumedIds, ...before]),
        timeoutMs,
      );
      consumedIds.add(pair.validationId);
      if (action.command === "exportImage") dismissWebViewDialog(child.pid);
      checks.push(
        makeCheck(
          action.id,
          `${action.kind} invocation: ${action.command}`,
          "PASS",
          { command: action.command, validationId: pair.validationId },
        ),
      );
    } catch (error) {
      checks.push(
        makeCheck(
          action.id,
          `${action.kind} invocation: ${action.command}`,
          error instanceof NativeValidationBlockedError ? "BLOCKED" : "FAIL",
          { command: action.command, error: String(error.message ?? error) },
        ),
      );
    }
  }
}

export async function validateProductionBundle({
  repoRoot = REPO_ROOT,
  manifestPath,
  reportPath,
  collectionDir,
  bindingPath,
  capturePlanPath,
  timeoutMs = 5000,
} = {}) {
  const startedAt = new Date().toISOString();
  const checks = [];
  let environment = null;
  const resolvedManifestPath =
    manifestPath ??
    defaultManifestPath(repoRoot, gitState(repoRoot).commit ?? "unknown");
  const finish = async (report) => {
    if (reportPath) await writeJson(reportPath, report);
    if (collectionDir || bindingPath) {
      if (!collectionDir || !bindingPath) {
        throw new NativeValidationBlockedError(
          "--collection-dir and --binding must be supplied together",
        );
      }
      const evidenceBinding = JSON.parse(
        await fsp.readFile(bindingPath, "utf8"),
      );
      await writeNativeValidationCollection(
        collectionDir,
        report,
        evidenceBinding,
      );
    }
    return report;
  };
  let manifest;
  let nativeProfile = null;
  try {
    manifest = JSON.parse(await fsp.readFile(resolvedManifestPath, "utf8"));
    checks.push(
      makeCheck("manifest", "read sealed package manifest", "PASS", {
        path: resolvedManifestPath,
      }),
    );
  } catch (error) {
    checks.push(
      makeCheck("manifest", "read sealed package manifest", "FAIL", {
        error: String(error.message ?? error),
      }),
    );
    return finish(
      buildReport({
        command: "validate",
        manifestPath: resolvedManifestPath,
        startedAt,
        checks,
      }),
    );
  }
  if (process.platform !== "darwin") {
    checks.push(
      makeCheck("platform", "macOS host", "BLOCKED", {
        reason: "T023b requires macOS",
      }),
    );
    return finish(
      buildReport({
        command: "validate",
        manifestPath: resolvedManifestPath,
        startedAt,
        checks,
        manifest,
      }),
    );
  }
  if (capturePlanPath) {
    try {
      const capturePlan = JSON.parse(
        await fsp.readFile(capturePlanPath, "utf8"),
      );
      Object.defineProperty(capturePlan, "__planPath", {
        value: path.resolve(capturePlanPath),
        enumerable: false,
      });
      nativeProfile = validatePreparedNativeProfile(capturePlan, manifest);
      if ((await fsp.readdir(nativeProfile.profileRoot)).length !== 0) {
        throw new NativeValidationBlockedError(
          "T023b disposable profile must be empty before launch",
        );
      }
      checks.push(
        makeCheck(
          "disposable-profile",
          "nonce-bound prepared T023b profile",
          "PASS",
          { profileRoot: nativeProfile.profileRoot },
        ),
      );
    } catch (error) {
      checks.push(
        makeCheck(
          "disposable-profile",
          "nonce-bound prepared T023b profile",
          "BLOCKED",
          {
            error: String(error.message ?? error),
          },
        ),
      );
      return finish(
        buildReport({
          command: "validate",
          manifestPath: resolvedManifestPath,
          startedAt,
          checks,
          manifest,
        }),
      );
    }
  }
  try {
    const observed = await inspectBundle(manifest.appPath, repoRoot);
    checks.push(manifestCheck(manifest, observed));
    const expectedBundle = await productionBundleContract(repoRoot);
    const bundleContractMismatches = compareBundleContract(
      expectedBundle,
      observed,
    );
    checks.push(
      makeCheck(
        "production-bundle-contract",
        "canonical package path and tauri.conf.json metadata",
        bundleContractMismatches.length === 0 ? "PASS" : "FAIL",
        {
          expected: expectedBundle,
          observed: {
            appPath: observed.appPath,
            bundleIdentifier: observed.bundleIdentifier,
            version: observed.version,
            executable: observed.executable,
          },
          mismatches: bundleContractMismatches,
        },
      ),
    );
    const state = gitState(repoRoot);
    checks.push(
      makeCheck(
        "git-commit",
        "exact git commit",
        state.commit === manifest.gitCommit ? "PASS" : "FAIL",
        {
          expected: manifest.gitCommit,
          observed: state.commit,
        },
      ),
    );
    checks.push(
      makeCheck(
        "clean-worktree",
        "clean repository at validation time",
        state.clean ? "PASS" : "FAIL",
        { gitStatus: state.status },
      ),
    );
    environment = {
      productVersion: macOSVersion(),
      architecture: process.arch,
    };
    checks.push(
      makeCheck("macOS-environment", "macOS version and architecture", "PASS", {
        observed: environment,
      }),
    );
    if (
      compareManifest(manifest, observed).length > 0 ||
      bundleContractMismatches.length > 0 ||
      state.commit !== manifest.gitCommit ||
      !state.clean
    ) {
      return finish(
        buildReport({
          command: "validate",
          manifestPath: resolvedManifestPath,
          startedAt,
          checks,
          manifest,
        }),
      );
    }
    const ambiguous = listAmbiguousProcesses(
      observed.executablePath,
      observed.executable,
    );
    if (ambiguous.length > 0) {
      checks.push(
        makeCheck(
          "process-safety",
          "no ambiguous existing app process",
          "BLOCKED",
          { processes: ambiguous },
        ),
      );
      return finish(
        buildReport({
          command: "validate",
          manifestPath: resolvedManifestPath,
          startedAt,
          checks,
          manifest,
        }),
      );
    }
    checks.push(
      makeCheck("process-safety", "no ambiguous existing app process", "PASS"),
    );
    const processInfo = spawnBundle(
      observed.executablePath,
      nativeProfile?.environment,
    );
    try {
      await wait(1000);
      try {
        environment.displayBackingScale = displayScale();
        checks.push(
          makeCheck("display-scale", "active display backing scale", "PASS", {
            observed: environment.displayBackingScale,
          }),
        );
      } catch (error) {
        checks.push(
          makeCheck(
            "display-scale",
            "active display backing scale",
            error instanceof NativeValidationBlockedError ? "BLOCKED" : "FAIL",
            { error: String(error.message ?? error) },
          ),
        );
      }
      await runNativeChecks(manifest, processInfo, checks, timeoutMs);
    } finally {
      await stopOwnedChild(processInfo);
      processInfo.stderr.close();
    }
  } catch (error) {
    checks.push(
      makeCheck(
        "runtime",
        "native runtime inspection",
        error instanceof NativeValidationBlockedError ? "BLOCKED" : "FAIL",
        {
          error: String(error.message ?? error),
        },
      ),
    );
  }
  const report = buildReport({
    command: "validate",
    manifestPath: resolvedManifestPath,
    startedAt,
    checks,
    manifest,
    environment,
  });
  return finish(report);
}

function printUsage() {
  console.log(
    `Usage:\n  node scripts/native-macos-validation.mjs seal [--manifest PATH]\n  node scripts/native-macos-validation.mjs validate --manifest PATH [--capture-plan FINAL_PLAN] [--report PATH] [--collection-dir NEW_PATH --binding BINDING_JSON]\n\nThe validate command uses macOS Accessibility/System Events and never captures screenshots. A schema-v2 capture plan supplies the distinct T023b profile without capture-specific production IPC. Adapter outputs are collector-owned and never contain reviewer or owner decisions.`,
  );
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (!command || command === "help" || command === "--help")
    return printUsage();
  if (args.includes("--help") || args.includes("help")) return printUsage();
  const repoRoot = optionValue(args, "--repo") ?? REPO_ROOT;
  let report;
  if (command === "seal") {
    report = await sealProductionBundle({
      repoRoot,
      manifestPath: optionValue(args, "--manifest"),
    });
  } else if (command === "validate") {
    report = await validateProductionBundle({
      repoRoot,
      manifestPath: optionValue(args, "--manifest"),
      reportPath: optionValue(args, "--report"),
      collectionDir: optionValue(args, "--collection-dir"),
      bindingPath: optionValue(args, "--binding"),
      capturePlanPath: optionValue(args, "--capture-plan"),
    });
  } else {
    printUsage();
    process.exitCode = 2;
    return;
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "FAIL") process.exitCode = 1;
  else if (report.status === "BLOCKED") process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await main();
}
