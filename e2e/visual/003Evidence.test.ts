import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EvidenceValidationError,
  HF2_FONT_DEVIATION_ID,
  PLATFORM_MONO_FONT_STACK,
  PLATFORM_UI_FONT_STACK,
  collectionDigestFor,
  validateCollectorReport,
  validateEnvironmentEvidence,
  validateMaskEvidence,
  writeCollectorReport,
  writeEnvironmentEvidence,
  writeMaskEvidence,
} from "./003Evidence";

const TEST_COMMIT = "ab".repeat(20);
const TEST_SHA256 = "cd".repeat(32);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const evidenceBinding = {
  productCommit: TEST_COMMIT,
  hf2ManifestSha256: TEST_SHA256,
  fixtureDigest: "ef".repeat(32),
  harnessVersion: "003-browser-v2",
};
const collector = {
  tool: "playwright-003-shell",
  version: "2",
  runIdentity: "run-001",
};

function environment() {
  return {
    schemaVersion: 1,
    collectionId: "VSL-001-browser",
    gateId: "VSL-001",
    route: "semantic-browser",
    binding: evidenceBinding,
    os: "macOS 26.5.2",
    viewport: { width: 1280, height: 760 },
    browserOrAppBuild: "browser-preflight",
    fontReady: true,
    fontPolicy: {
      deviationId: HF2_FONT_DEVIATION_ID,
      uiStack: PLATFORM_UI_FONT_STACK,
      monoStack: PLATFORM_MONO_FONT_STACK,
      computedUiFamily: PLATFORM_UI_FONT_STACK,
      computedMonoFamily: PLATFORM_MONO_FONT_STACK,
      remoteFontRequests: 0,
      englishTargetVerified: true,
      unicodeFallbackVerified: true,
    },
    theme: "light",
    sidebar: "pinned",
    session: "workspace",
    fixture: "pinned",
    collector,
  } as const;
}

function mask() {
  return {
    schemaVersion: 1,
    collectionId: "VSL-001-browser",
    gateId: "VSL-001",
    binding: evidenceBinding,
    masks: [
      {
        maskId: "sdk-canvas",
        selectorOrRect: ".excalidraw-editor",
        surface: "canvas",
        reason: "official SDK-owned editor interior",
        perimeterChecked: true,
        approved: true,
      },
    ],
  } as const;
}

function report() {
  const artifactDigests = [
    { path: "environment.json", sha256: TEST_SHA256 },
    { path: "mask.json", sha256: "ef".repeat(32) },
  ];
  return {
    schemaVersion: 1,
    collectionId: "VSL-001-browser",
    gateId: "VSL-001",
    route: "semantic-browser",
    binding: evidenceBinding,
    collector,
    environmentPath: "environment.json",
    maskPath: "mask.json",
    claims: [
      {
        claimId: "shell-geometry",
        factClass: "webview-semantic",
        primaryRoute: "semantic-browser",
        result: "PASS",
        artifactRefs: ["environment.json", "mask.json"],
      },
    ],
    artifactDigests,
    collectionDigest: collectionDigestFor(artifactDigests),
    result: "PASS",
  } as const;
}

describe("003 collector-owned evidence schemas", () => {
  it("accepts immutable environment, mask, and collector report records", async () => {
    const directory = await mkdtemp(join(tmpdir(), "003-evidence-"));
    temporaryDirectories.push(directory);
    await writeEnvironmentEvidence(
      join(directory, "environment.json"),
      environment(),
    );
    await writeMaskEvidence(join(directory, "mask.json"), mask());
    await writeCollectorReport(
      join(directory, "collector-report.json"),
      report(),
    );
    expect(
      JSON.parse(
        await readFile(join(directory, "collector-report.json"), "utf8"),
      ),
    ).toMatchObject({ route: "semantic-browser", result: "PASS" });
    await expect(
      writeCollectorReport(join(directory, "collector-report.json"), report()),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("rejects collector attempts to author reviewer or owner state", () => {
    expect(() =>
      validateCollectorReport({ ...report(), reviewerVerdict: "PASS" }),
    ).toThrow(EvidenceValidationError);
    expect(() =>
      validateEnvironmentEvidence({
        ...environment(),
        ownerRequirement: "NOT_REQUIRED",
      }),
    ).toThrow(EvidenceValidationError);
  });

  it("rejects stale digests, path escape, route substitution, and broad masks", () => {
    expect(() =>
      validateCollectorReport({ ...report(), collectionDigest: TEST_SHA256 }),
    ).toThrow(EvidenceValidationError);
    expect(() =>
      validateCollectorReport({
        ...report(),
        claims: [
          { ...report().claims[0], artifactRefs: ["../owner/decision.json"] },
        ],
      }),
    ).toThrow(EvidenceValidationError);
    expect(() =>
      validateCollectorReport({
        ...report(),
        claims: [
          {
            ...report().claims[0],
            primaryRoute: "fixed-capture-review",
          },
        ],
      }),
    ).toThrow(EvidenceValidationError);
    expect(() =>
      validateMaskEvidence({
        ...mask(),
        masks: [{ ...mask().masks[0], selectorOrRect: ".app-shell-tabs" }],
      }),
    ).toThrow(EvidenceValidationError);
  });

  it("requires font readiness and offline fallback for semantic browser evidence", () => {
    expect(() =>
      validateEnvironmentEvidence({ ...environment(), fontReady: false }),
    ).toThrow(EvidenceValidationError);
    expect(() =>
      validateEnvironmentEvidence({
        ...environment(),
        fontPolicy: { ...environment().fontPolicy, remoteFontRequests: 1 },
      }),
    ).toThrow(EvidenceValidationError);
  });

  it("produces a deterministic digest independent of artifact order", () => {
    const digests = report().artifactDigests;
    expect(collectionDigestFor(digests)).toBe(
      collectionDigestFor([...digests].reverse()),
    );
    expect(collectionDigestFor(digests)).toMatch(/^[0-9a-f]{64}$/u);
  });
});
