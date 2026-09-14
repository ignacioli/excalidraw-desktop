import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  EvidenceAggregateError,
  aggregateClosure,
  aggregateDelta,
  aggregateTechnical,
  classifyDeltaPaths,
  generateTaskProof,
  parseTasksMarkdown,
  verifyClosure,
} from "./evidence-aggregate.mjs";

const roots = [];
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

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fsp.rm(root, { recursive: true, force: true })),
  );
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function temporaryRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "evidence-aggregate-"));
  roots.push(root);
  return root;
}

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function commit(root, message) {
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Evidence Test",
    "-c",
    "user.email=evidence@example.invalid",
    "commit",
    "-m",
    message,
  );
  return git(root, "rev-parse", "HEAD");
}

async function deltaRepository(root) {
  const productRoot = path.join(root, "product");
  await fsp.mkdir(path.join(productRoot, "src"), { recursive: true });
  await fsp.mkdir(path.join(productRoot, "docs"), { recursive: true });
  git(productRoot, "init");
  await fsp.writeFile(path.join(productRoot, "src", "shell.ts"), "base\n");
  await fsp.writeFile(
    path.join(productRoot, "docs", "quickstart.md"),
    "base\n",
  );
  const base = await commit(productRoot, "base");

  git(productRoot, "switch", "-c", "source-shell");
  await fsp.writeFile(
    path.join(productRoot, "docs", "quickstart.md"),
    "final\n",
  );
  const sourceForShell = await commit(productRoot, "source with final docs");

  git(productRoot, "switch", "-c", "final", base);
  await fsp.writeFile(path.join(productRoot, "src", "shell.ts"), "final\n");
  const sourceForDocs = await commit(productRoot, "source with final shell");
  await fsp.writeFile(
    path.join(productRoot, "docs", "quickstart.md"),
    "final\n",
  );
  const finalCommit = await commit(productRoot, "final");
  return { productRoot, sourceForShell, sourceForDocs, finalCommit };
}

function ownershipMap() {
  return {
    schemaVersion: 1,
    version: "test-v2",
    commandCatalog: {
      lint: "pnpm lint",
      typecheck: "pnpm typecheck",
      unit: "pnpm test",
    },
    claimCommands: {
      "final-regression": ["unit", "lint"],
      "shell-semantic": ["typecheck", "unit"],
    },
    rules: [
      {
        id: "shell",
        pathPrefixes: ["src/"],
        owners: ["shell"],
        claimIds: ["shell-semantic"],
      },
      {
        id: "docs",
        pathPrefixes: ["docs/"],
        owners: ["docs"],
        claimIds: ["final-regression"],
      },
    ],
  };
}

async function deltaFixture(root, checkpointClaims) {
  const repository = await deltaRepository(root);
  const inputRoot = path.join(root, "inputs");
  const ownershipMapPath = path.join(inputRoot, "ownership.json");
  await writeJson(ownershipMapPath, ownershipMap());
  const commits = {
    sourceForShell: repository.sourceForShell,
    sourceForDocs: repository.sourceForDocs,
  };
  const checkpoints = [];
  for (const [index, { claimId, from }] of checkpointClaims.entries()) {
    const fromCommit = commits[from];
    const source = await collector(inputRoot, `checkpoint-${index}`, {
      productCommit: fromCommit,
    });
    checkpoints.push({
      claimId,
      fromCommit,
      sourceReportPath: source.reportPath,
      sourceCollectionDigest: source.collectionDigest,
    });
  }
  const checkpointMapPath = path.join(inputRoot, "checkpoints.json");
  await writeJson(checkpointMapPath, { schemaVersion: 1, checkpoints });
  return {
    ...repository,
    checkpointMapPath,
    checkpoints,
    ownershipMapPath,
  };
}

