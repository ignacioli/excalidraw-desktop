export class ThumbnailCancelledError extends Error {
  constructor(jobId: string) {
    super(`Thumbnail job "${jobId}" was cancelled.`);
    this.name = "ThumbnailCancelledError";
  }
}

export interface ThumbnailJob {
  /** Stable identity used for cancellation and deduplication. */
  id: string;
  run: () => Promise<unknown>;
}

interface QueueEntry {
  job: ThumbnailJob;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  cancelled: boolean;
}

export interface ThumbnailQueueOptions {
  /** Maximum simultaneous renders; allowed values are 1 or 2. */
  concurrency?: number;
  /**
   * Pending jobs beyond this limit are dropped oldest-first so the queue
   * stays biased toward the rows currently on screen.
   */
  maxPending?: number;
}

/**
 * Low-priority FIFO render queue with a concurrency cap and per-job
 * cancellation. Jobs that are cancelled while running still finish their
 * render work but their result is discarded.
 */
export class ThumbnailQueue {
  private readonly concurrency: number;
  private readonly maxPending: number;
  private readonly pending: QueueEntry[] = [];
  private readonly running = new Map<string, QueueEntry>();
  private activeCount = 0;

  constructor(options: ThumbnailQueueOptions = {}) {
    const concurrency = options.concurrency ?? 1;
    if (concurrency !== 1 && concurrency !== 2) {
      throw new RangeError("Thumbnail queue concurrency must be 1 or 2.");
    }
    const maxPending = options.maxPending ?? 32;
    if (!Number.isInteger(maxPending) || maxPending < 1) {
      throw new RangeError(
        "Thumbnail queue maxPending must be a positive integer.",
      );
    }
    this.concurrency = concurrency;
    this.maxPending = maxPending;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get active(): number {
    return this.activeCount;
  }

  enqueue(job: ThumbnailJob): Promise<unknown> {
    if (this.running.has(job.id)) {
      return Promise.reject(
        new Error(`Thumbnail job "${job.id}" is already running.`),
      );
    }
    if (this.pending.some((entry) => entry.job.id === job.id)) {
      return Promise.reject(
        new Error(`Thumbnail job "${job.id}" is already queued.`),
      );
    }

    return new Promise<unknown>((resolve, reject) => {
      if (this.pending.length >= this.maxPending) {
        const evicted = this.pending.shift();
        if (evicted !== undefined) {
          evicted.cancelled = true;
          evicted.reject(new ThumbnailCancelledError(evicted.job.id));
        }
      }
      this.pending.push({ job, resolve, reject, cancelled: false });
      this.pump();
    });
  }

  cancel(jobId: string): void {
    const pendingIndex = this.pending.findIndex(
      (entry) => entry.job.id === jobId,
    );
    if (pendingIndex !== -1) {
      const [entry] = this.pending.splice(pendingIndex, 1);
      entry.cancelled = true;
      entry.reject(new ThumbnailCancelledError(jobId));
      return;
    }
    const running = this.running.get(jobId);
    if (running !== undefined) {
      running.cancelled = true;
      running.reject(new ThumbnailCancelledError(jobId));
    }
  }

  cancelAll(): void {
    for (const entry of this.pending.splice(0)) {
      entry.cancelled = true;
      entry.reject(new ThumbnailCancelledError(entry.job.id));
    }
    for (const entry of this.running.values()) {
      entry.cancelled = true;
      entry.reject(new ThumbnailCancelledError(entry.job.id));
    }
    this.running.clear();
  }

  private pump(): void {
    while (this.activeCount < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift();
      if (entry === undefined) {
        return;
      }
      this.running.set(entry.job.id, entry);
      this.activeCount += 1;
      void this.run(entry);
    }
  }

  private async run(entry: QueueEntry): Promise<void> {
    try {
      const result = await entry.job.run();
      if (!entry.cancelled) {
        entry.resolve(result);
      }
    } catch (error) {
      if (!entry.cancelled) {
        entry.reject(error);
      }
    } finally {
      this.running.delete(entry.job.id);
      this.activeCount -= 1;
      this.pump();
    }
  }
}
