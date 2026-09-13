#!/usr/bin/env node

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const FINAL_GATES = [
  "HF2-01",
  "HF2-02",
  "HF2-03",
  "HF2-04",
  "HF2-05",
  "HF2-06",
];
const MAX_JSON_BYTES = 8 * 1024 * 1024;

export class EvidenceAggregateError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "EvidenceAggregateError";
    this.exitCode = exitCode;
  }
}

function blocked(message) {
  throw new EvidenceAggregateError(message, 2);
}

function failed(message) {
  throw new EvidenceAggregateError(message, 1);
}

function invalid(message) {
  throw new EvidenceAggregateError(message, 64);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    blocked(`${label} must be an object`);
  return value;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fsp.readFile(filePath));
}

function artifactDigest(artifacts) {
  return sha256(
    [...artifacts]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => `${entry.path}\0${entry.sha256}`)
      .join("\n"),
  );
}

function relativeArtifactPath(value, label) {
  if (
    typeof value !== "string" ||
    value === "" ||
    path.isAbsolute(value) ||
    value.split(/[\\/]/u).includes("..")
  ) {
    blocked(`${label} escapes its collection`);
  }
  return value;
}

async function readJson(filePath, label) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath))
    blocked(`${label} path must be absolute`);
  const stats = await fsp.lstat(filePath).catch(() => null);
  if (stats === null || !stats.isFile() || stats.isSymbolicLink())
    blocked(`${label} must be a real file`);
  if (stats.size > MAX_JSON_BYTES)
    blocked(`${label} exceeds the JSON size limit`);
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    blocked(`${label} is invalid JSON: ${String(error.message ?? error)}`);
  }
}

async function writeJsonExclusive(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function writeMarkdownExclusive(filePath, value) {
  await fsp.writeFile(filePath, value, { encoding: "utf8", flag: "wx" });
}

function assertAbsent(filePath, label) {
  return fsp
    .lstat(filePath)
    .then(() => blocked(`${label} already exists`))
    .catch((error) => {
      if (error instanceof EvidenceAggregateError) throw error;
      if (error?.code !== "ENOENT") throw error;
    });
}

export function parseTasksMarkdown(markdown) {
  const records = [];
  const seen = new Set();
  const pattern = /^- \[([ xX])\] (T\d+[a-z]?)(?:\s|$)/gmu;
  for (const match of markdown.matchAll(pattern)) {
    const taskId = match[2];
    if (seen.has(taskId)) blocked(`duplicate task id: ${taskId}`);
    seen.add(taskId);
    records.push({
      taskId,
      checkboxState: match[1].toLowerCase() === "x" ? "checked" : "unchecked",
    });
  }
  if (records.length === 0) blocked("tasks file has no checklist task ids");
  return records;
}

function matchingRules(filePath, ownershipMap) {
  return ownershipMap.rules.filter((rule) =>
    rule.pathPrefixes.some(
      (prefix) => filePath === prefix || filePath.startsWith(prefix),
    ),
  );
}

function nonEmptyStringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry === "")
  ) {
    blocked(`${label} must be a non-empty string array`);
  }
  if (new Set(value).size !== value.length)
    blocked(`${label} must not contain duplicates`);
  return value;
}

