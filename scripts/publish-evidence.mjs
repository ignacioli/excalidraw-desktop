#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const SHA256 = /^[0-9a-f]{64}$/u;
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
    const actual = await sha256File(path.join(collectionDir, relative));
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

export async function validateSealedGate(source) {
  await existingDirectory(source, "source");
  const topLevel = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of topLevel) {
    if (
      !entry.isDirectory() ||
      !["collection", "review", "owner"].includes(entry.name)
    ) {
      blocked(`unexpected top-level evidence role: ${entry.name}`);
    }
  }
  const collectionRoot = path.join(source, "collection");
  await existingDirectory(collectionRoot, "collection role");
  const collectionEntries = (
    await fsp.readdir(collectionRoot, { withFileTypes: true })
  ).filter((entry) => entry.isDirectory());
  if (collectionEntries.length === 0) blocked("sealed gate has no collection");
  const reports = [];
  for (const entry of collectionEntries) {
    reports.push(
      await validateCollection(path.join(collectionRoot, entry.name)),
    );
  }
  const gateId = path.basename(source);
  if (["VSL-001", "FINAL-003"].includes(gateId)) {
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
