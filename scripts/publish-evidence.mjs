#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const FINAL_GATES = [
  "HF2-01",
  "HF2-02",
  "HF2-03",
  "HF2-04",
  "HF2-05",
  "HF2-06",
];
const FINAL_BROWSER_CLAIMS = [
  "VSL-001",
  "HF2-01",
  "HF2-02",
  "HF2-04",
  "HF2-05",
  "HF2-06-semantic",
  "HF2-06-visual",
];
const TECHNICAL_FILES = [
  "attempt-issue-index.json",
  "dependency-graph.json",
  "input.json",
  "stale-evidence.json",
  "technical-report.json",
  "technical-report.md",
];
const TECHNICAL_INPUT_FIELDS = new Set([
  "schemaVersion",
  "finalCommit",
  "productIdentity",
  "hf2Manifest",
  "finalPackageManifest",
  "ownershipMap",
  "finalBrowserClaimCollections",
  "finalScreenCollections",
  "packageCollections",
  "regressionCollections",
  "delta",
  "attemptRecords",
  "attemptAmendments",
  "attemptReopenDecisions",
]);
const FOREIGN_COLLECTOR_KEYS = new Set([
  "reviewer",
  "reviewerIdentity",
  "reviewerVerdict",
  "reviewedCollections",
  "productOwnerDecision",
  "productOwnerDecisionPath",
  "ownerDecision",
  "ownerRequirement",
]);

export class EvidencePublishError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = "EvidencePublishError";
    this.exitCode = exitCode;
  }
}

function blocked(message) {
  throw new EvidencePublishError(message, 2);
}

function failed(message) {
  throw new EvidencePublishError(message, 1);
}

async function finalBlocked(action, label) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof EvidencePublishError)
      blocked(`${label}: ${error.message}`);
    throw error;
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failed(`${label} must be an object`);
  }
  return value;
}

function rejectForeignCollectorFields(value, label) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectForeignCollectorFields(entry, `${label}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FOREIGN_COLLECTOR_KEYS.has(key)) {
      failed(`${label}.${key} crosses the collector role boundary`);
    }
    rejectForeignCollectorFields(entry, `${label}.${key}`);
  }
}

export async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function walkFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink())
        blocked(`symlink is not publishable: ${relative}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push(relative);
      else blocked(`unsupported filesystem entry: ${relative}`);
    }
  }
  await visit(root);
  return files.sort();
}

export function digestArtifactList(artifacts) {
  const canonical = [...artifacts]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ path: artifactPath, sha256 }) => `${artifactPath}\0${sha256}`)
    .join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export async function digestTree(root) {
  const files = await walkFiles(root);
  const artifacts = [];
  for (const relative of files) {
    artifacts.push({
      path: relative,
      sha256: await sha256File(path.join(root, relative)),
    });
  }
  return { artifacts, sha256: digestArtifactList(artifacts) };
}

async function readJson(filePath, label) {
  const stats = await fsp.lstat(filePath).catch(() => null);
  if (stats === null || !stats.isFile() || stats.isSymbolicLink()) {
    failed(`${label} must be a real file`);
  }
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    failed(`${label} is not valid JSON: ${String(error.message ?? error)}`);
  }
}

async function existingDirectory(directory, label) {
  try {
    const stats = await fsp.lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory())
      blocked(`${label} must be a real directory`);
  } catch (error) {
    if (error?.code === "ENOENT") blocked(`${label} does not exist`);
    throw error;
  }
}

function safeRelativePath(value, label) {
  if (
    typeof value !== "string" ||
    value === "" ||
    path.isAbsolute(value) ||
    value.split(/[\\/]/u).includes("..")
  ) {
    failed(`${label} must stay inside its collection`);
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStringSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    sameJson([...actual].sort(), [...expected].sort())
  );
}

function validProductIdentity(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    COMMIT.test(value.productCommit ?? "") &&
    SHA256.test(value.runtimeInputsSha256 ?? "") &&
    (value.packageArtifactSha256 === undefined ||
      SHA256.test(value.packageArtifactSha256)) &&
    (value.bundleIdentifier === undefined ||
      typeof value.bundleIdentifier === "string") &&
    (value.version === undefined || typeof value.version === "string")
  );
}