function validateOwnershipMap(ownershipMap) {
  object(ownershipMap, "ownership map");
  if (
    ownershipMap.schemaVersion !== 1 ||
    typeof ownershipMap.version !== "string" ||
    ownershipMap.version === "" ||
    !Array.isArray(ownershipMap.rules) ||
    ownershipMap.rules.length === 0
  ) {
    blocked("ownership map schema is invalid");
  }
  const commandCatalog = object(
    ownershipMap.commandCatalog,
    "ownership map commandCatalog",
  );
  const claimCommands = object(
    ownershipMap.claimCommands,
    "ownership map claimCommands",
  );
  if (
    Object.keys(commandCatalog).length === 0 ||
    Object.keys(claimCommands).length === 0
  ) {
    blocked("ownership map command mappings must not be empty");
  }
  for (const [commandId, command] of Object.entries(commandCatalog)) {
    if (
      !/^[a-z0-9][a-z0-9-]*$/u.test(commandId) ||
      typeof command !== "string" ||
      command.trim() === ""
    ) {
      blocked(`ownership map commandCatalog entry is invalid: ${commandId}`);
    }
  }
  for (const [claimId, commandIds] of Object.entries(claimCommands)) {
    nonEmptyStringArray(commandIds, `claimCommands.${claimId}`);
    for (const commandId of commandIds) {
      if (!Object.hasOwn(commandCatalog, commandId))
        blocked(`claim command is not in commandCatalog: ${commandId}`);
    }
  }
  for (const [index, rule] of ownershipMap.rules.entries()) {
    object(rule, `ownership map rules[${index}]`);
    if (typeof rule.id !== "string" || rule.id === "")
      blocked(`ownership map rules[${index}].id is invalid`);
    nonEmptyStringArray(
      rule.pathPrefixes,
      `ownership map rules[${index}].pathPrefixes`,
    );
    nonEmptyStringArray(rule.owners, `ownership map rules[${index}].owners`);
    nonEmptyStringArray(
      rule.claimIds,
      `ownership map rules[${index}].claimIds`,
    );
  }
  return ownershipMap;
}

