import { test } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";

import { launchTauriTestApp, resolveDesktopBinary } from "../helpers/app";
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
  frameStatistics,
  PERF_BUDGETS,
} from "./helpers/workloads";

const READY_TIMEOUT_MS = 15_000;
const SCENE_WARM_UP_MS = 30_000;
const RSS_SAMPLE_WINDOW_MS = 30_000;
const SAMPLE_INTERVAL_MS = 1_000;
const PAN_ZOOM_DURATION_MS = 30_000;
const EDIT_DURATION_MS = 60_000;
const EDIT_TARGET_EVENTS = 3_600;
const REPORT_PATH =
  process.env.PERF_CANVAS_REPORT_PATH ?? "e2e/perf/results/canvas-io.json";

const BUDGET = {
  panZoomFps: {
    value: PERF_BUDGETS.minimumPanZoomFps,
    unit: "frames per second",
    statistic: "observed frames divided by rAF interval duration",
  },
  maximumFreeze: {
    value: PERF_BUDGETS.maximumFreezeMs,
    unit: "ms",
    statistic:
      "maximum requestAnimationFrame interval during pan/zoom and edit",
  },
  stable10kSceneProcessTreeRss: {
    value: PERF_BUDGETS.stable10kRssBytes,
    unit: "bytes (350 decimal MB)",
    statistic: "nearest-rank p95 after scene warm-up",
  },
  writesPerEditEventRatio: {
    value: PERF_BUDGETS.maximumWritesPerEditEventRatio,
    unit: "observed filesystem events per scripted edit event",
    statistic: "60 second observation",
  },
} as const;

const WORKLOAD = {
  name: "phase-3-10k-canvas-and-write-coalescing",
  fixture: {
    generator: "deterministic 100 x 100 grid of Excalidraw rectangles",
    elementCount: 10_000,
    seed: 30_000,
  },
  readiness:
    "test-only native contract proves Excalidraw API editable and exactly 10,000 elements loaded",
  rss: {
    warmUpMs: SCENE_WARM_UP_MS,
    sampleWindowMs: RSS_SAMPLE_WINDOW_MS,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    statistic: "process-tree RSS nearest-rank p95",
  },
  panZoom: {
    durationMs: PAN_ZOOM_DURATION_MS,
    statistic: "rAF-derived observed FPS and maximum frame interval",
  },
  editing: {
    durationMs: EDIT_DURATION_MS,
    targetEvents: EDIT_TARGET_EVENTS,
    statistic:
      "rAF maximum interval and fs-watch-plus-metadata-snapshot event ratio",
  },
  expectedVariance: {
    fps: "window compositing and background load may vary; repeat before assigning a bottleneck",
    rss: "up to 10 percent run-to-run before investigation; absolute budgets remain unchanged",
    writes:
      "fs.watch can coalesce or multiply kernel notifications; raw events are retained with observer limitations",
  },
} as const;

