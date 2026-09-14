import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  EvidencePublishError,
  digestArtifactList,
  digestTree,
  publishEvidence,
  sha256File,
} from "./publish-evidence.mjs";

const roots = [];
const SHA = "ab".repeat(32);
const COMMIT = "cd".repeat(20);
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
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "evidence-publish-"));
  roots.push(root);
  const source = path.join(root, "run", "VSL-001");
  const collection = path.join(source, "collection", "browser");
  const destinationRoot = path.join(root, "tracked");
  const destination = path.join(destinationRoot, "commit", "VSL-001");
  const binding = {
    productCommit: COMMIT,
    hf2ManifestSha256: SHA,
    fixtureDigest: "ef".repeat(32),
    harnessVersion: "fixture-v1",
    packageArtifactSha256: "12".repeat(32),
  };
  const environment = {
    schemaVersion: 1,
    collectionId: "browser",
    gateId: "VSL-001",
    route: "semantic-browser",
    binding,
  };
  const mask = {
    schemaVersion: 1,
    collectionId: "browser",
    gateId: "VSL-001",
    binding,
    masks: [],
  };
  await writeJson(path.join(collection, "environment.json"), environment);
  await writeJson(path.join(collection, "mask.json"), mask);
  const artifactDigests = [];
  for (const relative of ["environment.json", "mask.json"]) {
    artifactDigests.push({
      path: relative,
      sha256: await sha256File(path.join(collection, relative)),
    });
  }
  const report = {
    schemaVersion: 1,
    collectionId: "browser",
    gateId: "VSL-001",
    route: "semantic-browser",
    binding,
    collector: { tool: "fixture", version: "1", runIdentity: "fixture-run" },
    environmentPath: "environment.json",
    maskPath: "mask.json",
    claims: [],
    artifactDigests,
    collectionDigest: digestArtifactList(artifactDigests),
    result: "PASS",
  };
  await writeJson(path.join(collection, "collector-report.json"), report);
  await writeJson(path.join(source, "review", "reviewer-report.json"), {
    schemaVersion: 1,
    gateId: "VSL-001",
    reviewerIdentity: "independent-reviewer-run",
    reviewedCollections: [
      { collectionId: "browser", collectionDigest: report.collectionDigest },
    ],
    verdict: "PASS",
  });
  await fs.writeFile(
    path.join(source, "review", "reviewer-report.md"),
    "# Independent review\n\nPASS\n",
  );
  await writeJson(path.join(source, "owner", "product-owner-decision.json"), {
    schemaVersion: 1,
    gateId: "VSL-001",
    status: "APPROVED",
  });
  await fs.writeFile(
    path.join(source, "owner", "product-owner-decision.md"),
    "# Product owner\n\nAPPROVED\n",
  );
  return { root, source, collection, destinationRoot, destination, report };
}

async function addCollection({ source, collectionId, gateId, route, binding }) {
  const collection = path.join(source, "collection", collectionId);
  const environment = {
    schemaVersion: 1,
    collectionId,
    gateId,
    route,
    binding,
  };
  await writeJson(path.join(collection, "environment.json"), environment);
  const artifactDigests = [
    {
      path: "environment.json",
      sha256: await sha256File(path.join(collection, "environment.json")),
    },
  ];
  const report = {
    schemaVersion: 1,
    collectionId,
    gateId,
    route,
    binding,
    collector: { tool: "fixture", version: "1", runIdentity: collectionId },
    environmentPath: "environment.json",
    claims: [],
    artifactDigests,
    collectionDigest: digestArtifactList(artifactDigests),
    result: "PASS",
  };
  const reportPath = path.join(collection, "collector-report.json");
  await writeJson(reportPath, report);
  return { collectionId, gateId, report, reportPath };
}

