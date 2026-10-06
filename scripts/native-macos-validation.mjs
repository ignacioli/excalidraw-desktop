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
export const PRODUCTION_APP_BUILD_ARGS = Object.freeze([
  "tauri",
  "build",
  "--bundles",
  "app",
]);
export const PROOF_SCOPES = Object.freeze({
  QUALIFICATION: "qualification",
  FINAL: "final",
  HISTORY: "history",
});
export const HISTORY_MENU_READY_TIMEOUT_MS = 15_000;
export const STOPPED_COMMAND_S_ISSUE_ID =
  "issue-v1:7cec23a398ea5bc45123e3d0fe2fd415214e13cca31393b6fd94ecc9da1be99e";
export const PHYSICAL_COMMAND_S_TIMEOUT_MS = 600_000;
export const NATIVE_ACTION_STEPS = Object.freeze([
  Object.freeze({
    id: "save-keyboard",
    command: "save",
    kind: "physical-keyboard",
    character: "s",
    modifiers: Object.freeze(["command"]),
  }),
  Object.freeze({
    id: "save-menu",
    command: "save",
    kind: "menu",
    path: Object.freeze(["File", "Save"]),
  }),
  Object.freeze({
    id: "export-menu",
    command: "exportImage",
    kind: "menu",
    path: Object.freeze(["File", "Export Image"]),
  }),
  Object.freeze({
    id: "export-keyboard",
    command: "exportImage",
    kind: "keyboard",
    character: "e",
    modifiers: Object.freeze(["command", "option"]),
  }),
  Object.freeze({
    id: "appearance-system",
    command: "appearanceSystem",
    kind: "menu",
    path: Object.freeze(["View", "Appearance", "System"]),
  }),
  Object.freeze({
    id: "appearance-light",
    command: "appearanceLight",
    kind: "menu",
    path: Object.freeze(["View", "Appearance", "Light"]),
  }),
  Object.freeze({
    id: "appearance-dark",
    command: "appearanceDark",
    kind: "menu",
    path: Object.freeze(["View", "Appearance", "Dark"]),
  }),
]);
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
// Version History is a feature-owned native entry.  Keep it out of the
// existing T023b action graph so the 003 qualification/final route evidence
// remains stable; the final collector inspects and invokes this item once in
// its own check.
export const VERSION_HISTORY_MENU_ITEM = Object.freeze({
  path: Object.freeze(["File", "Version History…"]),
  command: "versionHistory",
  enabled: true,
  keyboard: null,
});

export function nativeActionsForScope(scope) {
  if (scope === PROOF_SCOPES.HISTORY) return [];
  if (scope === PROOF_SCOPES.QUALIFICATION) {
    return NATIVE_ACTION_STEPS.filter((action) =>
      new Set(["save-keyboard", "save-menu"]).has(action.id),
    );
  }
  if (scope === PROOF_SCOPES.FINAL) return [...NATIVE_ACTION_STEPS];
  throw new TypeError(`Unsupported native proof scope: ${scope}`);
}

export function nativeMenuItemsForScope(scope) {
  if (scope === PROOF_SCOPES.HISTORY) return [VERSION_HISTORY_MENU_ITEM];
  if (scope === PROOF_SCOPES.QUALIFICATION) return [EXPECTED_MENU_ITEMS[0]];
  if (scope === PROOF_SCOPES.FINAL)
    return [...EXPECTED_MENU_ITEMS, VERSION_HISTORY_MENU_ITEM];
  throw new TypeError(`Unsupported native proof scope: ${scope}`);
}

export function commandSConfirmationLine(challenge) {
  if (!/^[0-9a-f]{32}$/u.test(challenge ?? "")) {
    throw new TypeError("Command-S challenge must be 32 lowercase hex digits");
  }
  return `COMMAND-S T023b ${challenge}`;
}

export function parseCommandSConfirmation(input, expectedLine) {
  const lines = String(input ?? "")
    .split(/\r?\n/u)
    .filter((line) => line !== "");
  if (lines.length !== 1) {
    throw new NativeValidationBlockedError(
      "Command-S confirmation must contain exactly one line",
    );
  }
  if (lines[0] !== expectedLine) {
    throw new NativeValidationBlockedError(
      "Command-S confirmation must exactly match the nonce prompt",
    );
  }
  return lines[0];
}

const VALID_STAGES = new Set(["nativeEntry", "applicationRoute"]);
const VALID_COMMANDS = new Set([
  ...EXPECTED_MENU_ITEMS.map((item) => item.command),
  VERSION_HISTORY_MENU_ITEM.command,
]);
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
    validatorIdentity.version !== "4" ||
    validatorIdentity.schemaVersion !== 3 ||
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
  if (!Object.values(PROOF_SCOPES).includes(value.proofScope))
    throw new NativeValidationBlockedError(
      "native evidence binding.proofScope is invalid",
    );
  if (
    !Number.isSafeInteger(value.remediationEpoch) ||
    value.remediationEpoch < 0
  )
    throw new NativeValidationBlockedError(
      "native evidence binding.remediationEpoch is invalid",
    );
  if (value.remediationEpoch === 0 && value.reopenDecision !== null)
    throw new NativeValidationBlockedError(
      "epoch 0 must not bind a STOP_REOPEN decision",
    );
  if (value.remediationEpoch === 0 && value.repairTarget !== null)
    throw new NativeValidationBlockedError(
      "epoch 0 must not bind a repair target",
    );
  if (value.remediationEpoch > 0) {
    const reference = value.reopenDecision;
    if (
      !reference ||
      typeof reference !== "object" ||
      typeof reference.path !== "string" ||
      !path.isAbsolute(reference.path) ||
      typeof reference.relativePath !== "string" ||
      !/^\.\.\/reopen-decisions\/[A-Za-z0-9._-]+\.json$/u.test(
        reference.relativePath,
      ) ||
      !/^[0-9a-f]{64}$/u.test(reference.sha256 ?? "")
    )
      throw new NativeValidationBlockedError(
        "reopened epoch requires a valid STOP_REOPEN reference",
      );
    const target = value.repairTarget;
    if (
      !target ||
      typeof target !== "object" ||
      !/^[0-9a-f]{64}$/u.test(target.observableSignature ?? "") ||
      target.canonicalIssueId !==
        `issue-v1:${sha256Canonical({
          gate: value.attemptIdentity.gate,
          platform: value.attemptIdentity.platform,
          factClass: "native-entrypoint-router",
          observableSignature: target.observableSignature,
          rootCauseClass: value.rootCauseClass,
        })}`
    )
      throw new NativeValidationBlockedError(
        "reopened epoch requires a valid repair target",
      );
  }
  return value;
}