function commandsForClaim(claimId, ownershipMap) {
  if (!Object.hasOwn(ownershipMap.claimCommands, claimId))
    blocked(`claim has no command mapping: ${claimId}`);
  return ownershipMap.claimCommands[claimId]
    .map((commandId) => ({
      id: commandId,
      command: ownershipMap.commandCatalog[commandId],
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function classifyDeltaPaths(paths, ownershipMap) {
  validateOwnershipMap(ownershipMap);
  return [...new Set(paths)].sort().map((filePath) => {
    if (path.isAbsolute(filePath) || filePath.split(/[\\/]/u).includes(".."))
      blocked(`delta path escapes product root: ${filePath}`);
    const rules = matchingRules(filePath, ownershipMap);
    if (rules.length !== 1)
      blocked(`delta path must have exactly one owner rule: ${filePath}`);
    return {
      path: filePath,
      ownershipRule: rules[0].id,
      owners: [...rules[0].owners].sort(),
      claimIds: [...rules[0].claimIds].sort(),
      action: "RERUN",
    };
  });
}

function git(productRoot, args, label) {
  const result = spawnSync("git", ["-C", productRoot, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0)
    blocked(`${label}: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

export async function aggregateDelta({
  productRoot,
  checkpointMapPath,
  finalCommit,
  ownershipMapPath,
  outputPath,
}) {
  if (
    ![productRoot, checkpointMapPath, ownershipMapPath, outputPath].every(
      (value) => typeof value === "string" && path.isAbsolute(value),
    )
  )
    invalid("delta mode requires absolute paths");
  if (!/^[0-9a-f]{40}$/u.test(finalCommit ?? ""))
    invalid("delta mode requires a 40-hex final commit");
  if (git(productRoot, ["rev-parse", "HEAD"], "read HEAD") !== finalCommit)
    blocked("final commit is not the product HEAD");
  if (
    git(productRoot, ["status", "--porcelain"], "read worktree status") !== ""
  )
    blocked("delta mode requires a clean product worktree");
  const checkpointMap = object(
    await readJson(checkpointMapPath, "checkpoint map"),
    "checkpoint map",
  );
  const ownershipMap = await readJson(ownershipMapPath, "ownership map");
  if (
    checkpointMap.schemaVersion !== 1 ||
    !Array.isArray(checkpointMap.checkpoints) ||
    checkpointMap.checkpoints.length === 0
  )
    blocked("checkpoint map schema is invalid");
  validateOwnershipMap(ownershipMap);
  const changedPaths = new Set();
  const reuse = [];
  const rerunCommands = new Map();
  for (const checkpoint of checkpointMap.checkpoints) {
    object(checkpoint, "checkpoint");
    if (
      typeof checkpoint.claimId !== "string" ||
      checkpoint.claimId === "" ||
      typeof checkpoint.sourceReportPath !== "string" ||
      !path.isAbsolute(checkpoint.sourceReportPath) ||
      !/^[0-9a-f]{64}$/u.test(checkpoint.sourceCollectionDigest ?? "") ||
      !/^[0-9a-f]{40}$/u.test(checkpoint.fromCommit ?? "")
    ) {
      blocked("checkpoint source schema is invalid");
    }
    const claimCommands = commandsForClaim(checkpoint.claimId, ownershipMap);
    const sourceReport = await validateCollectorReport(
      checkpoint.sourceReportPath,
      checkpoint.sourceCollectionDigest,
    );
    if (sourceReport.binding?.productCommit !== checkpoint.fromCommit)
      blocked(
        `checkpoint source commit binding is stale: ${checkpoint.sourceReportPath}`,
      );
    git(
      productRoot,
      ["cat-file", "-e", `${checkpoint.fromCommit}^{commit}`],
      "resolve checkpoint commit",
    );
    const output = git(
      productRoot,
      ["diff", "--name-only", checkpoint.fromCommit, finalCommit],
      "compute checkpoint delta",
    );
    const checkpointPaths = output.split(/\r?\n/u).filter(Boolean);
    checkpointPaths.forEach((entry) => changedPaths.add(entry));
    const checkpointEntries = classifyDeltaPaths(checkpointPaths, ownershipMap);
    const changedOwningPaths = checkpointEntries
      .filter((entry) => entry.claimIds.includes(checkpoint.claimId))
      .map((entry) => entry.path);
    const result = changedOwningPaths.length === 0 ? "REUSE" : "RERUN";
    if (result === "RERUN") {
      for (const command of claimCommands)
        rerunCommands.set(command.id, command);
    }
    reuse.push({
      claimId: checkpoint.claimId,
      sourceReportPath: checkpoint.sourceReportPath,
      sourceReportSha256: await sha256File(checkpoint.sourceReportPath),
      sourceCollectionDigest: checkpoint.sourceCollectionDigest,
      fromCommit: checkpoint.fromCommit,
      toCommit: finalCommit,
      ownershipRule: ownershipMap.version,
      changedOwningPaths,
      result,
    });
  }
  const entries = classifyDeltaPaths([...changedPaths], ownershipMap);
  const report = {
    schemaVersion: 1,
    finalCommit,
    ownershipMapVersion: ownershipMap.version,
    entries,
    reuse,
    rerunCommands: [...rerunCommands.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
  await assertAbsent(outputPath, "delta output");
  await writeJsonExclusive(outputPath, report);
  return report;
}

async function validateCollectorReport(reportPath, expectedDigest) {
  const report = object(
    await readJson(reportPath, "collector report"),
    "collector report",
  );
  if (
    report.schemaVersion !== 1 ||
    report.result !== "PASS" ||
    report.collectionDigest !== expectedDigest ||
    !Array.isArray(report.artifactDigests)
  ) {
    blocked(`collector report binding is invalid: ${reportPath}`);
  }
  const root = path.dirname(reportPath);
  for (const [index, artifact] of report.artifactDigests.entries()) {
    const relative = relativeArtifactPath(
      artifact.path,
      `artifactDigests[${index}]`,
    );
    if (!/^[0-9a-f]{64}$/u.test(artifact.sha256 ?? ""))
      blocked("collector artifact digest is invalid");
    const artifactPath = path.join(root, relative);
    const stats = await fsp.lstat(artifactPath).catch(() => null);
    if (stats === null || !stats.isFile() || stats.isSymbolicLink())
      blocked(`collector artifact is missing or unsafe: ${relative}`);
    if ((await sha256File(artifactPath)) !== artifact.sha256)
      blocked(`collector artifact digest changed: ${relative}`);
  }
  if (artifactDigest(report.artifactDigests) !== report.collectionDigest)
    blocked("collector collectionDigest is stale");
  return report;
}

export async function aggregateTechnical({ inputPath, outputDir }) {
  if (
    ![inputPath, outputDir].every(
      (value) => typeof value === "string" && path.isAbsolute(value),
    )
  )
    invalid("technical mode requires absolute paths");
  await assertAbsent(outputDir, "technical output directory");
  const input = object(
    await readJson(inputPath, "technical input"),
    "technical input",
  );
  if (
    input.schemaVersion !== 1 ||
    !/^[0-9a-f]{40}$/u.test(input.finalCommit ?? "") ||
    !Array.isArray(input.finalScreenCollections)
  )
    blocked("technical input schema is invalid");
  const gates = input.finalScreenCollections
    .map((entry) => entry.gateId)
    .sort();
  if (JSON.stringify(gates) !== JSON.stringify([...FINAL_GATES].sort()))
    blocked("technical input must contain each final screen exactly once");
  const packageClaimSets = new Set(
    (input.packageCollections ?? []).map((entry) => entry.claimSet),
  );
  const regressionClaimSets = new Set(
    (input.regressionCollections ?? []).map((entry) => entry.claimSet),
  );
  for (const required of ["T060-identity", "T023b-native-entrypoint"]) {
    if (!packageClaimSets.has(required))
      blocked(`technical input is missing package claim set ${required}`);
  }
  for (const required of ["T023a", "T024", "final-regression"]) {
    if (!regressionClaimSets.has(required))
      blocked(`technical input is missing regression claim set ${required}`);
  }
  const allCollections = [
    ...input.finalScreenCollections,
    ...(input.packageCollections ?? []),
    ...(input.regressionCollections ?? []),
  ];
  const validated = [];
  for (const entry of allCollections) {
    const report = await validateCollectorReport(
      entry.reportPath,
      entry.collectionDigest,
    );
    if (entry.gateId && report.gateId !== entry.gateId)
      blocked(`collector gate binding is stale: ${entry.reportPath}`);
    if (
      report.binding.productCommit !== input.finalCommit ||
      report.binding.hf2ManifestSha256 !== input.hf2Manifest.sha256 ||
      (input.finalPackageManifest?.artifactSha256 &&
        report.binding.packageArtifactSha256 &&
        report.binding.packageArtifactSha256 !==
          input.finalPackageManifest.artifactSha256)
    ) {
      blocked(`collection binding is stale: ${entry.reportPath}`);
    }
    validated.push({ id: entry.gateId ?? entry.claimSet, report });
  }
  if ((await sha256File(input.hf2Manifest.path)) !== input.hf2Manifest.sha256)
    blocked("technical HF-2 manifest digest changed");
  if (
    (await sha256File(input.finalPackageManifest.path)) !==
    input.finalPackageManifest.sha256
  )
    blocked("technical package manifest digest changed");
  if ((await sha256File(input.delta.path)) !== input.delta.sha256)
    blocked("technical delta digest changed");
  const screenCollectionVerdicts = input.finalScreenCollections.map(
    (entry) => ({
      gateId: entry.gateId,
      collectionDigest: entry.collectionDigest,
      result: "PASS",
    }),
  );
  const claimVerdicts = validated
    .filter((entry) => !FINAL_GATES.includes(entry.id))
    .map((entry) => ({
      claimId: entry.id,
      sourceDigest: entry.report.collectionDigest,
      result: "PASS",
    }));
  const dependencyGraph = {
    schemaVersion: 1,
    nodes: validated
      .map((entry) => ({ id: entry.id, digest: entry.report.collectionDigest }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  const report = {
    schemaVersion: 1,
    mode: "technical",
    finalCommit: input.finalCommit,
    packageArtifactSha256: input.finalPackageManifest.artifactSha256,
    hf2ManifestSha256: input.hf2Manifest.sha256,
    dependencyGraphDigest: sha256(JSON.stringify(dependencyGraph)),
    screenCollectionVerdicts,
    claimVerdicts,
    staleEvidence: [],
    result: "PASS",
  };
  await fsp.mkdir(outputDir);
  await writeJsonExclusive(path.join(outputDir, "input.json"), input);
  await writeJsonExclusive(
    path.join(outputDir, "dependency-graph.json"),
    dependencyGraph,
  );
  await writeJsonExclusive(path.join(outputDir, "stale-evidence.json"), []);
  await writeJsonExclusive(
    path.join(outputDir, "technical-report.json"),
    report,
  );
  await writeMarkdownExclusive(
    path.join(outputDir, "technical-report.md"),
    `# Technical aggregate\n\n- Result: **PASS**\n- Final commit: \`${report.finalCommit}\`\n- Final screens: **6/6**\n- Stale evidence: **0**\n`,
  );
  return report;
}

async function validateProofArtifact(artifact, label) {
  object(artifact, label);
  if (
    typeof artifact.path !== "string" ||
    !path.isAbsolute(artifact.path) ||
    !/^[0-9a-f]{64}$/u.test(artifact.sha256 ?? "")
  )
    blocked(`${label} is invalid`);
  const stats = await fsp.lstat(artifact.path).catch(() => null);
  if (stats === null || !stats.isFile() || stats.isSymbolicLink())
    blocked(`${label} is missing or uses a symlink`);
  if ((await sha256File(artifact.path)) !== artifact.sha256)
    blocked(`${label} digest changed`);
}

function stringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry === "") ||
    new Set(value).size !== value.length
  ) {
    blocked(`${label} must be a unique string array`);
  }
  return value;
}

function assertOnlyKeys(value, allowedKeys, label) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key))
      blocked(`${label} has unknown field: ${key}`);
  }
}