async function assertExactEntries(directory, expected, label) {
  await existingDirectory(directory, label);
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  if (
    !sameStringSet(
      entries.map((entry) => entry.name),
      expected,
    )
  ) {
    blocked(
      `${label} must contain exactly: ${[...expected].sort().join(", ")}`,
    );
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink())
      blocked(`${label} contains a symlink: ${entry.name}`);
  }
  return entries;
}

async function validateAbsoluteDigest(reference, label) {
  const value = assertObject(reference, label);
  if (
    typeof value.path !== "string" ||
    !path.isAbsolute(value.path) ||
    !SHA256.test(value.sha256 ?? "")
  ) {
    blocked(`${label} binding is invalid`);
  }
  const stats = await fsp.lstat(value.path).catch(() => null);
  if (stats === null || !stats.isFile() || stats.isSymbolicLink()) {
    blocked(`${label} is missing or unsafe`);
  }
  if ((await sha256File(value.path)) !== value.sha256) {
    blocked(`${label} digest changed`);
  }
  return value;
}

async function validateCollection(collectionDir) {
  const reportPath = path.join(collectionDir, "collector-report.json");
  const report = assertObject(
    await readJson(reportPath, "collector report"),
    "collector report",
  );
  rejectForeignCollectorFields(report, "collectorReport");
  if (report.schemaVersion !== 1 || report.result !== "PASS") {
    failed("collector report must be schemaVersion 1 and PASS");
  }
  if (
    !Array.isArray(report.artifactDigests) ||
    report.artifactDigests.length === 0
  ) {
    failed("collector report must declare artifactDigests");
  }
  const seen = new Set();
  for (const [index, artifact] of report.artifactDigests.entries()) {
    assertObject(artifact, `artifactDigests[${index}]`);
    const relative = safeRelativePath(
      artifact.path,
      `artifactDigests[${index}].path`,
    );
    if (seen.has(relative))
      failed(`duplicate artifact digest path: ${relative}`);
    seen.add(relative);
    if (!SHA256.test(artifact.sha256))
      failed(`invalid artifact digest: ${relative}`);
    const artifactPath = path.join(collectionDir, relative);
    const artifactStats = await fsp.lstat(artifactPath).catch(() => null);
    if (
      artifactStats === null ||
      !artifactStats.isFile() ||
      artifactStats.isSymbolicLink()
    ) {
      failed(`artifact must be a real file: ${relative}`);
    }
    const actual = await sha256File(artifactPath);
    if (actual !== artifact.sha256)
      failed(`artifact digest mismatch: ${relative}`);
  }
  if (report.collectionDigest !== digestArtifactList(report.artifactDigests)) {
    failed("collector collectionDigest is stale");
  }
  const environmentPath = safeRelativePath(
    report.environmentPath,
    "environmentPath",
  );
  const environment = assertObject(
    await readJson(path.join(collectionDir, environmentPath), "environment"),
    "environment",
  );
  rejectForeignCollectorFields(environment, "environment");
  if (
    environment.schemaVersion !== 1 ||
    environment.collectionId !== report.collectionId ||
    environment.gateId !== report.gateId ||
    environment.route !== report.route ||
    !sameJson(environment.binding, report.binding)
  ) {
    failed("environment/report immutable binding mismatch");
  }
  if (report.maskPath !== undefined) {
    const maskPath = safeRelativePath(report.maskPath, "maskPath");
    const mask = assertObject(
      await readJson(path.join(collectionDir, maskPath), "mask"),
      "mask",
    );
    rejectForeignCollectorFields(mask, "mask");
    if (
      mask.schemaVersion !== 1 ||
      mask.collectionId !== report.collectionId ||
      mask.gateId !== report.gateId ||
      !sameJson(mask.binding, report.binding)
    ) {
      failed("mask/report immutable binding mismatch");
    }
  }
  return report;
}

