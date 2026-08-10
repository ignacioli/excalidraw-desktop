import { describe, expect, it, vi } from "vitest";
import { ThumbnailCancelledError, ThumbnailQueue } from "./thumbnailQueue";

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("ThumbnailQueue", () => {
  it("runs jobs in FIFO order with a concurrency cap of one", async () => {
    const queue = new ThumbnailQueue({ concurrency: 1 });
    const order: string[] = [];
    const first = deferred();
    const second = deferred();
    const firstPromise = queue.enqueue({
      id: "first",
      run: async () => {
        order.push("first-start");
        await first.promise;
        order.push("first-end");
      },
    });
    const secondPromise = queue.enqueue({
      id: "second",
      run: async () => {
        order.push("second-start");
        await second.promise;
        order.push("second-end");
      },
    });

    expect(queue.active).toBe(1);
    expect(queue.pendingCount).toBe(1);
    first.resolve(undefined);
    await firstPromise;
    second.resolve(undefined);
    await secondPromise;
    expect(order).toEqual([
      "first-start",
      "first-end",
      "second-start",
      "second-end",
    ]);
  });

  it("allows two concurrent renders when concurrency is two", async () => {
    const queue = new ThumbnailQueue({ concurrency: 2 });
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const jobs = ["a", "b", "c"].map((id) => {
      const gate = deferred();
      releases.push(() => gate.resolve(undefined));
      return queue.enqueue({
        id,
        run: async () => {
          started.push(id);
          await gate.promise;
        },
      });
    });

    await Promise.resolve();
    expect(started).toEqual(["a", "b"]);
    expect(queue.active).toBe(2);
    releases[0]();
    releases[1]();
    await jobs[0];
    await jobs[1];
    expect(started).toEqual(["a", "b", "c"]);
    releases[2]();
    await jobs[2];
  });

  it("rejects and skips a pending job when cancelled", async () => {
    const queue = new ThumbnailQueue({ concurrency: 1 });
    const gate = deferred();
    const run = vi.fn(async () => {
      await gate.promise;
    });
    const first = queue.enqueue({ id: "first", run });
    const second = queue.enqueue({
      id: "second",
      run: vi.fn(async () => "never"),
    });

    queue.cancel("second");
    await expect(second).rejects.toBeInstanceOf(ThumbnailCancelledError);
    gate.resolve(undefined);
    await first;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("drops the result of a cancelled running job", async () => {
    const queue = new ThumbnailQueue({ concurrency: 1 });
    const gate = deferred();
    const job = queue.enqueue({
      id: "running",
      run: async () => {
        await gate.promise;
        return "result";
      },
    });

    queue.cancel("running");
    await expect(job).rejects.toBeInstanceOf(ThumbnailCancelledError);
    gate.resolve(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.active).toBe(0);
  });

  it("evicts the oldest pending job beyond maxPending", async () => {
    const queue = new ThumbnailQueue({ concurrency: 1, maxPending: 2 });
    const gate = deferred();
    const first = queue.enqueue({
      id: "first",
      run: async () => {
        await gate.promise;
      },
    });
    const second = queue.enqueue({
      id: "second",
      run: vi.fn(async () => undefined),
    });
    const third = queue.enqueue({
      id: "third",
      run: vi.fn(async () => undefined),
    });
    const fourth = queue.enqueue({
      id: "fourth",
      run: vi.fn(async () => undefined),
    });

    await expect(second).rejects.toBeInstanceOf(ThumbnailCancelledError);
    expect(queue.pendingCount).toBe(2);
    gate.resolve(undefined);
    await first;
    await third;
    await fourth;
  });

  it("rejects duplicate job ids", async () => {
    const queue = new ThumbnailQueue({ concurrency: 2 });
    const gateA = deferred();
    const gateB = deferred();
    const first = queue.enqueue({
      id: "a",
      run: async () => {
        await gateA.promise;
      },
    });
    const second = queue.enqueue({
      id: "b",
      run: async () => {
        await gateB.promise;
      },
    });
    const queued = queue.enqueue({
      id: "duplicate",
      run: vi.fn(async () => undefined),
    });
    await expect(
      queue.enqueue({
        id: "duplicate",
        run: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("already queued");
    gateA.resolve(undefined);
    gateB.resolve(undefined);
    await first;
    await second;
    await queued;
  });

  it("cancels every pending and running job via cancelAll", async () => {
    const queue = new ThumbnailQueue({ concurrency: 1 });
    const gate = deferred();
    const first = queue.enqueue({
      id: "first",
      run: async () => {
        await gate.promise;
      },
    });
    const second = queue.enqueue({
      id: "second",
      run: vi.fn(async () => undefined),
    });

    queue.cancelAll();
    await expect(first).rejects.toBeInstanceOf(ThumbnailCancelledError);
    await expect(second).rejects.toBeInstanceOf(ThumbnailCancelledError);
    expect(queue.pendingCount).toBe(0);
  });

  it("rejects invalid concurrency options", () => {
    expect(() => new ThumbnailQueue({ concurrency: 3 })).toThrow(RangeError);
    expect(() => new ThumbnailQueue({ concurrency: 0 })).toThrow(RangeError);
  });
});
