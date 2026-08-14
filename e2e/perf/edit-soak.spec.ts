import { test } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";

import {
  describeAppError,
  launchTauriTestApp,
  resolveDesktopBinary,
} from "../helpers/app";
import {
  NativePerformanceControl,
  type PerformanceCommandResult,
} from "./helpers/nativePerformanceContract";
import {
  assertReferenceEnvironment,
  collectCommit,
  collectEnvironmentMetadata,
  DirectoryWriteObserver,
  executableAssociationTokens,
  percentile,
  PERFORMANCE_REPORT_SCHEMA_VERSION,
  processTreeAccounting,
  writePerformanceReport,
  type ProcessTreeSample,
  type WriteObservation,
} from "./helpers/processMetrics";
import {
  collectProcessTreeWindow,
  createTenThousandElementFixture,
  PERF_BUDGETS,
} from "./helpers/workloads";

// The required soak duration is governed by ADR-006 (15 minutes since 2026-08-14).
const REQUIRED_SOAK_DURATION_MS = 15 * 60_000;
const WARM_UP_MS = 30_000;
const BASELINE_WINDOW_MS = 60_000;
const QUIESCENT_WINDOW_MS = 60_000;
const SAMPLE_INTERVAL_MS = 1_000;
const SOAK_SAMPLE_INTERVAL_MS = 10_000;
const READY_TIMEOUT_MS = 15_000;
const REPORT_PATH =
  process.env.PERF_SOAK_REPORT_PATH ?? "e2e/perf/results/edit-soak.json";

function soakDurationMs(hardGate: boolean): number {
  if (hardGate) {
    return REQUIRED_SOAK_DURATION_MS;
  }
  const diagnosticDuration = Number(
    process.env.PERF_DIAGNOSTIC_SOAK_DURATION_MS ?? REQUIRED_SOAK_DURATION_MS,
  );
  if (!Number.isFinite(diagnosticDuration) || diagnosticDuration <= 0) {
    throw new Error("PERF_DIAGNOSTIC_SOAK_DURATION_MS must be positive.");
  }
  return diagnosticDuration;
}

