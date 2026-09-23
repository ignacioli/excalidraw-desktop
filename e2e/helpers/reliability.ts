import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  cleanupIsolatedDesktopPaths,
  createIsolatedDesktopPaths,
  isolatedDesktopEnvironment,
  resolveDesktopBinary,
  type IsolatedDesktopPaths,
} from "./app";
import {
  historyFaultEnvironment,
  isHistoryFaultReadyMarker,
  type AtomicWriteFaultPoint,
  type HistoryFaultReadyMarker,
  type HistoryFaultStage,
} from "./fault";

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

export interface HistoryStateProbeEvidence {
  scenario: "history-state-probe";
  targetPath: string;
  exists: boolean;
  parseableJson: boolean;
  byteLength?: number;
  sha256?: string;
  expectedState: "old" | "new" | "other" | "missing" | "invalid";
  temporaryFiles: string[];
  faultMarkerExists: boolean;
}

export interface HistoryFaultKillEvidence {
  scenario: "history-fault-kill";
  stage: HistoryFaultStage;
  seed: string;
  processSignal: NodeJS.Signals | null;
  targetPath: string;
  oldSha256?: string;
  newSha256?: string;
  beforeState: "old" | "new" | "other" | "missing" | "invalid";
  afterRestart: HistoryStateProbeEvidence;
  readyMarker: HistoryFaultReadyMarker;
}

export interface HistoryOperationFaultProbeEvidence {
  scenario: "history-operation-fault-probe";
  stage: string;
  requestId: string;
  targetPath: string;
  oldSha256: string;
  newSha256: string;
  targetSha256: string;
  expectedState: "old" | "new" | "other" | "invalid";
  parseableJson: boolean;
  operationState: string;
  replacementCommitted?: boolean;
  reconciliationOutcomes: string[];
  temporaryFiles: string[];
  targetObjectExists: boolean;
  targetAssetExists: boolean;
  processSignal?: NodeJS.Signals | null;
  readyMarkerPid?: number;
}

export interface HistoryOperationFailureEvidence {
  scenario: "history-operation-failure";
  failureMode: string;
  requestId: string;
  targetPath: string;
  targetSha256: string;
  originalSha256: string;
  targetUnchanged: boolean;
  error: string;
  temporaryFiles: string[];
}

export interface HistoryOperationConcurrencyEvidence {
  scenario: "history-operation-concurrency";
  targetPath: string;
  requestId: string;
  responseStates: string[];
  replacementCommitted: Array<boolean | undefined>;
  differentResponseStates: string[];
  differentReplacementCommitted: Array<boolean | undefined>;
  targetSha256: string;
  targetObjectExists: boolean;
  targetAssetExists: boolean;
}

export interface HistoryRestartSeedEvidence {
  scenario: "history-restart-seed";
  targetPath: string;
  documentId: string;
  versionAId: string;
  versionBId: string;
  sceneASha256: string;
  sceneBSha256: string;
  assetSha256: string;
  versionCount: number;
  historyDatabasePath: string;
}

export interface HistoryRestartRestoreEvidence {
  scenario: "history-restart-restore";
  requestId: string;
  targetVersionId: string;
  targetPath: string;
  targetSceneSha256: string;
  persistedSceneSha256: string;
  adoptedSceneSha256?: string;
  protectionVersionId?: string;
  operationState: string;
  operationStatusState: string;
  targetAssetSha256: string;
  response: Record<string, unknown>;
}

export interface HistoryRestartVerifyEvidence {
  scenario: "history-restart-verify";
  requestId: string;
  targetVersionId: string;
  targetPath: string;
  persistedSceneSha256: string;
  statusSceneSha256?: string;
  statusState: string;
  protectionVersionId?: string;
  listedVersionIds: string[];
  previewSceneSha256?: string;
  targetAssetSha256: string;
  targetObjectExists: boolean;
  targetAssetExists: boolean;
}

