import { readFile } from "node:fs/promises";

export const ATOMIC_WRITE_FAULT_POINTS = [
  "temp_created",
  "mid_write",
  "temp_synced",
  "json_validated",
  "before_rename",
  "after_rename",
  "before_parent_sync",
  "parent_synced",
] as const;

export type AtomicWriteFaultPoint = (typeof ATOMIC_WRITE_FAULT_POINTS)[number];

/** Shared process-level History transaction barriers owned by T015. */
export const HISTORY_FAULT_STAGES = [
  "object_publish",
  "protection_commit",
  "intent_commit",
  "after_rename_before_parent_sync",
  "metadata_complete_before_frontend_ack",
  "eviction_delete_gc",
  "rename_delete_repair",
] as const;

export type HistoryFaultStage = (typeof HISTORY_FAULT_STAGES)[number];

/**
 * Native process matrix metadata.  The stage is a real product barrier when
 * reached from a replacement/reconciliation journey; the current standalone
 * process fixture only proves that the barrier/kill/restart protocol itself is
 * deterministic.  Keep this mapping data-only so tests cannot silently turn
 * a barrier marker into a claimed replacement outcome.
 */
export const HISTORY_FAULT_MATRIX = [
  {
    stage: "object_publish",
    boundary: "history object publication",
  },
  {
    stage: "protection_commit",
    boundary: "protection SQLite commit",
  },
  {
    stage: "intent_commit",
    boundary: "replacement intent SQLite commit",
  },
  {
    stage: "after_rename_before_parent_sync",
    boundary: "target rename before parent-directory sync",
  },
  {
    stage: "metadata_complete_before_frontend_ack",
    boundary: "metadata complete before frontend acknowledgement",
  },
  {
    stage: "eviction_delete_gc",
    boundary: "eviction delete / reachability GC",
  },
  {
    stage: "rename_delete_repair",
    boundary: "restart rename/delete metadata repair",
  },
] as const satisfies ReadonlyArray<{
  stage: HistoryFaultStage;
  boundary: string;
}>;

export interface HistoryFaultContext {
  readonly operationId: string;
  readonly documentId: string;
  readonly targetPath: string;
  readonly oldSha256?: string;
  readonly newSha256?: string;
}

export interface HistoryFaultReadyMarker {
  readonly scenario: "history-fault-kill";
  readonly stage: HistoryFaultStage;
  readonly seed: string;
  readonly pid: number;
  readonly context: HistoryFaultContext;
}

export interface HistoryFaultEnvironment extends HistoryFaultContext {
  readonly stage: HistoryFaultStage;
  readonly seed: string;
}

export const E2E_HARNESS_COMMANDS = [
  "e2e_set_atomic_write_fault",
  "e2e_clear_atomic_write_fault",
  "e2e_corrupt_latest_snapshot",
] as const;

const E2E_PERFORMANCE_COMMANDS = [
  "e2e_perf_bootstrap",
  "e2e_perf_publish_ready",
  "e2e_perf_next_command",
  "e2e_perf_publish_result",
  "e2e_perf_publish_error",
] as const;

export type E2eHarnessCommand = (typeof E2E_HARNESS_COMMANDS)[number];

const E2E_HARNESS_ARTIFACT_TOKENS = [
  ...E2E_HARNESS_COMMANDS,
  ...E2E_PERFORMANCE_COMMANDS,
  "--e2e-reliability-scenario",
  "EXCALIDRAW_PERF_CONTROL_DIR",
  "history_fault_barrier",
] as const;

export type Invoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export interface FaultHarness {
  setAtomicWriteFault(point: AtomicWriteFaultPoint): Promise<void>;
  clearAtomicWriteFault(): Promise<void>;
  corruptLatestSnapshot(documentPath: string): Promise<void>;
}