async function collector(root, gateId, binding, artifactLabel = gateId) {
  const directory = path.join(root, "collections", gateId);
  await fsp.mkdir(directory, { recursive: true });
  const artifactPath = path.join(directory, "evidence.json");
  await fsp.writeFile(artifactPath, `${artifactLabel}\n`, "utf8");
  const artifacts = [
    { path: "evidence.json", sha256: sha256(`${artifactLabel}\n`) },
  ];
  const collectionDigest = sha256(`evidence.json\0${artifacts[0].sha256}`);
  const reportPath = path.join(directory, "collector-report.json");
  await writeJson(reportPath, {
    schemaVersion: 1,
    collectionId: `${gateId}-collection`,
    gateId,
    route: "semantic-browser",
    binding,
    claims: [],
    artifactDigests: artifacts,
    collectionDigest,
    result: "PASS",
  });
  return { gateId, reportPath, collectionDigest, artifactPath };
}

describe("evidence aggregation", () => {
  it("exposes every mode and fixed invalid-invocation semantics", () => {
    const help = spawnSync(
      process.execPath,
      ["scripts/evidence-aggregate.mjs", "--help"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(help.status, 0);
    for (const mode of [
      "delta",
      "technical",
      "task-proof",
      "closure",
      "closure-verify",
    ]) {
      assert.match(help.stdout, new RegExp(mode, "u"));
    }
    const invalidRun = spawnSync(
      process.execPath,
      ["scripts/evidence-aggregate.mjs"],
      {
        encoding: "utf8",
      },
    );
    assert.equal(invalidRun.status, 64);
  });

  it("parses unique tasks and rejects duplicate ids", () => {
    assert.deepEqual(parseTasksMarkdown("- [x] T001 done\n- [ ] T002 next\n"), [
      { taskId: "T001", checkboxState: "checked" },
      { taskId: "T002", checkboxState: "unchecked" },
    ]);
    assert.throws(
      () => parseTasksMarkdown("- [x] T001 a\n- [ ] T001 b\n"),
      /duplicate task id/u,
    );
  });

  it("classifies every delta path exactly once and blocks gaps/overlaps", () => {
    const map = {
      schemaVersion: 1,
      version: "v1",
      commandCatalog: { shell: "pnpm typecheck" },
      claimCommands: { shell: ["shell"], native: ["shell"] },
      rules: [
        {
          id: "frontend",
          pathPrefixes: ["src/"],
          owners: ["shell"],
          claimIds: ["shell"],
        },
        {
          id: "native",
          pathPrefixes: ["src-tauri/"],
          owners: ["native"],
          claimIds: ["native"],
        },
      ],
    };
    assert.deepEqual(classifyDeltaPaths(["src/App.css"], map)[0], {
      path: "src/App.css",
      ownershipRule: "frontend",
      owners: ["shell"],
      claimIds: ["shell"],
      action: "RERUN",
    });
    assert.throws(() => classifyDeltaPaths(["README.md"], map), /exactly one/u);
    assert.throws(
      () =>
        classifyDeltaPaths(["src/App.css"], {
          ...map,
          rules: [...map.rules, { ...map.rules[0], id: "duplicate" }],
        }),
      /exactly one/u,
    );
  });

  it("maps every ownership claim to the bounded final regression command set", async () => {
    const map = JSON.parse(
      await fsp.readFile(
        new URL("../e2e/visual/003EvidenceOwnership.json", import.meta.url),
        "utf8",
      ),
    );
    const expectedCommandIds = [
      "cargo-clippy",
      "cargo-fmt",
      "cargo-test",
      "focused-a11y-welcome-overlay",
      "focused-routing-browser",
      "focused-sidebar-browser",
      "focused-visual-browser",
      "lint",
      "node-validation-harness",
      "typecheck",
      "vitest",
    ];
    assert.equal(map.version, "003-ownership-v2");
    assert.deepEqual(
      Object.keys(map.commandCatalog).sort(),
      expectedCommandIds,
    );
    assert.deepEqual(
      [...map.claimCommands["final-regression"]].sort(),
      expectedCommandIds,
    );
    for (const claimId of new Set(map.rules.flatMap((rule) => rule.claimIds))) {
      assert.ok(map.claimCommands[claimId], `missing commands for ${claimId}`);
    }
    for (const command of Object.values(map.commandCatalog)) {
      assert.doesNotMatch(command, /pnpm e2e --(?:\s|$)/u);
    }
    for (const commandId of expectedCommandIds.filter((id) =>
      id.startsWith("focused-"),
    )) {
      assert.match(map.commandCatalog[commandId], /--workers=1/u);
      assert.match(map.commandCatalog[commandId], /--retries=0/u);
    }
    assert.match(
      map.commandCatalog["focused-visual-browser"],
      /SHELL_EVIDENCE_RUN_ROOT=\$T059_BROWSER_RUN_ROOT/u,
    );
  });

  it("blocks stale checkpoint report, artifact, and source commit bindings", async () => {
    const root = await temporaryRoot();
    const fixture = await deltaFixture(root, [
      { claimId: "shell-semantic", from: "sourceForShell" },
    ]);
    const checkpointMap = JSON.parse(
      await fsp.readFile(fixture.checkpointMapPath, "utf8"),
    );
    checkpointMap.checkpoints[0].sourceCollectionDigest = "00".repeat(32);
    const staleDigestPath = path.join(root, "stale-digest.json");
    await writeJson(staleDigestPath, checkpointMap);
    await assert.rejects(
      aggregateDelta({
        productRoot: fixture.productRoot,
        checkpointMapPath: staleDigestPath,
        finalCommit: fixture.finalCommit,
        ownershipMapPath: fixture.ownershipMapPath,
        outputPath: path.join(root, "stale-digest-output.json"),
      }),
      (error) =>
        error instanceof EvidenceAggregateError &&
        error.exitCode === 2 &&
        /collector report binding is invalid/u.test(error.message),
    );

    checkpointMap.checkpoints[0].sourceCollectionDigest =
      fixture.checkpoints[0].sourceCollectionDigest;
    const artifactPath = path.join(
      path.dirname(checkpointMap.checkpoints[0].sourceReportPath),
      "evidence.json",
    );
    await fsp.appendFile(artifactPath, "stale");
    const staleArtifactPath = path.join(root, "stale-artifact.json");
    await writeJson(staleArtifactPath, checkpointMap);
    await assert.rejects(
      aggregateDelta({
        productRoot: fixture.productRoot,
        checkpointMapPath: staleArtifactPath,
        finalCommit: fixture.finalCommit,
        ownershipMapPath: fixture.ownershipMapPath,
        outputPath: path.join(root, "stale-artifact-output.json"),
      }),
      /collector artifact digest changed/u,
    );
    await fsp.writeFile(artifactPath, "checkpoint-0\n");

    const report = JSON.parse(
      await fsp.readFile(checkpointMap.checkpoints[0].sourceReportPath, "utf8"),
    );
    report.binding.productCommit = fixture.sourceForDocs;
    await writeJson(checkpointMap.checkpoints[0].sourceReportPath, report);
    const wrongBindingPath = path.join(root, "wrong-binding.json");
    await writeJson(wrongBindingPath, checkpointMap);
    await assert.rejects(
      aggregateDelta({
        productRoot: fixture.productRoot,
        checkpointMapPath: wrongBindingPath,
        finalCommit: fixture.finalCommit,
        ownershipMapPath: fixture.ownershipMapPath,
        outputPath: path.join(root, "wrong-binding-output.json"),
      }),
      (error) =>
        error instanceof EvidenceAggregateError &&
        error.exitCode === 2 &&
        /source commit binding is stale/u.test(error.message),
    );
  });

  it("keeps disjoint checkpoint deltas from contaminating each other's rerun result", async () => {
    const root = await temporaryRoot();
    const fixture = await deltaFixture(root, [
      { claimId: "shell-semantic", from: "sourceForDocs" },
      { claimId: "final-regression", from: "sourceForShell" },
    ]);
    const report = await aggregateDelta({
      productRoot: fixture.productRoot,
      checkpointMapPath: fixture.checkpointMapPath,
      finalCommit: fixture.finalCommit,
      ownershipMapPath: fixture.ownershipMapPath,
      outputPath: path.join(root, "delta.json"),
    });
    assert.deepEqual(
      report.reuse.map(({ claimId, changedOwningPaths, result }) => ({
        claimId,
        changedOwningPaths,
        result,
      })),
      [
        { claimId: "shell-semantic", changedOwningPaths: [], result: "REUSE" },
        {
          claimId: "final-regression",
          changedOwningPaths: [],
          result: "REUSE",
        },
      ],
    );
    assert.deepEqual(report.rerunCommands, []);
  });

  it("blocks unknown claim command mappings and emits sorted deterministic rerun commands", async () => {
    const root = await temporaryRoot();
    const fixture = await deltaFixture(root, [
      { claimId: "shell-semantic", from: "sourceForShell" },
      { claimId: "final-regression", from: "sourceForDocs" },
    ]);
    const map = JSON.parse(
      await fsp.readFile(fixture.ownershipMapPath, "utf8"),
    );
    delete map.claimCommands["shell-semantic"];
    const unknownMapPath = path.join(root, "unknown-command-map.json");
    await writeJson(unknownMapPath, map);
    await assert.rejects(
      aggregateDelta({
        productRoot: fixture.productRoot,
        checkpointMapPath: fixture.checkpointMapPath,
        finalCommit: fixture.finalCommit,
        ownershipMapPath: unknownMapPath,
        outputPath: path.join(root, "unknown-command-output.json"),
      }),
      /command mapping/u,
    );

    const first = await aggregateDelta({
      productRoot: fixture.productRoot,
      checkpointMapPath: fixture.checkpointMapPath,
      finalCommit: fixture.finalCommit,
      ownershipMapPath: fixture.ownershipMapPath,
      outputPath: path.join(root, "delta-first.json"),
    });
    const second = await aggregateDelta({
      productRoot: fixture.productRoot,
      checkpointMapPath: fixture.checkpointMapPath,
      finalCommit: fixture.finalCommit,
      ownershipMapPath: fixture.ownershipMapPath,
      outputPath: path.join(root, "delta-second.json"),
    });
    assert.deepEqual(first.rerunCommands, [
      { id: "lint", command: "pnpm lint" },
      { id: "typecheck", command: "pnpm typecheck" },
      { id: "unit", command: "pnpm test" },
    ]);
    assert.deepEqual(second, first);
  });

  it("validates seven browser claims, six final screens, and every transitive artifact digest", async () => {
    const root = await temporaryRoot();
    const finalCommit = "ab".repeat(20);
    const hf2Path = path.join(root, "hf2.json");
    const packagePath = path.join(root, "package.json");
    const deltaPath = path.join(root, "delta.json");
    await fsp.writeFile(hf2Path, "hf2\n");
    await fsp.writeFile(packagePath, "package\n");
    await fsp.writeFile(deltaPath, "delta\n");
    const binding = {
      productCommit: finalCommit,
      hf2ManifestSha256: sha256("hf2\n"),
      fixtureDigest: "cd".repeat(32),
      harnessVersion: "v1",
      packageArtifactSha256: "ef".repeat(32),
    };
    const screens = [];
    for (const gateId of FINAL_GATES)
      screens.push(await collector(root, gateId, binding));
    const browserBinding = { ...binding };
    delete browserBinding.packageArtifactSha256;
    const browserClaims = [];
    for (const claimSet of FINAL_BROWSER_CLAIMS) {
      const gateId = claimSet.startsWith("HF2-06-") ? "HF2-06" : claimSet;
      const collection = await collector(
        path.join(root, "browser", claimSet),
        gateId,
        browserBinding,
        claimSet,
      );
      browserClaims.push({ ...collection, claimSet });
    }
    const support = await collector(root, "T024", binding);
    const inputPath = path.join(root, "technical-input.json");
    await writeJson(inputPath, {
      schemaVersion: 1,
      finalCommit,
      hf2Manifest: { path: hf2Path, sha256: sha256("hf2\n") },
      finalPackageManifest: {
        path: packagePath,
        sha256: sha256("package\n"),
        artifactSha256: binding.packageArtifactSha256,
      },
      finalBrowserClaimCollections: browserClaims.map(
        ({ claimSet, reportPath, collectionDigest }) => ({
          claimSet,
          reportPath,
          collectionDigest,
          disposition: "RERUN",
        }),
      ),
      finalScreenCollections: screens.map(
        ({ gateId, reportPath, collectionDigest }) => ({
          gateId,
          reportPath,
          collectionDigest,
        }),
      ),
      packageCollections: ["T060-identity", "T023b-native-entrypoint"].map(
        (claimSet) => ({
          claimSet,
          reportPath: support.reportPath,
          collectionDigest: support.collectionDigest,
        }),
      ),
      regressionCollections: ["T023a", "T024", "final-regression"].map(
        (claimSet) => ({
          claimSet,
          reportPath: support.reportPath,
          collectionDigest: support.collectionDigest,
        }),
      ),
      delta: { path: deltaPath, sha256: sha256("delta\n") },
    });
    const outputDir = path.join(root, "technical");
    const report = await aggregateTechnical({ inputPath, outputDir });
    assert.equal(report.result, "PASS");
    assert.equal(report.browserClaimVerdicts.length, 7);
    assert.equal(report.screenCollectionVerdicts.length, 6);
    const validInput = JSON.parse(await fsp.readFile(inputPath, "utf8"));
    const wrongCommitBrowser = await collector(
      path.join(root, "wrong-commit"),
      "VSL-001",
      { ...browserBinding, productCommit: "12".repeat(20) },
    );
    const invalidInputs = [
      {
        name: "missing-browser-claim",
        value: {
          ...validInput,
          finalBrowserClaimCollections:
            validInput.finalBrowserClaimCollections.slice(1),
        },
      },
      {
        name: "duplicate-browser-claim",
        value: {
          ...validInput,
          finalBrowserClaimCollections: [
            ...validInput.finalBrowserClaimCollections.slice(0, -1),
            validInput.finalBrowserClaimCollections[0],
          ],
        },
      },
      {
        name: "invalid-browser-disposition",
        value: {
          ...validInput,
          finalBrowserClaimCollections:
            validInput.finalBrowserClaimCollections.map((entry, index) =>
              index === 0 ? { ...entry, disposition: "PENDING" } : entry,
            ),
        },
      },
      {
        name: "wrong-browser-commit",
        value: {
          ...validInput,
          finalBrowserClaimCollections:
            validInput.finalBrowserClaimCollections.map((entry, index) =>
              index === 0
                ? {
                    ...entry,
                    reportPath: wrongCommitBrowser.reportPath,
                    collectionDigest: wrongCommitBrowser.collectionDigest,
                  }
                : entry,
            ),
        },
      },
      {
        name: "reviewer-input-forbidden",
        value: { ...validInput, reviewerReports: [] },
      },
      {
        name: "owner-input-forbidden",
        value: { ...validInput, ownerDecision: {} },
      },
      {
        name: "missing-screen",
        value: {
          ...validInput,
          finalScreenCollections: validInput.finalScreenCollections.slice(1),
        },
      },
      {
        name: "duplicate-screen",
        value: {
          ...validInput,
          finalScreenCollections: [
            ...validInput.finalScreenCollections.slice(0, -1),
            validInput.finalScreenCollections[0],
          ],
        },
      },
      {
        name: "package-mismatch",
        value: {
          ...validInput,
          finalPackageManifest: {
            ...validInput.finalPackageManifest,
            artifactSha256: "34".repeat(32),
          },
        },
      },
      {
        name: "missing-claim-set",
        value: {
          ...validInput,
          regressionCollections: validInput.regressionCollections.slice(1),
        },
      },
    ];
    for (const invalidInput of invalidInputs) {
      const invalidPath = path.join(root, `${invalidInput.name}.json`);
      await writeJson(invalidPath, invalidInput.value);
      await assert.rejects(
        aggregateTechnical({
          inputPath: invalidPath,
          outputDir: path.join(root, `${invalidInput.name}-output`),
        }),
        EvidenceAggregateError,
      );
    }
    const browserArtifact = await fsp.readFile(
      browserClaims[0].artifactPath,
      "utf8",
    );
    await fsp.appendFile(browserClaims[0].artifactPath, "changed");
    await assert.rejects(
      aggregateTechnical({
        inputPath,
        outputDir: path.join(root, "stale-browser"),
      }),
      (error) =>
        error instanceof EvidenceAggregateError && error.exitCode === 2,
    );
    await fsp.writeFile(browserClaims[0].artifactPath, browserArtifact, "utf8");
    const sourceHash = await fsp.readFile(support.artifactPath, "utf8");
    assert.equal(sourceHash, "T024\n");
    await fsp.appendFile(support.artifactPath, "changed");
    await assert.rejects(
      aggregateTechnical({ inputPath, outputDir: path.join(root, "stale") }),
      (error) =>
        error instanceof EvidenceAggregateError && error.exitCode === 2,
    );
  });

  it("generates canonical task proof without mutating tasks or source evidence", async () => {
    const root = await temporaryRoot();
    const tasksPath = path.join(root, "tasks.md");
    const artifactPath = path.join(root, "proof.json");
    const proofSourcePath = path.join(root, "proof-source.json");
    const outputPath = path.join(root, "task-proof-map.json");
    const tasks = "- [x] T001 done\n- [ ] T066 closure\n";
    await fsp.writeFile(tasksPath, tasks);
    await fsp.writeFile(artifactPath, "proof\n");
    await writeJson(proofSourcePath, {
      schemaVersion: 1,
      records: [
        {
          taskId: "T001",
          required: true,
          checkboxState: "checked",
          completionRefs: [{ repository: "product", commit: "ab".repeat(20) }],
          claimIds: ["approved"],
          artifactRefs: [{ path: artifactPath, sha256: sha256("proof\n") }],
          reviewerRequirement: "NOT_REQUIRED",
          ownerRequirement: "NOT_REQUIRED",
        },
        {
          taskId: "T066",
          required: true,
          checkboxState: "unchecked",
          completionRefs: [],
          claimIds: [],
          artifactRefs: [],
          reviewerRequirement: "NOT_REQUIRED",
          ownerRequirement: "NOT_REQUIRED",
        },
      ],
    });
    const tasksBefore = await fsp.readFile(tasksPath);
    const artifactBefore = await fsp.readFile(artifactPath);
    const map = await generateTaskProof({
      tasksPath,
      proofSourcePath,
      outputPath,
    });
    assert.equal(map.records.length, 2);
    assert.deepEqual(await fsp.readFile(tasksPath), tasksBefore);
    assert.deepEqual(await fsp.readFile(artifactPath), artifactBefore);
    const secondOutput = path.join(root, "task-proof-map-second.json");
    await generateTaskProof({
      tasksPath,
      proofSourcePath,
      outputPath: secondOutput,
    });
    assert.equal(
      await fsp.readFile(outputPath, "utf8"),
      await fsp.readFile(secondOutput, "utf8"),
    );
    const symlinkPath = path.join(root, "proof-link.json");
    await fsp.symlink(artifactPath, symlinkPath);
    const source = JSON.parse(await fsp.readFile(proofSourcePath, "utf8"));
    source.records[0].artifactRefs[0].path = symlinkPath;
    await writeJson(path.join(root, "symlink-source.json"), source);
    await assert.rejects(
      generateTaskProof({
        tasksPath,
        proofSourcePath: path.join(root, "symlink-source.json"),
        outputPath: path.join(root, "symlink-map.json"),
      }),
      /symlink/u,
    );
  });

  it("expands v2 proof groups with derived checkbox state without mutating inputs", async () => {
    const root = await temporaryRoot();
    const tasksPath = path.join(root, "tasks.md");
    const artifactPath = path.join(root, "proof.json");
    const proofSourcePath = path.join(root, "proof-source-v2.json");
    const outputPath = path.join(root, "task-proof-map-v2.json");
    await fsp.writeFile(tasksPath, "- [x] T001 done\n- [ ] T066 closure\n");
    await fsp.writeFile(artifactPath, "proof\n");
    await writeJson(proofSourcePath, {
      schemaVersion: 2,
      defaults: {
        required: true,
        reviewerRequirement: "NOT_REQUIRED",
        ownerRequirement: "NOT_REQUIRED",
      },
      proofGroups: [
        {
          taskIds: ["T001"],
          completionRefs: [{ repository: "product", commit: "ab".repeat(20) }],
          claimIds: ["approved"],
          artifactRefs: [{ path: artifactPath, sha256: sha256("proof\n") }],
        },
        {
          taskIds: ["T066"],
          completionRefs: [],
          claimIds: [],
          artifactRefs: [],
        },
      ],
    });
    const tasksBefore = await fsp.readFile(tasksPath);
    const sourceBefore = await fsp.readFile(proofSourcePath);
    const map = await generateTaskProof({
      tasksPath,
      proofSourcePath,
      outputPath,
    });
    assert.deepEqual(
      map.records.map(({ taskId, checkboxState }) => ({
        taskId,
        checkboxState,
      })),
      [
        { taskId: "T001", checkboxState: "checked" },
        { taskId: "T066", checkboxState: "unchecked" },
      ],
    );
    assert.deepEqual(await fsp.readFile(tasksPath), tasksBefore);
    assert.deepEqual(await fsp.readFile(proofSourcePath), sourceBefore);
  });

  it("blocks duplicate and missing task coverage in v2 proof groups", async () => {
    const root = await temporaryRoot();
    const tasksPath = path.join(root, "tasks.md");
    await fsp.writeFile(tasksPath, "- [x] T001 done\n- [ ] T066 closure\n");
    const defaults = {
      required: true,
      completionRefs: [],
      claimIds: [],
      artifactRefs: [],
      reviewerRequirement: "NOT_REQUIRED",
      ownerRequirement: "NOT_REQUIRED",
    };
    for (const [name, proofGroups, pattern] of [
      [
        "duplicate",
        [{ taskIds: ["T001", "T066"] }, { taskIds: ["T001"] }],
        /duplicate task proof group coverage/u,
      ],
      ["missing", [{ taskIds: ["T001"] }], /exactly match tasks\.md/u],
      [
        "unknown",
        [{ taskIds: ["T001", "T066", "T999"] }],
        /unknown task proof group task/u,
      ],
    ]) {
      const sourcePath = path.join(root, `${name}.json`);
      await writeJson(sourcePath, { schemaVersion: 2, defaults, proofGroups });
      await assert.rejects(
        generateTaskProof({
          tasksPath,
          proofSourcePath: sourcePath,
          outputPath: path.join(root, `${name}-output.json`),
        }),
        pattern,
      );
    }
  });

  it("allows only the declared closure self-task transition", async () => {
    const root = await temporaryRoot();
    const tasksPath = path.join(root, "tasks.md");
    const tasksBefore = "- [x] T001 complete\n- [ ] T066 closure\n";
    await fsp.writeFile(tasksPath, tasksBefore);
    const artifacts = [];
    for (const gateId of FINAL_GATES) {
      const reviewerPath = path.join(
        root,
        "review",
        gateId,
        "reviewer-report.json",
      );
      await writeJson(reviewerPath, {
        schemaVersion: 1,
        gateId,
        independenceConfirmed: true,
        findings: [],
        verdict: "PASS",
      });
      artifacts.push({
        path: reviewerPath,
        sha256: await sha256FileForTest(reviewerPath),
      });
    }
    const ownerPath = path.join(root, "owner", "product-owner-decision.json");
    await writeJson(ownerPath, {
      schemaVersion: 1,
      gateId: "FINAL-003",
      status: "APPROVED",
    });
    artifacts.push({
      path: ownerPath,
      sha256: await sha256FileForTest(ownerPath),
    });
    const taskProofMapPath = path.join(root, "task-proof-map.json");
    await writeJson(taskProofMapPath, {
      schemaVersion: 1,
      tasksFileSha256: sha256(tasksBefore),
      records: [
        {
          taskId: "T001",
          required: true,
          checkboxState: "checked",
          completionRefs: [{ repository: "product", commit: "ab".repeat(20) }],
          claimIds: ["final"],
          artifactRefs: artifacts,
        },
        {
          taskId: "T066",
          required: true,
          checkboxState: "unchecked",
          completionRefs: [],
          claimIds: [],
          artifactRefs: [],
        },
      ],
    });
    const technicalReportPath = path.join(root, "technical-report.json");
    await writeJson(technicalReportPath, { result: "PASS", staleEvidence: [] });
    const closureDir = path.join(root, "closure");
    const closure = await aggregateClosure({
      technicalReportPath,
      taskProofMapPath,
      tasksPath,
      selfTask: "T066",
      outputDir: closureDir,
    });
    assert.equal(closure.state, "READY_TO_CLOSE");
    assert.equal(await fsp.readFile(tasksPath, "utf8"), tasksBefore);
    await fsp.appendFile(artifacts[0].path, "stale");
    await assert.rejects(
      aggregateClosure({
        technicalReportPath,
        taskProofMapPath,
        tasksPath,
        selfTask: "T066",
        outputDir: path.join(root, "stale-closure"),
      }),
      EvidenceAggregateError,
    );
    await fsp.writeFile(
      artifacts[0].path,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          gateId: FINAL_GATES[0],
          independenceConfirmed: true,
          findings: [],
          verdict: "PASS",
        },
        null,
        2,
      )}\n`,
    );
    const unsupportedMapPath = path.join(root, "unsupported-map.json");
    const unsupportedMap = JSON.parse(
      await fsp.readFile(taskProofMapPath, "utf8"),
    );
    unsupportedMap.records[0].completionRefs = [];
    await writeJson(unsupportedMapPath, unsupportedMap);
    await assert.rejects(
      aggregateClosure({
        technicalReportPath,
        taskProofMapPath: unsupportedMapPath,
        tasksPath,
        selfTask: "T066",
        outputDir: path.join(root, "unsupported-closure"),
      }),
      (error) =>
        error instanceof EvidenceAggregateError && error.exitCode === 1,
    );
    await fsp.writeFile(tasksPath, "- [x] T001 complete\n- [x] T066 closure\n");
    const verification = await verifyClosure({
      closureReportPath: path.join(closureDir, "closure-report.json"),
      tasksPath,
      outputPath: path.join(closureDir, "closure-verification.json"),
    });
    assert.equal(verification.onlyPermittedSelfTransition, true);
  });
});

async function sha256FileForTest(filePath) {
  return sha256(await fsp.readFile(filePath));
}