async function validateTechnicalAggregate(source) {
  const aggregateRoot = path.join(source, "aggregate");
  const aggregateEntries = await assertExactEntries(
    aggregateRoot,
    ["technical"],
    "aggregate role",
  );
  if (!aggregateEntries[0].isDirectory())
    blocked("aggregate/technical must be a real directory");
  const technicalDir = path.join(aggregateRoot, "technical");
  const technicalEntries = await assertExactEntries(
    technicalDir,
    TECHNICAL_FILES,
    "technical aggregate",
  );
  if (technicalEntries.some((entry) => !entry.isFile()))
    blocked("technical aggregate entries must be files");

  const input = assertObject(
    await readJson(path.join(technicalDir, "input.json"), "technical input"),
    "technical input",
  );
  const dependencyGraph = assertObject(
    await readJson(
      path.join(technicalDir, "dependency-graph.json"),
      "technical dependency graph",
    ),
    "technical dependency graph",
  );
  const staleEvidence = await readJson(
    path.join(technicalDir, "stale-evidence.json"),
    "technical stale evidence",
  );
  const attemptIssueIndex = assertObject(
    await readJson(
      path.join(technicalDir, "attempt-issue-index.json"),
      "technical attempt issue index",
    ),
    "technical attempt issue index",
  );
  const report = assertObject(
    await readJson(
      path.join(technicalDir, "technical-report.json"),
      "technical report",
    ),
    "technical report",
  );
  const unsupportedInputFields = Object.keys(input).filter(
    (field) => !TECHNICAL_INPUT_FIELDS.has(field),
  );
  if (
    unsupportedInputFields.length !== 0 ||
    input.schemaVersion !== 1 ||
    !COMMIT.test(input.finalCommit ?? "") ||
    !validProductIdentity(input.productIdentity) ||
    report.schemaVersion !== 1 ||
    report.mode !== "technical" ||
    report.result !== "PASS" ||
    report.finalCommit !== input.finalCommit ||
    !sameJson(report.productIdentity, input.productIdentity) ||
    input.productIdentity.productCommit !== input.finalCommit ||
    (input.productIdentity.packageArtifactSha256 !== undefined &&
      input.productIdentity.packageArtifactSha256 !==
        report.packageArtifactSha256) ||
    attemptIssueIndex.schemaVersion !== 1 ||
    !Array.isArray(attemptIssueIndex.issues) ||
    !Array.isArray(staleEvidence) ||
    staleEvidence.length !== 0 ||
    !Array.isArray(report.staleEvidence) ||
    report.staleEvidence.length !== 0
  ) {
    blocked("technical aggregate is not a current PASS");
  }

  const hf2Manifest = await validateAbsoluteDigest(
    input.hf2Manifest,
    "technical HF-2 manifest",
  );
  const packageManifest = await validateAbsoluteDigest(
    input.finalPackageManifest,
    "technical package manifest",
  );
  await validateAbsoluteDigest(input.delta, "technical delta");
  for (const [field, label] of [
    ["attemptRecords", "technical attempt record"],
    ["attemptAmendments", "technical attempt amendment"],
    ["attemptReopenDecisions", "technical attempt reopen decision"],
  ]) {
    if (!Array.isArray(input[field])) blocked(`${field} must be an array`);
    for (const [index, reference] of input[field].entries()) {
      await validateAbsoluteDigest(reference, `${label}[${index}]`);
    }
  }
  if (
    report.hf2ManifestSha256 !== hf2Manifest.sha256 ||
    !SHA256.test(packageManifest.artifactSha256 ?? "") ||
    report.packageArtifactSha256 !== packageManifest.artifactSha256
  ) {
    blocked("technical manifest binding is stale");
  }

  const browserEntries = input.finalBrowserClaimCollections;
  const screenEntries = input.finalScreenCollections;
  const packageEntries = input.packageCollections;
  const regressionEntries = input.regressionCollections;
  if (
    !Array.isArray(browserEntries) ||
    !sameStringSet(
      browserEntries.map((entry) => entry?.claimSet),
      FINAL_BROWSER_CLAIMS,
    ) ||
    !Array.isArray(screenEntries) ||
    !sameStringSet(
      screenEntries.map((entry) => entry?.gateId),
      FINAL_GATES,
    ) ||
    !Array.isArray(packageEntries) ||
    !sameStringSet(
      packageEntries.map((entry) => entry?.claimSet),
      ["T060-identity", "T023b-native-entrypoint"],
    ) ||
    !Array.isArray(regressionEntries) ||
    !sameStringSet(
      regressionEntries.map((entry) => entry?.claimSet),
      ["T023a", "T024", "final-regression"],
    )
  ) {
    blocked("technical aggregate collection sets are incomplete or duplicated");
  }

  const allEntries = [
    ...browserEntries,
    ...screenEntries,
    ...packageEntries,
    ...regressionEntries,
  ];
  const reportPaths = [];
  const collectionDigests = [];
  const validated = [];
  for (const [index, entryValue] of allEntries.entries()) {
    const entry = assertObject(entryValue, `technical collection[${index}]`);
    if (
      typeof entry.reportPath !== "string" ||
      !path.isAbsolute(entry.reportPath) ||
      !SHA256.test(entry.collectionDigest ?? "")
    ) {
      blocked(`technical collection[${index}] binding is invalid`);
    }
    if (
      browserEntries.includes(entry) &&
      !["RERUN", "REUSE"].includes(entry.disposition)
    ) {
      blocked(`technical collection[${index}] disposition is invalid`);
    }
    reportPaths.push(entry.reportPath);
    collectionDigests.push(entry.collectionDigest);
    const collectionReport = await validateCollection(
      path.dirname(entry.reportPath),
    );
    if (
      collectionReport.collectionDigest !== entry.collectionDigest ||
      collectionReport.binding?.productCommit !== input.finalCommit ||
      collectionReport.binding?.hf2ManifestSha256 !== hf2Manifest.sha256 ||
      (collectionReport.binding?.packageArtifactSha256 !== undefined &&
        collectionReport.binding.packageArtifactSha256 !==
          packageManifest.artifactSha256)
    ) {
      blocked(`technical collection[${index}] immutable binding is stale`);
    }
    if (entry.gateId && collectionReport.gateId !== entry.gateId)
      blocked(`technical collection[${index}] gate binding is stale`);
    if (
      screenEntries.includes(entry) &&
      collectionReport.route !== "native-screen-capture"
    )
      blocked(`technical collection[${index}] is not a T061 visual collection`);
    validated.push({ entry, report: collectionReport });
  }
  if (
    new Set(reportPaths).size !== reportPaths.length ||
    new Set(collectionDigests).size !== collectionDigests.length
  ) {
    blocked("technical aggregate collections must be distinct");
  }

  const expectedNodes = validated
    .map(({ entry, report: collectionReport }) => ({
      id: entry.gateId ?? entry.claimSet,
      digest: collectionReport.collectionDigest,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (
    dependencyGraph.schemaVersion !== 1 ||
    !sameJson(dependencyGraph.nodes, expectedNodes) ||
    report.dependencyGraphDigest !==
      crypto
        .createHash("sha256")
        .update(JSON.stringify(dependencyGraph))
        .digest("hex")
  ) {
    blocked("technical dependency graph is stale");
  }

  const expectedBrowserVerdicts = browserEntries
    .map((entry) => ({
      claimSet: entry.claimSet,
      collectionDigest: entry.collectionDigest,
      disposition: entry.disposition,
      result: "PASS",
    }))
    .sort((left, right) => left.claimSet.localeCompare(right.claimSet));
  const actualBrowserVerdicts = Array.isArray(report.browserClaimVerdicts)
    ? [...report.browserClaimVerdicts].sort((left, right) =>
        left.claimSet.localeCompare(right.claimSet),
      )
    : null;
  const expectedScreenVerdicts = screenEntries
    .map((entry) => ({
      gateId: entry.gateId,
      collectionDigest: entry.collectionDigest,
      result: "PASS",
    }))
    .sort((left, right) => left.gateId.localeCompare(right.gateId));
  const actualScreenVerdicts = Array.isArray(report.screenCollectionVerdicts)
    ? [...report.screenCollectionVerdicts].sort((left, right) =>
        left.gateId.localeCompare(right.gateId),
      )
    : null;
  if (
    !sameJson(actualBrowserVerdicts, expectedBrowserVerdicts) ||
    !sameJson(actualScreenVerdicts, expectedScreenVerdicts)
  ) {
    blocked("technical aggregate verdict bindings are stale");
  }

  return {
    input,
    report,
    reportPath: path.join(technicalDir, "technical-report.json"),
    screenCollections: validated
      .filter(({ entry }) => typeof entry.gateId === "string")
      .map(({ report: collectionReport }) => collectionReport),
  };
}

function highCriticalCount(findings) {
  if (!Array.isArray(findings)) return null;
  return findings.filter((finding) =>
    ["High", "Critical"].includes(finding?.severity),
  ).length;
}

function validReviewerIdentity(identity) {
  if (typeof identity === "string") return identity.length > 0;
  return (
    identity !== null &&
    typeof identity === "object" &&
    !Array.isArray(identity) &&
    identity.role === "ui-visual-acceptance-reviewer" &&
    typeof identity.taskIdentity === "string" &&
    identity.taskIdentity.length > 0 &&
    typeof identity.runtimeIdentity === "string" &&
    identity.runtimeIdentity.length > 0
  );
}

function exactCollectionBindings(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const canonical = (entries) =>
    entries
      .map((entry) => ({
        collectionId: entry?.collectionId,
        collectionDigest: entry?.collectionDigest,
      }))
      .sort((left, right) =>
        String(left.collectionId).localeCompare(String(right.collectionId)),
      );
  return sameJson(canonical(actual), canonical(expected));
}

async function validateFinalReview(source, technical) {
  const reviewDir = path.join(source, "review");
  const reviewEntries = await assertExactEntries(
    reviewDir,
    ["reviewer-report.json", "reviewer-report.md", "screens"],
    "FINAL review role",
  );
  if (
    !reviewEntries.find((entry) => entry.name === "screens")?.isDirectory() ||
    reviewEntries
      .filter((entry) => entry.name !== "screens")
      .some((entry) => !entry.isFile())
  ) {
    blocked("FINAL review role entry types are invalid");
  }
  const screensDir = path.join(reviewDir, "screens");
  const screenDirectories = await assertExactEntries(
    screensDir,
    FINAL_GATES,
    "FINAL screen reviews",
  );
  if (screenDirectories.some((entry) => !entry.isDirectory()))
    blocked("FINAL screen review entries must be directories");

  const expectedCollections = technical.screenCollections.map((report) => ({
    collectionId: report.collectionId,
    collectionDigest: report.collectionDigest,
  }));
  const reviewPath = path.join(reviewDir, "reviewer-report.json");
  const review = assertObject(
    await readJson(reviewPath, "FINAL reviewer index"),
    "FINAL reviewer index",
  );
  if (
    review.schemaVersion !== 1 ||
    review.gateId !== "FINAL-003" ||
    review.verdict !== "PASS" ||
    !validReviewerIdentity(review.reviewerIdentity) ||
    review.independenceConfirmed !== true ||
    review.reviewedProductCommit !== technical.input.finalCommit ||
    review.reviewedPackageArtifactSha256 !==
      technical.input.finalPackageManifest.artifactSha256 ||
    review.highCriticalCount !== 0 ||
    !exactCollectionBindings(review.reviewedCollections, expectedCollections) ||
    !Array.isArray(review.screenReviews) ||
    review.screenReviews.length !== FINAL_GATES.length
  ) {
    blocked("FINAL reviewer index is incomplete or stale");
  }

  const screenGateIds = review.screenReviews.map((entry) => entry?.gateId);
  if (!sameStringSet(screenGateIds, FINAL_GATES))
    blocked("FINAL reviewer index must bind exactly six screens");
  for (const [index, referenceValue] of review.screenReviews.entries()) {
    const reference = assertObject(referenceValue, `screenReviews[${index}]`);
    const expectedPath = `screens/${reference.gateId}/reviewer-report.json`;
    if (
      reference.path !== expectedPath ||
      !SHA256.test(reference.sha256 ?? "") ||
      reference.verdict !== "PASS" ||
      reference.highCriticalCount !== 0
    ) {
      blocked(`screenReviews[${index}] binding is invalid`);
    }
    const screenDir = path.join(screensDir, reference.gateId);
    const entries = await assertExactEntries(
      screenDir,
      ["reviewer-report.json", "reviewer-report.md"],
      `${reference.gateId} review`,
    );
    if (entries.some((entry) => !entry.isFile()))
      blocked(`${reference.gateId} review entries must be files`);
    const screenReportPath = path.join(reviewDir, reference.path);
    if ((await sha256File(screenReportPath)) !== reference.sha256)
      blocked(`${reference.gateId} reviewer report digest changed`);
    const screenReport = assertObject(
      await readJson(screenReportPath, `${reference.gateId} reviewer report`),
      `${reference.gateId} reviewer report`,
    );
    const expectedCollection = technical.screenCollections.find(
      (collection) => collection.gateId === reference.gateId,
    );
    if (
      !expectedCollection ||
      screenReport.schemaVersion !== 1 ||
      screenReport.gateId !== reference.gateId ||
      screenReport.verdict !== "PASS" ||
      !validReviewerIdentity(screenReport.reviewerIdentity) ||
      screenReport.independenceConfirmed !== true ||
      screenReport.reviewedProductCommit !== technical.input.finalCommit ||
      screenReport.reviewedPackageArtifactSha256 !==
        technical.input.finalPackageManifest.artifactSha256 ||
      highCriticalCount(screenReport.findings) !== 0 ||
      reference.collectionId !== expectedCollection.collectionId ||
      reference.collectionDigest !== expectedCollection.collectionDigest ||
      !exactCollectionBindings(screenReport.reviewedCollections, [
        expectedCollection,
      ])
    ) {
      blocked(`${reference.gateId} reviewer report is incomplete or stale`);
    }
  }
  return { review, reviewPath };
}

async function validateFinalOwner(source, technical, review) {
  const ownerDir = path.join(source, "owner");
  const entries = await assertExactEntries(
    ownerDir,
    ["product-owner-decision.json", "product-owner-decision.md"],
    "FINAL owner role",
  );
  if (entries.some((entry) => !entry.isFile()))
    blocked("FINAL owner role entries must be files");
  const owner = assertObject(
    await readJson(
      path.join(ownerDir, "product-owner-decision.json"),
      "FINAL owner decision",
    ),
    "FINAL owner decision",
  );
  const technicalReference = assertObject(
    owner.technicalReport,
    "owner technicalReport",
  );
  const reviewerReference = assertObject(
    owner.reviewerReport,
    "owner reviewerReport",
  );
  if (
    owner.schemaVersion !== 1 ||
    owner.gateId !== "FINAL-003" ||
    owner.status !== "APPROVED" ||
    technicalReference.path !== "aggregate/technical/technical-report.json" ||
    technicalReference.result !== "PASS" ||
    !SHA256.test(technicalReference.sha256 ?? "") ||
    technicalReference.sha256 !== (await sha256File(technical.reportPath)) ||
    reviewerReference.path !== "review/reviewer-report.json" ||
    reviewerReference.verdict !== "PASS" ||
    !SHA256.test(reviewerReference.sha256 ?? "") ||
    reviewerReference.sha256 !== (await sha256File(review.reviewPath))
  ) {
    blocked("FINAL owner decision does not bind technical and reviewer inputs");
  }
}

export async function validateSealedGate(source) {
  await existingDirectory(source, "source");
  const gateId = path.basename(source);
  const allowedTopLevel =
    gateId === "FINAL-003"
      ? ["aggregate", "collection", "owner", "review"]
      : ["collection", "owner", "review"];
  const topLevel = await fsp.readdir(source, { withFileTypes: true });
  if (
    !sameStringSet(
      topLevel.map((entry) => entry.name),
      allowedTopLevel,
    )
  )
    blocked(
      "sealed gate top-level evidence roles are incomplete or unexpected",
    );
  if (topLevel.some((entry) => !entry.isDirectory() || entry.isSymbolicLink()))
    blocked("sealed gate top-level roles must be real directories");
  const collectionRoot = path.join(source, "collection");
  await existingDirectory(collectionRoot, "collection role");
  const collectionEntries = await fsp.readdir(collectionRoot, {
    withFileTypes: true,
  });
  if (collectionEntries.length === 0) blocked("sealed gate has no collection");
  if (
    collectionEntries.some(
      (entry) => !entry.isDirectory() || entry.isSymbolicLink(),
    )
  ) {
    blocked("collection role may contain only real collection directories");
  }
  const reports = [];
  for (const entry of collectionEntries) {
    const validate = () =>
      validateCollection(path.join(collectionRoot, entry.name));
    reports.push(
      gateId === "FINAL-003"
        ? await finalBlocked(validate, `FINAL collection ${entry.name}`)
        : await validate(),
    );
  }
  if (gateId === "FINAL-003") {
    const technical = await finalBlocked(
      () => validateTechnicalAggregate(source),
      "FINAL technical aggregate",
    );
    const review = await finalBlocked(
      () => validateFinalReview(source, technical),
      "FINAL reviewer graph",
    );
    await finalBlocked(
      () => validateFinalOwner(source, technical, review),
      "FINAL owner graph",
    );
  } else if (gateId === "VSL-001") {
    const reviewDir = path.join(source, "review");
    const ownerDir = path.join(source, "owner");
    await existingDirectory(reviewDir, "review role");
    await existingDirectory(ownerDir, "owner role");
    const review = assertObject(
      await readJson(
        path.join(reviewDir, "reviewer-report.json"),
        "reviewer report",
      ),
      "reviewer report",
    );
    if (
      review.schemaVersion !== 1 ||
      review.gateId !== gateId ||
      review.verdict !== "PASS"
    ) {
      blocked("reviewer report does not seal this gate with PASS");
    }
    if (!Array.isArray(review.reviewedCollections))
      blocked("reviewer report has no collection binding");
    for (const report of reports) {
      if (
        !review.reviewedCollections.some(
          (entry) =>
            entry?.collectionId === report.collectionId &&
            entry?.collectionDigest === report.collectionDigest,
        )
      ) {
        blocked(
          `reviewer report does not bind collection ${report.collectionId}`,
        );
      }
    }
    const owner = assertObject(
      await readJson(
        path.join(ownerDir, "product-owner-decision.json"),
        "owner decision",
      ),
      "owner decision",
    );
    if (
      owner.schemaVersion !== 1 ||
      owner.gateId !== gateId ||
      owner.status !== "APPROVED"
    ) {
      blocked("product owner has not approved this sealed gate");
    }
  }
  return { gateId, reports, tree: await digestTree(source) };
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

export async function publishEvidence({
  source,
  destination,
  allowedDestinationRoot = path.join(
    REPO_ROOT,
    "docs",
    "evidence",
    "003-visual-acceptance",
  ),
}) {
  const resolvedSource = path.resolve(source);
  const resolvedDestination = path.resolve(destination);
  const resolvedAllowedRoot = path.resolve(allowedDestinationRoot);
  if (!inside(resolvedAllowedRoot, resolvedDestination)) {
    blocked("destination escapes the configured evidence root");
  }
  try {
    await fsp.lstat(resolvedDestination);
    blocked("destination already exists");
  } catch (error) {
    if (error instanceof EvidencePublishError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  const sealed = await validateSealedGate(resolvedSource);
  const staging = `${resolvedDestination}.publishing-${process.pid}`;
  try {
    await fsp.mkdir(path.dirname(resolvedDestination), { recursive: true });
    await fsp.cp(resolvedSource, staging, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const copied = await digestTree(staging);
    const sourceAfter = await digestTree(resolvedSource);
    if (
      copied.sha256 !== sealed.tree.sha256 ||
      sourceAfter.sha256 !== sealed.tree.sha256
    ) {
      failed("byte-preserving publication digest check failed");
    }
    await fsp.rename(staging, resolvedDestination);
    const receiptPath = path.join(
      path.dirname(resolvedDestination),
      `${path.basename(resolvedDestination)}.publication.json`,
    );
    const receipt = {
      schemaVersion: 1,
      gateId: sealed.gateId,
      source: resolvedSource,
      destination: resolvedDestination,
      sourceTreeSha256: sealed.tree.sha256,
      destinationTreeSha256: copied.sha256,
      fileCount: copied.artifacts.length,
      result: "PASS",
    };
    await fsp.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
    });
    return { receiptPath, receipt };
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function usage() {
  console.log(
    "Usage: pnpm evidence:publish -- --source <sealed-gate-dir> --destination <new-evidence-dir>\nExit codes: 0=PASS, 1=FAIL, 2=BLOCKED, 64=invalid invocation.",
  );
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("help")) return usage();
  const source = option(args, "--source");
  const destination = option(args, "--destination");
  if (!source || !destination) {
    usage();
    process.exitCode = 64;
    return;
  }
  try {
    const result = await publishEvidence({ source, destination });
    console.log(JSON.stringify(result.receipt, null, 2));
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exitCode =
      error instanceof EvidencePublishError ? error.exitCode : 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH)
  await main();
