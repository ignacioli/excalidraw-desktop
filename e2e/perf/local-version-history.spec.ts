import { expect, test } from "@playwright/test";
import { realpath } from "node:fs/promises";
import { relative } from "node:path";

import {
  runTauriHistoryRestartJourney,
  type HistoryRestartJourneyEvidence,
} from "../helpers/reliability";
import {
  assertReferenceEnvironment,
  collectCommit,
  collectEnvironmentMetadata,
  percentile,
  PERFORMANCE_REPORT_SCHEMA_VERSION,
  writePerformanceReport,
} from "./helpers/processMetrics";

const REPORT_PATH =
  process.env.PERF_HISTORY_REPORT_PATH ??
  process.env.PERF_REPORT_PATH ??
  "e2e/perf/results/local-version-history.json";
const WARM_UP_JOURNEYS = 1;
const MEASURED_JOURNEYS = 3;

const WORKLOAD = {
  name: "feature-004-local-version-history-restart",
  kind: "history-specific-native-reliability",
  fixture: "deterministic text/shape/image A→B history fixture",
  seed: "deterministic history-restart fixture",
  operations: [
    "seed 20 pooled versions and one protected prior state",
    "fresh-process preview and adopt version B",
    "fresh-process verify version B and its protected resources",
    "fresh-process preview and adopt version A",
    "fresh-process verify version A and its protected resources",
    "run retention and GC probe while preserving the adopted target",
  ],
  clock: "process.hrtime.bigint monotonic wall clock",
  warmUpJourneys: WARM_UP_JOURNEYS,
  measuredJourneys: MEASURED_JOURNEYS,
  sampleWindow:
    "three independent complete A→B→A journeys, each with a fresh isolated application root and six native process phases",
  statistic:
    "nearest-rank p95 of three complete journey durations; descriptive only",
  expectedVariance:
    "process launch, WebKit initialization and filesystem scheduling may vary between journeys; investigate changes above 20 percent without adjusting a budget",
} as const;

const BUDGET = {
  lifecycleDuration: {
    value: null,
    unit: "ms",
    statistic: "descriptive nearest-rank p95 of three journeys; not evaluated",
  },
} as const;

/**
 * T049's reusable history-specific workload.
 *
 * The generic T090/T108 specs own startup, process-tree, canvas and soak
 * budgets. This workload owns only the absolute history list/snapshot/resource
 * and recovery facts that a history feature adds. It intentionally reports a
 * descriptive duration and `not_evaluated`; no history-specific budget exists
 * in the approved contract yet.
 */
