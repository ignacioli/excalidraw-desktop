import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  cleanupIsolatedDesktopPaths,
  createIsolatedDesktopPaths,
  isolatedDesktopEnvironment,
  resolveDesktopBinary,
  type IsolatedDesktopPaths,
} from "./app";
import { type AtomicWriteFaultPoint } from "./fault";

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
  seed: "deterministic" | string;
}

export interface AtomicWriteKillEvidence {
  scenario: "atomic-write-kill";
  faultPoint: AtomicWriteFaultPoint;
  seed: "deterministic" | string;
  processSignal: NodeJS.Signals | null;
  targetPath: string;
  oldSceneJson: string;
  newSceneJson: string;
  oldSha256: string;
  newSha256: string;
  persistedSceneJson: string;
  persistedSha256: string;
  temporaryFiles: string[];
}

export interface SnapshotCorruptionEvidence {
  scenario: "snapshot-corruption";
  targetPath: string;
  latestSnapshotPath: string;
  fallbackSnapshotPath: string;
  latestSnapshotCorrupted: boolean;
  recoveredSnapshotSavedAt: number;
  expectedFallbackSavedAt: number;
  recoveryDialogVisible: boolean;
  recoveredSceneJson: string;
  targetSceneJson: string;
  snapshotsRemaining: number;
}

export interface RecoveryWindowEvidence {
  scenario: "recovery-window";
  normalExitDialogVisible: boolean;
  forcedExitDialogVisible: boolean;
  recoveryElapsedMs: number;
  expectedSceneJson: string;
  restoredSceneJson: string;
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

/**
 * Start the test-only native fixture, wait for its exact atomic-write barrier,
 * and terminate the process group with SIGKILL. The fixture creates the old
 * file and starts the new write itself; this helper only controls the OS-level
 * interruption and records the resulting filesystem evidence.
 */
export async function runTauriAtomicWriteKill(
  faultPoint: AtomicWriteFaultPoint,
  seed: "deterministic" | string = "deterministic",
): Promise<ReliabilityRun<AtomicWriteKillEvidence>> {
  const binary = await resolveDesktopBinary();
  const paths = await createIsolatedDesktopPaths();
  const controlDirectory = join(paths.runtime, "reliability");
  const readyPath = join(controlDirectory, "atomic-write.ready.json");
  const child = spawn(
    binary,
    [RELIABILITY_SCENARIO_FLAG, "atomic-write-kill"],
    {
      detached: process.platform !== "win32",
      env: isolatedDesktopEnvironment(paths, {
        EXCALIDRAW_E2E_FAULT_POINT: faultPoint,
        EXCALIDRAW_E2E_SEED: seed,
      }),
      stdio: ["ignore", "ignore", "ignore"],
    },
  );

  let cleaned = false;
  let killed = false;
  const terminate = (): void => {
    if (child.pid === undefined || child.exitCode !== null) {
      return;
    }
    try {
      if (process.platform !== "win32") {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") {
        throw error;
      }
    }
  };
  const cleanup = async (): Promise<void> => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    if (!killed) {
      terminate();
      await waitForChildExit(child, 2_000);
    }
    await cleanupIsolatedDesktopPaths(paths);
  };

  try {
    const marker = await waitForAtomicWriteReady(child, readyPath, 15_000);
    const targetPath = marker.targetPath;
    if (!targetPath.startsWith(`${paths.workspace}/`)) {
      throw new Error(
        `Atomic fixture escaped its isolated workspace: ${targetPath}`,
      );
    }
    if (marker.faultPoint !== faultPoint) {
      throw new Error(
        `Atomic fixture fault mismatch: requested ${faultPoint}, received ${marker.faultPoint}`,
      );
    }

    terminate();
    killed = true;
    await waitForChildExit(child, 5_000);
    const persistedSceneJson = await readFile(targetPath, "utf8");
    const persistedSha256 = sha256(persistedSceneJson);
    const temporaryFiles = await listTemporaryFiles(targetPath);
    const binarySha256 = sha256(await readFile(binary));
    const filesystem = await statfs(paths.workspace);

    return {
      evidence: {
        scenario: "atomic-write-kill",
        faultPoint,
        seed,
        processSignal: child.signalCode,
        targetPath,
        oldSceneJson: marker.oldSceneJson,
        newSceneJson: marker.newSceneJson,
        oldSha256: marker.oldSha256,
        newSha256: marker.newSha256,
        persistedSceneJson,
        persistedSha256,
        temporaryFiles,
      },
      environment: {
        platform: process.platform,
        architecture: process.arch,
        filesystemType: String(filesystem.type),
        binaryPath: binary,
        binarySha256,
        seed,
      },
      paths,
      cleanup,
    };
  } catch (error) {
    try {
      terminate();
    } finally {
      await waitForChildExit(child, 2_000).catch(() => undefined);
      await cleanupIsolatedDesktopPaths(paths);
      cleaned = true;
    }
    throw error;
  }
}

