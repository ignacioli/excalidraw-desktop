import { test } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";
import { relative } from "node:path";

import {
  describeAppError,
  launchTauriTestApp,
  resolveDesktopBinary,
} from "../helpers/app";
import {
  NativePerformanceControl,
  RESULT_PUBLISH_SLACK_MS,
} from "./helpers/nativePerformanceContract";
import {
  collectCommit,
  collectEnvironmentMetadata,
  DirectoryWriteObserver,
  executableAssociationTokens,
  percentile,
  writePerformanceReport,
  type ProcessClassCounts,
  type ProcessTreeBreakdown,
} from "./helpers/processMetrics";
import {
  collectProcessTreeBreakdownWindow,
  createTenThousandElementFixture,
} from "./helpers/workloads";

const READY_TIMEOUT_MS = 15_000;
const EMPTY_WARM_UP_MS = 15_000;
const SCENE_WARM_UP_MS = 20_000;
const SAMPLE_WINDOW_MS = 20_000;
const SAMPLE_INTERVAL_MS = 1_000;
const SHORT_EDIT_DURATION_MS = 15_000;
const SHORT_EDIT_TARGET_EVENTS = 900;
const QUIESCENT_WINDOW_MS = 60_000;
const REPORT_PATH =
  process.env.PERF_PHASE2_REPORT_PATH ??
  "e2e/perf/results/phase2-attribution.host.json";
const PROGRESS_PATH = "e2e/perf/results/phase2-attribution.progress.json";

const CLASS_KEYS = [
  "tauri",
  "webview",
  "gpu",
  "network",
  "other",
] as const satisfies readonly (keyof ProcessClassCounts)[];

function summarizeBreakdownWindow(
  samples: readonly ProcessTreeBreakdown[],
): {
  sampleCount: number;
  treeRssP95: number;
  treeCpuP95: number;
  rssP95ByClass: Record<keyof ProcessClassCounts, number>;
  cpuP95ByClass: Record<keyof ProcessClassCounts, number>;
  lastProcesses: ProcessTreeBreakdown["processes"];
} {
  if (samples.length === 0) {
    throw new Error("Phase 2 attribution window collected no samples.");
  }
  const rssP95ByClass = {} as Record<keyof ProcessClassCounts, number>;
  const cpuP95ByClass = {} as Record<keyof ProcessClassCounts, number>;
  for (const key of CLASS_KEYS) {
    rssP95ByClass[key] = percentile(
      samples.map((sample) => sample.rssBytesByClass[key]),
      0.95,
    );
    cpuP95ByClass[key] = percentile(
      samples.map((sample) => sample.cpuPercentByClass[key]),
      0.95,
    );
  }
  return {
    sampleCount: samples.length,
    treeRssP95: percentile(
      samples.map((sample) => sample.tree.rssBytes),
      0.95,
    ),
    treeCpuP95: percentile(
      samples.map((sample) => sample.tree.cpuPercentOfOneLogicalCore),
      0.95,
    ),
    rssP95ByClass,
    cpuP95ByClass,
    lastProcesses: samples[samples.length - 1]?.processes ?? [],
  };
}

function relativizeChangedPaths(
  paths: readonly string[],
  root: string,
): string[] {
  return paths.map((path) => (path.startsWith(root) ? relative(root, path) : path));
}