async function validateProofMetadata(proof, taskId) {
  object(proof, `task proof ${taskId}`);
  if (typeof proof.required !== "boolean")
    blocked(`task proof required flag is invalid: ${taskId}`);
  stringArray(proof.claimIds, `${taskId}.claimIds`);
  if (!Array.isArray(proof.completionRefs))
    blocked(`task proof completionRefs are missing: ${taskId}`);
  if (!Array.isArray(proof.artifactRefs))
    blocked(`task proof artifactRefs are missing: ${taskId}`);
  if (
    ![undefined, "NOT_REQUIRED", "REQUIRED"].includes(
      proof.reviewerRequirement,
    ) ||
    ![undefined, "NOT_REQUIRED", "REQUIRED"].includes(proof.ownerRequirement)
  ) {
    blocked(`task proof review requirement is invalid: ${taskId}`);
  }
  for (const reference of proof.completionRefs) {
    object(reference, `${taskId}.completionRefs`);
    if (
      !/^[0-9a-f]{40}$/u.test(reference.commit ?? "") ||
      !["product", "specs"].includes(reference.repository)
    ) {
      blocked(`task completion reference is invalid: ${taskId}`);
    }
  }
  for (const [index, artifact] of proof.artifactRefs.entries()) {
    await validateProofArtifact(artifact, `${taskId}.artifactRefs[${index}]`);
  }
}

