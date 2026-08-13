import { describe, expect, it, vi } from "vitest";
import {
  executePerformanceCommand,
  parseBootstrap,
  parseCommand,
  type PerformanceClock,
  type PerformanceCommand,
  type PerformanceEditor,
} from "./performanceDriver";

vi.mock("@excalidraw/excalidraw", () => ({
  restore: (scene: object) => scene,
  serializeAsJSON: (
    elements: readonly object[],
    appState: object,
    files: object,
  ) =>
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements,
      appState,
      files,
    }),
}));

function createFrameClock(frameIntervalMs = 20): PerformanceClock {
  let currentTime = 0;
  return {
    now: () => currentTime,
    requestFrame: (callback) => {
      queueMicrotask(() => {
        currentTime += frameIntervalMs;
        callback(currentTime);
      });
      return currentTime;
    },
    visibilityState: () => "visible",
  };
}

function createEditor(): PerformanceEditor {
  return {
    isEditable: () => true,
    getLiveElementCount: () => 10_000,
    applyPerformanceViewport: vi.fn(),
    applyPerformanceEdit: vi.fn(() => true),
  };
}

function command(values: Partial<PerformanceCommand> = {}): PerformanceCommand {
  return {
    schemaVersion: "1.0.0",
    commandId: "command-1",
    operation: "high-frequency-edit",
    durationMs: 100,
    seed: 42,
    ...values,
  };
}

describe("native performance driver contract", () => {
  it("validates the exact bootstrap and command payloads", () => {
    expect(
      parseBootstrap({
        schemaVersion: "1.0.0",
        scenario: "canvas-10k",
        seed: 4,
        documentPath: "/tmp/fixture.excalidraw",
      }),
    ).toEqual({
      schemaVersion: "1.0.0",
      scenario: "canvas-10k",
      seed: 4,
      documentPath: "/tmp/fixture.excalidraw",
    });
    expect(
      parseCommand({
        schemaVersion: "1.0.0",
        commandId: "edit-1",
        operation: "high-frequency-edit",
        durationMs: 60_000,
        seed: 8,
        targetEvents: 3_600,
      }),
    ).toMatchObject({ commandId: "edit-1", targetEvents: 3_600 });
    expect(() =>
      parseBootstrap({ schemaVersion: "1.0.0", scenario: "canvas-10k" }),
    ).toThrow("bootstrap payload is invalid");
    expect(() =>
      parseCommand({
        schemaVersion: "1.0.0",
        commandId: "bad",
        operation: "unknown",
        durationMs: 10,
        seed: 1,
      }),
    ).toThrow("command payload is invalid");
  });

  it("accepts a command without targetEvents", () => {
    const parsed = parseCommand({
      schemaVersion: "1.0.0",
      commandId: "pan-1",
      operation: "pan-zoom",
      durationMs: 30_000,
      seed: 9,
    });
    expect(parsed.commandId).toBe("pan-1");
    expect(parsed.targetEvents).toBeUndefined();
  });

  it("records every visible rAF interval and completes all targeted edits", async () => {
    const editor = createEditor();
    const result = await executePerformanceCommand(
      command({ targetEvents: 10 }),
      editor,
      createFrameClock(),
    );

    expect(result.durationMs).toBe(100);
    expect(result.frameIntervalsMs).toEqual([20, 20, 20, 20, 20]);
    expect(result.eventCount).toBe(10);
    expect(editor.applyPerformanceEdit).toHaveBeenCalledTimes(10);
    expect(result.frameClock).toBe("requestAnimationFrame-performance.now");
  });

  it("drives deterministic pan and zoom work for the requested duration", async () => {
    const editor = createEditor();
    const result = await executePerformanceCommand(
      command({ operation: "pan-zoom", durationMs: 80, seed: 9 }),
      editor,
      createFrameClock(),
    );

    expect(result.eventCount).toBe(4);
    expect(editor.applyPerformanceViewport).toHaveBeenNthCalledWith(1, 9, 0);
    expect(editor.applyPerformanceViewport).toHaveBeenNthCalledWith(4, 9, 3);
  });

  it("paces soak edits while retaining frame-by-frame measurements", async () => {
    const editor = createEditor();
    const result = await executePerformanceCommand(
      command({ operation: "edit-soak", durationMs: 1_000 }),
      editor,
      createFrameClock(100),
    );

    expect(result.frameIntervalsMs).toHaveLength(10);
    expect(result.eventCount).toBe(4);
    expect(editor.applyPerformanceEdit).toHaveBeenCalledTimes(4);
  });
});
