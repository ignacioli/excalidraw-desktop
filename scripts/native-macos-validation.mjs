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
const ROOT_CAUSE_CLASSES = new Set([
  "PRODUCT",
  "HARNESS",
  "ENVIRONMENT",
  "SPEC_CONTRACT",
  "TEST_FLAKE",
  "OPERATOR",
  "UNKNOWN",
]);
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
  const profileRoot = path.join(
    plan?.isolation?.root ?? "",
    "profiles",
    "T023b",
  );
  const legacySaveTarget = plan?.nativeValidation?.filesystemTargets?.save;
  const launchDocument =
    plan?.nativeValidation?.launchDocument ?? legacySaveTarget;
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
    !Array.isArray(plan.screens) ||
    plan.nativeValidation?.profileRoot !== profileRoot ||
    typeof plan.fixture?.manifestPath !== "string" ||
    !path.isAbsolute(plan.fixture.manifestPath) ||
    typeof plan.fixture?.workspaceRoot !== "string" ||
    !path.isAbsolute(plan.fixture.workspaceRoot) ||
    (launchDocument !== undefined &&
      (typeof launchDocument !== "string" ||
        !path.isAbsolute(launchDocument) ||
        path.relative(plan.isolation.root, launchDocument).startsWith("..")))
  ) {
    throw new NativeValidationBlockedError(
      "capture plan does not provide a matching disposable T023b profile",
    );
  }
  const profileSlice = {
    schemaVersion: 1,
    runId: plan.runId,
    productCommit: plan.productCommit,
    packageArtifactSha256: manifest.artifactSha256 ?? manifest.packageSha256,
    profileRoot,
    fixtureManifestPath: plan.fixture.manifestPath,
    workspaceRoot: plan.fixture.workspaceRoot,
    launchDocument: launchDocument ?? null,
  };
  return {
    profileRoot,
    launchDocument: launchDocument ?? null,
    fixtureManifestPath: plan.fixture.manifestPath,
    workspaceRoot: plan.fixture.workspaceRoot,
    nativeEntrypointProfileSha256: sha256Canonical(profileSlice),
    environment: {
      HOME: profileRoot,
    },
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Canonical(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
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
  if (!/^[0-9a-f]{64}$/u.test(value.nativeEntrypointProfileSha256 ?? ""))
    throw new NativeValidationBlockedError(
      "native evidence binding.nativeEntrypointProfileSha256 is invalid",
    );
  const productIdentity = value.productIdentity;
  if (
    !productIdentity ||
    !/^[0-9a-f]{64}$/u.test(productIdentity.runtimeInputsSha256 ?? "") ||
    productIdentity.packageArtifactSha256 !== value.packageArtifactSha256 ||
    typeof productIdentity.bundleIdentifier !== "string" ||
    productIdentity.bundleIdentifier === "" ||
    typeof productIdentity.version !== "string" ||
    productIdentity.version === ""
  )
    throw new NativeValidationBlockedError(
      "native evidence binding.productIdentity is invalid",
    );
  const validatorIdentity = value.validatorIdentity;
  if (
    !validatorIdentity ||
    validatorIdentity.producer !== "native-macos-validation" ||
    validatorIdentity.version !== "3" ||
    validatorIdentity.schemaVersion !== 2 ||
    !/^[0-9a-f]{64}$/u.test(validatorIdentity.sourceSha256 ?? "")
  )
    throw new NativeValidationBlockedError(
      "native evidence binding.validatorIdentity is invalid",
    );
  const attemptIdentity = value.attemptIdentity;
  if (
    !attemptIdentity ||
    !/^[A-Za-z0-9._-]{1,128}$/u.test(attemptIdentity.attemptId ?? "") ||
    attemptIdentity.gate !== "T023b" ||
    attemptIdentity.platform !== "macos" ||
    !/^[0-9a-f]{64}$/u.test(attemptIdentity.inputSha256 ?? "")
  )
    throw new NativeValidationBlockedError(
      "native evidence binding.attemptIdentity is invalid",
    );
  if (
    !value.namedChangeSincePreviousAttempt ||
    typeof value.namedChangeSincePreviousAttempt.changeId !== "string" ||
    value.namedChangeSincePreviousAttempt.changeId === "" ||
    typeof value.namedChangeSincePreviousAttempt.producer !== "string" ||
    !/^[0-9a-f]{64}$/u.test(
      value.namedChangeSincePreviousAttempt.afterSha256 ?? "",
    ) ||
    (![null, undefined].includes(
      value.namedChangeSincePreviousAttempt.beforeSha256,
    ) &&
      !/^[0-9a-f]{64}$/u.test(
        value.namedChangeSincePreviousAttempt.beforeSha256,
      ))
  )
    throw new NativeValidationBlockedError(
      "native evidence binding.namedChangeSincePreviousAttempt is invalid",
    );
  if (!ROOT_CAUSE_CLASSES.has(value.rootCauseClass))
    throw new NativeValidationBlockedError(
      "native evidence binding.rootCauseClass is invalid",
    );
  if (
    !Number.isSafeInteger(value.consecutiveFailureCount) ||
    value.consecutiveFailureCount < 0 ||
    value.consecutiveFailureCount > 2
  )
    throw new NativeValidationBlockedError(
      "native evidence binding.consecutiveFailureCount is invalid",
    );
  return value;
}

function stableFailureObservation(report) {
  const failedCheck = report.checks.find((check) => check.status !== "PASS");
  if (!failedCheck) {
    return {
      assertionId: "T023b",
      reasonCode: "ALL_ASSERTIONS_SATISFIED",
      expectedClass: "PASS",
      observedClass: "PASS",
    };
  }
  const reasonCodes = {
    "native-menu": "MENU_CONTRACT_MISMATCH",
    "window-geometry": "GEOMETRY_MISMATCH",
    "state-preparation": "STATE_PREPARATION_MISMATCH",
    "save-menu": "ROUTE_ACK_MISSING",
    "save-keyboard": "ROUTE_ACK_MISSING",
    "export-menu": "ROUTE_ACK_MISSING",
    "export-keyboard": "ROUTE_ACK_MISSING",
    "appearance-system": "ROUTE_ACK_MISSING",
    "appearance-light": "ROUTE_ACK_MISSING",
    "appearance-dark": "ROUTE_ACK_MISSING",
  };
  return {
    assertionId: failedCheck.id,
    reasonCode: reasonCodes[failedCheck.id] ?? "ASSERTION_NOT_SATISFIED",
    expectedClass: "PASS",
    observedClass: failedCheck.status,
  };
}

export function buildAttemptRecord(report, bindingValue) {
  const binding = requireNativeAdapterBinding(bindingValue);
  const observation = stableFailureObservation(report);
  const observableSignature = sha256Canonical(observation);
  const verdict = aggregateStatus(report.checks);
  const canonicalIssueId = `issue-v1:${sha256Canonical({
    gate: binding.attemptIdentity.gate,
    platform: binding.attemptIdentity.platform,
    factClass: "native-entrypoint-router",
    observableSignature,
    rootCauseClass: binding.rootCauseClass,
  })}`;
  const consecutiveFailureCount =
    verdict === "PASS" ? 0 : binding.consecutiveFailureCount + 1;
  const repairActions = {
    PRODUCT: "REPAIR_PRODUCT",
    HARNESS: "REPAIR_HARNESS",
    ENVIRONMENT: "REPAIR_ENVIRONMENT",
    SPEC_CONTRACT: "REVISE_SPEC",
    TEST_FLAKE: "CONTROLLED_RETRY",
    OPERATOR: "REPAIR_ENVIRONMENT",
    UNKNOWN: "STOP_REQUIRED",
  };
  return {
    attemptId: binding.attemptIdentity.attemptId,
    attemptIdentity: binding.attemptIdentity,
    gate: binding.attemptIdentity.gate,
    platform: binding.attemptIdentity.platform,
    factClass: "native-entrypoint-router",
    mechanism: binding.validatorIdentity.producer,
    assertionReached: true,
    observableSignature,
    observation,
    rootCauseClass: binding.rootCauseClass,
    canonicalIssueId,
    productIdentity: binding.productIdentity,
    validatorIdentity: binding.validatorIdentity,
    namedChangeSincePreviousAttempt: binding.namedChangeSincePreviousAttempt,
    verdict,
    consecutiveFailureCount,
    nextAction:
      verdict === "PASS"
        ? "RUN_TRUE_DEPENDENTS"
        : consecutiveFailureCount >= 3
          ? "STOP_REQUIRED"
          : repairActions[binding.rootCauseClass],
  };
}

export function adaptNativeValidationReport(report, bindingValue) {
  const binding = requireNativeAdapterBinding(bindingValue);
  if (!report || typeof report !== "object" || !Array.isArray(report.checks)) {
    throw new NativeValidationBlockedError(
      "native validation report is malformed",
    );
  }
  if (
    report.nativeEntrypointProfileSha256 !==
      binding.nativeEntrypointProfileSha256 ||
    report.manifest?.artifactSha256 !== binding.packageArtifactSha256 ||
    report.manifest?.bundleIdentifier !==
      binding.productIdentity.bundleIdentifier ||
    report.manifest?.version !== binding.productIdentity.version
  ) {
    throw new NativeValidationBlockedError(
      "native validation report identity does not match its binding",
    );
  }
  const expectedActionIds = [
    "save-menu",
    "save-keyboard",
    "export-menu",
    "export-keyboard",
    "appearance-system",
    "appearance-light",
    "appearance-dark",
  ];
  const actions = report.checks
    .filter((check) => expectedActionIds.includes(check.id))
    .map((check) => ({
      checkId: check.id,
      command: check.command,
      validationId: check.validationId,
      result: check.status,
    }));
  const actionIds = actions.map((action) => action.checkId).sort();
  const actionValidationIds = actions.map((action) => action.validationId);
  const actionResult =
    JSON.stringify(actionIds) ===
      JSON.stringify([...expectedActionIds].sort()) &&
    actionValidationIds.every(
      (validationId) => Number.isSafeInteger(validationId) && validationId > 0,
    ) &&
    new Set(actionValidationIds).size === expectedActionIds.length &&
    actions.every((action) => action.result === "PASS")
      ? "PASS"
      : "BLOCKED";
  const statePreparationCheck = report.checks.find(
    (check) => check.id === "state-preparation",
  );
  const requiredChecks = ["native-menu", "window-geometry"]
    .map((id) => report.checks.find((check) => check.id === id))
    .concat(statePreparationCheck);
  const routeResult =
    actionResult === "PASS" &&
    requiredChecks.every((check) => check?.status === "PASS")
      ? "PASS"
      : "BLOCKED";
  const environment = {
    schemaVersion: 1,
    collectionId: "native-entrypoints",
    gateId: "T023b",
    route: "macos-accessibility",
    binding,
    productIdentity: binding.productIdentity,
    validatorIdentity: binding.validatorIdentity,
    attemptIdentity: binding.attemptIdentity,
    os: report.environment?.productVersion ?? "unknown macOS",
    browserOrAppBuild:
      report.manifest?.appPath ?? report.manifestPath ?? "unknown package",
    fixture: "T023b-disposable-profile",
    collector: {
      tool: "native-macos-validation",
      version: "3",
      runIdentity: binding.attemptIdentity.attemptId,
    },
    statePreparation:
      statePreparationCheck === undefined
        ? null
        : {
            launchMode: statePreparationCheck.launchMode,
            path: statePreparationCheck.path,
            sha256Before: statePreparationCheck.sha256Before,
            sha256After: statePreparationCheck.sha256After,
            byteLength: statePreparationCheck.byteLength,
            result: statePreparationCheck.status,
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
      result: routeResult,
    },
  };
}

export async function writeNativeValidationCollection(
  collectionDir,
  report,
  bindingValue,
) {
  const records = adaptNativeValidationReport(report, bindingValue);
  const sourceSha256 = await sha256File(SCRIPT_PATH);
  if (records.environment.validatorIdentity.sourceSha256 !== sourceSha256) {
    throw new NativeValidationBlockedError(
      "native validator source digest does not match the running producer",
    );
  }
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
    records.routeAcknowledgements.result,
  ]);
  const attemptRecord = buildAttemptRecord(report, records.environment.binding);
  const attemptRelativePath = path.join(
    "attempts",
    attemptRecord.attemptId,
    "attempt.json",
  );
  const attemptPath = path.join(
    path.dirname(collectionDir),
    attemptRelativePath,
  );
  await fsp.mkdir(path.dirname(attemptPath), { recursive: true });
  await fsp.writeFile(
    attemptPath,
    `${JSON.stringify(attemptRecord, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
  const collectorReport = {
    schemaVersion: 1,
    collectionId: "native-entrypoints",
    gateId: "T023b",
    route: "macos-accessibility",
    binding: records.environment.binding,
    productIdentity: records.environment.productIdentity,
    validatorIdentity: records.environment.validatorIdentity,
    attemptIdentity: records.environment.attemptIdentity,
    attemptRecord: {
      path: `../${attemptRelativePath}`,
      sha256: await sha256File(attemptPath),
    },
    collector: records.environment.collector,
    environmentPath: "environment.json",
    claims: [
      {
        claimId: "native-menu-entrypoints",
        factClass: "native-menu-action",
        primaryRoute: "macos-accessibility",
        result: records.routeAcknowledgements.result,
        artifactRefs: ["native-report.json", "route-acknowledgements.json"],
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
  const moduleCache = path.join(
    os.tmpdir(),
    "excalidraw-desktop-native-validation-swift-cache",
  );
  const result = runSync(
    "xcrun",
    ["swift", "-e", keyboardShortcutSwiftSource(pid, character, modifiers)],
    {
      env: {
        ...process.env,
        CLANG_MODULE_CACHE_PATH: moduleCache,
        SWIFT_MODULECACHE_PATH: moduleCache,
      },
    },
  );
  if (result.status !== 0) {
    throw new NativeValidationBlockedError(
      result.stderr.trim() || "Unable to post native shortcut to owned PID",
    );
  }
}

export function keyboardShortcutSwiftSource(pid, character, modifiers) {
  const keyCodes = { s: 1, e: 14 };
  const keyCode = keyCodes[character];
  if (!Number.isInteger(keyCode))
    throw new TypeError(`Unsupported native shortcut character: ${character}`);
  const flagNames = {
    command: ".maskCommand",
    option: ".maskAlternate",
    shift: ".maskShift",
    control: ".maskControl",
  };
  const flags = modifiers.map((modifier) => flagNames[modifier]);
  if (flags.some((flag) => flag === undefined))
    throw new TypeError("Unsupported native shortcut modifier");
  const expression = flags.length === 0 ? "[]" : `[${flags.join(", ")}]`;
  return `import CoreGraphics
import Foundation
let source = CGEventSource(stateID: .hidSystemState)
let down = CGEvent(keyboardEventSource: source, virtualKey: ${keyCode}, keyDown: true)
let up = CGEvent(keyboardEventSource: source, virtualKey: ${keyCode}, keyDown: false)
down?.flags = ${expression}
up?.flags = ${expression}
down?.postToPid(pid_t(${Number(pid)}))
usleep(50000)
up?.postToPid(pid_t(${Number(pid)}))`;
}

export function completeExportDialogAppleScript(pid, format, targetPath) {
  const directory = path.dirname(targetPath);
  const filename = path.basename(targetPath);
  return `
tell application "System Events"
  set appProcess to first application process whose unix id is ${Number(pid)}
  tell appProcess
    set frontmost to true
    delay 0.4
    ${format === "svg" ? "key code 125" : ""}
    key code 36
    delay 0.8
    keystroke "g" using {command down, shift down}
    delay 0.3
    keystroke ${appleScriptQuote(directory)}
    key code 36
    delay 0.5
    keystroke "a" using {command down}
    keystroke ${appleScriptQuote(filename)}
    key code 36
    delay 0.8
    key code 53
  end tell
end tell
`;
}

function dismissExportDialog(pid) {
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

export function parseWindowGeometryOutput(output) {
  const values = String(output)
    .split("\t")
    .map((value) => Number(value));
  if (
    values.length !== 8 ||
    values.some((value) => !Number.isFinite(value) || !Number.isInteger(value))
  ) {
    throw new NativeValidationBlockedError(
      "window geometry must contain eight tab-delimited numeric fields",
    );
  }
  const [launchX, launchY, launchWidth, launchHeight, x, y, width, height] =
    values;
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

export function windowGeometryAppleScript(pid) {
  return `
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
    return ((item 1 of launchPosition) as text) & tab & ((item 2 of launchPosition) as text) & tab & ((item 1 of launchSize) as text) & tab & ((item 2 of launchSize) as text) & tab & ((item 1 of measuredPosition) as text) & tab & ((item 2 of measuredPosition) as text) & tab & ((item 1 of measuredSize) as text) & tab & ((item 2 of measuredSize) as text)
  end tell
end tell
`;
}

function measureWindow(pid) {
  return parseWindowGeometryOutput(
    runAppleScript(windowGeometryAppleScript(pid)),
  );
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

function spawnBundle(
  executablePath,
  launchEnvironment = {},
  launchArguments = [],
) {
  const child = spawn(executablePath, launchArguments, {
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

async function filesystemSnapshot(filePath) {
  const stats = await fsp.stat(filePath).catch(() => null);
  if (stats === null || !stats.isFile()) return null;
  return {
    path: filePath,
    sha256: await sha256File(filePath),
    byteLength: stats.size,
    modifiedAtMs: stats.mtimeMs,
  };
}

async function validExcalidrawSnapshot(filePath) {
  const snapshot = await filesystemSnapshot(filePath);
  if (snapshot === null || path.extname(filePath) !== ".excalidraw")
    return null;
  try {
    const value = JSON.parse(await fsp.readFile(filePath, "utf8"));
    return value?.type === "excalidraw" ? snapshot : null;
  } catch {
    return null;
  }
}

async function resolvePreparedLaunchDocument(nativeProfile) {
  const fixtureManifest = JSON.parse(
    await fsp.readFile(nativeProfile.fixtureManifestPath, "utf8"),
  );
  const files = Array.isArray(fixtureManifest.files)
    ? fixtureManifest.files
        .filter(
          (entry) =>
            typeof entry?.path === "string" &&
            entry.path.endsWith(".excalidraw") &&
            /^[0-9a-f]{64}$/u.test(entry.sha256 ?? ""),
        )
        .sort((left, right) => left.path.localeCompare(right.path))
    : [];
  const requested = nativeProfile.launchDocument;
  let selected = files.find(
    (entry) => path.join(nativeProfile.workspaceRoot, entry.path) === requested,
  );
  if (!selected) selected = files[0];
  if (!selected)
    throw new NativeValidationBlockedError(
      "T023b requires one valid declared .excalidraw launch fixture",
    );
  const launchDocument = path.join(nativeProfile.workspaceRoot, selected.path);
  const relative = path.relative(nativeProfile.workspaceRoot, launchDocument);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new NativeValidationBlockedError(
      "T023b launch fixture escapes the declared workspace",
    );
  const snapshot = await validExcalidrawSnapshot(launchDocument);
  if (snapshot === null || snapshot.sha256 !== selected.sha256)
    throw new NativeValidationBlockedError(
      "T023b launch fixture is missing, invalid, or digest-stale",
    );
  const slice = {
    schemaVersion: 1,
    profileRoot: nativeProfile.profileRoot,
    fixtureManifestPath: nativeProfile.fixtureManifestPath,
    workspaceRoot: nativeProfile.workspaceRoot,
    launchDocument,
    launchDocumentSha256: selected.sha256,
  };
  return {
    ...nativeProfile,
    launchDocument,
    launchDocumentSha256: selected.sha256,
    nativeEntrypointProfileSha256: sha256Canonical(slice),
  };
}

async function runNativeChecks(
  manifest,
  processInfo,
  checks,
  timeoutMs,
  launchDocument,
) {
  const { child, events } = processInfo;
  const launchBefore = await validExcalidrawSnapshot(launchDocument);
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
      else {
        await wait(250);
        invokeKeyboard(child.pid, action.character, action.modifiers);
      }
      const pair = await waitForValidationPair(
        events,
        action.command,
        new Set([...consumedIds, ...before]),
        timeoutMs,
      );
      consumedIds.add(pair.validationId);
      if (action.command === "exportImage") dismissExportDialog(child.pid);
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
  const launchAfter = await validExcalidrawSnapshot(launchDocument);
  const statePrepared =
    launchBefore !== null &&
    launchAfter !== null &&
    launchBefore.sha256 === launchAfter.sha256 &&
    launchBefore.byteLength === launchAfter.byteLength;
  checks.push(
    makeCheck(
      "state-preparation",
      "digest-bound normal-open fixture remains unchanged",
      statePrepared ? "PASS" : "BLOCKED",
      {
        launchMode: "normal-open-argument",
        path: launchDocument,
        sha256Before: launchBefore?.sha256,
        sha256After: launchAfter?.sha256,
        byteLength: launchAfter?.byteLength ?? launchBefore?.byteLength,
      },
    ),
  );
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
      nativeProfile = await resolvePreparedLaunchDocument(
        validatePreparedNativeProfile(capturePlan, manifest),
      );
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
          {
            profileRoot: nativeProfile.profileRoot,
            launchDocument: nativeProfile.launchDocument,
            nativeEntrypointProfileSha256:
              nativeProfile.nativeEntrypointProfileSha256,
          },
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
      nativeProfile ? [nativeProfile.launchDocument] : [],
    );
    try {
      await wait(3000);
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
      await runNativeChecks(
        manifest,
        processInfo,
        checks,
        timeoutMs,
        nativeProfile?.launchDocument,
      );
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
    nativeEntrypointProfileSha256:
      nativeProfile?.nativeEntrypointProfileSha256 ?? null,
  });
  return finish(report);
}

function printUsage() {
  console.log(
    `Usage:\n  node scripts/native-macos-validation.mjs seal [--manifest PATH]\n  node scripts/native-macos-validation.mjs validate --manifest PATH [--capture-plan FINAL_PLAN] [--report PATH] [--collection-dir NEW_PATH --binding BINDING_JSON]\n\nThe validate command uses macOS Accessibility/System Events and never captures screenshots. A schema-v2 FINAL plan supplies a distinct T023b profile and one digest-bound .excalidraw fixture through the normal launch/open path. PASS requires 5/5 menu facts, exact numeric 1280x760 geometry, seven fresh unique nativeEntry -> routeAccepted pairs, owned process/profile evidence, and unchanged fixture bytes. Save/PNG/SVG business filesystem outcomes are owned by deterministic implementation/process-level tests, not this exact-package router probe. Adapter outputs carry separate product, validator, and attempt identities and never contain reviewer or owner decisions.`,
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