export async function runLocalVersionHistoryPerformanceWorkload(options?: {
  reportPath?: string;
}): Promise<LocalVersionHistoryPerformanceReport> {
  const [environment, commit] = await Promise.all([
    collectEnvironmentMetadata(),
    collectCommit(),
  ]);
  if (process.env.PERF_REFERENCE_RUN === "1") {
    assertReferenceEnvironment(environment);
  }

  const samples: LocalVersionHistoryPerformanceReport["samples"]["lifecycle"] =
    [];
  let measuredBinary: { path: string; sha256: string } | undefined;
  for (
    let attempt = 0;
    attempt < WARM_UP_JOURNEYS + MEASURED_JOURNEYS;
    attempt += 1
  ) {
    const startedAt = process.hrtime.bigint();
    const run = await runTauriHistoryRestartJourney();
    try {
      assertHistoryJourney(run.evidence);
      const currentBinary = {
        path: await realpath(run.environment.binaryPath),
        sha256: run.environment.binarySha256,
      };
      if (
        measuredBinary !== undefined &&
        (measuredBinary.path !== currentBinary.path ||
          measuredBinary.sha256 !== currentBinary.sha256)
      ) {
        throw new Error(
          "History journey samples used different executable bytes or paths.",
        );
      }
      measuredBinary = currentBinary;
      if (attempt < WARM_UP_JOURNEYS) continue;

      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      samples.push({
        attempt: attempt - WARM_UP_JOURNEYS + 1,
        durationMs,
        versionCount: run.evidence.seed.versionCount,
        retainedVersionCount: run.evidence.evict.retainedVersionCount,
        listedVersionCounts: {
          frontendB: run.evidence.frontendB.listedVersionIds.length,
          verifyB: run.evidence.verifyB.listedVersionIds.length,
          frontendA: run.evidence.frontendA.listedVersionIds.length,
          verifyA: run.evidence.verifyA.listedVersionIds.length,
        },
        sceneSha256: {
          initial: run.evidence.seed.initialSceneSha256,
          versionA: run.evidence.seed.sceneASha256,
          versionB: run.evidence.seed.sceneBSha256,
          verifiedB: run.evidence.verifyB.persistedSceneSha256,
          verifiedA: run.evidence.verifyA.persistedSceneSha256,
        },
        resourceFacts: {
          assetSha256: run.evidence.seed.assetSha256,
          versionBObjectExists: run.evidence.verifyB.targetObjectExists,
          versionBAssetExists: run.evidence.verifyB.targetAssetExists,
          versionAObjectExists: run.evidence.verifyA.targetObjectExists,
          versionAAssetExists: run.evidence.verifyA.targetAssetExists,
          gcPreservedTargetObject: run.evidence.evict.targetObjectExistsAfterGc,
          gcPreservedTargetAsset: run.evidence.evict.targetAssetExistsAfterGc,
          gcDeletedTarget: run.evidence.evict.gcDeletedTarget,
          targetRetainedSceneReferences:
            run.evidence.evict.targetRetainedSceneReferences,
          targetRetainedAssetReferences:
            run.evidence.evict.targetRetainedAssetReferences,
        },
        recoveryFacts: {
          frontendBAdopted: run.evidence.frontendB.adopted,
          frontendAAdopted: run.evidence.frontendA.adopted,
          verifyBStatus: run.evidence.verifyB.statusState,
          verifyAStatus: run.evidence.verifyA.statusState,
          verifyBStaleAutosaveRejected:
            run.evidence.verifyB.staleAutosaveRejected,
          verifyAStaleAutosaveRejected:
            run.evidence.verifyA.staleAutosaveRejected,
          evictionStatus: run.evidence.evict.operationStatusState,
        },
      });
    } finally {
      await run.cleanup();
    }
  }
  if (samples.length !== MEASURED_JOURNEYS || measuredBinary === undefined) {
    throw new Error("History workload did not collect all measured journeys.");
  }
  const relativeBinaryPath = relative(process.cwd(), measuredBinary.path);
  const workspaceRelative =
    relativeBinaryPath.length > 0 && !relativeBinaryPath.startsWith("..");
  const binary = {
    path: workspaceRelative ? relativeBinaryPath : measuredBinary.path,
    sha256: measuredBinary.sha256,
    kind: "e2e-harness" as const,
    pathScope: workspaceRelative
      ? ("workspace-relative" as const)
      : ("absolute" as const),
  };
  const report: LocalVersionHistoryPerformanceReport = {
    schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
    commit,
    ...environment,
    binary,
    workload: WORKLOAD,
    processTreeAccounting: {
      rootProcessName: "excalidraw-desktop",
      associationMethod:
        "not sampled by this history-specific reliability workload; use T090/T108 process-tree reports",
      includedClasses: [],
      exclusions: [
        "Tauri main, WebView, GPU and Network RSS/CPU are owned by startup-idle, canvas-io and edit-soak",
      ],
      platformLimitations: [
        "This report does not establish a process-tree performance verdict.",
      ],
    },
    samples: { lifecycle: samples },
    statistic: {
      lifecycleDurationP95: {
        value: percentile(
          samples.map((sample) => sample.durationMs),
          0.95,
        ),
        unit: "ms",
        statistic: "nearest-rank p95 of three independent complete journeys",
      },
      versionCounts: samples.map((sample) => sample.versionCount),
      retainedVersionCounts: samples.map(
        (sample) => sample.retainedVersionCount,
      ),
      listedVersionCounts: samples.map((sample) => sample.listedVersionCounts),
    },
    budget: BUDGET,
    verdict: {
      overall: "not_evaluated",
      scope: "history-specific absolute facts and descriptive timing",
      reason:
        "No standalone local-version-history timing or memory budget is approved; T090/T108 own generic performance verdicts.",
    },
  };

  await writePerformanceReport(options?.reportPath ?? REPORT_PATH, report);
  return report;
}

