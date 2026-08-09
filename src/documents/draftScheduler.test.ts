import { beforeEach, describe, expect, it, vi } from "vitest";
import { DraftScheduler, type DraftSchedulerOptions } from "./draftScheduler";

function createScheduler(overrides: Partial<DraftSchedulerOptions> = {}) {
  const persistDraft = vi.fn(async () => undefined);
  const checkpoint = vi.fn(async () => undefined);
  const scheduler = new DraftScheduler({
    persistDraft,
    checkpoint,
    debounceMs: 300,
    idleMs: 3_000,
    maxWaitMs: 60_000,
    ...overrides,
  });

  return { checkpoint, persistDraft, scheduler };
}

describe("DraftScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("debounces draft persistence for 300ms and persists only the latest scene", async () => {
    const { persistDraft, scheduler } = createScheduler();

    scheduler.recordChange("scene-1");
    await vi.advanceTimersByTimeAsync(200);
    scheduler.recordChange("scene-2");
    await vi.advanceTimersByTimeAsync(299);

    expect(persistDraft).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(persistDraft).toHaveBeenCalledTimes(1);
    expect(persistDraft).toHaveBeenCalledWith("scene-2");
    scheduler.dispose();
  });

  it.each(["manualSave", "tabSwitch", "tabClose", "appExit"] as const)(
    "checkpoints immediately for %s",
    async (reason) => {
      const { checkpoint, scheduler } = createScheduler();
      scheduler.recordChange("scene");

      await scheduler.checkpoint(reason);

      expect(checkpoint).toHaveBeenCalledWith("scene", reason);
      scheduler.dispose();
    },
  );

  it("checkpoints after three seconds idle and at the 60 second maximum wait", async () => {
    const idle = createScheduler();
    idle.scheduler.recordChange("idle-scene");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(idle.checkpoint).toHaveBeenCalledWith("idle-scene", "idle");
    idle.scheduler.dispose();

    const maxWait = createScheduler({ idleMs: 120_000 });
    maxWait.scheduler.recordChange("long-running-scene");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(maxWait.checkpoint).toHaveBeenCalledWith(
      "long-running-scene",
      "maxWait",
    );
    maxWait.scheduler.dispose();
  });

  it("suppresses draft and checkpoint writes while conflicted", async () => {
    const { checkpoint, persistDraft, scheduler } = createScheduler();
    scheduler.setConflicted(true);
    scheduler.recordChange("conflicted-scene");

    await vi.advanceTimersByTimeAsync(60_000);
    await scheduler.checkpoint("manualSave");

    expect(persistDraft).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
    scheduler.dispose();
  });
});
