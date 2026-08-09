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
] as const;

export type E2eHarnessCommand = (typeof E2E_HARNESS_COMMANDS)[number];

const E2E_HARNESS_ARTIFACT_TOKENS = [
  ...E2E_HARNESS_COMMANDS,
  ...E2E_PERFORMANCE_COMMANDS,
  "--e2e-reliability-scenario",
  "EXCALIDRAW_PERF_CONTROL_DIR",
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
