import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const CONTRACT_SCHEMA_VERSION = "1.0.0";
const CONTROL_ROOT_PREFIX = "excalidraw-desktop-perf-control-";

export type PerformanceScenario =
  "startup-editable" | "canvas-10k" | "edit-soak";

export interface PerformanceBootstrap {
  schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  scenario: PerformanceScenario;
  fixturePath?: string;
  seed: number;
}

export interface PerformanceReadySignal {
  schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  scenario: PerformanceScenario;
  editorReady: true;
  editable: true;
  elementCount: number;
  visibilityState: "visible";
}

export interface PerformanceCommand {
  schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  commandId: string;
  operation: "pan-zoom" | "high-frequency-edit" | "edit-soak";
  durationMs: number;
  seed: number;
  targetEvents?: number;
}

export interface PerformanceCommandResult {
  schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  commandId: string;
  operation: PerformanceCommand["operation"];
  completed: true;
  durationMs: number;
  eventCount: number;
  frameIntervalsMs: number[];
  visibilityState: "visible";
  frameClock: "requestAnimationFrame-performance.now";
}

/**
 * Filesystem contract for the test-only native performance driver.
 *
 * The application must only consume this contract in an `e2e-harness` build.
 * It writes ready.json after the Excalidraw imperative API accepts edits, then
 * watches command.json and atomically publishes result.json. Production builds
 * must ignore EXCALIDRAW_PERF_CONTROL_DIR.
 */
export class NativePerformanceControl {
  readonly root: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly bootstrap: PerformanceBootstrap;

  private constructor(root: string, bootstrap: PerformanceBootstrap) {
    this.root = root;
    this.bootstrap = bootstrap;
    this.environment = { EXCALIDRAW_PERF_CONTROL_DIR: root };
  }

  static async create(
    bootstrap: Omit<PerformanceBootstrap, "schemaVersion">,
  ): Promise<NativePerformanceControl> {
    const root = await mkdtemp(join(tmpdir(), CONTROL_ROOT_PREFIX));
    const completeBootstrap: PerformanceBootstrap = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      ...bootstrap,
    };
    await writeJsonAtomically(join(root, "bootstrap.json"), completeBootstrap);
    return new NativePerformanceControl(root, completeBootstrap);
  }

  async waitForReady(timeoutMs: number): Promise<PerformanceReadySignal> {
    const value = await waitForJson(join(this.root, "ready.json"), timeoutMs);
    return validateReadySignal(value, this.bootstrap.scenario);
  }

  async sendCommand(
    command: Omit<PerformanceCommand, "schemaVersion" | "commandId">,
  ): Promise<PerformanceCommand> {
    const completeCommand: PerformanceCommand = {
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      commandId: randomUUID(),
      ...command,
    };
    await removeIfPresent(join(this.root, "result.json"));
    await writeJsonAtomically(join(this.root, "command.json"), completeCommand);
    return completeCommand;
  }

  async waitForResult(
    command: PerformanceCommand,
    timeoutMs: number,
  ): Promise<PerformanceCommandResult> {
    const value = await waitForJson(join(this.root, "result.json"), timeoutMs);
    return validateCommandResult(value, command);
  }

  async dispose(): Promise<void> {
    const expectedPrefix = join(tmpdir(), CONTROL_ROOT_PREFIX);
    if (!this.root.startsWith(expectedPrefix)) {
      throw new Error(
        `Refusing to remove unexpected control root: ${this.root}`,
      );
    }
    await rm(this.root, { recursive: true, force: true });
  }
}

async function waitForJson(path: string, timeoutMs: number): Promise<unknown> {
  const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1_000_000n;
  let lastParseError: unknown;
  while (process.hrtime.bigint() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        lastParseError = error;
      }
      await delay(25);
    }
  }
  const detail =
    lastParseError instanceof Error
      ? ` Last parse error: ${lastParseError.message}`
      : "";
  throw new Error(
    `Native performance contract did not publish ${basename(path)} within ${timeoutMs} ms.${detail}`,
  );
}

function validateReadySignal(
  value: unknown,
  scenario: PerformanceScenario,
): PerformanceReadySignal {
  if (!isRecord(value)) {
    throw new Error("Native performance ready signal must be an object.");
  }
  if (
    value.schemaVersion !== CONTRACT_SCHEMA_VERSION ||
    value.scenario !== scenario ||
    value.editorReady !== true ||
    value.editable !== true ||
    !isNonNegativeInteger(value.elementCount) ||
    value.visibilityState !== "visible"
  ) {
    throw new Error(
      "Native performance ready signal is invalid or does not prove an editable canvas.",
    );
  }
  return value as unknown as PerformanceReadySignal;
}

function validateCommandResult(
  value: unknown,
  command: PerformanceCommand,
): PerformanceCommandResult {
  if (!isRecord(value)) {
    throw new Error("Native performance command result must be an object.");
  }
  const intervalsValid =
    Array.isArray(value.frameIntervalsMs) &&
    value.frameIntervalsMs.every(
      (interval) => typeof interval === "number" && interval >= 0,
    );
  if (
    value.schemaVersion !== CONTRACT_SCHEMA_VERSION ||
    value.commandId !== command.commandId ||
    value.operation !== command.operation ||
    value.completed !== true ||
    typeof value.durationMs !== "number" ||
    value.durationMs < command.durationMs ||
    !isNonNegativeInteger(value.eventCount) ||
    !intervalsValid ||
    value.visibilityState !== "visible" ||
    value.frameClock !== "requestAnimationFrame-performance.now"
  ) {
    throw new Error(
      `Native performance result for ${command.operation} is invalid or incomplete.`,
    );
  }
  if (command.operation !== "edit-soak") {
    const coveredDurationMs = (value.frameIntervalsMs as number[]).reduce(
      (sum, interval) => sum + interval,
      0,
    );
    if (
      coveredDurationMs < command.durationMs * 0.95 ||
      coveredDurationMs > Number(value.durationMs) + 1_000
    ) {
      throw new Error(
        `Native frame timing for ${command.operation} does not cover the requested visible workload window.`,
      );
    }
  }
  return value as unknown as PerformanceCommandResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
