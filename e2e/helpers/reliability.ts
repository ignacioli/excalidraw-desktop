import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, statfs } from "node:fs/promises";

import {
  cleanupIsolatedDesktopPaths,
  createIsolatedDesktopPaths,
  isolatedDesktopEnvironment,
  resolveDesktopBinary,
  type IsolatedDesktopPaths,
} from "./app";

const RELIABILITY_SCENARIO_FLAG = "--e2e-reliability-scenario";
const SCENARIO_TIMEOUT_MS = 30_000;

export type ReliabilityScenario =
  "concurrent-checkpoints" | "disk-full-checkpoint";

export interface CheckpointEvidence {
  path: string;
  expectedSceneJson: string;
  expectedSha256: string;
  returnedBaseHash: string;
  persistedSha256: string;
  draftSha256: string;
  draftDirty: boolean;
  temporaryFiles: string[];
}

export interface ConcurrentCheckpointEvidence {
  scenario: "concurrent-checkpoints";
  concurrentBarrierReached: boolean;
  checkpoints: CheckpointEvidence[];
}

export interface StableIpcError {
  code: string;
  message: string;
  retriable: boolean;
  context?: Record<string, string>;
}

export interface DiskFullEvidence {
  scenario: "disk-full-checkpoint";
  path: string;
  originalSceneJson: string;
  attemptedSceneJson: string;
  originalSha256: string;
  attemptedSha256: string;
  persistedSha256: string;
  draftSha256: string;
  draftDirty: boolean;
  openReportsNewerDraft: boolean;
  temporaryFiles: string[];
  error: StableIpcError;
}

export interface ReliabilityRun<T> {
  evidence: T;
  environment: ReliabilityEnvironment;
  paths: IsolatedDesktopPaths;
  cleanup(): Promise<void>;
}

export interface ReliabilityEnvironment {
  platform: NodeJS.Platform;
  architecture: string;
  filesystemType: string;
  binaryPath: string;
  binarySha256: string;
  seed: "deterministic";
}

export function runTauriReliabilityScenario(
  scenario: "concurrent-checkpoints",
): Promise<ReliabilityRun<ConcurrentCheckpointEvidence>>;
export function runTauriReliabilityScenario(
  scenario: "disk-full-checkpoint",
): Promise<ReliabilityRun<DiskFullEvidence>>;
export async function runTauriReliabilityScenario(
  scenario: ReliabilityScenario,
): Promise<ReliabilityRun<ConcurrentCheckpointEvidence | DiskFullEvidence>> {
  const binary = await resolveDesktopBinary();
  const paths = await createIsolatedDesktopPaths();

  try {
    const evidence = await runScenarioProcess(binary, paths, scenario);
    const binarySha256 = createHash("sha256")
      .update(await readFile(binary))
      .digest("hex");
    const filesystem = await statfs(paths.workspace);
    let cleaned = false;
    return {
      evidence,
      environment: {
        platform: process.platform,
        architecture: process.arch,
        filesystemType: String(filesystem.type),
        binaryPath: binary,
        binarySha256,
        seed: "deterministic",
      },
      paths,
      async cleanup(): Promise<void> {
        if (cleaned) {
          return;
        }
        cleaned = true;
        await cleanupIsolatedDesktopPaths(paths);
      },
    };
  } catch (error) {
    await cleanupIsolatedDesktopPaths(paths);
    throw error;
  }
}

async function runScenarioProcess(
  binary: string,
  paths: IsolatedDesktopPaths,
  scenario: ReliabilityScenario,
): Promise<ConcurrentCheckpointEvidence | DiskFullEvidence> {
  const child = spawn(binary, [RELIABILITY_SCENARIO_FLAG, scenario], {
    env: isolatedDesktopEnvironment(paths, undefined),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `Reliability scenario ${scenario} exceeded ${SCENARIO_TIMEOUT_MS} ms.`,
        ),
      );
    }, SCENARIO_TIMEOUT_MS);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveExit(code ?? -1);
    });
  });

  if (exitCode !== 0) {
    throw new Error(
      `Reliability scenario ${scenario} exited with ${exitCode}: ${stderr.trim()}`,
    );
  }
  const evidenceLine = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!evidenceLine) {
    throw new Error(`Reliability scenario ${scenario} produced no evidence.`);
  }
  const evidence = JSON.parse(evidenceLine) as
    ConcurrentCheckpointEvidence | DiskFullEvidence;
  if (evidence.scenario !== scenario) {
    throw new Error(
      `Reliability scenario mismatch: requested ${scenario}, received ${evidence.scenario}.`,
    );
  }
  return evidence;
}
