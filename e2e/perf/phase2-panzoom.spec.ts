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
  writePerformanceReport,
} from "./helpers/processMetrics";
import {
  createTenThousandElementFixture,
  frameStatistics,
} from "./helpers/workloads";

const READY_TIMEOUT_MS = 15_000;
const SCENE_WARM_UP_MS = 20_000;
const PAN_DURATION_MS = 15_000;
/** Pan-only arm used seed 90_000 with a temporary adapter probe that held zoom
 * at 1. That probe is reverted; do not treat a re-run as pan-only unless the
 * probe (or an equivalent workload change) is restored. */
const SHORT_EDIT_DURATION_MS = 15_000;
const SHORT_EDIT_TARGET_EVENTS = 900;
const SETTLE_BEFORE_OBSERVE_MS = 5_000;
const SETTLED_OBSERVE_MS = 20_000;
const REPORT_PATH =
  process.env.PERF_PHASE2_PANZOOM_REPORT_PATH ??
  "e2e/perf/results/phase2-panzoom.host.json";
const PROGRESS_PATH = "e2e/perf/results/phase2-panzoom.progress.json";

test("compares pan+zoom vs pan-only and settled post-edit writes", async () => {
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
  const fixture = await createTenThousandElementFixture();
  const control = await NativePerformanceControl.create({
    scenario: "canvas-10k",
    fixturePath: fixture.path,
    seed: 22_100,
  });
  const app = await launchTauriTestApp({
    binaryPath: executable,
    environment: control.environment,
  });

  let panZoomStats: ReturnType<typeof frameStatistics> | undefined;
  let panOnlyStats: ReturnType<typeof frameStatistics> | undefined;
  let settledEventCount: number | undefined;
  let settledPathCount: number | undefined;
  let settledRelativePaths: string[] = [];
  let contractError: string | undefined;

  try {
    const ready = await control.waitForReady(READY_TIMEOUT_MS);
    if (ready.elementCount !== 10_000) {
      throw new Error(
        `Pan/zoom attribution fixture reported ${ready.elementCount} elements.`,
      );
    }
    await delay(SCENE_WARM_UP_MS);

    const panZoomCommand = await control.sendCommand({
      operation: "pan-zoom",
      durationMs: PAN_DURATION_MS,
      seed: 31_000,
    });
    const panZoomResult = await control.waitForResult(
      panZoomCommand,
      PAN_DURATION_MS + RESULT_PUBLISH_SLACK_MS,
    );
    panZoomStats = frameStatistics(panZoomResult.frameIntervalsMs);
    await writePerformanceReport(PROGRESS_PATH, {
      stage: "pan-zoom",
      panZoom: panZoomStats,
    });

    const panOnlyCommand = await control.sendCommand({
      operation: "pan-zoom",
      durationMs: PAN_DURATION_MS,
      seed: 90_000,
    });
    const panOnlyResult = await control.waitForResult(
      panOnlyCommand,
      PAN_DURATION_MS + RESULT_PUBLISH_SLACK_MS,
    );
    panOnlyStats = frameStatistics(panOnlyResult.frameIntervalsMs);
    await writePerformanceReport(PROGRESS_PATH, {
      stage: "pan-only",
      panZoom: panZoomStats,
      panOnly: panOnlyStats,
    });

    const editCommand = await control.sendCommand({
      operation: "high-frequency-edit",
      durationMs: SHORT_EDIT_DURATION_MS,
      seed: 23_100,
      targetEvents: SHORT_EDIT_TARGET_EVENTS,
    });
    await control.waitForResult(
      editCommand,
      SHORT_EDIT_DURATION_MS + RESULT_PUBLISH_SLACK_MS,
    );
    await delay(SETTLE_BEFORE_OBSERVE_MS);

    const observer = new DirectoryWriteObserver([
      app.paths.data,
      app.paths.config,
      app.paths.cache,
      app.paths.runtime,
      app.paths.workspace,
    ]);
    await observer.start();
    try {
      await delay(SETTLED_OBSERVE_MS);
    } finally {
      const observation = await observer.stop();
      settledEventCount = observation.eventCount;
      settledPathCount = observation.changedPathCount;
      settledRelativePaths = observer
        .changedPaths()
        .map((path) =>
          path.startsWith(app.paths.root)
            ? relative(app.paths.root, path)
            : path,
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
    kind: "phase2-panzoom",
    commit,
    ...environment,
    panZoom: panZoomStats ?? null,
    panOnly: panOnlyStats ?? null,
    settledWritesAfter5s: {
      eventCount: settledEventCount ?? null,
      changedPathCount: settledPathCount ?? null,
      relativeChangedPaths: settledRelativePaths,
    },
    contractError: contractError ?? null,
  });
  if (contractError !== undefined) {
    throw new Error(contractError);
  }
});
