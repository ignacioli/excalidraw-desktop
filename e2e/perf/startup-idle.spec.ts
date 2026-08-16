import { test } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";

import {
  describeAppError,
  launchTauriTestApp,
  resolveDesktopBinary,
  type DesktopAppHandle,
} from "../helpers/app";
import { NativePerformanceControl } from "./helpers/nativePerformanceContract";
import {
  assertReferenceEnvironment,
  collectCommit,
  collectEnvironmentMetadata,
  collectProcessTreeSample,
  DirectoryWriteObserver,
  executableAssociationTokens,
  percentile,
  PERFORMANCE_REPORT_SCHEMA_VERSION,
  processTreeAccounting,
  writePerformanceReport,
  type ProcessTreeSample,
  type WriteObservation,
} from "./helpers/processMetrics";
import { collectProcessTreeWindow, PERF_BUDGETS } from "./helpers/workloads";

const COLD_START_REPETITIONS = 10;
const READY_TIMEOUT_MS = 15_000;
const WARM_UP_MS = 30_000;
const SAMPLE_WINDOW_MS = 60_000;
const SAMPLE_INTERVAL_MS = 1_000;
const REPORT_PATH =
  process.env.PERF_STARTUP_REPORT_PATH ??
  process.env.PERF_REPORT_PATH ??
  "e2e/perf/results/startup-idle.json";

const BUDGET = {
  coldStartToEditable: {
    value: PERF_BUDGETS.coldStartToEditableMs,
    unit: "ms",
    statistic: "nearest-rank p95 of 10 cold process launches",
  },
  idleProcessTreeRss: {
    value: PERF_BUDGETS.idleRssBytes,
    unit: "bytes (500 decimal MB)",
    statistic: "nearest-rank p95",
  },
} as const;

const WORKLOAD = {
  name: "phase-3-startup-idle",
  dataState:
    "new isolated app-managed data and workspace directories for every launch",
  coldStart: {
    repetitions: COLD_START_REPETITIONS,
    warmUp: "none; every repetition launches a new process and empty data root",
    clock: "process.hrtime.bigint monotonic clock",
    start: "immediately before spawning the Tauri executable",
    stop: "observation of ready.json proving Excalidraw API ready, editable=true, and an empty scene",
    statistic: "nearest-rank p95",
    expectedVariance:
      "individual samples may vary by 20 percent from scheduling and code-signing cache state; the absolute budget is unchanged",
  },
  idle: {
    warmUpMs: WARM_UP_MS,
    sampleWindowMs: SAMPLE_WINDOW_MS,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    statistic: "process-tree RSS nearest-rank p95",
    expectedVariance:
      "up to 10 percent run-to-run before investigation; no automatic threshold adjustment",
  },
} as const;

async function firstObservableProcessSample(
  app: DesktopAppHandle,
  associationTokens: readonly string[],
): Promise<ProcessTreeSample> {
  const deadline = process.hrtime.bigint() + 5_000_000_000n;
  let lastError: unknown;
  while (process.hrtime.bigint() < deadline) {
    try {
      return await collectProcessTreeSample(
        app.pid,
        app.startedAtNs,
        associationTokens,
        app.webkitTracker,
      );
    } catch (error) {
      lastError = error;
      await delay(25);
    }
  }
  throw new Error("Tauri process did not become observable within 5 seconds.", {
    cause: lastError,
  });
}