export function historyFaultEnvironment(
  configuration: HistoryFaultEnvironment,
): Readonly<NodeJS.ProcessEnv> {
  return {
    EXCALIDRAW_E2E_HISTORY_FAULT_ARMED: "1",
    EXCALIDRAW_E2E_HISTORY_FAULT_STAGE: configuration.stage,
    EXCALIDRAW_E2E_HISTORY_FAULT_SEED: configuration.seed,
    EXCALIDRAW_E2E_HISTORY_OPERATION_ID: configuration.operationId,
    EXCALIDRAW_E2E_HISTORY_DOCUMENT_ID: configuration.documentId,
    EXCALIDRAW_E2E_HISTORY_TARGET_PATH: configuration.targetPath,
    ...(configuration.oldSha256 === undefined
      ? {}
      : { EXCALIDRAW_E2E_HISTORY_OLD_SHA256: configuration.oldSha256 }),
    ...(configuration.newSha256 === undefined
      ? {}
      : { EXCALIDRAW_E2E_HISTORY_NEW_SHA256: configuration.newSha256 }),
  };
}

export function isHistoryFaultReadyMarker(
  value: unknown,
): value is HistoryFaultReadyMarker {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const context = record.context;
  if (typeof context !== "object" || context === null) {
    return false;
  }
  const contextRecord = context as Record<string, unknown>;
  return (
    record.scenario === "history-fault-kill" &&
    typeof record.stage === "string" &&
    (HISTORY_FAULT_STAGES as readonly string[]).includes(record.stage) &&
    typeof record.seed === "string" &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    typeof contextRecord.operationId === "string" &&
    typeof contextRecord.documentId === "string" &&
    typeof contextRecord.targetPath === "string" &&
    (contextRecord.oldSha256 === undefined ||
      typeof contextRecord.oldSha256 === "string") &&
    (contextRecord.newSha256 === undefined ||
      typeof contextRecord.newSha256 === "string")
  );
}

export function createFaultHarness(invoke: Invoke): FaultHarness {
  return {
    async setAtomicWriteFault(point): Promise<void> {
      await invoke<void>("e2e_set_atomic_write_fault", { point });
    },
    async clearAtomicWriteFault(): Promise<void> {
      await invoke<void>("e2e_clear_atomic_write_fault", {});
    },
    async corruptLatestSnapshot(documentPath): Promise<void> {
      await invoke<void>("e2e_corrupt_latest_snapshot", { documentPath });
    },
  };
}

function isUnavailableCommandError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(unknown command|command .* not found|not allowed|unavailable)/i.test(
    message,
  );
}

/** Runtime assertion for a production app reached through a native automation bridge. */
export async function assertProductionFaultHarnessUnavailable(
  invoke: Invoke,
): Promise<void> {
  const probes: ReadonlyArray<
    readonly [E2eHarnessCommand, Record<string, unknown>]
  > = [
    ["e2e_set_atomic_write_fault", { point: "temp_created" }],
    ["e2e_clear_atomic_write_fault", {}],
    ["e2e_corrupt_latest_snapshot", { documentPath: "/nonexistent" }],
  ];

  for (const [command, args] of probes) {
    try {
      await invoke<unknown>(command, args);
    } catch (error) {
      if (isUnavailableCommandError(error)) {
        continue;
      }
      throw new Error(
        `Production harness probe ${command} failed for an unexpected reason.`,
        { cause: error },
      );
    }
    throw new Error(`Production build exposed test-only command ${command}.`);
  }
}

/**
 * Build-artifact assertion used when no native IPC automation bridge is available.
 * It proves the production executable does not contain the registered command names;
 * it does not replace the runtime assertion above.
 */
export async function assertProductionBinaryOmitsFaultHarness(
  binaryPath: string,
): Promise<void> {
  const executable = await readFile(binaryPath);
  const exposed = E2E_HARNESS_ARTIFACT_TOKENS.filter((token) =>
    executable.includes(Buffer.from(token)),
  );
  if (exposed.length > 0) {
    throw new Error(
      `Production executable contains test-only harness commands: ${exposed.join(", ")}`,
    );
  }
}