export interface HistoryRestartEvictEvidence {
  scenario: "history-restart-evict";
  requestId: string;
  retainedVersionCount: number;
  evictedVersionId: string;
  operationStatusState: string;
  targetSceneSha256: string;
  targetAssetSha256: string;
  targetObjectExistsAfterGc: boolean;
  targetAssetExistsAfterGc: boolean;
  gcDeletedTarget: boolean;
}

export interface HistoryFrontendCanvasEvidence {
  scenario: "history-frontend-adoption";
  requestId: string;
  targetVersionId: string;
  documentId: string;
  adopted: true;
  canvasReadback: {
    elementIds: string[];
    elementTypes: string[];
    appState: Record<string, unknown>;
    assetHashes: Record<string, string>;
  };
}

interface HistoryFrontendErrorEvidence {
  scenario: "history-frontend-error";
  error: string;
}

export interface HistoryRestartJourneyEvidence {
  seed: HistoryRestartSeedEvidence;
  frontendB: HistoryFrontendCanvasEvidence;
  verifyB: HistoryRestartVerifyEvidence;
  frontendA: HistoryFrontendCanvasEvidence;
  verifyA: HistoryRestartVerifyEvidence;
  evict: HistoryRestartEvictEvidence;
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

async function runTauriHistoryFrontendAdoption(
  binary: string,
  paths: IsolatedDesktopPaths,
  targetVersionId: string,
  requestId: string,
): Promise<HistoryFrontendCanvasEvidence> {
  const markerPath = join(
    paths.runtime,
    "reliability",
    "history-frontend.ready.json",
  );
  const targetPath = join(paths.workspace, "history-restart.excalidraw");
  const child = spawn(binary, [targetPath], {
    detached: process.platform !== "win32",
    env: isolatedDesktopEnvironment(paths, {
      EXCALIDRAW_E2E_HISTORY_FRONTEND: "1",
      EXCALIDRAW_E2E_HISTORY_DOCUMENT_PATH: targetPath,
      EXCALIDRAW_E2E_HISTORY_TARGET_VERSION: targetVersionId,
      EXCALIDRAW_E2E_HISTORY_REQUEST_ID: requestId,
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.setEncoding("utf8");
  let stderr = "";
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-16_384);
  });
  try {
    const marker = await waitForHistoryFrontendEvidence(
      child,
      markerPath,
      30_000,
    );
    await terminateReliabilityChild(child);
    if (marker.scenario === "history-frontend-error") {
      throw new Error(`Frontend driver error: ${marker.error}`);
    }
    if (marker.scenario !== "history-frontend-adoption") {
      throw new Error(
        "History frontend driver published an unexpected scenario.",
      );
    }
    for (const hash of Object.values(marker.canvasReadback.assetHashes)) {
      const assetPath = join(paths.workspace, ".excalidraw_assets", hash);
      const bytes = await readFile(assetPath);
      if (sha256(bytes) !== hash) {
        throw new Error(
          `History frontend asset materialization hash mismatch: ${assetPath}`,
        );
      }
    }
    return marker;
  } catch (error) {
    await terminateReliabilityChild(child);
    throw new Error(
      `History frontend adoption failed: ${error instanceof Error ? error.message : String(error)}${stderr ? `\napp stderr tail:\n${stderr}` : ""}`,
      { cause: error },
    );
  }
}

async function waitForHistoryFrontendEvidence(
  child: ReturnType<typeof spawn>,
  markerPath: string,
  timeoutMs: number,
): Promise<HistoryFrontendCanvasEvidence | HistoryFrontendErrorEvidence> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `History frontend process exited before evidence (code=${child.exitCode}, signal=${child.signalCode}).`,
      );
    }
    try {
      const evidence: unknown = JSON.parse(await readFile(markerPath, "utf8"));
      if (
        typeof evidence === "object" &&
        evidence !== null &&
        "scenario" in evidence &&
        (evidence.scenario === "history-frontend-adoption" ||
          evidence.scenario === "history-frontend-error")
      ) {
        return evidence as
          HistoryFrontendCanvasEvidence | HistoryFrontendErrorEvidence;
      }
      throw new Error("History frontend evidence shape is invalid.");
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" ||
        error instanceof SyntaxError
      ) {
        await delay(25);
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    `History frontend evidence did not arrive within ${timeoutMs} ms.`,
  );
}