test("attributes idle/10k RSS by process class and post-edit quiescent writes", async () => {
  test.skip(
    process.env.PERF_PHASE2 !== "1",
    "Opt-in diagnostic; run with PERF_PHASE2=1.",
  );
  test.setTimeout(480_000);
  const [environment, commit, executable] = await Promise.all([
      collectEnvironmentMetadata(),
      collectCommit(),
      resolveDesktopBinary(),
    ]);

    let emptySummary:
      | ReturnType<typeof summarizeBreakdownWindow>
      | undefined;
    let loadedSummary:
      | ReturnType<typeof summarizeBreakdownWindow>
      | undefined;
    let quiescentSummary:
      | ReturnType<typeof summarizeBreakdownWindow>
      | undefined;
    let writeEventCount: number | undefined;
    let changedPathCount: number | undefined;
    let changedPaths: string[] = [];
    let relativeChangedPaths: string[] = [];
    let editEventCount: number | undefined;
    let contractError: string | undefined;

    const emptyControl = await NativePerformanceControl.create({
      scenario: "startup-editable",
      seed: 21_000,
    });
    const emptyApp = await launchTauriTestApp({
      binaryPath: executable,
      environment: emptyControl.environment,
    });
    try {
      const ready = await emptyControl.waitForReady(READY_TIMEOUT_MS);
      if (ready.elementCount !== 0) {
        throw new Error(
          `Empty attribution scene must be empty; found ${ready.elementCount} elements.`,
        );
      }
      await delay(EMPTY_WARM_UP_MS);
      const emptySamples = await collectProcessTreeBreakdownWindow({
        rootPid: emptyApp.pid,
        startedAtNs: emptyApp.startedAtNs,
        associationTokens: executableAssociationTokens(
          executable,
          emptyApp.paths.root,
        ),
        durationMs: SAMPLE_WINDOW_MS,
        intervalMs: SAMPLE_INTERVAL_MS,
        webkitTracker: emptyApp.webkitTracker,
      });
      emptySummary = summarizeBreakdownWindow(emptySamples);
      await writePerformanceReport(PROGRESS_PATH, {
        stage: "empty-idle",
        empty: emptySummary,
      });
    } catch (error) {
      contractError = describeAppError(error, emptyApp);
    } finally {
      await emptyApp.close();
      await emptyControl.dispose();
    }
    if (contractError !== undefined) {
      await writePerformanceReport(REPORT_PATH, {
        kind: "phase2-attribution",
        commit,
        ...environment,
        contractError,
      });
      throw new Error(contractError);
    }

    const fixture = await createTenThousandElementFixture();
    const control = await NativePerformanceControl.create({
      scenario: "canvas-10k",
      fixturePath: fixture.path,
      seed: 22_000,
    });
    const app = await launchTauriTestApp({
      binaryPath: executable,
      environment: control.environment,
    });
    try {
      const ready = await control.waitForReady(READY_TIMEOUT_MS);
      if (ready.elementCount !== 10_000) {
        throw new Error(
          `10k attribution fixture reported ${ready.elementCount} elements.`,
        );
      }
      await delay(SCENE_WARM_UP_MS);
      const associationTokens = executableAssociationTokens(
        executable,
        app.paths.root,
      );
      const loadedSamples = await collectProcessTreeBreakdownWindow({
        rootPid: app.pid,
        startedAtNs: app.startedAtNs,
        associationTokens,
        durationMs: SAMPLE_WINDOW_MS,
        intervalMs: SAMPLE_INTERVAL_MS,
        webkitTracker: app.webkitTracker,
      });
      loadedSummary = summarizeBreakdownWindow(loadedSamples);
      await writePerformanceReport(PROGRESS_PATH, {
        stage: "10k-loaded",
        empty: emptySummary,
        loaded: loadedSummary,
      });

      const editCommand = await control.sendCommand({
        operation: "high-frequency-edit",
        durationMs: SHORT_EDIT_DURATION_MS,
        seed: 23_000,
        targetEvents: SHORT_EDIT_TARGET_EVENTS,
      });
      const editResult = await control.waitForResult(
        editCommand,
        SHORT_EDIT_DURATION_MS + RESULT_PUBLISH_SLACK_MS,
      );
      editEventCount = editResult.eventCount;

      const observer = new DirectoryWriteObserver([
        app.paths.data,
        app.paths.config,
        app.paths.cache,
        app.paths.runtime,
        app.paths.workspace,
      ]);
      await observer.start();
      try {
        const quiescentSamples = await collectProcessTreeBreakdownWindow({
          rootPid: app.pid,
          startedAtNs: app.startedAtNs,
          associationTokens,
          durationMs: QUIESCENT_WINDOW_MS,
          intervalMs: SAMPLE_INTERVAL_MS,
          webkitTracker: app.webkitTracker,
        });
        quiescentSummary = summarizeBreakdownWindow(quiescentSamples);
      } finally {
        const observation = await observer.stop();
        writeEventCount = observation.eventCount;
        changedPathCount = observation.changedPathCount;
        changedPaths = observer.changedPaths();
        relativeChangedPaths = relativizeChangedPaths(
          changedPaths,
          app.paths.root,
        );
      }
    } catch (error) {
      contractError = describeAppError(error, app);
    } finally {
      await app.close();
      await control.dispose();
      await fixture.dispose();
    }

    await writePerformanceReport(REPORT_PATH, {
      kind: "phase2-attribution",
      commit,
      ...environment,
      binaryHint:
        "reuses the current EXCALIDRAW_E2E_BINARY; no harness rebuild",
      windows: {
        emptyIdle: emptySummary,
        loaded10kBeforeEdit: loadedSummary,
        postEditQuiescent60s: quiescentSummary,
      },
      edits: {
        durationMs: SHORT_EDIT_DURATION_MS,
        targetEvents: SHORT_EDIT_TARGET_EVENTS,
        eventCount: editEventCount ?? null,
      },
      quiescentWrites: {
        eventCount: writeEventCount ?? null,
        changedPathCount: changedPathCount ?? null,
        changedPaths,
        relativeChangedPaths,
      },
      contractError: contractError ?? null,
    });
    if (contractError !== undefined) {
      throw new Error(contractError);
    }
});
