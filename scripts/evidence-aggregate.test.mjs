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

async function collector(root, gateId, binding) {
  const directory = path.join(root, "collections", gateId);
  await fsp.mkdir(directory, { recursive: true });
  const artifactPath = path.join(directory, "evidence.json");
  await fsp.writeFile(artifactPath, `${gateId}\n`, "utf8");
  const artifacts = [{ path: "evidence.json", sha256: sha256(`${gateId}\n`) }];
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

  it("validates six technical collections and every transitive artifact digest", async () => {
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
    assert.equal(report.screenCollectionVerdicts.length, 6);
    const validInput = JSON.parse(await fsp.readFile(inputPath, "utf8"));
    const invalidInputs = [
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