export interface LocalVersionHistoryPerformanceReport {
  schemaVersion: typeof PERFORMANCE_REPORT_SCHEMA_VERSION;
  commit: string;
  hardware: string;
  memory: { bytes: number; gibibytes: number };
  architecture: string;
  logicalCores: number;
  osVersion: string;
  webviewVersion: string;
  executionEnvironment: {
    type: "physical" | "virtual" | "unspecified";
    hostHardware: string;
    virtualization: { name: string; version: string } | null;
  };
  binary: {
    path: string;
    sha256: string;
    kind: "e2e-harness";
    pathScope: "absolute" | "workspace-relative";
  };
  workload: typeof WORKLOAD;
  processTreeAccounting: {
    rootProcessName: string;
    associationMethod: string;
    includedClasses: readonly string[];
    exclusions: readonly string[];
    platformLimitations: readonly string[];
  };
  samples: {
    lifecycle: Array<{
      attempt: number;
      durationMs: number;
      versionCount: number;
      retainedVersionCount: number;
      listedVersionCounts: Record<
        "frontendB" | "verifyB" | "frontendA" | "verifyA",
        number
      >;
      sceneSha256: Record<
        "initial" | "versionA" | "versionB" | "verifiedB" | "verifiedA",
        string
      >;
      resourceFacts: {
        assetSha256: string;
        versionBObjectExists: boolean;
        versionBAssetExists: boolean;
        versionAObjectExists: boolean;
        versionAAssetExists: boolean;
        gcPreservedTargetObject: boolean;
        gcPreservedTargetAsset: boolean;
        gcDeletedTarget: boolean;
        targetRetainedSceneReferences: number;
        targetRetainedAssetReferences: number;
      };
      recoveryFacts: {
        frontendBAdopted: true;
        frontendAAdopted: true;
        verifyBStatus: string;
        verifyAStatus: string;
        verifyBStaleAutosaveRejected: boolean;
        verifyAStaleAutosaveRejected: boolean;
        evictionStatus: string;
      };
    }>;
  };
  statistic: Record<string, unknown>;
  budget: typeof BUDGET;
  verdict: {
    overall: "not_evaluated";
    scope: string;
    reason: string;
  };
}

test("records local version history absolute lifecycle facts", async ({
  browserName,
}, testInfo) => {
  void browserName;
  test.setTimeout(300_000);
  test.skip(
    !nativeHistoryPerformanceBuildConfigured(),
    "Local history performance workload requires APP_E2E=1, EXCALIDRAW_E2E_BINARY, and EXCALIDRAW_E2E_HISTORY_RESTART=1.",
  );
  if (!nativeHistoryPerformanceBuildConfigured()) return;

  const report = await runLocalVersionHistoryPerformanceWorkload();
  await testInfo.attach("local-version-history-performance-report", {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: "application/json",
  });
  expect(report.verdict.overall).toBe("not_evaluated");
  expect(report.binary.kind).toBe("e2e-harness");
});

function nativeHistoryPerformanceBuildConfigured(): boolean {
  return (
    process.env.APP_E2E === "1" &&
    Boolean(process.env.EXCALIDRAW_E2E_BINARY) &&
    process.env.EXCALIDRAW_E2E_HISTORY_RESTART === "1"
  );
}

function assertHistoryJourney(
  evidence: HistoryRestartJourneyEvidence,
): asserts evidence is HistoryRestartJourneyEvidence {
  expect(evidence.seed.versionCount).toBe(20);
  expect(evidence.seed.initialSceneSha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(evidence.seed.sceneASha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(evidence.seed.sceneBSha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(evidence.seed.assetSha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(evidence.frontendB.adopted).toBe(true);
  expect(evidence.frontendA.adopted).toBe(true);
  expect(evidence.verifyB.persistedSceneSha256).toBe(
    evidence.seed.sceneBSha256,
  );
  expect(evidence.verifyA.persistedSceneSha256).toBe(
    evidence.seed.sceneASha256,
  );
  expect(evidence.verifyB.targetObjectExists).toBe(true);
  expect(evidence.verifyB.targetAssetExists).toBe(true);
  expect(evidence.verifyA.targetObjectExists).toBe(true);
  expect(evidence.verifyA.targetAssetExists).toBe(true);
  expect(evidence.verifyB.staleAutosaveRejected).toBe(true);
  expect(evidence.verifyA.staleAutosaveRejected).toBe(true);
  expect(evidence.evict.targetObjectExistsAfterGc).toBe(true);
  expect(evidence.evict.targetAssetExistsAfterGc).toBe(true);
  expect(evidence.evict.gcDeletedTarget).toBe(false);
}