test("measures the 10k canvas and 60 second persistence workload", async () => {
  test.setTimeout(300_000);
  const referenceRun = process.env.PERF_REFERENCE_RUN === "1";
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
    scenario: "canvas-10k",
    fixturePath: fixture.path,
    seed: 30_000,
  });
  const app = await launchTauriTestApp({
    binaryPath: executable,
    environment: control.environment,
  });
  const sceneRssSamples: ProcessTreeSample[] = [];
  let panZoomResult: PerformanceCommandResult | undefined;
  let editResult: PerformanceCommandResult | undefined;
  let writeObservation: WriteObservation | undefined;
  let contractError: string | undefined;
  try {
    const ready = await control.waitForReady(READY_TIMEOUT_MS);
    if (ready.elementCount !== 10_000) {
      throw new Error(
        `10k fixture readiness reported ${ready.elementCount} elements.`,
      );
    }
    await delay(SCENE_WARM_UP_MS);
    sceneRssSamples.push(
      ...(await collectProcessTreeWindow({
        rootPid: app.pid,
        startedAtNs: app.startedAtNs,
        associationTokens: executableAssociationTokens(
          executable,
          app.paths.root,
        ),
        durationMs: RSS_SAMPLE_WINDOW_MS,
        intervalMs: SAMPLE_INTERVAL_MS,
      })),
    );

    const panZoomCommand = await control.sendCommand({
      operation: "pan-zoom",
      durationMs: PAN_ZOOM_DURATION_MS,
      seed: 31_000,
    });
    panZoomResult = await control.waitForResult(
      panZoomCommand,
      PAN_ZOOM_DURATION_MS + 15_000,
    );

    const observer = new DirectoryWriteObserver([
      app.paths.data,
      app.paths.config,
      app.paths.cache,
      app.paths.runtime,
      app.paths.workspace,
    ]);
    await observer.start();
    try {
      const editCommand = await control.sendCommand({
        operation: "high-frequency-edit",
        durationMs: EDIT_DURATION_MS,
        seed: 32_000,
        targetEvents: EDIT_TARGET_EVENTS,
      });
      editResult = await control.waitForResult(
        editCommand,
        EDIT_DURATION_MS + 15_000,
      );
    } finally {
      writeObservation = await observer.stop();
    }
    if (editResult.eventCount < EDIT_TARGET_EVENTS) {
      throw new Error(
        `Editing contract completed only ${editResult.eventCount} of ${EDIT_TARGET_EVENTS} required events.`,
      );
    }
  } catch (error) {
    contractError = error instanceof Error ? error.message : String(error);
  } finally {
    await app.close();
    await control.dispose();
    await fixture.dispose();
  }

  const measurementsAvailable =
    sceneRssSamples.length > 0 &&
    panZoomResult !== undefined &&
    editResult !== undefined &&
    writeObservation !== undefined;
  const statistic = (() => {
    if (
      sceneRssSamples.length === 0 ||
      panZoomResult === undefined ||
      editResult === undefined ||
      writeObservation === undefined
    ) {
      return null;
    }
    return {
      stable10kSceneProcessTreeRssP95: {
        value: percentile(
          sceneRssSamples.map((sample) => sample.rssBytes),
          0.95,
        ),
        unit: "bytes",
        statistic: "nearest-rank p95",
      },
      panZoom: frameStatistics(panZoomResult.frameIntervalsMs),
      editing: frameStatistics(editResult.frameIntervalsMs),
      writesPerEditEventRatio: {
        value: writeObservation.eventCount / editResult.eventCount,
        observedWriteEvents: writeObservation.eventCount,
        editEventCount: editResult.eventCount,
        statistic: "60 second observation",
      },
    };
  })();
  const comparisons = statistic
    ? {
        stable10kSceneRss:
          statistic.stable10kSceneProcessTreeRssP95.value <=
          BUDGET.stable10kSceneProcessTreeRss.value,
        panZoomFps: statistic.panZoom.observedFps >= BUDGET.panZoomFps.value,
        noPanZoomFreeze:
          statistic.panZoom.maximumFrameIntervalMs <=
          BUDGET.maximumFreeze.value,
        noEditingFreeze:
          statistic.editing.maximumFrameIntervalMs <=
          BUDGET.maximumFreeze.value,
        writeCoalescing:
          statistic.writesPerEditEventRatio.value <=
          BUDGET.writesPerEditEventRatio.value,
      }
    : null;
  const allWithinBudget =
    comparisons !== null && Object.values(comparisons).every(Boolean);
  const overall = !measurementsAvailable
    ? "not_evaluated"
    : allWithinBudget
      ? "pass"
      : "fail";
  const reason = !measurementsAvailable
    ? `The test-only native canvas workload contract was unavailable or incomplete. ${contractError ?? ""}`.trim()
    : allWithinBudget
      ? "All evaluated T090 10k canvas and write-coalescing budgets passed."
      : "At least one evaluated T090 10k canvas or write-coalescing budget failed.";

  await writePerformanceReport(REPORT_PATH, {
    schemaVersion: PERFORMANCE_REPORT_SCHEMA_VERSION,
    commit,
    ...environment,
    workload: WORKLOAD,
    processTreeAccounting: processTreeAccounting("excalidraw-desktop"),
    samples: {
      sceneRssSamples,
      panZoomResult,
      editResult,
      writeObservation,
    },
    statistic: statistic ?? {},
    budget: BUDGET,
    verdict: {
      overall,
      scope: referenceRun
        ? "declared-reference T090 canvas and I/O"
        : "diagnostic T090 canvas and I/O",
      reason,
      comparisons,
    },
  });

  if (!measurementsAvailable) {
    throw new Error(
      `The native canvas performance contract was unavailable or incomplete. ${contractError ?? ""}`.trim(),
    );
  }
});
