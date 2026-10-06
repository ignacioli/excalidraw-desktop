// @vitest-environment node
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

import {
  NativePerformanceControl,
  NativePerformanceDriverError,
} from "./nativePerformanceContract";
import { collectWindow } from "./workloads";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const controls: NativePerformanceControl[] = [];

function fakeAssertion() {
  const child = Object.assign(new EventEmitter(), {
    pid: 12345 as number | undefined,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((signal: NodeJS.Signals) => {
      child.signalCode = signal;
      child.emit("exit", null, signal);
      return true;
    }),
  });
  return child;
}

async function createControl() {
  const control = await NativePerformanceControl.create({
    scenario: "edit-soak",
    seed: 40_000,
  });
  controls.push(control);
  return control;
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  spawnMock.mockReset();
  spawnMock.mockImplementation(fakeAssertion);
});

afterEach(async () => {
  for (const control of controls.splice(0)) await control.dispose();
  Object.defineProperty(process, "platform", originalPlatform);
  vi.restoreAllMocks();
});

describe("performance idle assertion lifecycle", () => {
  it("binds the temporary assertion to the runner and releases it on dispose", async () => {
    const child = fakeAssertion();
    spawnMock.mockReturnValue(child);
    const control = await createControl();
    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/bin/caffeinate",
      ["-di", "-w", String(process.pid)],
      { stdio: "ignore" },
    );
    await control.dispose();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(
      readFile(join(control.root, "bootstrap.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await control.dispose();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("does not launch a macOS assertion on other platforms", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    await createControl();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("surfaces a spawn failure without signalling an absent process", async () => {
    const child = fakeAssertion();
    child.pid = undefined;
    spawnMock.mockImplementation(() => {
      setTimeout(() => child.emit("error", new Error("spawn denied")), 0);
      return child;
    });
    await expect(createControl()).rejects.toThrow("spawn denied");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("rejects an assertion that exits during startup", async () => {
    const child = fakeAssertion();
    spawnMock.mockImplementation(() => {
      setTimeout(() => {
        child.exitCode = 1;
        child.emit("exit", 1, null);
      }, 0);
      return child;
    });
    await expect(createControl()).rejects.toThrow("exited unexpectedly (1)");
  });

  it("reports an unexpected exit after startup through the shared health check", async () => {
    const child = fakeAssertion();
    spawnMock.mockReturnValue(child);
    const control = await createControl();
    child.exitCode = 2;
    child.emit("exit", 2, null);
    await expect(control.throwIfFailed()).rejects.toThrow(
      "exited unexpectedly (2)",
    );
  });
});

describe("soak fatal-error sampling", () => {
  it("stops before another sample and retains partial samples and the original driver payload", async () => {
    const control = await createControl();
    const original = {
      message: "Window became hidden",
      visibilityState: "hidden",
      eventCount: 72,
    };
    const partial: number[] = [];
    const collect = vi.fn(async () => collect.mock.calls.length);
    let caught: unknown;
    try {
      await collectWindow(
        {
          durationMs: 500,
          intervalMs: 10,
          beforeSample: () => control.throwIfFailed(),
          onSample: async (sample) => {
            partial.push(sample);
            if (partial.length === 2)
              await writeFile(
                join(control.root, "error.json"),
                JSON.stringify(original),
              );
            await control.throwIfFailed();
          },
        },
        collect,
      );
    } catch (error) {
      caught = error;
    }
    expect(collect).toHaveBeenCalledTimes(2);
    expect(partial).toEqual([1, 2]);
    expect(caught).toBeInstanceOf(NativePerformanceDriverError);
    await writeFile(
      join(control.root, "error.json"),
      JSON.stringify({ message: "Root process exited during teardown" }),
    );
    expect((caught as NativePerformanceDriverError).driverError).toEqual(
      original,
    );
    await control.dispose();
    expect((caught as NativePerformanceDriverError).driverError).toEqual(
      original,
    );
  });

  it("checks an error published between samples before collecting more metrics", async () => {
    const control = await createControl();
    const partial: number[] = [];
    const collect = vi.fn(async () => 42);
    await expect(
      collectWindow(
        {
          durationMs: 500,
          intervalMs: 10,
          beforeSample: () => control.throwIfFailed(),
          onSample: async (sample) => {
            partial.push(sample);
            await writeFile(
              join(control.root, "error.json"),
              JSON.stringify({ message: "Driver failed" }),
            );
          },
        },
        collect,
      ),
    ).rejects.toThrow("Driver failed");
    expect(collect).toHaveBeenCalledTimes(1);
    expect(partial).toEqual([42]);
  });

  it("retains malformed fatal-error content rather than ignoring it", async () => {
    const control = await createControl();
    await writeFile(join(control.root, "error.json"), "incomplete-error{");
    await expect(control.throwIfFailed()).rejects.toMatchObject({
      driverError: "incomplete-error{",
    });
  });
});