async function terminateReliabilityChild(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await waitForChildExit(child, 10_000);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    await waitForChildExit(child, 2_000);
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
 * Run one History transaction barrier, terminate the process at the exact
 * marker, then start a fresh probe process with the same isolated root.  The
 * helper deliberately performs no sleeps and classifies only exact bytes/
 * hashes.  T013/T014 product hooks use the same environment contract when
 * this fixture is replaced by a real operation journey.
 */
export async function runTauriHistoryFaultKill(
  stage: HistoryFaultStage,
  options: {
    seed?: string;
    operationId?: string;
    documentId?: string;
    oldSceneJson?: string;
    newSceneJson?: string;
  } = {},
): Promise<ReliabilityRun<HistoryFaultKillEvidence>> {
  const binary = await resolveDesktopBinary();
  const paths = await createIsolatedDesktopPaths();
  const targetPath = join(paths.workspace, "history-fault.excalidraw");
  const oldSceneJson = options.oldSceneJson ?? '{"version":2,"state":"old"}';
  const newSceneJson = options.newSceneJson ?? '{"version":2,"state":"new"}';
  const seed = options.seed ?? "deterministic";
  const operationId = options.operationId ?? `history-operation-${seed}`;
  const documentId = options.documentId ?? `history-document-${seed}`;
  const oldSha256 = sha256(oldSceneJson);
  const newSha256 = sha256(newSceneJson);
  try {
    await writeFile(targetPath, oldSceneJson, "utf8");
  } catch (error) {
    await cleanupIsolatedDesktopPaths(paths);
    throw error;
  }

  const controlDirectory = join(paths.runtime, "reliability");
  const readyPath = join(controlDirectory, "history-fault.ready.json");
  const child = spawn(
    binary,
    [RELIABILITY_SCENARIO_FLAG, "history-fault-kill"],
    {
      detached: process.platform !== "win32",
      env: isolatedDesktopEnvironment(paths, {
        ...historyFaultEnvironment({
          stage,
          seed,
          operationId,
          documentId,
          targetPath,
          oldSha256,
          newSha256,
        }),
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
    const readyMarker = await waitForHistoryFaultReady(
      child,
      readyPath,
      stage,
      15_000,
    );
    if (readyMarker.context.targetPath !== targetPath) {
      throw new Error(
        `History fault target escaped fixture: ${readyMarker.context.targetPath}`,
      );
    }
    terminate();
    killed = true;
    await waitForChildExit(child, 5_000);

    const afterRestart = await runHistoryStateProbe(
      binary,
      paths,
      targetPath,
      oldSha256,
      newSha256,
    );
    const filesystem = await statfs(paths.workspace);
    const binarySha256 = sha256(await readFile(binary));
    return {
      evidence: {
        scenario: "history-fault-kill",
        stage,
        seed,
        processSignal: child.signalCode,
        targetPath,
        oldSha256,
        newSha256,
        beforeState: "old",
        afterRestart,
        readyMarker,
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
 * Run a real HistoryReplacementService operation until its configured native
 * barrier, kill it, then reconcile and query status from a fresh process in
 * the same isolated root.  The operation driver is test-only native code; no
 * browser-local state is used for these assertions.
 */
export async function runTauriHistoryOperationFaultKill(
  stage: HistoryFaultStage,
  options: { seed?: string; operationId?: string } = {},
): Promise<ReliabilityRun<HistoryOperationFaultProbeEvidence>> {
  const binary = await resolveDesktopBinary();
  const paths = await createIsolatedDesktopPaths();
  const targetPath = join(
    paths.workspace,
    "history-fault-operation.excalidraw",
  );
  const seed = options.seed ?? `t025-operation-${stage}`;
  const operationId = options.operationId ?? `history-fault-operation-${seed}`;
  const controlDirectory = join(paths.runtime, "reliability");
  const readyPath = join(controlDirectory, "history-fault.ready.json");
  const child = spawn(
    binary,
    [RELIABILITY_SCENARIO_FLAG, "history-operation-fault-kill"],
    {
      detached: process.platform !== "win32",
      env: isolatedDesktopEnvironment(paths, {
        ...historyFaultEnvironment({
          stage,
          seed,
          operationId,
          documentId: `history-document-${seed}`,
          targetPath,
        }),
        EXCALIDRAW_E2E_HISTORY_FAULT_ARMED: "0",
      }),
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  let cleaned = false;
  let killed = false;
  const terminate = (): void => {
    if (child.pid === undefined || child.exitCode !== null) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") throw error;
    }
  };
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    if (!killed) {
      terminate();
      await waitForChildExit(child, 2_000);
    }
    await cleanupIsolatedDesktopPaths(paths);
  };
  try {
    const readyMarker = await waitForHistoryFaultReady(
      child,
      readyPath,
      stage,
      15_000,
    );
    if (readyMarker.context.targetPath !== targetPath) {
      throw new Error(
        `History operation fault target escaped fixture: ${readyMarker.context.targetPath}`,
      );
    }
    terminate();
    killed = true;
    await waitForChildExit(child, 5_000);
    if (child.signalCode !== "SIGKILL") {
      throw new Error(
        `History operation fault process did not terminate by SIGKILL: ${child.signalCode}`,
      );
    }
    const probe = await runHistoryOperationProbeProcess(binary, paths, {
      EXCALIDRAW_E2E_HISTORY_FAULT_STAGE: stage,
      EXCALIDRAW_E2E_HISTORY_FAULT_MODE: "record",
      EXCALIDRAW_E2E_HISTORY_FAULT_ARMED: "0",
      EXCALIDRAW_E2E_HISTORY_FAULT_SEED: seed,
      EXCALIDRAW_E2E_HISTORY_OPERATION_ID: operationId,
      EXCALIDRAW_E2E_HISTORY_DOCUMENT_ID: `history-document-${seed}`,
      EXCALIDRAW_E2E_HISTORY_TARGET_PATH: targetPath,
    });
    const filesystem = await statfs(paths.workspace);
    return {
      evidence: {
        ...probe,
        processSignal: child.signalCode,
        readyMarkerPid: readyMarker.pid,
      },
      environment: {
        platform: process.platform,
        architecture: process.arch,
        filesystemType: String(filesystem.type),
        binaryPath: binary,
        binarySha256: sha256(await readFile(binary)),
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

export async function runTauriHistoryOperationFailure(
  failureMode: string,
): Promise<ReliabilityRun<HistoryOperationFailureEvidence>> {
  return runHistoryOperationResultProcess("history-operation-failure", {
    EXCALIDRAW_E2E_HISTORY_FAILURE_MODE: failureMode,
    EXCALIDRAW_E2E_HISTORY_OPERATION_ID: `history-fault-failure-${failureMode}`,
    EXCALIDRAW_E2E_HISTORY_TARGET_PATH: "",
  });
}

export async function runTauriHistoryOperationConcurrency(): Promise<
  ReliabilityRun<HistoryOperationConcurrencyEvidence>
> {
  return runHistoryOperationResultProcess("history-operation-concurrency", {
    EXCALIDRAW_E2E_HISTORY_OPERATION_ID: "history-concurrent-same",
    EXCALIDRAW_E2E_HISTORY_TARGET_PATH: "",
  });
}

async function runHistoryOperationProbeProcess(
  binary: string,
  paths: IsolatedDesktopPaths,
  overrides: Readonly<NodeJS.ProcessEnv>,
): Promise<HistoryOperationFaultProbeEvidence> {
  return runHistoryOperationResultProcessWithPaths(
    binary,
    paths,
    "history-operation-fault-probe",
    overrides,
  );
}

async function runHistoryOperationResultProcess(
  scenario: "history-operation-failure",
  overrides: Readonly<NodeJS.ProcessEnv>,
): Promise<ReliabilityRun<HistoryOperationFailureEvidence>>;
async function runHistoryOperationResultProcess(
  scenario: "history-operation-concurrency",
  overrides: Readonly<NodeJS.ProcessEnv>,
): Promise<ReliabilityRun<HistoryOperationConcurrencyEvidence>>;
async function runHistoryOperationResultProcess(
  scenario: "history-operation-failure" | "history-operation-concurrency",
  overrides: Readonly<NodeJS.ProcessEnv>,
): Promise<
  ReliabilityRun<
    HistoryOperationFailureEvidence | HistoryOperationConcurrencyEvidence
  >
> {
  const binary = await resolveDesktopBinary();
  const paths = await createIsolatedDesktopPaths();
  let cleaned = false;
  try {
    const evidence = await runHistoryOperationResultProcessWithPaths(
      binary,
      paths,
      scenario,
      {
        ...overrides,
        EXCALIDRAW_E2E_HISTORY_TARGET_PATH: join(
          paths.workspace,
          "history-fault-operation.excalidraw",
        ),
      },
    );
    const filesystem = await statfs(paths.workspace);
    return {
      evidence,
      environment: {
        platform: process.platform,
        architecture: process.arch,
        filesystemType: String(filesystem.type),
        binaryPath: binary,
        binarySha256: sha256(await readFile(binary)),
        seed: "deterministic",
      },
      paths,
      async cleanup(): Promise<void> {
        if (cleaned) return;
        cleaned = true;
        await cleanupIsolatedDesktopPaths(paths);
      },
    };
  } catch (error) {
    await cleanupIsolatedDesktopPaths(paths);
    throw error;
  }
}

async function runHistoryOperationResultProcessWithPaths(
  binary: string,
  paths: IsolatedDesktopPaths,
  scenario: "history-operation-fault-probe",
  overrides: Readonly<NodeJS.ProcessEnv>,
): Promise<HistoryOperationFaultProbeEvidence>;
async function runHistoryOperationResultProcessWithPaths(
  binary: string,
  paths: IsolatedDesktopPaths,
  scenario: "history-operation-failure",
  overrides: Readonly<NodeJS.ProcessEnv>,
): Promise<HistoryOperationFailureEvidence>;
async function runHistoryOperationResultProcessWithPaths(
  binary: string,
  paths: IsolatedDesktopPaths,
  scenario: "history-operation-concurrency",
  overrides: Readonly<NodeJS.ProcessEnv>,
): Promise<HistoryOperationConcurrencyEvidence>;
async function runHistoryOperationResultProcessWithPaths(
  binary: string,
  paths: IsolatedDesktopPaths,
  scenario: "history-operation-failure" | "history-operation-concurrency",
  overrides: Readonly<NodeJS.ProcessEnv>,
): Promise<
  HistoryOperationFailureEvidence | HistoryOperationConcurrencyEvidence
>;
async function runHistoryOperationResultProcessWithPaths(
  binary: string,
  paths: IsolatedDesktopPaths,
  scenario:
    | "history-operation-fault-probe"
    | "history-operation-failure"
    | "history-operation-concurrency",
  overrides: Readonly<NodeJS.ProcessEnv>,
): Promise<
  | HistoryOperationFaultProbeEvidence
  | HistoryOperationFailureEvidence
  | HistoryOperationConcurrencyEvidence
> {
  const child = spawn(binary, [RELIABILITY_SCENARIO_FLAG, scenario], {
    env: isolatedDesktopEnvironment(paths, overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `History operation scenario ${scenario} exceeded ${SCENARIO_TIMEOUT_MS} ms.`,
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
      `History operation scenario ${scenario} exited with ${exitCode}: ${stderr.trim()}`,
    );
  }
  const evidenceLine = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (evidenceLine === undefined) {
    throw new Error(
      `History operation scenario ${scenario} produced no evidence.`,
    );
  }
  const evidence: unknown = JSON.parse(evidenceLine);
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    !("scenario" in evidence) ||
    evidence.scenario !== scenario
  ) {
    throw new Error(`History operation scenario mismatch for ${scenario}.`);
  }
  return evidence as
    | HistoryOperationFaultProbeEvidence
    | HistoryOperationFailureEvidence
    | HistoryOperationConcurrencyEvidence;
}

/**
 * Execute the native history success journey as separate processes sharing
 * one isolated root. Each phase opens the production HistoryStore/query and
 * protected replacement services again; no browser-local state is involved.
 */
export async function runTauriHistoryRestartJourney(): Promise<
  ReliabilityRun<HistoryRestartJourneyEvidence>
> {
  const binary = await resolveDesktopBinary();
  const paths = await createIsolatedDesktopPaths();
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    await cleanupIsolatedDesktopPaths(paths);
  };
  try {
    const seed = await runHistoryRestartProcess(
      binary,
      paths,
      "history-restart-seed",
    );
    const frontendB = await runTauriHistoryFrontendAdoption(
      binary,
      paths,
      seed.versionBId,
      "history-restart-b",
    );
    const verifyB = await runHistoryRestartProcess(
      binary,
      paths,
      "history-restart-verify",
      {
        EXCALIDRAW_E2E_HISTORY_TARGET_VERSION: seed.versionBId,
        EXCALIDRAW_E2E_HISTORY_REQUEST_ID: "history-restart-b",
      },
    );
    const frontendA = await runTauriHistoryFrontendAdoption(
      binary,
      paths,
      seed.versionAId,
      "history-restart-a",
    );
    const verifyA = await runHistoryRestartProcess(
      binary,
      paths,
      "history-restart-verify",
      {
        EXCALIDRAW_E2E_HISTORY_TARGET_VERSION: seed.versionAId,
        EXCALIDRAW_E2E_HISTORY_REQUEST_ID: "history-restart-a",
      },
    );
    const evict = await runHistoryRestartProcess(
      binary,
      paths,
      "history-restart-evict",
      {
        EXCALIDRAW_E2E_HISTORY_REQUEST_ID: "history-restart-a",
        EXCALIDRAW_E2E_HISTORY_TARGET_VERSION: seed.versionAId,
      },
    );
    const filesystem = await statfs(paths.workspace);
    return {
      evidence: { seed, frontendB, verifyB, frontendA, verifyA, evict },
      environment: {
        platform: process.platform,
        architecture: process.arch,
        filesystemType: String(filesystem.type),
        binaryPath: binary,
        binarySha256: sha256(await readFile(binary)),
        seed: "deterministic",
      },
      paths,
      cleanup,
    };
  } catch (error) {
    await cleanup();
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

type HistoryRestartProcessScenario =
  | "history-restart-seed"
  | "history-restart-restore"
  | "history-restart-verify"
  | "history-restart-evict";

async function runHistoryRestartProcess(
  binary: string,
  paths: IsolatedDesktopPaths,
  scenario: "history-restart-seed",
  overrides?: Readonly<NodeJS.ProcessEnv>,
): Promise<HistoryRestartSeedEvidence>;
async function runHistoryRestartProcess(
  binary: string,
  paths: IsolatedDesktopPaths,
  scenario: "history-restart-restore",
  overrides?: Readonly<NodeJS.ProcessEnv>,
): Promise<HistoryRestartRestoreEvidence>;
async function runHistoryRestartProcess(
  binary: string,
  paths: IsolatedDesktopPaths,
  scenario: "history-restart-verify",
  overrides?: Readonly<NodeJS.ProcessEnv>,
): Promise<HistoryRestartVerifyEvidence>;
async function runHistoryRestartProcess(
  binary: string,
  paths: IsolatedDesktopPaths,
  scenario: "history-restart-evict",
  overrides?: Readonly<NodeJS.ProcessEnv>,
): Promise<HistoryRestartEvictEvidence>;
async function runHistoryRestartProcess(
  binary: string,
  paths: IsolatedDesktopPaths,
  scenario: HistoryRestartProcessScenario,
  overrides: Readonly<NodeJS.ProcessEnv> = {},
): Promise<
  | HistoryRestartSeedEvidence
  | HistoryRestartRestoreEvidence
  | HistoryRestartVerifyEvidence
  | HistoryRestartEvictEvidence
> {
  const child = spawn(binary, [RELIABILITY_SCENARIO_FLAG, scenario], {
    env: isolatedDesktopEnvironment(paths, overrides),
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
          `History restart scenario ${scenario} exceeded ${SCENARIO_TIMEOUT_MS} ms.`,
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
      `History restart scenario ${scenario} exited with ${exitCode}: ${stderr.trim()}`,
    );
  }
  const evidenceLine = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (evidenceLine === undefined) {
    throw new Error(
      `History restart scenario ${scenario} produced no evidence.`,
    );
  }
  const evidence: unknown = JSON.parse(evidenceLine);
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    !("scenario" in evidence) ||
    evidence.scenario !== scenario
  ) {
    throw new Error(`History restart scenario mismatch for ${scenario}.`);
  }
  return evidence as
    | HistoryRestartSeedEvidence
    | HistoryRestartRestoreEvidence
    | HistoryRestartVerifyEvidence
    | HistoryRestartEvictEvidence;
}

async function waitForHistoryFaultReady(
  child: ReturnType<typeof spawn>,
  markerPath: string,
  stage: HistoryFaultStage,
  timeoutMs: number,
): Promise<HistoryFaultReadyMarker> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `History fault fixture exited before its barrier (code=${child.exitCode}, signal=${child.signalCode}).`,
      );
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(markerPath, "utf8"));
      if (!isHistoryFaultReadyMarker(parsed)) {
        throw new Error("History fault fixture published an invalid marker.");
      }
      if (parsed.stage !== stage) {
        throw new Error(
          `History fault stage mismatch: requested ${stage}, received ${parsed.stage}.`,
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
    `History fault fixture did not publish its barrier within ${timeoutMs} ms.`,
  );
}

async function runHistoryStateProbe(
  binary: string,
  paths: IsolatedDesktopPaths,
  targetPath: string,
  oldSha256: string,
  newSha256: string,
): Promise<HistoryStateProbeEvidence> {
  const child = spawn(
    binary,
    [RELIABILITY_SCENARIO_FLAG, "history-state-probe"],
    {
      env: isolatedDesktopEnvironment(paths, {
        EXCALIDRAW_E2E_HISTORY_TARGET_PATH: targetPath,
        EXCALIDRAW_E2E_HISTORY_OLD_SHA256: oldSha256,
        EXCALIDRAW_E2E_HISTORY_NEW_SHA256: newSha256,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
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
      reject(new Error("History state probe exceeded 15 seconds."));
    }, 15_000);
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
      `History state probe exited with ${exitCode}: ${stderr.trim()}`,
    );
  }
  const evidenceLine = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!evidenceLine) {
    throw new Error("History state probe produced no evidence.");
  }
  const evidence: unknown = JSON.parse(evidenceLine);
  if (
    typeof evidence !== "object" ||
    evidence === null ||
    !("scenario" in evidence) ||
    evidence.scenario !== "history-state-probe"
  ) {
    throw new Error("History state probe returned an invalid scenario.");
  }
  return evidence as HistoryStateProbeEvidence;
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
