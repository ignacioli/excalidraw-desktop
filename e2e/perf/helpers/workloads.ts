import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectProcessTreeSample,
  type ProcessTreeSample,
} from "./processMetrics";

export const PERF_BUDGETS = {
  coldStartToEditableMs: 2_000,
  idleRssBytes: 150_000_000,
  idleCpuPercentOfOneCore: 1,
  stable10kRssBytes: 350_000_000,
  minimumPanZoomFps: 30,
  maximumFreezeMs: 100,
  maximumWritesPerEditEventRatio: 0.01,
  soakRssGrowthBytes: 50_000_000,
  soakRssGrowthPercent: 15,
  quiescentWrites: 0,
} as const;

export async function collectProcessTreeWindow(options: {
  rootPid: number;
  startedAtNs: bigint;
  associationTokens: readonly string[];
  durationMs: number;
  intervalMs: number;
}): Promise<ProcessTreeSample[]> {
  const samples: ProcessTreeSample[] = [];
  const deadline =
    process.hrtime.bigint() + BigInt(options.durationMs) * 1_000_000n;
  while (process.hrtime.bigint() < deadline) {
    const sampleStartedAt = process.hrtime.bigint();
    samples.push(
      await collectProcessTreeSample(
        options.rootPid,
        options.startedAtNs,
        options.associationTokens,
      ),
    );
    const elapsedMs =
      Number(process.hrtime.bigint() - sampleStartedAt) / 1_000_000;
    const remainingMs = Number(deadline - process.hrtime.bigint()) / 1_000_000;
    if (remainingMs > 0) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(Math.max(0, options.intervalMs - elapsedMs), remainingMs),
        ),
      );
    }
  }
  return samples;
}

export function frameStatistics(frameIntervalsMs: readonly number[]): {
  observedFps: number;
  maximumFrameIntervalMs: number;
  frameCount: number;
} {
  if (frameIntervalsMs.length === 0) {
    throw new Error("Frame timing result contains no intervals.");
  }
  const durationMs = frameIntervalsMs.reduce((sum, value) => sum + value, 0);
  if (durationMs <= 0) {
    throw new Error("Frame timing duration must be positive.");
  }
  return {
    observedFps: (frameIntervalsMs.length * 1_000) / durationMs,
    maximumFrameIntervalMs: Math.max(...frameIntervalsMs),
    frameCount: frameIntervalsMs.length + 1,
  };
}

export async function writeTenThousandElementFixture(
  path: string,
): Promise<void> {
  const elements = Array.from({ length: 10_000 }, (_, index) => ({
    id: `perf-rect-${index.toString().padStart(5, "0")}`,
    type: "rectangle",
    x: (index % 100) * 24,
    y: Math.floor(index / 100) * 24,
    width: 16,
    height: 16,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: index + 1,
    version: 1,
    versionNonce: 1_000_000 + index,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  }));
  await writeFile(
    path,
    `${JSON.stringify({ type: "excalidraw", version: 2, elements, appState: {}, files: {} })}\n`,
    "utf8",
  );
}

export async function createTenThousandElementFixture(): Promise<{
  path: string;
  dispose(): Promise<void>;
}> {
  const root = await mkdtemp(
    join(tmpdir(), "excalidraw-desktop-perf-fixture-"),
  );
  const path = join(root, "scene-10000.excalidraw");
  await writeTenThousandElementFixture(path);
  return {
    path,
    async dispose(): Promise<void> {
      const expectedPrefix = join(tmpdir(), "excalidraw-desktop-perf-fixture-");
      if (!root.startsWith(expectedPrefix)) {
        throw new Error(`Refusing to remove unexpected fixture root: ${root}`);
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function hardGateRequiresEvaluatedVerdict(overall: string): void {
  if (process.env.PERF_HARD_GATE === "1" && overall !== "pass") {
    throw new Error(
      `Fixed-runner performance gate requires an evaluated pass; received ${overall}.`,
    );
  }
}