function expandProofSourceV2(source, tasks) {
  assertOnlyKeys(
    source,
    ["schemaVersion", "defaults", "proofGroups"],
    "task proof source",
  );
  const defaults = object(source.defaults, "task proof source defaults");
  if (!Array.isArray(source.proofGroups))
    blocked("task proof source proofGroups must be an array");
  const sharedKeys = [
    "required",
    "completionRefs",
    "claimIds",
    "artifactRefs",
    "reviewerRequirement",
    "ownerRequirement",
  ];
  assertOnlyKeys(defaults, sharedKeys, "task proof source defaults");
  const taskIds = new Set(tasks.map((task) => task.taskId));
  const byId = new Map();
  for (const [index, rawGroup] of source.proofGroups.entries()) {
    const group = object(rawGroup, `task proof source proofGroups[${index}]`);
    assertOnlyKeys(
      group,
      ["taskIds", ...sharedKeys],
      `task proof source proofGroups[${index}]`,
    );
    nonEmptyStringArray(
      group.taskIds,
      `task proof source proofGroups[${index}].taskIds`,
    );
    for (const taskId of group.taskIds) {
      if (!taskIds.has(taskId))
        blocked(`unknown task proof group task: ${taskId}`);
      if (byId.has(taskId))
        blocked(`duplicate task proof group coverage: ${taskId}`);
      const { taskIds: ignoredTaskIds, ...metadata } = group;
      void ignoredTaskIds;
      byId.set(taskId, { ...defaults, ...metadata });
    }
  }
  if (byId.size !== tasks.length)
    blocked("task proof groups must exactly match tasks.md");
  return byId;
}

