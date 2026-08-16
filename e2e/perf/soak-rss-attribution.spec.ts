/**
 * Diagnostic spec: physical soak RSS rise by process class during the
 * first minutes of the T108 edit-soak workload. Official 15-minute T108
 * reports only whole-tree RSS at 10 s; this spec samples WebContent /
 * Tauri / GPU / Network through the documented 788→1110 MB rise and the
 * subsequent plateau. Not an official T108 gate and not tasks.md SDD Phase 2.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";

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
  executableAssociationTokens,
  processTreeAccounting,
  writePerformanceReport,
  type ProcessClassCounts,
  type ProcessTreeBreakdown,
} from "./helpers/processMetrics";
import {
  collectProcessTreeBreakdownWindow,
  createTenThousandElementFixture,
} from "./helpers/workloads";

const READY_TIMEOUT_MS = 15_000;
const WARM_UP_MS = 30_000;
const BASELINE_WINDOW_MS = 20_000;
const EDIT_DURATION_MS = 180_000;
const POST_EDIT_WINDOW_MS = 30_000;
const SAMPLE_INTERVAL_MS = 1_000;
const PROGRESS_INTERVAL_MS = 15_000;
const REPORT_PATH =
  process.env.PERF_SOAK_RSS_ATTRIBUTION_REPORT_PATH ??
  "e2e/perf/results/soak-rss-attribution.host.json";
const PROGRESS_PATH = "e2e/perf/results/soak-rss-attribution.progress.json";

const CLASS_KEYS = [
  "tauri",
  "webview",
  "gpu",
  "network",
  "other",
] as const satisfies readonly (keyof ProcessClassCounts)[];

interface CompactSample {
  monotonicMs: number;
  rssBytes: number;
  rssBytesByClass: ProcessClassCounts;
  cpuPercentByClass: Record<keyof ProcessClassCounts, number>;
  processCount: number;
}

interface RiseSummary {
  sampleCount: number;
  firstRssBytes: number;
  lastRssBytes: number;
  maxRssBytes: number;
  deltaRssBytes: number;
  deltaRssBytesByClass: ProcessClassCounts;
  elapsedMs: number;
  msTo90PercentOfDelta: number | null;
  plateauLast60sDeltaRssBytes: number | null;
  dominantClass: keyof ProcessClassCounts | null;
}

function emptyClassCounts(): ProcessClassCounts {
  return {
    tauri: 0,
    webview: 0,
    gpu: 0,
    network: 0,
    other: 0,
  };
}

function compactSample(sample: ProcessTreeBreakdown): CompactSample {
  return {
    monotonicMs: sample.tree.monotonicMs,
    rssBytes: sample.tree.rssBytes,
    rssBytesByClass: sample.rssBytesByClass,
    cpuPercentByClass: sample.cpuPercentByClass,
    processCount: sample.tree.processCount,
  };
}

function subtractClassCounts(
  later: ProcessClassCounts,
  earlier: ProcessClassCounts,
): ProcessClassCounts {
  const delta = emptyClassCounts();
  for (const key of CLASS_KEYS) {
    delta[key] = later[key] - earlier[key];
  }
  return delta;
}

function summarizeRise(samples: readonly CompactSample[]): RiseSummary {
  if (samples.length === 0) {
    throw new Error("Soak RSS attribution window collected no samples.");
  }
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const maxRssBytes = Math.max(...samples.map((sample) => sample.rssBytes));
  const deltaRssBytes = last.rssBytes - first.rssBytes;
  const target = first.rssBytes + 0.9 * Math.max(0, deltaRssBytes);
  const reached90 = samples.find((sample) => sample.rssBytes >= target);
  const plateauStartMs = last.monotonicMs - 60_000;
  const plateauSamples = samples.filter(
    (sample) => sample.monotonicMs >= plateauStartMs,
  );
  const deltaByClass = subtractClassCounts(
    last.rssBytesByClass,
    first.rssBytesByClass,
  );
  const dominant = CLASS_KEYS.reduce<{
    key: keyof ProcessClassCounts | null;
    value: number;
  }>(
    (best, key) =>
      deltaByClass[key] > best.value
        ? { key, value: deltaByClass[key] }
        : best,
    { key: null, value: 0 },
  );

  return {
    sampleCount: samples.length,
    firstRssBytes: first.rssBytes,
    lastRssBytes: last.rssBytes,
    maxRssBytes,
    deltaRssBytes,
    deltaRssBytesByClass: deltaByClass,
    elapsedMs: last.monotonicMs - first.monotonicMs,
    msTo90PercentOfDelta:
      deltaRssBytes > 0 && reached90 !== undefined
        ? reached90.monotonicMs - first.monotonicMs
        : null,
    plateauLast60sDeltaRssBytes:
      plateauSamples.length >= 2
        ? plateauSamples[plateauSamples.length - 1]!.rssBytes -
          plateauSamples[0]!.rssBytes
        : null,
    dominantClass: dominant.key,
  };
}

function keyframe(
  samples: readonly ProcessTreeBreakdown[],
  predicate: (sample: ProcessTreeBreakdown) => boolean,
): ProcessTreeBreakdown | null {
  return samples.find(predicate) ?? null;
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

test("attributes soak RSS rise by process class over the documented lift window", async () => {
  test.skip(
    process.env.PERF_PHASE2 !== "1",
    "Opt-in diagnostic; run with PERF_PHASE2=1.",
  );
  test.setTimeout(720_000);

  const [environment, commit, executable] = await Promise.all([
    collectEnvironmentMetadata(),
    collectCommit(),
    resolveDesktopBinary(),
  ]);
  const binarySha256 = await sha256File(executable);

  let baselineSamples: ProcessTreeBreakdown[] = [];
  let editingSamples: ProcessTreeBreakdown[] = [];
  let postEditSamples: ProcessTreeBreakdown[] = [];
  let editEventCount: number | undefined;
  let contractError: string | undefined;

  const fixture = await createTenThousandElementFixture();
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
  await writePerformanceReport(PROGRESS_PATH, {
    stage: "launched",
    binarySha256,
    pid: app.pid,
  });

  const collectWindow = (
    durationMs: number,
    stage: string,
    extra: Record<string, unknown> = {},
  ) => {
    let lastProgressAtMs = Number.NEGATIVE_INFINITY;
    return collectProcessTreeBreakdownWindow({
      rootPid: app.pid,
      startedAtNs: app.startedAtNs,
      associationTokens,
      durationMs,
      intervalMs: SAMPLE_INTERVAL_MS,
      webkitTracker: app.webkitTracker,
      onSample: async (sample, samples) => {
        if (sample.tree.monotonicMs - lastProgressAtMs < PROGRESS_INTERVAL_MS) {
          return;
        }
        lastProgressAtMs = sample.tree.monotonicMs;
        await writePerformanceReport(PROGRESS_PATH, {
          stage,
          sampleCount: samples.length,
          lastMonotonicMs: sample.tree.monotonicMs,
          lastRssBytes: sample.tree.rssBytes,
          lastRssBytesByClass: sample.rssBytesByClass,
          ...extra,
        });
      },
    });
  };

  try {
    const ready = await control.waitForReady(READY_TIMEOUT_MS);
    if (ready.elementCount !== 10_000) {
      throw new Error(
        `Soak RSS attribution fixture reported ${ready.elementCount} elements.`,
      );
    }
    await delay(WARM_UP_MS);

    baselineSamples = await collectWindow(BASELINE_WINDOW_MS, "pre-edit-baseline");
    const baselineLast = baselineSamples[baselineSamples.length - 1];
    await writePerformanceReport(PROGRESS_PATH, {
      stage: "pre-edit-baseline",
      sampleCount: baselineSamples.length,
      lastRssBytes: baselineLast?.tree.rssBytes ?? null,
      lastRssBytesByClass: baselineLast?.rssBytesByClass ?? null,
    });

    const command = await control.sendCommand({
      operation: "edit-soak",
      durationMs: EDIT_DURATION_MS,
      seed: 40_000,
    });
    editingSamples = await collectWindow(EDIT_DURATION_MS, "editing", {
      editDurationMs: EDIT_DURATION_MS,
    });
    const soakResult = await control.waitForResult(
      command,
      RESULT_PUBLISH_SLACK_MS,
    );
    editEventCount = soakResult.eventCount;
    if (soakResult.eventCount === 0) {
      throw new Error(
        "Soak RSS attribution completed without any scripted edit events.",
      );
    }

    postEditSamples = await collectWindow(POST_EDIT_WINDOW_MS, "post-edit");
  } catch (error) {
    contractError = describeAppError(error, app);
  } finally {
    await app.close();
    await control.dispose();
    await fixture.dispose();
  }

  const baselineSeries = baselineSamples.map(compactSample);
  const editingSeries = editingSamples.map(compactSample);
  const postEditSeries = postEditSamples.map(compactSample);
  const editingSummary =
    editingSeries.length > 0 ? summarizeRise(editingSeries) : null;
  const ninetyPercentSample =
    editingSummary?.msTo90PercentOfDelta !== null &&
    editingSamples.length > 0 &&
    editingSummary !== null
      ? keyframe(
          editingSamples,
          (sample) =>
            sample.tree.monotonicMs >=
            editingSamples[0]!.tree.monotonicMs +
              editingSummary.msTo90PercentOfDelta!,
        )
      : null;

  await writePerformanceReport(REPORT_PATH, {
    kind: "soak-rss-attribution",
    commit,
    ...environment,
    binaryPath: executable,
    binarySha256,
    binaryHint:
      "reuses the current e2e-harness release binary; no official T090/T108 rerun",
    processTreeAccounting: processTreeAccounting("excalidraw-desktop"),
    workload: {
      name: "soak-rss-attribution",
      fixture: "deterministic 10,000-element scene",
      operation: "edit-soak",
      seed: 40_000,
      warmUpMs: WARM_UP_MS,
      baselineWindowMs: BASELINE_WINDOW_MS,
      editDurationMs: EDIT_DURATION_MS,
      postEditWindowMs: POST_EDIT_WINDOW_MS,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      notes:
        "Same 4 Hz soak edit rate as T108. Covers the host evidence rise (complete by ~40 s, 788→1110 MB by ~100 s) plus a plateau confirmation. Window must stay visible (harness always_on_top).",
    },
    samples: {
      preEditBaseline: baselineSeries,
      editing: editingSeries,
      postEdit: postEditSeries,
    },
    keyframes: {
      preEditLast: baselineSamples[baselineSamples.length - 1] ?? null,
      editingFirst: editingSamples[0] ?? null,
      editingAt90PercentDelta: ninetyPercentSample,
      editingLast: editingSamples[editingSamples.length - 1] ?? null,
      postEditLast: postEditSamples[postEditSamples.length - 1] ?? null,
    },
    statistic: {
      editing: editingSummary,
      postEditDeltaRssBytes:
        postEditSeries.length >= 2
          ? postEditSeries[postEditSeries.length - 1]!.rssBytes -
            postEditSeries[0]!.rssBytes
          : null,
      editEventCount: editEventCount ?? null,
    },
    contractError: contractError ?? null,
  });
  if (contractError !== undefined) {
    throw new Error(contractError);
  }
});