test("measures cold start to editable canvas and idle process-tree RSS", async () => {
  test.setTimeout(240_000);
  const referenceRun = process.env.PERF_REFERENCE_RUN === "1";
  const [environment, commit, executable] = await Promise.all([
    collectEnvironmentMetadata(),
    collectCommit(),
    resolveDesktopBinary(),
  ]);

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
      throw error;
    }
  }

  const coldStartToEditableMs: number[] = [];
  const coldStartProcessAliveMs: number[] = [];
  let contractError: string | undefined;
  for (let attempt = 0; attempt < COLD_START_REPETITIONS; attempt += 1) {
    const control = await NativePerformanceControl.create({
      scenario: "startup-editable",
      seed: 10_000 + attempt,
    });
    const app = await launchTauriTestApp({
      binaryPath: executable,
      environment: control.environment,
    });
    try {
      const associationTokens = executableAssociationTokens(
        executable,
        app.paths.root,
      );
      const firstSample = await firstObservableProcessSample(
        app,
        associationTokens,
      );
      coldStartProcessAliveMs.push(firstSample.monotonicMs);
      try {
        const ready = await control.waitForReady(READY_TIMEOUT_MS);
        if (ready.elementCount !== 0) {
          throw new Error(
            `Cold-start readiness must expose an empty editable scene; found ${ready.elementCount} elements.`,
          );
        }
        coldStartToEditableMs.push(
          Number(process.hrtime.bigint() - app.startedAtNs) / 1_000_000,
        );
      } catch (error) {
        contractError = describeAppError(error, app);
        break;
      }
    } finally {
      await app.close();
      await control.dispose();
    }
  }

  const idleControl = await NativePerformanceControl.create({
    scenario: "startup-editable",
    seed: 20_000,
  });
  const idleApp = await launchTauriTestApp({
    binaryPath: executable,
    environment: idleControl.environment,
  });
  const idleProcessTree: ProcessTreeSample[] = [];
  let idleReady = false;
  let idleWriteObservation: WriteObservation | undefined;
  try {
    try {
      const ready = await idleControl.waitForReady(READY_TIMEOUT_MS);
      idleReady = ready.elementCount === 0;
    } catch (error) {
      contractError ??= describeAppError(error, idleApp);
    }
    await delay(WARM_UP_MS);
    const observer = new DirectoryWriteObserver([
      idleApp.paths.data,
      idleApp.paths.config,
      idleApp.paths.cache,
      idleApp.paths.runtime,
      idleApp.paths.workspace,
    ]);
    await observer.start();
    try {
      idleProcessTree.push(
        ...(await collectProcessTreeWindow({
          rootPid: idleApp.pid,
          startedAtNs: idleApp.startedAtNs,
          associationTokens: executableAssociationTokens(
            executable,
            idleApp.paths.root,
          ),
          durationMs: SAMPLE_WINDOW_MS,
          intervalMs: SAMPLE_INTERVAL_MS,
          webkitTracker: idleApp.webkitTracker,
        })),
      );
    } finally {
      idleWriteObservation = await observer.stop();
    }
  } finally {
    await idleApp.close();
    await idleControl.dispose();
  }

  const statistic = {
    coldStartToEditableP95:
      coldStartToEditableMs.length === COLD_START_REPETITIONS
        ? {
            value: percentile(coldStartToEditableMs, 0.95),
            unit: "ms",
            statistic: "nearest-rank p95",
          }
        : null,
    coldStartProcessAliveP95:
      coldStartProcessAliveMs.length > 0
        ? {
            value: percentile(coldStartProcessAliveMs, 0.95),
            unit: "ms",
            statistic: "diagnostic nearest-rank p95",
          }
        : null,
    idleProcessTreeRssP95: {
      value: percentile(
        idleProcessTree.map((sample) => sample.rssBytes),
        0.95,
      ),
      unit: "bytes",
      statistic: "nearest-rank p95",
    },
  };
  const measurementsAvailable =
    statistic.coldStartToEditableP95 !== null && idleReady;
  const comparisons = {
    coldStartToEditable:
      statistic.coldStartToEditableP95 !== null &&
      statistic.coldStartToEditableP95.value <=
        BUDGET.coldStartToEditable.value,
    idleProcessTreeRss:
      statistic.idleProcessTreeRssP95.value <= BUDGET.idleProcessTreeRss.value,
  };
  const allWithinBudget = Object.values(comparisons).every(Boolean);
  const overall = !measurementsAvailable
    ? "not_evaluated"
    : allWithinBudget
      ? "pass"
      : "fail";
  const reason = !measurementsAvailable
    ? `The native editable-canvas contract was unavailable, so process-alive timing cannot substitute for startup readiness. ${contractError ?? ""}`.trim()
    : allWithinBudget
      ? "All evaluated T090 startup and idle RSS budgets passed."
      : "At least one evaluated T090 startup or idle RSS budget failed.";

  await writePerformanceReport(REPORT_PATH, {
    schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
    commit,
    ...environment,
    workload: WORKLOAD,
    processTreeAccounting: processTreeAccounting("excalidraw-desktop"),
    samples: {
      coldStartToEditableMs,
      coldStartProcessAliveMs,
      idleProcessTree,
      idleWriteObservation,
    },
    statistic,
    budget: BUDGET,
    verdict: {
      overall,
      scope: referenceRun
        ? "declared-reference T090 startup and idle RSS"
        : "diagnostic T090 startup and idle RSS",
      reason,
      comparisons,
    },
  });

  if (!measurementsAvailable) {
    throw new Error(
      `The native startup performance contract was unavailable or incomplete. ${contractError ?? ""}`.trim(),
    );
  }
});