export async function generateTaskProof({
  tasksPath,
  proofSourcePath,
  outputPath,
}) {
  if (
    ![tasksPath, proofSourcePath, outputPath].every(
      (value) => typeof value === "string" && path.isAbsolute(value),
    )
  )
    invalid("task-proof mode requires absolute paths");
  const tasksBytes = await fsp.readFile(tasksPath);
  const tasks = parseTasksMarkdown(tasksBytes.toString("utf8"));
  const source = object(
    await readJson(proofSourcePath, "task proof source"),
    "task proof source",
  );
  let byId;
  if (source.schemaVersion === 1 && Array.isArray(source.records)) {
    byId = new Map();
    for (const record of source.records) {
      object(record, "task proof record");
      if (byId.has(record.taskId))
        blocked(`duplicate task proof record: ${record.taskId}`);
      byId.set(record.taskId, record);
    }
  } else if (source.schemaVersion === 2) {
    byId = expandProofSourceV2(source, tasks);
  } else {
    blocked("task proof source schema is invalid");
  }
  if (
    byId.size !== tasks.length ||
    tasks.some((task) => !byId.has(task.taskId))
  )
    blocked("task proof records must exactly match tasks.md");
  const records = [];
  for (const task of tasks) {
    const proof = byId.get(task.taskId);
    if (
      source.schemaVersion === 1 &&
      proof.checkboxState !== task.checkboxState
    )
      blocked(`task proof checkbox mismatch: ${task.taskId}`);
    await validateProofMetadata(proof, task.taskId);
    records.push({
      taskId: task.taskId,
      required: proof.required,
      checkboxState: task.checkboxState,
      completionRefs: proof.completionRefs,
      claimIds: proof.claimIds,
      artifactRefs: proof.artifactRefs,
      reviewerRequirement: proof.reviewerRequirement,
      ownerRequirement: proof.ownerRequirement,
    });
  }
  const output = {
    schemaVersion: 1,
    tasksFileSha256: sha256(tasksBytes),
    records: records.sort((left, right) =>
      left.taskId.localeCompare(right.taskId),
    ),
  };
  await assertAbsent(outputPath, "task proof output");
  await writeJsonExclusive(outputPath, output);
  return output;
}

function taskLineTransition(markdown, taskId) {
  const pattern = new RegExp(
    `^- \\[ \\] (${taskId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")})(?=\\s|$)`,
    "mu",
  );
  if (!pattern.test(markdown))
    blocked(`closure self task ${taskId} is not the one unchecked task`);
  return markdown.replace(pattern, `- [x] $1`);
}

async function validateFinalReviewAndOwner(records) {
  const reviewerPaths = records
    .flatMap((record) => record.artifactRefs.map((artifact) => artifact.path))
    .filter((filePath) => filePath.endsWith("reviewer-report.json"));
  const ownerPaths = records
    .flatMap((record) => record.artifactRefs.map((artifact) => artifact.path))
    .filter((filePath) => filePath.endsWith("product-owner-decision.json"));
  const finalReviews = [];
  for (const reviewerPath of reviewerPaths) {
    const review = await readJson(reviewerPath, "reviewer report");
    if (
      FINAL_GATES.includes(review.gateId) &&
      review.verdict === "PASS" &&
      review.independenceConfirmed === true &&
      !review.findings?.some((finding) =>
        ["HIGH", "CRITICAL"].includes(finding.severity),
      )
    ) {
      finalReviews.push(review.gateId);
    }
  }
  if (
    JSON.stringify([...new Set(finalReviews)].sort()) !==
    JSON.stringify([...FINAL_GATES].sort())
  )
    failed("closure requires six independent final reviewer PASS reports");
  let ownerApproved = false;
  for (const ownerPath of ownerPaths) {
    const owner = await readJson(ownerPath, "product owner decision");
    if (owner.gateId === "FINAL-003" && owner.status === "APPROVED")
      ownerApproved = true;
  }
  if (!ownerApproved)
    failed("closure requires explicit FINAL-003 product-owner APPROVED");
}

