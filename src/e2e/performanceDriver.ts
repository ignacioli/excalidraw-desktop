import {
  documentManager,
  type DocumentManager,
} from "../documents/documentStore";
import type { ExcalidrawAdapter } from "../editor/ExcalidrawAdapter";

const CONTRACT_SCHEMA_VERSION = "1.0.0" as const;
const TEN_THOUSAND_ELEMENT_SCENARIOS = new Set<PerformanceScenario>([
  "canvas-10k",
  "edit-soak",
]);
const COMMAND_POLL_INTERVAL_MS = 25;
const SOAK_EDIT_INTERVAL_MS = 250;

export type PerformanceScenario =
  "startup-editable" | "canvas-10k" | "edit-soak";

export interface PerformanceBootstrap {
  schemaVersion: typeof CONTRACT_SCHEMA_VERSION;
  scenario: PerformanceScenario;
  seed: number;
  documentPath: string;
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

interface PerformanceControl {
  bootstrap(): Promise<PerformanceBootstrap | null>;
  publishReady(ready: PerformanceReadySignal): Promise<void>;
  nextCommand(): Promise<PerformanceCommand | null>;
  publishResult(result: PerformanceCommandResult): Promise<void>;
}

export interface PerformanceEditor {
  isEditable(): boolean;
  getLiveElementCount(): number;
  applyPerformanceViewport(seed: number, frameIndex: number): void;
  applyPerformanceEdit(seed: number, editIndex: number): boolean;
}

interface AttachedEditor {
  documentId: string;
  adapter: PerformanceEditor;
  container: HTMLElement;
}

export interface PerformanceClock {
  now(): number;
  requestFrame(callback: FrameRequestCallback): number;
  visibilityState(): DocumentVisibilityState;
}

interface PerformanceDriverDependencies {
  control: PerformanceControl;
  documents: Pick<DocumentManager, "open">;
  clock: PerformanceClock;
  wait(milliseconds: number): Promise<void>;
  isNativeRuntime(): boolean;
  reportError(error: unknown): void;
}

export class NativePerformanceDriver {
  private readonly dependencies: PerformanceDriverDependencies;
  private attachedEditor: AttachedEditor | null = null;
  private started = false;

  constructor(dependencies: PerformanceDriverDependencies) {
    this.dependencies = dependencies;
  }

  start(): void {
    if (this.started || !this.dependencies.isNativeRuntime()) {
      return;
    }
    this.started = true;
    void this.run().catch(this.dependencies.reportError);
  }

  attachEditor(
    documentId: string,
    adapter: ExcalidrawAdapter,
    container: HTMLElement,
  ): void {
    this.attachedEditor = { documentId, adapter, container };
  }

  private async run(): Promise<void> {
    const bootstrap = await this.dependencies.control.bootstrap();
    if (bootstrap === null) {
      return;
    }

    const documentId = await this.dependencies.documents.open(
      bootstrap.documentPath,
    );
    const editor = await this.waitForEditableEditor(bootstrap, documentId);
    await this.dependencies.control.publishReady({
      schemaVersion: CONTRACT_SCHEMA_VERSION,
      scenario: bootstrap.scenario,
      editorReady: true,
      editable: true,
      elementCount: editor.adapter.getLiveElementCount(),
      visibilityState: "visible",
    });

    const completedCommands = new Set<string>();
    while (true) {
      const command = await this.dependencies.control.nextCommand();
      if (command === null || completedCommands.has(command.commandId)) {
        await this.dependencies.wait(COMMAND_POLL_INTERVAL_MS);
        continue;
      }

      completedCommands.add(command.commandId);
      const result = await executePerformanceCommand(
        command,
        editor.adapter,
        this.dependencies.clock,
      );
      await this.dependencies.control.publishResult(result);
    }
  }