async function finalFixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "evidence-publish-final-"),
  );
  roots.push(root);
  const source = path.join(root, "run", "FINAL-003");
  const destinationRoot = path.join(root, "tracked");
  const destination = path.join(destinationRoot, COMMIT, "FINAL-003");
  const inputs = path.join(root, "inputs");
  const hf2ManifestPath = path.join(inputs, "hf2-manifest.json");
  const packageManifestPath = path.join(inputs, "package-manifest.json");
  const deltaPath = path.join(inputs, "delta.json");
  await writeJson(hf2ManifestPath, { revision: 59 });
  await writeJson(packageManifestPath, { artifactSha256: SHA });
  await writeJson(deltaPath, { result: "PASS" });
  const hf2ManifestSha256 = await sha256File(hf2ManifestPath);
  const binding = {
    productCommit: COMMIT,
    hf2ManifestSha256,
    fixtureDigest: "ef".repeat(32),
    harnessVersion: "fixture-v1",
    packageArtifactSha256: SHA,
  };

  const visualCollections = [];
  for (const gateId of FINAL_GATES) {
    visualCollections.push(
      await addCollection({
        source,
        collectionId: `${gateId}-final-native-capture`,
        gateId,
        route: "native-screen-capture",
        binding,
      }),
    );
  }

  const browserCollections = [];
  for (const claimSet of FINAL_BROWSER_CLAIMS) {
    const gateId = claimSet.startsWith("HF2-06-") ? "HF2-06" : claimSet;
    browserCollections.push({
      claimSet,
      ...(await addCollection({
        source,
        collectionId: `browser-${claimSet}`,
        gateId,
        route: "semantic-browser",
        binding,
      })),
    });
  }
  const packageCollections = [];
  for (const claimSet of ["T060-identity", "T023b-native-entrypoint"]) {
    packageCollections.push({
      claimSet,
      ...(await addCollection({
        source,
        collectionId: `package-${claimSet}`,
        gateId: "FINAL-003",
        route: "native-package",
        binding,
      })),
    });
  }
  const regressionCollections = [];
  for (const claimSet of ["T023a", "T024", "final-regression"]) {
    regressionCollections.push({
      claimSet,
      ...(await addCollection({
        source,
        collectionId: `regression-${claimSet}`,
        gateId: "FINAL-003",
        route: "regression",
        binding,
      })),
    });
  }

  const technicalInput = {
    schemaVersion: 1,
    finalCommit: COMMIT,
    productIdentity: {
      productCommit: COMMIT,
      runtimeInputsSha256: "ab".repeat(32),
      packageArtifactSha256: SHA,
      bundleIdentifier: "com.example.fixture",
      version: "1.0.0",
    },
    hf2Manifest: {
      path: hf2ManifestPath,
      sha256: hf2ManifestSha256,
    },
    finalPackageManifest: {
      path: packageManifestPath,
      sha256: await sha256File(packageManifestPath),
      artifactSha256: SHA,
    },
    ownershipMap: { version: "fixture-v1" },
    finalBrowserClaimCollections: browserCollections.map((entry) => ({
      claimSet: entry.claimSet,
      reportPath: entry.reportPath,
      collectionDigest: entry.report.collectionDigest,
      disposition: "REUSE",
    })),
    finalScreenCollections: visualCollections.map((entry) => ({
      gateId: entry.gateId,
      reportPath: entry.reportPath,
      collectionDigest: entry.report.collectionDigest,
    })),
    packageCollections: packageCollections.map((entry) => ({
      claimSet: entry.claimSet,
      reportPath: entry.reportPath,
      collectionDigest: entry.report.collectionDigest,
    })),
    regressionCollections: regressionCollections.map((entry) => ({
      claimSet: entry.claimSet,
      reportPath: entry.reportPath,
      collectionDigest: entry.report.collectionDigest,
    })),
    delta: { path: deltaPath, sha256: await sha256File(deltaPath) },
    attemptRecords: [],
    attemptAmendments: [],
  };
  const technicalDir = path.join(source, "aggregate", "technical");
  await writeJson(path.join(technicalDir, "input.json"), technicalInput);
  const dependencyGraph = {
    schemaVersion: 1,
    nodes: [
      ...technicalInput.finalBrowserClaimCollections,
      ...technicalInput.finalScreenCollections,
      ...technicalInput.packageCollections,
      ...technicalInput.regressionCollections,
    ]
      .map((entry) => ({
        id: entry.gateId ?? entry.claimSet,
        digest: entry.collectionDigest,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  await writeJson(
    path.join(technicalDir, "dependency-graph.json"),
    dependencyGraph,
  );
  await writeJson(path.join(technicalDir, "stale-evidence.json"), []);
  await writeJson(path.join(technicalDir, "attempt-issue-index.json"), {
    schemaVersion: 1,
    issues: [],
  });
  const technicalReport = {
    schemaVersion: 1,
    mode: "technical",
    finalCommit: COMMIT,
    productIdentity: technicalInput.productIdentity,
    packageArtifactSha256: SHA,
    hf2ManifestSha256: technicalInput.hf2Manifest.sha256,
    dependencyGraphDigest: crypto
      .createHash("sha256")
      .update(JSON.stringify(dependencyGraph))
      .digest("hex"),
    browserClaimVerdicts: browserCollections.map((entry) => ({
      claimSet: entry.claimSet,
      collectionDigest: entry.report.collectionDigest,
      disposition: "REUSE",
      result: "PASS",
    })),
    screenCollectionVerdicts: visualCollections.map((entry) => ({
      gateId: entry.gateId,
      collectionDigest: entry.report.collectionDigest,
      result: "PASS",
    })),
    claimVerdicts: [],
    staleEvidence: [],
    result: "PASS",
  };
  await writeJson(
    path.join(technicalDir, "technical-report.json"),
    technicalReport,
  );
  await fs.writeFile(
    path.join(technicalDir, "technical-report.md"),
    "# Technical aggregate\n\nPASS\n",
  );

  const screenReviews = [];
  for (const collection of visualCollections) {
    const relativePath = `screens/${collection.gateId}/reviewer-report.json`;
    const reportPath = path.join(source, "review", relativePath);
    await writeJson(reportPath, {
      schemaVersion: 1,
      gateId: collection.gateId,
      reviewerIdentity: {
        role: "ui-visual-acceptance-reviewer",
        taskIdentity: `/root/review-${collection.gateId}`,
        runtimeIdentity: `/root/review-${collection.gateId}`,
      },
      independenceConfirmed: true,
      reviewedProductCommit: COMMIT,
      reviewedPackageArtifactSha256: SHA,
      reviewedCollections: [
        {
          collectionId: collection.collectionId,
          collectionDigest: collection.report.collectionDigest,
        },
      ],
      findings: [],
      verdict: "PASS",
    });
    await fs.writeFile(
      path.join(
        source,
        "review",
        "screens",
        collection.gateId,
        "reviewer-report.md",
      ),
      `# ${collection.gateId} review\n\nPASS\n`,
    );
    screenReviews.push({
      gateId: collection.gateId,
      path: relativePath,
      sha256: await sha256File(reportPath),
      collectionId: collection.collectionId,
      collectionDigest: collection.report.collectionDigest,
      verdict: "PASS",
      highCriticalCount: 0,
    });
  }
  const reviewerIndexPath = path.join(source, "review", "reviewer-report.json");
  const reviewerIndex = {
    schemaVersion: 1,
    gateId: "FINAL-003",
    reviewerIdentity: {
      role: "ui-visual-acceptance-reviewer",
      taskIdentity: "/root/final-review-index",
      runtimeIdentity: "/root/final-review-index",
    },
    independenceConfirmed: true,
    reviewedProductCommit: COMMIT,
    reviewedPackageArtifactSha256: SHA,
    reviewedCollections: visualCollections.map((collection) => ({
      collectionId: collection.collectionId,
      collectionDigest: collection.report.collectionDigest,
    })),
    screenReviews,
    verdict: "PASS",
    highCriticalCount: 0,
  };
  await writeJson(reviewerIndexPath, reviewerIndex);
  await fs.writeFile(
    path.join(source, "review", "reviewer-report.md"),
    "# Final independent review index\n\n6/6 PASS\n",
  );
  const technicalReportPath = path.join(technicalDir, "technical-report.json");
  const ownerPath = path.join(source, "owner", "product-owner-decision.json");
  const owner = {
    schemaVersion: 1,
    gateId: "FINAL-003",
    status: "APPROVED",
    technicalReport: {
      path: "aggregate/technical/technical-report.json",
      sha256: await sha256File(technicalReportPath),
      result: "PASS",
    },
    reviewerReport: {
      path: "review/reviewer-report.json",
      sha256: await sha256File(reviewerIndexPath),
      verdict: "PASS",
    },
  };
  await writeJson(ownerPath, owner);
  await fs.writeFile(
    path.join(source, "owner", "product-owner-decision.md"),
    "# Product owner\n\nAPPROVED\n",
  );
  return {
    root,
    source,
    destinationRoot,
    destination,
    technicalDir,
    technicalReportPath,
    visualCollections,
    packageCollections,
    reviewerIndex,
    reviewerIndexPath,
    owner,
    ownerPath,
  };
}

describe("evidence publisher", () => {
  it("copies a sealed gate byte-for-byte and writes an adjacent receipt", async () => {
    const test = await fixture();
    const sourceBefore = await digestTree(test.source);
    const result = await publishEvidence({
      source: test.source,
      destination: test.destination,
      allowedDestinationRoot: test.destinationRoot,
    });
    assert.equal(
      (await digestTree(test.destination)).sha256,
      sourceBefore.sha256,
    );
    assert.equal((await digestTree(test.source)).sha256, sourceBefore.sha256);
    assert.equal(result.receipt.result, "PASS");
    assert.equal(result.receipt.sourceTreeSha256, sourceBefore.sha256);
  });

  it("blocks an existing destination", async () => {
    const test = await fixture();
    await fs.mkdir(test.destination, { recursive: true });
    await assert.rejects(
      publishEvidence({
        source: test.source,
        destination: test.destination,
        allowedDestinationRoot: test.destinationRoot,
      }),
      (error) => error instanceof EvidencePublishError && error.exitCode === 2,
    );
  });

  it("fails a stale artifact digest", async () => {
    const test = await fixture();
    await fs.appendFile(path.join(test.collection, "environment.json"), " ");
    await assert.rejects(
      publishEvidence({
        source: test.source,
        destination: test.destination,
        allowedDestinationRoot: test.destinationRoot,
      }),
      (error) => error instanceof EvidencePublishError && error.exitCode === 1,
    );
  });

  it("fails collector attempts to author reviewer fields", async () => {
    const test = await fixture();
    await writeJson(path.join(test.collection, "collector-report.json"), {
      ...test.report,
      reviewerVerdict: "PASS",
    });
    await assert.rejects(
      publishEvidence({
        source: test.source,
        destination: test.destination,
        allowedDestinationRoot: test.destinationRoot,
      }),
      (error) => error instanceof EvidencePublishError && error.exitCode === 1,
    );
  });

  it("blocks destination path escape and symlinked source content", async () => {
    const test = await fixture();
    await assert.rejects(
      publishEvidence({
        source: test.source,
        destination: path.join(test.root, "outside"),
        allowedDestinationRoot: test.destinationRoot,
      }),
      (error) => error instanceof EvidencePublishError && error.exitCode === 2,
    );
    await fs.symlink(
      path.join(test.collection, "environment.json"),
      path.join(test.collection, "escape-link"),
    );
    await assert.rejects(
      publishEvidence({
        source: test.source,
        destination: test.destination,
        allowedDestinationRoot: test.destinationRoot,
      }),
      (error) => error instanceof EvidencePublishError && error.exitCode === 2,
    );
  });

  it("uses stable SHA-256 digests for raw bytes", async () => {
    const test = await fixture();
    const bytes = await fs.readFile(
      path.join(test.collection, "environment.json"),
    );
    assert.equal(
      await sha256File(path.join(test.collection, "environment.json")),
      crypto.createHash("sha256").update(bytes).digest("hex"),
    );
  });

  it("publishes a FINAL-003 proof graph byte-for-byte", async () => {
    const test = await finalFixture();
    const sourceBefore = await digestTree(test.source);
    await publishEvidence({
      source: test.source,
      destination: test.destination,
      allowedDestinationRoot: test.destinationRoot,
    });
    assert.deepEqual(await digestTree(test.destination), sourceBefore);
  });

  it("blocks stale technical aggregate bytes and transitive inputs", async () => {
    const staleAggregate = await finalFixture();
    await writeJson(
      path.join(staleAggregate.technicalDir, "stale-evidence.json"),
      ["stale"],
    );
    await assert.rejects(
      publishEvidence({
        source: staleAggregate.source,
        destination: staleAggregate.destination,
        allowedDestinationRoot: staleAggregate.destinationRoot,
      }),
      (error) => error instanceof EvidencePublishError && error.exitCode === 2,
    );

    const staleInput = await finalFixture();
    const environmentPath = path.join(
      path.dirname(staleInput.visualCollections[0].reportPath),
      "environment.json",
    );
    await fs.appendFile(environmentPath, " ");
    await assert.rejects(
      publishEvidence({
        source: staleInput.source,
        destination: staleInput.destination,
        allowedDestinationRoot: staleInput.destinationRoot,
      }),
      (error) => error instanceof EvidencePublishError && error.exitCode === 2,
    );
  });

  it("blocks a malformed attempt issue index", async () => {
    const test = await finalFixture();
    await writeJson(path.join(test.technicalDir, "attempt-issue-index.json"), {
      schemaVersion: 1,
      issues: "invalid",
    });
    await assert.rejects(
      publishEvidence({
        source: test.source,
        destination: test.destination,
        allowedDestinationRoot: test.destinationRoot,
      }),
      (error) => error instanceof EvidencePublishError && error.exitCode === 2,
    );
  });

  it("blocks reviewer or owner data embedded in the technical input", async () => {
    const test = await finalFixture();
    const inputPath = path.join(test.technicalDir, "input.json");
    const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
    await writeJson(inputPath, {
      ...input,
      reviewerReports: ["review/reviewer-report.json"],
    });
    await assert.rejects(
      publishEvidence({
        source: test.source,
        destination: test.destination,
        allowedDestinationRoot: test.destinationRoot,
      }),
      (error) => error instanceof EvidencePublishError && error.exitCode === 2,
    );
  });

  it("blocks an incomplete or technically polluted FINAL reviewer index", async () => {
    const incomplete = await finalFixture();
    await writeJson(incomplete.reviewerIndexPath, {
      ...incomplete.reviewerIndex,
      reviewedCollections:
        incomplete.reviewerIndex.reviewedCollections.slice(1),
      screenReviews: incomplete.reviewerIndex.screenReviews.slice(1),
    });
    await assert.rejects(
      publishEvidence({
        source: incomplete.source,
        destination: incomplete.destination,
        allowedDestinationRoot: incomplete.destinationRoot,
      }),
      (error) => error instanceof EvidencePublishError && error.exitCode === 2,
    );

    const polluted = await finalFixture();
    const technicalCollection = polluted.packageCollections[0];
    await writeJson(polluted.reviewerIndexPath, {
      ...polluted.reviewerIndex,
      reviewedCollections: [
        ...polluted.reviewerIndex.reviewedCollections,
        {
          collectionId: technicalCollection.collectionId,
          collectionDigest: technicalCollection.report.collectionDigest,
        },
      ],
    });
    await assert.rejects(
      publishEvidence({
        source: polluted.source,
        destination: polluted.destination,
        allowedDestinationRoot: polluted.destinationRoot,
      }),
      (error) => error instanceof EvidencePublishError && error.exitCode === 2,
    );
  });

  it("blocks stale per-screen review and owner bindings", async () => {
    const staleScreen = await finalFixture();
    await fs.appendFile(
      path.join(
        staleScreen.source,
        "review",
        staleScreen.reviewerIndex.screenReviews[0].path,
      ),
      " ",
    );
    await assert.rejects(
      publishEvidence({
        source: staleScreen.source,
        destination: staleScreen.destination,
        allowedDestinationRoot: staleScreen.destinationRoot,
      }),
      (error) => error instanceof EvidencePublishError && error.exitCode === 2,
    );

    const missingTechnical = await finalFixture();
    const { technicalReport: _technicalReport, ...ownerWithoutTechnical } =
      missingTechnical.owner;
    await writeJson(missingTechnical.ownerPath, ownerWithoutTechnical);
    await assert.rejects(
      publishEvidence({
        source: missingTechnical.source,
        destination: missingTechnical.destination,
        allowedDestinationRoot: missingTechnical.destinationRoot,
      }),
      (error) => error instanceof EvidencePublishError && error.exitCode === 2,
    );
  });
});