export async function aggregateClosure({
  technicalReportPath,
  taskProofMapPath,
  tasksPath,
  selfTask,
  outputDir,
}) {
  if (
    ![technicalReportPath, taskProofMapPath, tasksPath, outputDir].every(
      (value) => typeof value === "string" && path.isAbsolute(value),
    ) ||
    typeof selfTask !== "string"
  )
    invalid("closure mode requires absolute paths and --self-task");
  await assertAbsent(outputDir, "closure output directory");
  const technical = await readJson(technicalReportPath, "technical report");
  if (technical.result !== "PASS" || technical.staleEvidence?.length !== 0)
    blocked("technical aggregate is not a clean PASS");
  const taskProof = await readJson(taskProofMapPath, "task proof map");
  const tasksBytes = await fsp.readFile(tasksPath);
  const tasksText = tasksBytes.toString("utf8");
  if (taskProof.tasksFileSha256 !== sha256(tasksBytes))
    blocked("task proof map is stale for tasks.md");
  for (const record of taskProof.records) {
    for (const [index, artifact] of record.artifactRefs.entries()) {
      await validateProofArtifact(
        artifact,
        `${record.taskId}.artifactRefs[${index}]`,
      );
    }
  }
  const unsupportedCheckedTasks = taskProof.records
    .filter(
      (record) =>
        record.checkboxState === "checked" &&
        (record.completionRefs.length === 0 ||
          record.claimIds.length === 0 ||
          record.artifactRefs.length === 0),
    )
    .map((record) => record.taskId);
  const uncheckedRequiredTasks = taskProof.records
    .filter(
      (record) =>
        record.required &&
        record.checkboxState === "unchecked" &&
        record.taskId !== selfTask,
    )
    .map((record) => record.taskId);
  const self = taskProof.records.find((record) => record.taskId === selfTask);
  if (!self || self.checkboxState !== "unchecked")
    blocked("closure self task must exist and be unchecked");
  if (unsupportedCheckedTasks.length > 0 || uncheckedRequiredTasks.length > 0)
    failed("task proof map does not support closure");
  await validateFinalReviewAndOwner(taskProof.records);
  const transitioned = taskLineTransition(tasksText, selfTask);
  const report = {
    schemaVersion: 1,
    mode: "closure",
    technicalAggregateDigest: await sha256File(technicalReportPath),
    taskProofMapSha256: await sha256File(taskProofMapPath),
    tasksFileSha256Before: sha256(tasksBytes),
    selfTaskId: selfTask,
    tasksFileSha256AfterExpected: sha256(transitioned),
    unsupportedCheckedTasks,
    uncheckedRequiredTasks,
    staleEvidence: [],
    result: "PASS",
    state: "READY_TO_CLOSE",
  };
  await fsp.mkdir(outputDir);
  await writeJsonExclusive(path.join(outputDir, "task-audit.json"), {
    unsupportedCheckedTasks,
    uncheckedRequiredTasks,
  });
  await writeMarkdownExclusive(
    path.join(outputDir, "task-audit.md"),
    "# Task audit\n\nAll required tasks except the declared self task are proven.\n",
  );
  await writeJsonExclusive(path.join(outputDir, "closure-report.json"), report);
  await writeMarkdownExclusive(
    path.join(outputDir, "closure-report.md"),
    `# Closure report\n\n- Result: **PASS / READY_TO_CLOSE**\n- Self task: \`${selfTask}\`\n`,
  );
  return report;
}