test("measures 15 minute editing stability and subsequent quiescence", async () => {
  const referenceRun = process.env.PERF_REFERENCE_RUN === "1";
  const editDurationMs = soakDurationMs(referenceRun);
  test.setTimeout(editDurationMs + 300_000);

  const BUDGET = {
    rssGrowthAbsolute: {
      value: PERF_BUDGETS.soakRssGrowthBytes,
      unit: "bytes (50 decimal MB)",
      statistic: "post-soak quiescent RSS p95 minus warmed RSS p95",
    },
    rssGrowthRelative: {
      value: PERF_BUDGETS.soakRssGrowthPercent,
      unit: "percent",
      statistic: "RSS p95 delta divided by warmed RSS p95",
    },
    idleCpu: {
      value: PERF_BUDGETS.idleCpuPercentOfOneCore,
      unit: "percent of one logical core",
      statistic: "nearest-rank p95 over 60 seconds",
    },
    quiescentWrites: {
      value: PERF_BUDGETS.quiescentWrites,
      unit: "observed filesystem events and persistently changed paths",
      statistic: "60 second quiescent window",
    },
  } as const;
  const WORKLOAD = {
    name: "phase-3-edit-soak",
    fixture: "deterministic 10,000-element scene",
    warmUpMs: WARM_UP_MS,
    warmedBaseline: {
      sampleWindowMs: BASELINE_WINDOW_MS,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      statistic: "process-tree RSS nearest-rank p95",
    },
    editing: {
      requiredDurationMs: REQUIRED_SOAK_DURATION_MS,
      actualDurationMs: editDurationMs,
      seed: 40_000,
      processTreeSampleIntervalMs: SOAK_SAMPLE_INTERVAL_MS,
    },
    quiescent: {
      durationMs: QUIESCENT_WINDOW_MS,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      statistics: ["process-tree RSS p95", "process-tree CPU p95"],
      writeObservation:
        "application-managed data/config/cache/runtime roots and mounted workspace",
    },
    expectedVariance: {
      rss: "up to 10 percent run-to-run before investigation; both absolute and relative caps remain mandatory",
      cpu: "one-second samples may spike; nearest-rank p95 is authoritative",
      writes:
        "fs.watch may coalesce events; before/after metadata snapshots also detect persistent changes",
    },
  } as const;

  const [environment, commit, executable] = await Promise.all([
    collectEnvironmentMetadata(),
    collectCommit(),
    resolveDesktopBinary(),
  ]);
  const fixture = await createTenThousandElementFixture();
  if (referenceRun) {
    try {
      assertReferenceEnvironment(environment);
    } catch (error) {
      await writePerformanceReport(REPORT_PATH, {
        schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
        commit,
        ...environment,
        workload: WORKLOAD,
        samples: {},
        statistic: {},
        budget: BUDGET,
        verdict: {
          overall: "fail",
          scope: "runner-environment-validity",
          reason: error instanceof Error ? error.message : String(error),
        },
      });
      await fixture.dispose();
      throw error;
    }
  }

  const control = await NativePerformanceControl.create({
    scenario: "edit-soak",
    fixturePath: fixture.path,
    seed: 40_000,
  });
  const app = await launchTauriTestApp({
    binaryPath: executable,
    environment: control.environment,
  });
  const associationTokens = executableAssociationTokens(
    executable,
    app.paths.root,
  );
  const warmedBaselineSamples: ProcessTreeSample[] = [];
  const soakSamples: ProcessTreeSample[] = [];
  const quiescentSamples: ProcessTreeSample[] = [];
  let soakResult: PerformanceCommandResult | undefined;
  let writeObservation: WriteObservation | undefined;
  let contractError: string | undefined;
  try {
    const ready = await control.waitForReady(READY_TIMEOUT_MS);
    if (ready.elementCount !== 10_000) {
      throw new Error(
        `Soak fixture readiness reported ${ready.elementCount} elements.`,
      );
    }
    await delay(WARM_UP_MS);
    warmedBaselineSamples.push(
      ...(await collectProcessTreeWindow({
        rootPid: app.pid,
        startedAtNs: app.startedAtNs,
        associationTokens,
        durationMs: BASELINE_WINDOW_MS,
        intervalMs: SAMPLE_INTERVAL_MS,
        webkitTracker: app.webkitTracker,
      })),
    );

    const command = await control.sendCommand({
      operation: "edit-soak",
      durationMs: editDurationMs,
      seed: 40_000,
    });
    soakSamples.push(
      ...(await collectProcessTreeWindow({
        rootPid: app.pid,
        startedAtNs: app.startedAtNs,
        associationTokens,
        durationMs: editDurationMs,
        intervalMs: SOAK_SAMPLE_INTERVAL_MS,
        webkitTracker: app.webkitTracker,
      })),
    );
    soakResult = await control.waitForResult(command, 15_000);
    if (soakResult.eventCount === 0) {
      throw new Error(
        "Soak command completed without any scripted edit events.",
      );
    }

    const observer = new DirectoryWriteObserver([
      app.paths.data,
      app.paths.config,
      app.paths.cache,
      app.paths.runtime,
      app.paths.workspace,
    ]);
    await observer.start();
    try {
      quiescentSamples.push(
        ...(await collectProcessTreeWindow({
          rootPid: app.pid,
          startedAtNs: app.startedAtNs,
          associationTokens,
          durationMs: QUIESCENT_WINDOW_MS,
          intervalMs: SAMPLE_INTERVAL_MS,
          webkitTracker: app.webkitTracker,
        })),
      );
    } finally {
      writeObservation = await observer.stop();
    }
  } catch (error) {
    contractError = describeAppError(error, app);
  } finally {
    await app.close();
    await control.dispose();
    await fixture.dispose();
  }

  const fullDuration = editDurationMs >= REQUIRED_SOAK_DURATION_MS;
  const diagnosticMeasurementsAvailable =
    warmedBaselineSamples.length > 0 &&
    soakSamples.length > 0 &&
    quiescentSamples.length > 0 &&
    soakResult !== undefined &&
    writeObservation !== undefined;
  const measurementsAvailable = fullDuration && diagnosticMeasurementsAvailable;
  const warmedRssP95 =
    warmedBaselineSamples.length > 0
      ? percentile(
          warmedBaselineSamples.map((sample) => sample.rssBytes),
          0.95,
        )
      : null;
  const postSoakRssP95 =
    quiescentSamples.length > 0
      ? percentile(
          quiescentSamples.map((sample) => sample.rssBytes),
          0.95,
        )
      : null;
  const rssGrowthBytes =
    warmedRssP95 !== null && postSoakRssP95 !== null
      ? Math.max(0, postSoakRssP95 - warmedRssP95)
      : null;
  const rssGrowthPercent =
    rssGrowthBytes !== null && warmedRssP95 !== null && warmedRssP95 > 0
      ? (rssGrowthBytes / warmedRssP95) * 100
      : null;
  const idleCpuP95 =
    quiescentSamples.length > 0
      ? percentile(
          quiescentSamples.map((sample) => sample.cpuPercentOfOneLogicalCore),
          0.95,
        )
      : null;
  const statistic = {
    warmedRssP95,
    postSoakRssP95,
    rssGrowthBytes,
    rssGrowthPercent,
    idleCpuP95,
    editEventCount: soakResult?.eventCount ?? null,
    observedQuiescentWriteEvents: writeObservation?.eventCount ?? null,
    changedPathCount: writeObservation?.changedPathCount ?? null,
  };
  const comparisons = measurementsAvailable
    ? {
        rssGrowthAbsolute:
          rssGrowthBytes !== null &&
          rssGrowthBytes <= BUDGET.rssGrowthAbsolute.value,
        rssGrowthRelative:
          rssGrowthPercent !== null &&
          rssGrowthPercent <= BUDGET.rssGrowthRelative.value,
        idleCpu: idleCpuP95 !== null && idleCpuP95 <= BUDGET.idleCpu.value,
        zeroQuiescentWrites:
          writeObservation?.eventCount === BUDGET.quiescentWrites.value &&
          writeObservation?.changedPathCount === BUDGET.quiescentWrites.value,
      }
    : null;
  const allWithinBudget =
    comparisons !== null && Object.values(comparisons).every(Boolean);
  const overall = !measurementsAvailable
    ? "not_evaluated"
    : allWithinBudget
      ? "pass"
      : "fail";
  const reason = !fullDuration
    ? "A shortened diagnostic soak cannot evaluate the approved 15-minute budget."
    : !measurementsAvailable
      ? `The 15-minute native editing contract was unavailable or incomplete. ${contractError ?? ""}`.trim()
      : allWithinBudget
        ? "All evaluated T108 memory, idle CPU, and quiescent-write budgets passed."
        : "At least one evaluated T108 resource budget failed.";

  await writePerformanceReport(REPORT_PATH, {
    schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
    commit,
    ...environment,
    workload: WORKLOAD,
    processTreeAccounting: processTreeAccounting("excalidraw-desktop"),
    samples: {
      warmedBaseline: warmedBaselineSamples,
      soak: soakSamples,
      quiescent: quiescentSamples,
      soakResult,
      writeObservation,
    },
    statistic,
    budget: BUDGET,
    verdict: {
      overall,
      scope: referenceRun
        ? "declared-reference T108 soak"
        : "diagnostic T108 soak",
      reason,
      comparisons,
    },
  });

  if (!diagnosticMeasurementsAvailable) {
    throw new Error(
      `The native soak performance contract was unavailable or incomplete. ${contractError ?? ""}`.trim(),
    );
  }
});