/**
 * Run a recovery acceptance scenario implemented by the test-only native
 * harness. The helper reports native process errors directly instead of
 * substituting browser-local state when the recovery integration is absent or
 * fails.
 */
export async function runTauriRecoveryScenario(
  scenario: "snapshot-corruption" | "recovery-window",
): Promise<
  ReliabilityRun<SnapshotCorruptionEvidence | RecoveryWindowEvidence>
> {
  const binary = await resolveDesktopBinary();
  const paths = await createIsolatedDesktopPaths();
  try {
    const evidence = await runRecoveryScenarioProcess(binary, paths, scenario);
    const binarySha256 = sha256(await readFile(binary));
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

async function runRecoveryScenarioProcess(
  binary: string,
  paths: IsolatedDesktopPaths,
  scenario: "snapshot-corruption" | "recovery-window",
): Promise<SnapshotCorruptionEvidence | RecoveryWindowEvidence> {
  const child = spawn(binary, [RELIABILITY_SCENARIO_FLAG, scenario], {
    env: isolatedDesktopEnvironment(paths, {
      EXCALIDRAW_E2E_RECOVERY_SCENARIO: "1",
    }),
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
          `Recovery scenario ${scenario} exceeded ${SCENARIO_TIMEOUT_MS} ms.`,
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
      `Recovery scenario ${scenario} exited with ${exitCode}: ${stderr.trim()}`,
    );
  }
  const evidenceLine = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!evidenceLine) {
    throw new Error(`Recovery scenario ${scenario} produced no evidence.`);
  }
  const evidence: unknown = JSON.parse(evidenceLine);
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    !("scenario" in evidence) ||
    evidence.scenario !== scenario
  ) {
    throw new Error(
      `Recovery scenario mismatch: requested ${scenario}, received ${String(
        (evidence as { scenario?: unknown } | null)?.scenario,
      )}.`,
    );
  }
  return evidence as SnapshotCorruptionEvidence | RecoveryWindowEvidence;
}

interface AtomicWriteReadyMarker {
  scenario: "atomic-write-kill";
  faultPoint: AtomicWriteFaultPoint;
  seed: "deterministic" | string;
  targetPath: string;
  oldSceneJson: string;
  newSceneJson: string;
  oldSha256: string;
  newSha256: string;
}

async function waitForAtomicWriteReady(
  child: ReturnType<typeof spawn>,
  markerPath: string,
  timeoutMs: number,
): Promise<AtomicWriteReadyMarker> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Atomic write fixture exited before its barrier (code=${child.exitCode}, signal=${child.signalCode}).`,
      );
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(markerPath, "utf8"));
      if (!isAtomicWriteReadyMarker(parsed)) {
        throw new Error(
          "Atomic write fixture published an invalid barrier marker.",
        );
      }
      return parsed;
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        await delay(25);
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    `Atomic write fixture did not publish its barrier within ${timeoutMs} ms.`,
  );
}

function isAtomicWriteReadyMarker(
  value: unknown,
): value is AtomicWriteReadyMarker {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.scenario === "atomic-write-kill" &&
    typeof record.faultPoint === "string" &&
    typeof record.seed === "string" &&
    typeof record.targetPath === "string" &&
    typeof record.oldSceneJson === "string" &&
    typeof record.newSceneJson === "string" &&
    typeof record.oldSha256 === "string" &&
    typeof record.newSha256 === "string"
  );
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    delay(timeoutMs).then(() => undefined),
  ]);
}

async function listTemporaryFiles(targetPath: string): Promise<string[]> {
  const separator = targetPath.lastIndexOf("/");
  const parent = separator === -1 ? "." : targetPath.slice(0, separator);
  const targetName =
    separator === -1 ? targetPath : targetPath.slice(separator + 1);
  const prefix = `${targetName}.`;
  const entries = await readdir(parent, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(prefix) &&
        entry.name.endsWith(".tmp"),
    )
    .map((entry) => join(parent, entry.name));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