export async function verifyClosure({
  closureReportPath,
  tasksPath,
  outputPath,
}) {
  if (
    ![closureReportPath, tasksPath, outputPath].every(
      (value) => typeof value === "string" && path.isAbsolute(value),
    )
  )
    invalid("closure-verify mode requires absolute paths");
  const closure = await readJson(closureReportPath, "closure report");
  if (closure.result !== "PASS" || closure.state !== "READY_TO_CLOSE")
    blocked("closure report is not ready to verify");
  const observedTasksFileSha256 = await sha256File(tasksPath);
  const result =
    observedTasksFileSha256 === closure.tasksFileSha256AfterExpected
      ? "PASS"
      : "FAIL";
  const verification = {
    schemaVersion: 1,
    closureReportSha256: await sha256File(closureReportPath),
    selfTaskId: closure.selfTaskId,
    observedTasksFileSha256,
    expectedTasksFileSha256: closure.tasksFileSha256AfterExpected,
    onlyPermittedSelfTransition: result === "PASS",
    result,
  };
  await assertAbsent(outputPath, "closure verification output");
  await writeJsonExclusive(outputPath, verification);
  if (result !== "PASS")
    failed("tasks.md does not match the permitted self transition");
  return verification;
}

function usage() {
  console.log(
    "Usage: pnpm evidence:aggregate -- --mode delta|technical|task-proof|closure|closure-verify <mode options>\nModes:\n  delta --product-root PATH --checkpoint-map JSON --final-commit SHA --ownership-map JSON --output JSON\n    checkpoint map schema v1: absolute sourceReportPath plus sourceCollectionDigest, fromCommit, and claimId per checkpoint\n  technical --input JSON --output-dir NEW_DIR\n  task-proof --tasks TASKS --proof-source JSON --output JSON\n    proof source schema v2 is preferred: defaults plus proofGroups; checkbox state is derived from tasks.md\n  closure --technical-report JSON --task-proof-map JSON --tasks TASKS --self-task ID --output-dir NEW_DIR\n  closure-verify --closure-report JSON --tasks TASKS --output JSON\nExit codes: 0=PASS, 1=FAIL, 2=BLOCKED, 64=invalid invocation. All modes are read-only for source evidence and tasks.md.",
  );
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("help")) return usage();
  const mode = option(args, "--mode");
  try {
    if (mode === "delta") {
      await aggregateDelta({
        productRoot: option(args, "--product-root"),
        checkpointMapPath: option(args, "--checkpoint-map"),
        finalCommit: option(args, "--final-commit"),
        ownershipMapPath: option(args, "--ownership-map"),
        outputPath: option(args, "--output"),
      });
    } else if (mode === "technical") {
      await aggregateTechnical({
        inputPath: option(args, "--input"),
        outputDir: option(args, "--output-dir"),
      });
    } else if (mode === "task-proof") {
      await generateTaskProof({
        tasksPath: option(args, "--tasks"),
        proofSourcePath: option(args, "--proof-source"),
        outputPath: option(args, "--output"),
      });
    } else if (mode === "closure") {
      await aggregateClosure({
        technicalReportPath: option(args, "--technical-report"),
        taskProofMapPath: option(args, "--task-proof-map"),
        tasksPath: option(args, "--tasks"),
        selfTask: option(args, "--self-task"),
        outputDir: option(args, "--output-dir"),
      });
    } else if (mode === "closure-verify") {
      await verifyClosure({
        closureReportPath: option(args, "--closure-report"),
        tasksPath: option(args, "--tasks"),
        outputPath: option(args, "--output"),
      });
    } else {
      invalid("--mode is required");
    }
    console.log(JSON.stringify({ mode, result: "PASS" }));
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exitCode =
      error instanceof EvidenceAggregateError ? error.exitCode : 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH)
  await main();
