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
});
