import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EvidenceValidationError,
  type EnvironmentEvidence,
  type VisualReport,
  validateMaskEvidence,
  validateVisualReport,
  writeEnvironmentEvidence,
  writeMaskEvidence,
  writePendingProductOwnerDecision,
  writeVisualReport,
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

function runtimeIdentity(agent: string) {
  return {
    agent,
    runIdentity: `${agent}-run-001`,
    configuredModel: "gpt-5.6-sol",
    configuredReasoningEffort: "high",
  };
}

function environment(): EnvironmentEvidence {
  return {
    commit: TEST_COMMIT,
    os: "macOS 26.5.2",
    viewport: { width: 1280, height: 760 },
    browserOrAppBuild: "browser-preflight",
    fontReady: true,
    theme: "light",
    sidebar: "pinned",
    session: "restored",
    fixture: "pinned",
    implementation: runtimeIdentity("implementation-task"),
    reviewer: runtimeIdentity("ui-visual-acceptance-reviewer"),
  };
}

function report(overrides: Partial<VisualReport> = {}): VisualReport {
  return {
    gateId: "VSL-001",
    commit: TEST_COMMIT,
    baseline: {
      path: "screens/workspace-pinned-light.png",
      sha256: TEST_SHA256,
    },
    actualPath: "actual.png",
    environment: environment(),
    maskDeclarations: [
      {
        maskId: "canvas-internal",
        selectorOrRect: "#editor-canvas .scene",
        surface: "canvas",
        reason: "Official SDK-owned canvas internals",
        perimeterChecked: true,
        approved: true,
      },
    ],
    legacyCounts: {
      globalNewDrawing: 0,
      textSidebar: 0,
      largePinUnpin: 0,
      topLevelSaveExportAppearance: 0,
      autosaveStrip: 0,
      tabScrollbar: 0,
      sidebarScrollbar: 0,
      placeholderIcons: 0,
      horizontalEllipsis: 0,
      duplicateWorkspaceRoots: 0,
      headerActionOverflow: 0,
    },
    geometryAssertions: [
      {
        name: "canvas share",
        expected: "0.761",
        actual: "0.761",
        tolerance: "2px",
        result: "PASS",
      },
    ],
    tokenAssertions: [
      {
        name: "font.ui",
        expected: "Inter",
        actual: "Inter",
        tolerance: "exact",
        result: "PASS",
      },
    ],
    rasterSummary: {
      scope: "component-crops-only",
      maxDiffPixelRatio: 0,
      threshold: 0.01,
      auxiliary: true,
    },
    findings: [],
    reviewer: runtimeIdentity("ui-visual-acceptance-reviewer"),
    reviewerVerdict: "PASS",
    productOwnerDecision: "PENDING",
    productOwnerDecisionPath: "product-owner-decision.md",
    ...overrides,
  };
}

describe("003 evidence schema", () => {
  it("writes validated environment, report, and pending owner-decision evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "003-evidence-"));
    temporaryDirectories.push(directory);
    const environmentPath = join(directory, "environment.json");
    const maskPath = join(directory, "mask.json");
    const reportPath = join(directory, "report.json");
    const decisionPath = join(directory, "product-owner-decision.md");

    await writeEnvironmentEvidence(environmentPath, environment());
    await writeMaskEvidence(maskPath, {
      gateId: "VSL-001",
      masks: report().maskDeclarations,
    });
    await writeVisualReport(reportPath, report());
    await writePendingProductOwnerDecision(decisionPath);

    expect(JSON.parse(await readFile(environmentPath, "utf8"))).toMatchObject({
      implementation: { runIdentity: "implementation-task-run-001" },
      reviewer: { runIdentity: "ui-visual-acceptance-reviewer-run-001" },
    });
    expect(JSON.parse(await readFile(reportPath, "utf8"))).toMatchObject({
      gateId: "VSL-001",
      reviewerVerdict: "PASS",
      productOwnerDecision: "PENDING",
    });
    expect(JSON.parse(await readFile(maskPath, "utf8"))).toMatchObject({
      gateId: "VSL-001",
      masks: [{ surface: "canvas", perimeterChecked: true }],
    });
    await expect(readFile(decisionPath, "utf8")).resolves.toContain(
      "**PENDING**",
    );
  });

  it("rejects a broad shell mask and unallowlisted surface", () => {
    expect(() =>
      validateMaskEvidence({
        gateId: "VSL-001",
        masks: [
          {
            maskId: "bad",
            selectorOrRect: ".shell .sidebar",
            surface: "canvas",
            reason: "hide mismatch",
            perimeterChecked: true,
            approved: true,
          },
        ],
      }),
    ).toThrow(EvidenceValidationError);
    expect(() =>
      validateMaskEvidence({
        gateId: "VSL-001",
        masks: [
          {
            maskId: "bad-surface",
            selectorOrRect: "#unknown",
            surface: "menu",
            reason: "not SDK owned",
            perimeterChecked: true,
            approved: true,
          },
        ],
      }),
    ).toThrow(EvidenceValidationError);
  });

  it("rejects missing runtime identity, invalid owner decision, and unreviewed approval", () => {
    const missingIdentity = report({
      reviewer: {
        ...runtimeIdentity("ui-visual-acceptance-reviewer"),
        runIdentity: "",
      },
    });
    expect(() => validateVisualReport(missingIdentity)).toThrow(
      EvidenceValidationError,
    );

    expect(() =>
      validateVisualReport({
        ...report(),
        productOwnerDecision: "MAYBE" as "PENDING",
      }),
    ).toThrow(EvidenceValidationError);
    expect(() =>
      validateVisualReport({
        ...report(),
        baseline: { path: "", sha256: TEST_SHA256 },
      }),
    ).toThrow(EvidenceValidationError);
    expect(() =>
      validateVisualReport({
        ...report({ reviewerVerdict: "BLOCKED" }),
        productOwnerDecision: "APPROVED",
      }),
    ).toThrow(EvidenceValidationError);
  });

  it("refuses to initialize an owner decision as approved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "003-evidence-"));
    temporaryDirectories.push(directory);
    await expect(
      writePendingProductOwnerDecision(join(directory, "owner.md")),
    ).rejects.toThrow(EvidenceValidationError);
  });
});