export function validateStopReopenDecision(
  decision,
  bindingValue,
  currentSourceSha256,
) {
  const binding = requireNativeAdapterBinding(bindingValue);
  if (binding.remediationEpoch === 0) return null;
  if (
    !decision ||
    typeof decision !== "object" ||
    decision.schemaVersion !== 1 ||
    !/^[A-Za-z0-9._-]{1,128}$/u.test(decision.decisionId ?? "") ||
    decision.decisionType !== "STOP_REOPEN" ||
    decision.canonicalIssueId !== STOPPED_COMMAND_S_ISSUE_ID ||
    decision.canonicalIssueId !== binding.repairTarget.canonicalIssueId ||
    !Number.isSafeInteger(decision.closedRemediationEpoch) ||
    decision.closedRemediationEpoch < 0 ||
    decision.reopenedRemediationEpoch !== decision.closedRemediationEpoch + 1 ||
    decision.reopenedRemediationEpoch !== binding.remediationEpoch ||
    decision.approvedByRole !== "product-owner" ||
    !/^[0-9a-f]{40}$/u.test(decision.approvedSpecCommit ?? "") ||
    decision.rationaleCode !== "PROOF_MECHANISM_REPAIR" ||
    decision.allowedGate !== binding.attemptIdentity.gate ||
    decision.allowedFactClass !== "native-entrypoint-router"
  ) {
    throw new NativeValidationBlockedError(
      "STOP_REOPEN decision does not authorize this remediation epoch",
    );
  }
  const change = decision.requiredChange;
  if (
    change &&
    typeof change === "object" &&
    change.beforeSha256 === change.afterSha256
  ) {
    throw new NativeValidationBlockedError(
      "STOP_REOPEN decision is identity-equivalent",
    );
  }
  const validOpeningChange =
    binding.consecutiveFailureCount === 0 &&
    change?.beforeSha256 ===
      binding.namedChangeSincePreviousAttempt.beforeSha256 &&
    change?.afterSha256 === binding.namedChangeSincePreviousAttempt.afterSha256;
  const validLaterRepair =
    binding.consecutiveFailureCount > 0 &&
    change?.producer === binding.namedChangeSincePreviousAttempt.producer &&
    binding.namedChangeSincePreviousAttempt.beforeSha256 !==
      binding.namedChangeSincePreviousAttempt.afterSha256;
  if (
    !change ||
    typeof change !== "object" ||
    change.producer !== "native-macos-validation" ||
    !/^[0-9a-f]{64}$/u.test(change.beforeSha256 ?? "") ||
    !/^[0-9a-f]{64}$/u.test(change.afterSha256 ?? "") ||
    binding.namedChangeSincePreviousAttempt.afterSha256 !==
      currentSourceSha256 ||
    (!validOpeningChange && !validLaterRepair)
  ) {
    throw new NativeValidationBlockedError(
      "STOP_REOPEN required change does not match the running validator",
    );
  }
  if (
    binding.reopenDecision.relativePath !==
    `../reopen-decisions/${decision.decisionId}.json`
  ) {
    throw new NativeValidationBlockedError(
      "STOP_REOPEN decision path does not match its decision id",
    );
  }
  return decision;
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
  const observedSignature = sha256Canonical(observation);
  const verdict = aggregateStatus(report.checks);
  const observableSignature =
    binding.repairTarget?.observableSignature ?? observedSignature;
  const canonicalIssueId =
    binding.repairTarget?.canonicalIssueId ??
    `issue-v1:${sha256Canonical({
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
    observedSignature,
    repairTarget: binding.repairTarget,
    rootCauseClass: binding.rootCauseClass,
    canonicalIssueId,
    productIdentity: binding.productIdentity,
    validatorIdentity: binding.validatorIdentity,
    remediationEpoch: binding.remediationEpoch,
    reopenDecision:
      binding.reopenDecision === null
        ? null
        : {
            path: binding.reopenDecision.relativePath,
            sha256: binding.reopenDecision.sha256,
          },
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
  const profileChecks = report.checks.filter(
    (check) => check.id === "disposable-profile",
  );
  const profileCheck = profileChecks.length === 1 ? profileChecks[0] : null;
  const profileSha256 =
    report.nativeEntrypointProfileSha256 ??
    (aggregateStatus(report.checks) !== "PASS" &&
    profileCheck?.status === "PASS"
      ? profileCheck.nativeEntrypointProfileSha256
      : null);
  if (
    profileChecks.length > 1 ||
    profileSha256 !== binding.nativeEntrypointProfileSha256 ||
    (profileCheck?.status === "PASS" &&
      profileCheck.nativeEntrypointProfileSha256 !==
        binding.nativeEntrypointProfileSha256) ||
    report.manifest?.artifactSha256 !== binding.packageArtifactSha256 ||
    report.manifest?.bundleIdentifier !==
      binding.productIdentity.bundleIdentifier ||
    report.manifest?.version !== binding.productIdentity.version
  ) {
    throw new NativeValidationBlockedError(
      "native validation report identity does not match its binding",
    );
  }
  const expectedActionIds = nativeActionsForScope(binding.proofScope).map(
    (action) => action.id,
  );
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
  const versionHistoryChecks = report.checks.filter(
    (check) => check.id === "version-history-route",
  );
  const versionHistoryCheck = versionHistoryChecks[0];
  const versionHistoryTarget = versionHistoryCheck?.targetDocumentBinding;
  const versionHistoryResult = ![
    PROOF_SCOPES.FINAL,
    PROOF_SCOPES.HISTORY,
  ].includes(binding.proofScope)
    ? null
    : routeResult === "PASS" &&
        versionHistoryChecks.length === 1 &&
        versionHistoryCheck?.command === VERSION_HISTORY_MENU_ITEM.command &&
        Number.isSafeInteger(versionHistoryCheck.validationId) &&
        versionHistoryCheck.validationId > 0 &&
        versionHistoryCheck.status === "PASS" &&
        versionHistoryTarget &&
        versionHistoryTarget.launchMode === "single-normal-open-argument" &&
        typeof versionHistoryTarget.path === "string" &&
        path.isAbsolute(versionHistoryTarget.path) &&
        versionHistoryTarget.path.endsWith(".excalidraw") &&
        /^[0-9a-f]{64}$/u.test(versionHistoryTarget.sha256 ?? "") &&
        Number.isSafeInteger(versionHistoryTarget.byteLength) &&
        versionHistoryTarget.byteLength >= 0 &&
        (binding.proofScope !== PROOF_SCOPES.HISTORY ||
          (versionHistoryTarget.observationMethod ===
            "ax-history-panel-filename" &&
            versionHistoryTarget.path === statePreparationCheck?.path &&
            versionHistoryTarget.sha256 ===
              statePreparationCheck?.sha256Before &&
            versionHistoryTarget.byteLength ===
              statePreparationCheck?.byteLength &&
            versionHistoryTarget.observedFileName ===
              path.basename(versionHistoryTarget.path) &&
            versionHistoryTarget.uniqueFileNameInFixture === true &&
            versionHistoryTarget.panelObservation?.pass === true))
      ? "PASS"
      : "BLOCKED";
  const versionHistoryEntry =
    versionHistoryResult === null
      ? null
      : {
          schemaVersion: 1,
          collectionId: "native-entrypoints",
          gateId: "T023b",
          route: "macos-accessibility",
          binding,
          action: {
            checkId: "version-history-route",
            command: VERSION_HISTORY_MENU_ITEM.command,
            validationId: versionHistoryCheck?.validationId ?? null,
            result: versionHistoryResult,
          },
          targetDocumentBinding: versionHistoryTarget ?? null,
          result: versionHistoryResult,
        };
  const environment = {
    schemaVersion: 1,
    collectionId: "native-entrypoints",
    gateId: "T023b",
    route: "macos-accessibility",
    binding,
    productIdentity: binding.productIdentity,
    validatorIdentity: binding.validatorIdentity,
    attemptIdentity: binding.attemptIdentity,
    proofScope: binding.proofScope,
    remediationEpoch: binding.remediationEpoch,
    reopenDecision: binding.reopenDecision,
    os: report.environment?.productVersion ?? "unknown macOS",
    browserOrAppBuild:
      report.manifest?.appPath ?? report.manifestPath ?? "unknown package",
    fixture: "T023b-disposable-profile",
    collector: {
      tool: "native-macos-validation",
      version: "4",
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
    versionHistoryEntry,
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
  if (records.versionHistoryEntry !== null) {
    payloads["version-history-entry.json"] = records.versionHistoryEntry;
  }
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
    records.versionHistoryEntry?.result ?? "PASS",
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
        result: aggregateStatus([
          records.routeAcknowledgements.result,
          records.versionHistoryEntry?.result ?? "PASS",
        ]),
        artifactRefs: [
          "native-report.json",
          "route-acknowledgements.json",
          ...(records.versionHistoryEntry === null
            ? []
            : ["version-history-entry.json"]),
        ],
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
    timeout: options.timeoutMs,
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

function runtimePathPrefixes(repoRoot, commit) {
  const ownershipMap = JSON.parse(
    runRequired(
      "git",
      ["show", `${commit}:e2e/visual/003EvidenceOwnership.json`],
      { cwd: repoRoot },
    ),
  );
  const prefixes = ownershipMap.productIdentity?.pathPrefixes;
  if (!Array.isArray(prefixes) || prefixes.length === 0) {
    throw new NativeValidationBlockedError(
      "product identity path prefixes are missing",
    );
  }
  return prefixes;
}

export function runtimeProductIdentitySha256(repoRoot, commit) {
  const prefixes = runtimePathPrefixes(repoRoot, commit);
  const tree = runSync("git", ["ls-tree", "-r", "--full-tree", commit], {
    cwd: repoRoot,
  });
  if (tree.status !== 0) {
    throw new NativeValidationBlockedError(
      tree.stderr.trim() || "Unable to read product identity tree",
    );
  }
  const entries = tree.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\w+)\s+([0-9a-f]{40,64})\t(.+)$/u.exec(line);
      if (!match) {
        throw new NativeValidationBlockedError(
          "product identity tree entry is malformed",
        );
      }
      return {
        mode: match[1],
        type: match[2],
        objectId: match[3],
        path: match[4],
      };
    })
    .filter((entry) =>
      prefixes.some(
        (prefix) => entry.path === prefix || entry.path.startsWith(prefix),
      ),
    )
    .sort((left, right) => left.path.localeCompare(right.path));
  if (entries.length === 0) {
    throw new NativeValidationBlockedError(
      "product identity runtime path set is empty",
    );
  }
  return sha256Canonical(entries);
}

export async function verifyReusableManifest({
  repoRoot,
  manifest,
  inspect = inspectBundle,
}) {
  const state = gitState(repoRoot);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.repositoryRoot !== repoRoot ||
    !/^[0-9a-f]{40,64}$/u.test(manifest.gitCommit ?? "") ||
    !state.commit ||
    state.status === null ||
    !Array.isArray(manifest.artifacts) ||
    !["executableSha256", "packageSha256", "artifactSha256"].every((field) =>
      /^[0-9a-f]{64}$/u.test(manifest[field] ?? ""),
    ) ||
    JSON.stringify(manifest.buildCommand) !==
      JSON.stringify(["pnpm", ...PRODUCTION_APP_BUILD_ARGS])
  ) {
    throw new NativeValidationBlockedError(
      "Invalid manifest repository or commit identity",
    );
  }
  const prefixes = [
    ...new Set([
      ...runtimePathPrefixes(repoRoot, manifest.gitCommit),
      ...runtimePathPrefixes(repoRoot, state.commit),
      "e2e/visual/003EvidenceOwnership.json",
      "src-tauri/build.rs",
    ]),
  ];
  const changed = [
    runRequired("git", ["diff", "--no-renames", "--name-only", "-z", "HEAD"], {
      cwd: repoRoot,
    }),
    runRequired("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: repoRoot,
    }),
  ].flatMap((output) => output.split("\0").filter(Boolean));
  const dirtyRuntimePaths = changed.filter((file) =>
    prefixes.some((prefix) => file === prefix || file.startsWith(prefix)),
  );
  if (dirtyRuntimePaths.length > 0) {
    throw new NativeValidationBlockedError(
      `Uncommitted runtime inputs: ${dirtyRuntimePaths.join(", ")}`,
    );
  }
  const sealed = runtimeProductIdentitySha256(repoRoot, manifest.gitCommit);
  const current = runtimeProductIdentitySha256(repoRoot, state.commit);
  if (sealed !== current) {
    throw new NativeValidationBlockedError(
      "Runtime inputs changed since the sealed package; choose a new manifest path for a fresh build",
    );
  }
  // Keep the established runtime identity digest unchanged. The Tauri build
  // script is a necessary input omitted by the legacy ownership map.
  const changedBuildInputs = runRequired(
    "git",
    [
      "diff",
      "--name-only",
      manifest.gitCommit,
      state.commit,
      "--",
      "src-tauri/build.rs",
    ],
    { cwd: repoRoot },
  );
  if (changedBuildInputs) {
    throw new NativeValidationBlockedError(
      "Build inputs changed since the sealed package: src-tauri/build.rs",
    );
  }
  const observed = await inspect(manifest.appPath, repoRoot);
  const mismatches = [
    ...compareManifest(manifest, observed),
    ...compareBundleContract(
      await productionBundleContract(repoRoot),
      observed,
    ),
  ];
  if (mismatches.length > 0) {
    throw new NativeValidationBlockedError(
      `Sealed package identity mismatch: ${JSON.stringify(mismatches)}`,
    );
  }
  return {
    packageProvenanceCommit: manifest.gitCommit,
    validatorProvenanceCommit: state.commit,
    runtimeInputsSha256: current,
    observed,
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

function runAppleScript(script, timeoutMs) {
  const result = runSync("osascript", ["-e", script], { timeoutMs });
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

function inspectMenuItem(pid, expected, timeoutMs) {
  const script = inspectMenuItemAppleScript(pid, expected);
  const [label, enabled, character, modifiers] = runAppleScript(
    script,
    timeoutMs,
  ).split("\t");
  return {
    label,
    enabled: enabled === "true",
    keyboard: { character, modifiers: decodeAXModifiers(modifiers) },
  };
}

export async function waitForHistoryMenuReady(
  inspect,
  {
    timeoutMs = HISTORY_MENU_READY_TIMEOUT_MS,
    now = Date.now,
    delay = wait,
  } = {},
) {
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let lastItem = null;
  let lastError = null;
  do {
    attempts += 1;
    try {
      const result = compareMenuObservation(
        VERSION_HISTORY_MENU_ITEM,
        await inspect(),
      );
      lastItem = { path: VERSION_HISTORY_MENU_ITEM.path, ...result };
      lastError = null;
      if (!result.labelMatches || !result.keyboardMatches) {
        return { status: "FAIL", attempts, item: lastItem };
      }
      if (result.pass) return { status: "PASS", attempts, item: lastItem };
    } catch (error) {
      lastError = String(error.message ?? error);
    }
    if (now() >= deadline) break;
    await delay(Math.min(250, Math.max(0, deadline - now())));
  } while (now() <= deadline);
  return {
    status: lastItem === null ? "BLOCKED" : "FAIL",
    attempts,
    ...(lastItem === null ? { error: lastError } : { item: lastItem }),
  };
}

export function windowCountAppleScript(pid) {
  return `tell application "System Events"
  set appProcess to first application process whose unix id is ${Number(pid)}
  return count of windows of appProcess
end tell`;
}

export async function waitForUniqueHistoryWindow(
  inspect,
  {
    timeoutMs = HISTORY_MENU_READY_TIMEOUT_MS,
    now = Date.now,
    delay = wait,
  } = {},
) {
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let error = null;
  do {
    attempts += 1;
    try {
      const count = Number(await inspect());
      if (!Number.isSafeInteger(count) || count < 0)
        throw new Error("AX window count must be a nonnegative integer");
      if (count === 1) return { status: "PASS", attempts, windowCount: count };
      if (count > 1)
        return {
          status: "BLOCKED",
          attempts,
          windowCount: count,
          error: "Owned PID has multiple AX windows; no actions performed",
        };
      error = "Owned PID has no AX window before the readiness deadline";
    } catch (cause) {
      error = String(cause.message ?? cause);
    }
    if (now() >= deadline) break;
    await delay(Math.min(250, Math.max(0, deadline - now())));
  } while (now() <= deadline);
  return { status: "BLOCKED", attempts, error };
}

export function historyPanelObservationAppleScript(pid, fileName) {
  if (typeof fileName !== "string" || fileName.length === 0) {
    throw new TypeError("History target filename is required");
  }
  return `tell application "System Events"
  set appProcess to first application process whose unix id is ${Number(pid)}
  tell appProcess
    set headingCount to 0
    set fileCount to 0
    set closeCount to 0
    -- Materialize the AX list before iterating. A repeat over the unresolved
    -- entire-contents specifier produces unreadable element references.
    set axElements to entire contents of front window
    repeat with elementRef in axElements
      set axElement to contents of elementRef
      if role of axElement is "AXStaticText" then
        set elementValue to (value of axElement) as text
        if elementValue is "Version History" then set headingCount to headingCount + 1
        if elementValue is ${appleScriptQuote(fileName)} then set fileCount to fileCount + 1
      else if role of axElement is "AXButton" then
        if name of axElement is "Close version history" then set closeCount to closeCount + 1
      end if
    end repeat
    return (headingCount as text) & tab & (fileCount as text) & tab & (closeCount as text)
  end tell
end tell`;
}

export function parseHistoryPanelObservation(output) {
  const counts = String(output).trim().split("\t").map(Number);
  if (
    counts.length !== 3 ||
    counts.some((count) => !Number.isSafeInteger(count) || count < 0)
  ) {
    throw new NativeValidationBlockedError(
      "History panel AX observation must contain three nonnegative counts",
    );
  }
  const [headingCount, fileNameCount, closeCount] = counts;
  return {
    headingCount,
    fileNameCount,
    closeCount,
    pass: headingCount > 0 && fileNameCount > 0 && closeCount > 0,
  };
}

// Read app-owned accessibility semantics only. Never navigate, activate, or
// mutate the app while determining whether an operator's prepared state exists.
export function historyReadinessAppleScript(pid, fileName) {
  return `tell application "System Events"
  set appProcess to first application process whose unix id is ${Number(pid)}
  tell appProcess
    set counts to {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
    set axElements to entire contents of front window
    repeat with elementRef in axElements
      set axElement to contents of elementRef
      set elementName to ""
      try
        set elementName to (name of axElement) as text
      end try
      if elementName is ${appleScriptQuote(fileName)} then
        try
          if value of attribute "AXSelected" of axElement is true then set item 4 of counts to (item 4 of counts) + 1
        end try
        if role of axElement is "AXRadioButton" then
          try
            if value of axElement is 1 then set item 4 of counts to (item 4 of counts) + 1
          end try
        end if
      end if
      if elementName contains ", unsaved changes" then set item 5 of counts to (item 5 of counts) + 1
      if role of axElement is "AXStaticText" then
        set elementValue to (value of axElement) as text
        if elementValue is "Version History" then set item 1 of counts to (item 1 of counts) + 1
        if elementValue is ${appleScriptQuote(fileName)} then set item 2 of counts to (item 2 of counts) + 1
        if elementValue is "Version history could not be loaded" then set item 6 of counts to (item 6 of counts) + 1
        if elementValue is "Selected version · unavailable" then set item 8 of counts to (item 8 of counts) + 1
        if elementValue contains "Your current drawing is unchanged." then set item 9 of counts to (item 9 of counts) + 1
        if elementValue ends with " versions shown" then
          try
            set displayedCount to (text 1 thru ((length of elementValue) - (length of " versions shown")) of elementValue) as integer
            if item 12 of counts is 0 then
              set item 12 of counts to displayedCount
            else
              set item 12 of counts to -1
            end if
          on error
            set item 12 of counts to -1
          end try
        end if
        if elementValue is "Loading version history" then set item 13 of counts to (item 13 of counts) + 1
      else if role of axElement is "AXButton" then
        if elementName is "Close version history" then set item 3 of counts to (item 3 of counts) + 1
        if elementName is "Try again" and enabled of axElement then set item 7 of counts to (item 7 of counts) + 1
        if elementName is "Preview" and not enabled of axElement then set item 10 of counts to (item 10 of counts) + 1
        if elementName is "Restore this version" and not enabled of axElement then set item 11 of counts to (item 11 of counts) + 1
        if elementName is "Mark current version" and enabled of axElement then set item 14 of counts to (item 14 of counts) + 1
        if elementName starts with "More actions for " and enabled of axElement then set item 15 of counts to (item 15 of counts) + 1
      end if
    end repeat
    set AppleScript's text item delimiters to tab
    return counts as text
  end tell
end tell`;
}

export function parseHistoryReadiness(
  output,
  scenario,
  requiredVersionCount = 50,
) {
  const counts = String(output).trim().split("\t").map(Number);
  if (
    counts.length !== 15 ||
    counts.some((count) => !Number.isSafeInteger(count) || count < 0)
  ) {
    throw new NativeValidationBlockedError(
      "History readiness AX observation must contain fifteen nonnegative counts",
    );
  }
  const [
    heading,
    filename,
    close,
    selectedSavedTab,
    dirtyTabs,
    error,
    retry,
    unavailable,
    reason,
    previewDisabled,
    restoreDisabled,
    versions,
    loading,
    markCurrent,
    rowMenus,
  ] = counts;
  const missing = [];
  if (!heading || !filename || !close)
    missing.push("History panel for the declared filename");
  if (!selectedSavedTab)
    missing.push(
      "active saved target tab (AXSelected or selected radio value)",
    );
  if (dirtyTabs) missing.push("saved drawing tabs; unsaved changes remain");
  if (loading) missing.push("loading must finish");
  if (scenario === "pendingIssue" && (!error || !retry))
    missing.push("pending/error heading and enabled Try again");
  else if (
    scenario === "unavailable" &&
    (!unavailable || !reason || !previewDisabled || !restoreDisabled)
  )
    missing.push(
      "selected unavailable version, reason, and disabled Preview/Restore",
    );
  else if (
    scenario === "longList" &&
    (versions < requiredVersionCount ||
      error ||
      unavailable ||
      !markCurrent ||
      !rowMenus)
  )
    missing.push(
      `loaded long-list state showing at least ${requiredVersionCount} versions with enabled Mark current and row actions`,
    );
  if (
    scenario === "longList" &&
    (!Number.isSafeInteger(requiredVersionCount) || requiredVersionCount < 50)
  ) {
    throw new NativeValidationBlockedError(
      "Long-list fixture must require at least 50 displayed versions",
    );
  }
  if (!["pendingIssue", "unavailable", "longList"].includes(scenario))
    throw new NativeValidationBlockedError(
      "Unsupported History readiness scenario",
    );
  return { status: missing.length ? "BLOCKED" : "PASS", counts, missing };
}

async function existingSyntheticFixture(fixturePath, scenario) {
  const fixture = JSON.parse(await fsp.readFile(fixturePath, "utf8"));
  const root = await fsp.realpath(fixture.root);
  const temp = await fsp.realpath(os.tmpdir());
  if (!temp.startsWith("/private/var/folders/") && temp !== "/private/tmp") {
    throw new NativeValidationBlockedError(
      "System temp must resolve inside a macOS temporary directory",
    );
  }
  const isBeneath = (base, target) => {
    const relative = path.relative(base, target);
    return (
      relative !== "" &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative)
    );
  };
  if (
    !isBeneath(temp, root) ||
    fixture.root !== root ||
    fixture.nativeVerified !== false
  ) {
    throw new NativeValidationBlockedError(
      "Readiness requires an existing synthetic fixture beneath system temp",
    );
  }
  const document = fixture.documents?.[scenario];
  for (const target of [
    fixturePath,
    fixture.profileHome,
    fixture.workspace,
    fixture.historyDatabase,
    document?.currentFile,
  ]) {
    if (
      typeof target !== "string" ||
      !path.isAbsolute(target) ||
      !isBeneath(root, target) ||
      (await fsp.realpath(target)) !== target
    ) {
      throw new NativeValidationBlockedError(
        "Fixture path is missing, symlinked, or outside the synthetic root",
      );
    }
    // Detect internal symlinks even if they happen to resolve to the same root.
    let checked = root;
    for (const part of path.relative(root, target).split(path.sep)) {
      checked = path.join(checked, part);
      if ((await fsp.lstat(checked)).isSymbolicLink())
        throw new NativeValidationBlockedError(
          "Fixture contains a symbolic link",
        );
    }
  }
  if (
    fixture.profileHome !== path.join(root, "home") ||
    fixture.workspace !== path.join(root, "workspace") ||
    Object.values(fixture.documents).filter(
      (entry) =>
        path.basename(entry.currentFile) ===
        path.basename(document.currentFile),
    ).length !== 1
  ) {
    throw new NativeValidationBlockedError(
      "Fixture profile or target filename is ambiguous",
    );
  }
  return { fixture, target: document.currentFile };
}

function verifyFixtureBackend(fixture, scenario, target) {
  const document = fixture.documents[scenario];
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const query = `SELECT id FROM history_documents WHERE canonical_path=${quote(target)} AND state='active';
    SELECT count(*) FROM maintenance_state WHERE document_id=${quote(document.documentId)} AND issue_code='fixture_pending';
    SELECT count(*) FROM history_versions WHERE document_id=${quote(document.documentId)};`;
  const [id, pending, versionCount] = runRequired("sqlite3", [
    "-readonly",
    fixture.historyDatabase,
    query,
  ]).split(/\r?\n/u);
  if (
    id !== document.documentId ||
    (scenario === "pendingIssue" && Number(pending) !== 1) ||
    (scenario === "longList" && Number(versionCount) < document.versionCount) ||
    (scenario === "unavailable" && Number(versionCount) < 1)
  ) {
    throw new NativeValidationBlockedError(
      "Synthetic backend state is missing or changed; Save can clear pending. Run refresh-pending after Save, then reopen History",
    );
  }
  return {
    documentId: id,
    pendingIssueCount: Number(pending),
    versionCount: Number(versionCount),
  };
}

export async function historyReadiness({
  repoRoot = REPO_ROOT,
  manifestPath,
  pid,
  fixturePath,
  scenario,
}) {
  const checks = [];
  try {
    if (process.platform !== "darwin" || !Number.isSafeInteger(pid) || pid <= 0)
      throw new NativeValidationBlockedError(
        "Readiness requires macOS and one declared owned PID",
      );
    const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    const identity = await verifyReusableManifest({ repoRoot, manifest });
    checks.push(
      makeCheck(
        "artifact-identity",
        "reusable package identity",
        "PASS",
        identity,
      ),
    );
    const { fixture, target } = await existingSyntheticFixture(
      fixturePath,
      scenario,
    );
    for (const suffix of ["-wal", "-shm"]) {
      const metadata = await fsp
        .lstat(`${fixture.historyDatabase}${suffix}`)
        .catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (metadata?.isSymbolicLink())
        throw new NativeValidationBlockedError(
          "Synthetic SQLite sidecar contains a symbolic link",
        );
    }
    const backendBefore = verifyFixtureBackend(fixture, scenario, target);
    const command = runRequired("ps", ["-p", String(pid), "-o", "comm="]);
    const peers = listAmbiguousProcesses(
      manifest.executablePath,
      manifest.executable,
    );
    if (
      command !== manifest.executablePath ||
      peers.length !== 1 ||
      Number(peers[0].split(/\s+/u)[0]) !== pid
    )
      throw new NativeValidationBlockedError(
        "Declared PID is not the unique manifest-bound process",
      );
    const environment = runRequired("ps", [
      "eww",
      "-p",
      String(pid),
      "-o",
      "command=",
    ]);
    if (
      !environment.includes(` HOME=${fixture.profileHome} `) &&
      !environment.endsWith(` HOME=${fixture.profileHome}`)
    )
      throw new NativeValidationBlockedError(
        "Owned process HOME does not match the synthetic backend profile",
      );
    const before = await validExcalidrawSnapshot(target);
    if (!before)
      throw new NativeValidationBlockedError(
        "Synthetic drawing is absent or invalid",
      );
    const samples = [];
    for (let index = 0; index < 2; index += 1) {
      const ready = await waitForUniqueHistoryWindow(() =>
        runAppleScript(windowCountAppleScript(pid), 5000),
      );
      if (ready.status !== "PASS")
        throw new NativeValidationBlockedError(ready.error);
      samples.push(
        parseHistoryReadiness(
          runAppleScript(
            historyReadinessAppleScript(pid, path.basename(target)),
            5000,
          ),
          scenario,
          fixture.documents[scenario].versionCount,
        ),
      );
      if (samples.at(-1).status !== "PASS")
        throw new NativeValidationBlockedError(
          samples.at(-1).missing.join("; "),
        );
      if (index === 0) await wait(500);
    }
    const after = await validExcalidrawSnapshot(target);
    const backendAfter = verifyFixtureBackend(fixture, scenario, target);
    if (
      JSON.stringify(before) !== JSON.stringify(after) ||
      JSON.stringify(samples[0]) !== JSON.stringify(samples[1])
    )
      throw new NativeValidationBlockedError(
        "Prepared drawing or AX state changed between stable samples",
      );
    if (JSON.stringify(backendBefore) !== JSON.stringify(backendAfter))
      throw new NativeValidationBlockedError(
        "Synthetic backend state changed between readiness samples",
      );
    checks.push(
      makeCheck(
        "history-preparation",
        "stable saved History scenario",
        "PASS",
        {
          pid,
          scenario,
          target,
          fixturePath,
          profileHome: fixture.profileHome,
          samples,
          drawing: after,
        },
      ),
    );
  } catch (error) {
    checks.push(
      makeCheck(
        "history-preparation",
        "stable saved History scenario",
        "BLOCKED",
        { error: String(error.message ?? error) },
      ),
    );
  }
  return buildReport({
    command: "readiness",
    manifestPath,
    checks,
    scope: "preparation-only",
    visualVerified: false,
    ownerAccepted: false,
  });
}

function invokeMenuItem(pid, labels) {
  runAppleScript(resolveMenuItemAppleScript(pid, labels, "click targetItem"));
}

function invokeKeyboard(pid, character, modifiers) {
  runAppleScript(keyboardShortcutAppleScript(pid, character, modifiers));
}

export function frontmostProcessAppleScript(pid, activate = true) {
  return `tell application "System Events"
  set appProcess to first application process whose unix id is ${Number(pid)}
  ${activate ? "tell appProcess to set frontmost to true\n  delay 0.2" : ""}
  return unix id of first application process whose frontmost is true
end tell`;
}

export function parseFrontmostPid(output, expectedPid) {
  const observed = Number(String(output ?? "").trim());
  if (!Number.isSafeInteger(observed) || observed !== expectedPid) {
    throw new NativeValidationBlockedError(
      `owned app is not the frontmost PID: expected ${expectedPid}, observed ${String(output).trim()}`,
    );
  }
  return observed;
}

export function physicalCommandSObserverSwiftSource(challenge, timeoutSeconds) {
  if (!/^[0-9a-f]{32}$/u.test(challenge ?? "")) {
    throw new TypeError("Command-S challenge must be 32 lowercase hex digits");
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new TypeError("Command-S observer timeout must be positive");
  }
  return `import AppKit
import Foundation

let challenge = ${JSON.stringify(challenge)}
let deadline = Date().addingTimeInterval(${Number(timeoutSeconds)})
let disallowed: NSEvent.ModifierFlags = [.option, .control, .shift]
var observed = false

func emit(_ value: String) {
  FileHandle.standardOutput.write(Data((value + "\\n").utf8))
}

guard let monitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: { event in
  let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
  if event.keyCode == 1 && flags.contains(.command) && flags.intersection(disallowed).isEmpty && event.isARepeat == false {
    if observed {
      emit("EXCALIDRAW_PHYSICAL_COMMAND_S_DUPLICATE " + challenge)
    } else {
      observed = true
      emit("EXCALIDRAW_PHYSICAL_COMMAND_S " + challenge)
    }
  }
}) else {
  FileHandle.standardError.write(Data("unable to install global key monitor\\n".utf8))
  exit(2)
}

emit("EXCALIDRAW_PHYSICAL_COMMAND_S_READY " + challenge)
while Date() < deadline {
  RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
  if observed {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.5))
    NSEvent.removeMonitor(monitor)
    exit(0)
  }
}
NSEvent.removeMonitor(monitor)
FileHandle.standardError.write(Data("physical Command-S was not observed\\n".utf8))
exit(2)
`;
}

export function keyboardShortcutAppleScript(pid, character, modifiers) {
  if (!new Set(["s", "e"]).has(character))
    throw new TypeError(`Unsupported native shortcut character: ${character}`);
  const allowedModifiers = new Set(["command", "option", "shift", "control"]);
  if (modifiers.some((modifier) => !allowedModifiers.has(modifier)))
    throw new TypeError("Unsupported native shortcut modifier");
  const modifierExpression = modifiers
    .map((modifier) => `${modifier} down`)
    .join(", ");
  return `tell application "System Events"
  set appProcess to first application process whose unix id is ${Number(pid)}
  tell appProcess
    set frontmost to true
    delay 0.2
    keystroke ${appleScriptQuote(character)} using {${modifierExpression}}
  end tell
