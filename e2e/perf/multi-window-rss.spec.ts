import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test } from "@playwright/test";

import {
  cleanupIsolatedDesktopPaths,
  createIsolatedDesktopPaths,
  resolveDesktopBinary,
} from "../helpers/app";
import {
  launchMultiWindowApp,
  type MultiWindowApp,
} from "../helpers/reliability";
import {
  collectCommit,
  collectEnvironmentMetadata,
  collectPerformanceBinaryIdentity,
  collectProcessTreeSample,
  executableAssociationTokens,
  percentile,
} from "./helpers/processMetrics";

/**
 * Process-tree RSS with one, two and three windows, each holding its own
 * Workspace and one open drawing. Recorded only: there is no budget for the
 * memory a window adds.
 */

const SETTLE_MS = 15_000;
const SAMPLE_WINDOW_MS = 20_000;
const SAMPLE_INTERVAL_MS = 1_000;
const REPORT_PATH =
  process.env.PERF_MULTI_WINDOW_REPORT_PATH ??
  "e2e/perf/results/multi-window-rss.json";

function configured(): boolean {
  return (
    process.env.PERF_TEST === "1" &&
    process.env.APP_E2E === "1" &&
    process.env.EXCALIDRAW_E2E_BINARY !== undefined
  );
}

function scene(id: string) {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "multi-window-rss",
    elements: [
      {
        id,
        type: "rectangle",
        x: 40,
        y: 40,
        width: 160,
        height: 100,
        angle: 0,
        strokeColor: "#1e1e1e",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        index: "a0",
        roundness: null,
        boundElements: null,
        updated: 1,
        seed: 7,
        version: 1,
        versionNonce: 11,
        isDeleted: false,
        locked: false,
        link: null,
      },
    ],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  });
}

test.skip(
  !configured(),
  "Requires PERF_TEST=1, APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at an e2e-harness build.",
);

test("records process-tree RSS with one, two and three windows", async () => {
  test.setTimeout(300_000);
  const executable = await resolveDesktopBinary();
  const [environment, commit, binary] = await Promise.all([
    collectEnvironmentMetadata(),
    collectCommit(),
    collectPerformanceBinaryIdentity(executable),
  ]);
  const paths = await createIsolatedDesktopPaths();
  const workspaces: Array<{ root: string; file: string }> = [];
  for (const name of ["alpha", "beta", "gamma"]) {
    const root = join(paths.workspace, name);
    await mkdir(root, { recursive: true });
    const file = join(root, `${name}.excalidraw`);
    await writeFile(file, scene(`${name}-rect`));
    workspaces.push({ root, file });
  }

  let app: MultiWindowApp | undefined;
  const stages: Array<{
    windows: number;
    samples: number;
    rssP50Bytes: number;
    rssP95Bytes: number;
    processCount: number;
  }> = [];
  try {
    app = await launchMultiWindowApp(paths);
    const tokens = executableAssociationTokens(executable, paths.root);
    const first = await app.waitForSnapshot(
      (snapshot) =>
        snapshot.windows.length === 1 && snapshot.openWindows.length === 1,
    );
    const labels = [first.windows[0].label];
    for (const [index, workspace] of workspaces.entries()) {
      if (index > 0) {
        const { label } = await app.request<{ label: string }>(
          "app",
          "newWindow",
        );
        labels.push(label);
      }
      const label = labels[index];
      await app.request(label, "openWorkspace", { rootPath: workspace.root });
      await app.request(label, "openDrawing", { path: workspace.file });
      await app.waitForSnapshot(
        (snapshot) => snapshot.openWindows.length === index + 1,
      );
      await delay(SETTLE_MS);
      const rss: number[] = [];
      let processCount = 0;
      const deadline = Date.now() + SAMPLE_WINDOW_MS;
      while (Date.now() < deadline) {
        const sample = await collectProcessTreeSample(
          app.child.pid ?? 0,
          app.startedAtNs,
          tokens,
          app.webkitTracker,
        );
        rss.push(sample.rssBytes);
        processCount = Math.max(processCount, sample.processCount);
        await delay(SAMPLE_INTERVAL_MS);
      }
      stages.push({
        windows: index + 1,
        samples: rss.length,
        rssP50Bytes: percentile(rss, 0.5),
        rssP95Bytes: percentile(rss, 0.95),
        processCount,
      });
    }
  } finally {
    if (app !== undefined && app.running()) await app.kill();
    await cleanupIsolatedDesktopPaths(paths);
  }

  const deltas = stages.slice(1).map((stage, index) => ({
    from: stages[index].windows,
    to: stage.windows,
    rssP95DeltaBytes: stage.rssP95Bytes - stages[index].rssP95Bytes,
  }));
  const report = {
    commit,
    ...environment,
    binary,
    workload: {
      name: "multi-window-rss",
      perWindow: "one Workspace and one drawing with one rectangle",
      settleMs: SETTLE_MS,
      sampleWindowMs: SAMPLE_WINDOW_MS,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      statistic: "process-tree RSS nearest-rank p50 and p95 per stage",
    },
    stages,
    deltas,
    verdict: {
      overall: "recorded",
      reason: "No budget for per-window memory.",
    },
  };
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[multi-window-rss] ${JSON.stringify({ stages, deltas })}`);
  expect(stages.map((stage) => stage.windows)).toEqual([1, 2, 3]);
});