  private async waitForEditableEditor(
    bootstrap: PerformanceBootstrap,
    documentId: string,
  ): Promise<AttachedEditor> {
    const expectedElementCount = TEN_THOUSAND_ELEMENT_SCENARIOS.has(
      bootstrap.scenario,
    )
      ? 10_000
      : 0;

    while (true) {
      const editor = this.attachedEditor;
      if (
        editor !== null &&
        editor.documentId === documentId &&
        editor.adapter.isEditable() &&
        editor.adapter.getLiveElementCount() === expectedElementCount &&
        isVisibleEditor(editor, this.dependencies.clock)
      ) {
        await nextAnimationFrame(this.dependencies.clock);
        if (
          this.attachedEditor === editor &&
          editor.adapter.isEditable() &&
          editor.adapter.getLiveElementCount() === expectedElementCount &&
          isVisibleEditor(editor, this.dependencies.clock)
        ) {
          return editor;
        }
      } else {
        await nextAnimationFrame(this.dependencies.clock);
      }
    }
  }
}

export async function executePerformanceCommand(
  command: PerformanceCommand,
  editor: PerformanceEditor,
  clock: PerformanceClock,
): Promise<PerformanceCommandResult> {
  const startedAt = clock.now();
  let previousFrameAt = startedAt;
  let frameIndex = 0;
  let eventCount = 0;
  const frameIntervalsMs: number[] = [];
  const targetEvents = getTargetEventCount(command);

  while (true) {
    await nextAnimationFrame(clock);
    const frameAt = clock.now();
    const elapsedMs = frameAt - startedAt;
    frameIntervalsMs.push(frameAt - previousFrameAt);
    previousFrameAt = frameAt;

    if (clock.visibilityState() !== "visible") {
      throw new Error(
        `Performance workload ${command.commandId} lost window visibility.`,
      );
    }

    if (command.operation === "pan-zoom") {
      editor.applyPerformanceViewport(command.seed, frameIndex);
      eventCount += 1;
    } else {
      const expectedEvents = Math.min(
        targetEvents,
        Math.floor(
          (Math.min(elapsedMs, command.durationMs) / command.durationMs) *
            targetEvents,
        ),
      );
      while (eventCount < expectedEvents) {
        if (!editor.applyPerformanceEdit(command.seed, eventCount)) {
          throw new Error(
            `Performance workload ${command.commandId} has no editable scene element.`,
          );
        }
        eventCount += 1;
      }
    }

    frameIndex += 1;
    if (elapsedMs >= command.durationMs) {
      return {
        schemaVersion: CONTRACT_SCHEMA_VERSION,
        commandId: command.commandId,
        operation: command.operation,
        completed: true,
        durationMs: elapsedMs,
        eventCount,
        frameIntervalsMs,
        visibilityState: "visible",
        frameClock: "requestAnimationFrame-performance.now",
      };
    }
  }
}

function getTargetEventCount(command: PerformanceCommand): number {
  if (command.operation === "pan-zoom") {
    return 0;
  }
  if (command.targetEvents !== undefined) {
    return command.targetEvents;
  }
  if (command.operation === "edit-soak") {
    return Math.max(1, Math.floor(command.durationMs / SOAK_EDIT_INTERVAL_MS));
  }
  return Math.max(1, Math.floor(command.durationMs / (1_000 / 60)));
}

function isVisibleEditor(
  editor: AttachedEditor,
  clock: PerformanceClock,
): boolean {
  return (
    clock.visibilityState() === "visible" &&
    editor.container.isConnected &&
    editor.container.getClientRects().length > 0
  );
}

function nextAnimationFrame(clock: PerformanceClock): Promise<void> {
  return new Promise((resolve) => {
    clock.requestFrame(() => resolve());
  });
}

function createPerformanceControl(): PerformanceControl {
  return {
    async bootstrap() {
      let value: unknown;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        value = await invoke<unknown>("e2e_perf_bootstrap", {});
      } catch {
        return null;
      }
      return parseBootstrap(value);
    },
    async publishReady(ready) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("e2e_perf_publish_ready", { ready });
    },
    async nextCommand() {
      const { invoke } = await import("@tauri-apps/api/core");
      const value = await invoke<unknown>("e2e_perf_next_command", {});
      return value === null ? null : parseCommand(value);
    },
    async publishResult(result) {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("e2e_perf_publish_result", { result });
    },
  };
}

export function parseBootstrap(value: unknown): PerformanceBootstrap {
  if (
    !isRecord(value) ||
    value.schemaVersion !== CONTRACT_SCHEMA_VERSION ||
    !isPerformanceScenario(value.scenario) ||
    !isInteger(value.seed) ||
    typeof value.documentPath !== "string" ||
    value.documentPath.length === 0
  ) {
    throw new Error("Native performance bootstrap payload is invalid.");
  }
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    scenario: value.scenario,
    seed: value.seed,
    documentPath: value.documentPath,
  };
}

export function parseCommand(value: unknown): PerformanceCommand {
  if (
    !isRecord(value) ||
    value.schemaVersion !== CONTRACT_SCHEMA_VERSION ||
    typeof value.commandId !== "string" ||
    value.commandId.length === 0 ||
    !isPerformanceOperation(value.operation) ||
    !isPositiveFiniteNumber(value.durationMs) ||
    !isInteger(value.seed) ||
    (value.targetEvents !== undefined &&
      (!isNonNegativeInteger(value.targetEvents) || value.targetEvents === 0))
  ) {
    throw new Error("Native performance command payload is invalid.");
  }
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    commandId: value.commandId,
    operation: value.operation,
    durationMs: value.durationMs,
    seed: value.seed,
    ...(value.targetEvents === undefined
      ? {}
      : { targetEvents: value.targetEvents }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPerformanceScenario(value: unknown): value is PerformanceScenario {
  return (
    value === "startup-editable" ||
    value === "canvas-10k" ||
    value === "edit-soak"
  );
}

function isPerformanceOperation(
  value: unknown,
): value is PerformanceCommand["operation"] {
  return (
    value === "pan-zoom" ||
    value === "high-frequency-edit" ||
    value === "edit-soak"
  );
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

const browserClock: PerformanceClock = {
  now: () => performance.now(),
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  visibilityState: () => document.visibilityState,
};

export const nativePerformanceDriver = new NativePerformanceDriver({
  control: createPerformanceControl(),
  documents: documentManager,
  clock: browserClock,
  wait: (milliseconds) =>
    new Promise((resolve) => window.setTimeout(resolve, milliseconds)),
  isNativeRuntime: () => "__TAURI_INTERNALS__" in window,
  reportError: (error) => {
    console.error("Native performance driver failed.", error);
  },
});