end tell`;
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

function waitForCommandSConfirmation(expectedLine, timeoutMs) {
  if (!process.stdin.isTTY) {
    throw new NativeValidationBlockedError(
      "physical Command-S proof requires an interactive terminal",
    );
  }
  process.stdout.write(
    `Confirm operator presence by entering this exact line once:\n${expectedLine}\n`,
  );
  return new Promise((resolve, reject) => {
    const terminal = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const timer = setTimeout(() => {
      terminal.close();
      reject(
        new NativeValidationBlockedError(
          "timed out waiting for Command-S operator confirmation",
        ),
      );
    }, timeoutMs);
    terminal.once("line", (line) => {
      clearTimeout(timer);
      terminal.close();
      try {
        resolve(parseCommandSConfirmation(`${line}\n`, expectedLine));
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function startPhysicalCommandSObserver(challenge, timeoutMs) {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), "excalidraw-command-s-observer-"),
  );
  const swiftPath = path.join(root, "observer.swift");
  await fsp.writeFile(
    swiftPath,
    physicalCommandSObserverSwiftSource(challenge, timeoutMs / 1000),
    "utf8",
  );
  const moduleCache = path.join(
    os.tmpdir(),
    "excalidraw-desktop-native-validation-swift-cache",
  );
  const child = spawn("xcrun", ["swift", swiftPath], {
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: moduleCache,
      SWIFT_MODULECACHE_PATH: moduleCache,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = readline.createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const readyLine = `EXCALIDRAW_PHYSICAL_COMMAND_S_READY ${challenge}`;
  const observedLine = `EXCALIDRAW_PHYSICAL_COMMAND_S ${challenge}`;
  const duplicateLine = `EXCALIDRAW_PHYSICAL_COMMAND_S_DUPLICATE ${challenge}`;
  let readyResolve;
  let readyReject;
  let observedResolve;
  let observedReject;
  let duplicate = false;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const observed = new Promise((resolve, reject) => {
    observedResolve = resolve;
    observedReject = reject;
  });
  stdout.on("line", (line) => {
    if (line === readyLine) readyResolve(line);
    else if (line === observedLine) observedResolve(line);
    else if (line === duplicateLine) duplicate = true;
  });
  child.once("error", (error) => {
    readyReject(error);
    observedReject(error);
  });
  child.once("exit", (code) => {
    if (code !== 0) {
      const error = new NativeValidationBlockedError(
        stderr.trim() || `physical Command-S observer exited ${code}`,
      );
      readyReject(error);
      observedReject(error);
    }
  });
  return {
    ready,
    observed,
    duplicate: () => duplicate,
    async close() {
      stdout.close();
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        wait(1000),
      ]);
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

async function invokePhysicalCommandS(processInfo, ignoredIds, timeoutMs) {
  const { child, events } = processInfo;
  const challenge = crypto.randomBytes(16).toString("hex");
  const confirmation = commandSConfirmationLine(challenge);
  await waitForCommandSConfirmation(
    confirmation,
    PHYSICAL_COMMAND_S_TIMEOUT_MS,
  );
  const observer = await startPhysicalCommandSObserver(
    challenge,
    PHYSICAL_COMMAND_S_TIMEOUT_MS,
  );
  try {
    await observer.ready;
    parseFrontmostPid(
      runAppleScript(frontmostProcessAppleScript(child.pid)),
      child.pid,
    );
    process.stdout.write(
      `Press Command-S exactly once in the now-frontmost owned app (PID ${child.pid}). Do not use the menu.\n`,
    );
    const observation = await observer.observed;
    const pair = await waitForValidationPair(
      events,
      "save",
      ignoredIds,
      timeoutMs,
    );
    await wait(600);
    if (observer.duplicate()) {
      throw new NativeValidationBlockedError(
        "more than one physical Command-S keydown was observed",
      );
    }
    const duplicatePair = validationPair(
      events,
      "save",
      new Set([...ignoredIds, pair.validationId]),
    );
    if (duplicatePair) {
      throw new NativeValidationBlockedError(
        "more than one fresh Command-S route pair was observed",
      );
    }
    parseFrontmostPid(
      runAppleScript(frontmostProcessAppleScript(child.pid, false)),
      child.pid,
    );
    return {
      pair,
      physicalKeyEvidence: {
        challenge,
        confirmation,
        observation,
        keyCode: 1,
        modifiers: ["command"],
        repeat: false,
        ownedPid: child.pid,
        frontmostBeforeAndAfter: true,
      },
    };
  } finally {
    await observer.close();
  }
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
  buildCommand = ["pnpm", ...PRODUCTION_APP_BUILD_ARGS],
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
  build = () =>
    runSync("pnpm", PRODUCTION_APP_BUILD_ARGS, {
      cwd: repoRoot,
      inherit: true,
    }),
  inspect = inspectBundle,
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
  if (!initialState.commit || initialState.status === null) {
    checks.push(
      makeCheck("clean-commit", "read repository HEAD and status", "BLOCKED"),
    );
    return buildReport({ command: "seal", manifestPath, startedAt, checks });
  }
  const outputPath =
    manifestPath ?? defaultManifestPath(repoRoot, initialState.commit);
  const existingManifest = await fsp.lstat(outputPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existingManifest) {
    try {
      const manifest = JSON.parse(await fsp.readFile(outputPath, "utf8"));
      const identity = await verifyReusableManifest({
        repoRoot,
        manifest,
        inspect,
      });
      checks.push(
        makeCheck(
          "manifest-reuse",
          "unchanged sealed production package",
          "PASS",
          {
            path: outputPath,
            ...identity,
            reused: true,
          },
        ),
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
        makeCheck(
          "manifest-reuse",
          "unchanged sealed production package",
          "BLOCKED",
          {
            error: String(error.message ?? error),
            reason:
              "Existing manifests are immutable; use a new path after resolving the mismatch",
          },
        ),
      );
      return buildReport({
        command: "seal",
        manifestPath: outputPath,
        startedAt,
        checks,
      });
    }
  }
  if (!initialState.clean) {
    checks.push(
      makeCheck("clean-commit", "clean git commit", "BLOCKED", {
        gitStatus: initialState.status,
      }),
    );
    return buildReport({ command: "seal", manifestPath, startedAt, checks });
  }
  const buildResult = await build();
  if (buildResult.status !== 0) {
    checks.push(
      makeCheck("production-build", "pnpm tauri build --bundles app", "FAIL", {
        exitCode: buildResult.status,
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
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    await fsp.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
    checks.push(
      makeCheck("clean-commit", "clean git commit", "PASS", {
        gitCommit: state.commit,
      }),
    );
    checks.push(
      makeCheck("production-build", "pnpm tauri build --bundles app", "PASS"),
    );
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

export function uniqueHistoryTargetFileName(fixtureFiles, launchDocument) {
  const fileName = path.basename(launchDocument);
  if (
    !Array.isArray(fixtureFiles) ||
    fixtureFiles.filter(
      (entry) =>
        typeof entry?.path === "string" &&
        path.basename(entry.path) === fileName,
    ).length !== 1
  ) {
    return null;
  }
  return fileName;
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
  proofScope,
  fixtureManifestPath,
) {
  const { child, events } = processInfo;
  const expectedMenuItems = nativeMenuItemsForScope(proofScope);
  const actions = nativeActionsForScope(proofScope);
  const launchBefore = await validExcalidrawSnapshot(launchDocument);
  let menuObservations = [];
  try {
    if (proofScope === PROOF_SCOPES.HISTORY) {
      const readiness = await waitForHistoryMenuReady(() =>
        inspectMenuItem(child.pid, VERSION_HISTORY_MENU_ITEM, 5000),
      );
      checks.push(
        makeCheck(
          "native-menu",
          "native Version History menu hierarchy, label, and enabled state",
          readiness.status,
          {
            attempts: readiness.attempts,
            items: readiness.item === undefined ? [] : [readiness.item],
            ...(readiness.error ? { error: readiness.error } : {}),
          },
        ),
      );
      if (readiness.status !== "PASS") return;
      const windowReady = await waitForUniqueHistoryWindow(() =>
        runAppleScript(windowCountAppleScript(child.pid), 5000),
      );
      checks.push(
        makeCheck(
          "window-ready",
          "unique owned AX window",
          windowReady.status,
          windowReady,
        ),
      );
      if (windowReady.status !== "PASS") return;
    } else {
      let lastError;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const attemptObservations = [];
          for (const expected of expectedMenuItems) {
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
        menuObservations.length === expectedMenuItems.length &&
        menuObservations.every((item) => item.pass);
      checks.push(
        makeCheck(
          "native-menu",
          "native menu hierarchy, labels, enabled state, keyboard equivalents",
          allMenuItemsPass ? "PASS" : "FAIL",
          { items: menuObservations },
        ),
      );
    }
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
    if (proofScope === PROOF_SCOPES.HISTORY) return;
  }

  const consumedIds = new Set();
  for (const action of actions) {
    try {
      const before = new Set(events.map((event) => event.validationId));
      let pair;
      let physicalKeyEvidence;
      if (action.kind === "menu") {
        invokeMenuItem(child.pid, action.path);
        pair = await waitForValidationPair(
          events,
          action.command,
          new Set([...consumedIds, ...before]),
          timeoutMs,
        );
      } else if (action.kind === "physical-keyboard") {
        const physical = await invokePhysicalCommandS(
          processInfo,
          new Set([...consumedIds, ...before]),
          timeoutMs,
        );
        pair = physical.pair;
        physicalKeyEvidence = physical.physicalKeyEvidence;
      } else {
        await wait(250);
        invokeKeyboard(child.pid, action.character, action.modifiers);
        pair = await waitForValidationPair(
          events,
          action.command,
          new Set([...consumedIds, ...before]),
          timeoutMs,
        );
      }
      consumedIds.add(pair.validationId);
      if (action.command === "exportImage") dismissExportDialog(child.pid);
      checks.push(
        makeCheck(
          action.id,
          `${action.kind} invocation: ${action.command}`,
          "PASS",
          {
            command: action.command,
            validationId: pair.validationId,
            ...(physicalKeyEvidence ? { physicalKeyEvidence } : {}),
          },
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

  // History has a separate native route. The dedicated history scope also
  // observes the opened panel's filename before claiming a target binding.
  if (
    proofScope === PROOF_SCOPES.FINAL ||
    proofScope === PROOF_SCOPES.HISTORY
  ) {
    try {
      if (
        launchBefore === null ||
        typeof launchDocument !== "string" ||
        !path.isAbsolute(launchDocument) ||
        path.extname(launchDocument) !== ".excalidraw"
      ) {
        throw new NativeValidationBlockedError(
          "Version History route has no valid digest-bound launch document",
        );
      }
      let fileName = null;
      if (proofScope === PROOF_SCOPES.HISTORY) {
        const fixtureManifest = JSON.parse(
          await fsp.readFile(fixtureManifestPath, "utf8"),
        );
        fileName = uniqueHistoryTargetFileName(
          fixtureManifest.files,
          launchDocument,
        );
        if (fileName === null) {
          throw new NativeValidationBlockedError(
            "History target filename is not unique in the prepared fixture",
          );
        }
      }
      const before = new Set(events.map((event) => event.validationId));
      invokeMenuItem(child.pid, VERSION_HISTORY_MENU_ITEM.path);
      const pair = await waitForValidationPair(
        events,
        VERSION_HISTORY_MENU_ITEM.command,
        new Set([...consumedIds, ...before]),
        timeoutMs,
      );
      consumedIds.add(pair.validationId);
      await wait(600);
      const duplicatePair = validationPair(
        events,
        VERSION_HISTORY_MENU_ITEM.command,
        new Set([...consumedIds]),
      );
      if (duplicatePair) {
        throw new NativeValidationBlockedError(
          "more than one fresh Version History route pair was observed",
        );
      }
      let panelObservation = null;
      if (proofScope === PROOF_SCOPES.HISTORY) {
        const deadline = Date.now() + 10_000;
        let lastError = null;
        do {
          try {
            panelObservation = parseHistoryPanelObservation(
              runAppleScript(
                historyPanelObservationAppleScript(child.pid, fileName),
                5000,
              ),
            );
            lastError = null;
            if (panelObservation.pass) break;
          } catch (error) {
            lastError = String(error.message ?? error);
          }
          if (Date.now() >= deadline) break;
          await wait(250);
        } while (Date.now() < deadline);
        if (!panelObservation?.pass) {
          throw new NativeValidationBlockedError(
            `History panel AX did not show the launched document filename${lastError ? `: ${lastError}` : ""}`,
          );
        }
      }
      checks.push(
        makeCheck(
          "version-history-route",
          "native Version History menu route for the launched document",
          "PASS",
          {
            command: VERSION_HISTORY_MENU_ITEM.command,
            validationId: pair.validationId,
            targetDocumentBinding: {
              launchMode: "single-normal-open-argument",
              path: launchBefore.path,
              sha256: launchBefore.sha256,
              byteLength: launchBefore.byteLength,
              ...(panelObservation
                ? {
                    observationMethod: "ax-history-panel-filename",
                    observedFileName: fileName,
                    uniqueFileNameInFixture: true,
                    panelObservation,
                  }
                : {}),
            },
          },
        ),
      );
    } catch (error) {
      checks.push(
        makeCheck(
          "version-history-route",
          "native Version History menu route for the launched document",
          error instanceof NativeValidationBlockedError ? "BLOCKED" : "FAIL",
          {
            command: VERSION_HISTORY_MENU_ITEM.command,
            targetDocumentBinding: {
              launchMode: "single-normal-open-argument",
              path: launchDocument,
              sha256: launchBefore?.sha256 ?? null,
              byteLength: launchBefore?.byteLength ?? null,
            },
            error: String(error.message ?? error),
          },
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
  let evidenceBinding = null;
  if (collectionDir || bindingPath) {
    if (!collectionDir || !bindingPath) {
      throw new NativeValidationBlockedError(
        "--collection-dir and --binding must be supplied together",
      );
    }
    evidenceBinding = requireNativeAdapterBinding(
      JSON.parse(await fsp.readFile(bindingPath, "utf8")),
    );
    const currentSourceSha256 = await sha256File(SCRIPT_PATH);
    if (
      evidenceBinding.validatorIdentity.sourceSha256 !== currentSourceSha256
    ) {
      throw new NativeValidationBlockedError(
        "native validator source digest does not match the running producer",
      );
    }
    if (evidenceBinding.remediationEpoch > 0) {
      const decisionBytes = await fsp.readFile(
        evidenceBinding.reopenDecision.path,
      );
      const decisionSha256 = crypto
        .createHash("sha256")
        .update(decisionBytes)
        .digest("hex");
      if (decisionSha256 !== evidenceBinding.reopenDecision.sha256) {
        throw new NativeValidationBlockedError(
          "STOP_REOPEN decision digest does not match its binding",
        );
      }
      validateStopReopenDecision(
        JSON.parse(decisionBytes.toString("utf8")),
        evidenceBinding,
        currentSourceSha256,
      );
    }
  }
  const resolvedManifestPath =
    manifestPath ??
    defaultManifestPath(repoRoot, gitState(repoRoot).commit ?? "unknown");
  const finish = async (report) => {
    if (reportPath) await writeJson(reportPath, report);
    if (evidenceBinding) {
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
    let productIdentityMatches = state.commit === manifest.gitCommit;
    let sealedRuntimeInputsSha256 = null;
    let currentRuntimeInputsSha256 = null;
    if (evidenceBinding) {
      sealedRuntimeInputsSha256 = runtimeProductIdentitySha256(
        repoRoot,
        manifest.gitCommit,
      );
      currentRuntimeInputsSha256 = runtimeProductIdentitySha256(
        repoRoot,
        state.commit,
      );
      productIdentityMatches =
        sealedRuntimeInputsSha256 ===
          evidenceBinding.productIdentity.runtimeInputsSha256 &&
        currentRuntimeInputsSha256 ===
          evidenceBinding.productIdentity.runtimeInputsSha256;
    }
    checks.push(
      makeCheck(
        "product-identity",
        "runtime product identity across package and validator provenance",
        productIdentityMatches ? "PASS" : "FAIL",
        {
          packageProvenanceCommit: manifest.gitCommit,
          validatorProvenanceCommit: state.commit,
          sameCommit: state.commit === manifest.gitCommit,
          expectedRuntimeInputsSha256:
            evidenceBinding?.productIdentity.runtimeInputsSha256 ?? null,
          sealedRuntimeInputsSha256,
          currentRuntimeInputsSha256,
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
      !productIdentityMatches ||
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
        evidenceBinding?.proofScope ?? PROOF_SCOPES.FINAL,
        nativeProfile?.fixtureManifestPath,
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
    `Usage:\n  node scripts/native-macos-validation.mjs seal [--manifest PATH]\n  node scripts/native-macos-validation.mjs validate --manifest PATH [--capture-plan FINAL_PLAN] [--report PATH] [--collection-dir NEW_PATH --binding BINDING_JSON]\n  node scripts/native-macos-validation.mjs readiness --manifest PATH --pid N --fixture FIXTURE_JSON --scenario pendingIssue|unavailable|longList [--report NEW_PATH]\n\nExisting seal manifests are reused only when package and runtime inputs match. Fresh seals require a clean commit and an absent manifest path. Readiness is read-only preparation evidence for a unique PID in a synthetic backend HOME; it never grants owner or visual PASS. Save the drawing, use prepare_history_visual_fixture refresh-pending ROOT for the pending scenario, reopen History, then run readiness. The validate command uses macOS Accessibility/System Events and never captures screenshots. A schema-v2 FINAL plan supplies a distinct T023b profile and one digest-bound .excalidraw fixture through the normal launch/open path. Qualification scope proves exact 1280x760 geometry, File > Save, physical Command-S, and unchanged prepared state; final scope proves 6/6 menu facts, seven unchanged 003 nativeEntry -> routeAccepted pairs, and one fresh Version History nativeEntry -> routeAccepted pair bound to the launch document. The physical Command-S step requires one nonce-confirmed interactive terminal and one operator keypress while the owned PID is frontmost; menu-click substitution and duplicate observations are rejected. Save/PNG/SVG business filesystem outcomes are owned by deterministic implementation/process-level tests, not this exact-package router probe. Adapter outputs carry separate product, validator, attempt, remediation-epoch, and STOP_REOPEN identities and never contain reviewer or owner decisions.`,
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
  } else if (command === "readiness") {
    report = await historyReadiness({
      repoRoot,
      manifestPath: optionValue(args, "--manifest"),
      pid: Number(optionValue(args, "--pid")),
      fixturePath: optionValue(args, "--fixture"),
      scenario: optionValue(args, "--scenario"),
    });
    const reportPath = optionValue(args, "--report");
    if (reportPath)
      await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
        flag: "wx",
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
