import type { CheckpointReason } from "../ipc/contracts";

export interface DraftSchedulerOptions<Payload = string, PersistResult = void> {
  persistDraft: (payload: Payload) => Promise<PersistResult>;
  checkpoint: (payload: Payload, reason: CheckpointReason) => Promise<void>;
  onError?: (error: unknown) => void;
  operationQueue?: DocumentOperationQueue;
  debounceMs?: number;
  idleMs?: number;
  maxWaitMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_IDLE_MS = 3_000;
const DEFAULT_MAX_WAIT_MS = 60_000;

/**
 * Serializes all writes belonging to one open document. The queue is shared
 * with DocumentManager operations so a history operation can wait behind a
 * pending draft/checkpoint and future drafts cannot overtake it.
 */
export class DocumentOperationQueue {
  private readonly pending: Array<{
    operation: () => Promise<unknown> | unknown;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | undefined;
  private running = false;
  private disposed = false;

  enqueue<Result>(operation: () => Promise<Result> | Result): Promise<Result> {
    if (this.disposed) {
      return Promise.reject(
        new Error("The document operation queue is closed."),
      );
    }

    let resolveResult: (value: Result) => void = () => undefined;
    let rejectResult: (reason?: unknown) => void = () => undefined;
    const result = new Promise<Result>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.pending.push({
      operation: operation as () => Promise<unknown> | unknown,
      resolve: resolveResult as (value: unknown) => void,
      reject: rejectResult,
    });
    if (!this.running) {
      this.running = true;
      this.idle = new Promise<void>((resolve) => {
        this.resolveIdle = resolve;
      });
      this.pump();
    }
    return result;
  }

  async drain(): Promise<void> {
    await this.idle;
  }

  dispose(): void {
    this.disposed = true;
    const error = new Error("The document operation queue is closed.");
    for (const pending of this.pending.splice(0)) {
      pending.reject(error);
    }
  }

  private pump(): void {
    const next = this.pending.shift();
    if (next === undefined) {
      this.running = false;
      this.resolveIdle?.();
      this.resolveIdle = undefined;
      return;
    }

    let result: Promise<unknown>;
    try {
      result = Promise.resolve(next.operation());
    } catch (error) {
      next.reject(error);
      this.pump();
      return;
    }
    void result.then(next.resolve, next.reject).then(
      () => this.pump(),
      () => this.pump(),
    );
  }
}

export class DraftScheduler<Payload = string, PersistResult = void> {
  private readonly persistDraft: DraftSchedulerOptions<Payload, PersistResult>["persistDraft"];
  private readonly writeCheckpoint: DraftSchedulerOptions<Payload, PersistResult>["checkpoint"];
  private readonly onError: (error: unknown) => void;
  private readonly debounceMs: number;
  private readonly idleMs: number;
  private readonly maxWaitMs: number;
  private readonly operationQueue: DocumentOperationQueue;
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  private latestPayload: Payload | undefined;
  private revision = 0;
  private conflicted = false;
  private disposed = false;

  constructor({
    persistDraft,
    checkpoint,
    onError = () => undefined,
    operationQueue = new DocumentOperationQueue(),
    debounceMs = DEFAULT_DEBOUNCE_MS,
    idleMs = DEFAULT_IDLE_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
  }: DraftSchedulerOptions<Payload, PersistResult>) {
    this.persistDraft = persistDraft;
    this.writeCheckpoint = checkpoint;
    this.onError = onError;
    this.operationQueue = operationQueue;
    this.debounceMs = debounceMs;
    this.idleMs = idleMs;
    this.maxWaitMs = maxWaitMs;
  }

  recordChange(payload: Payload): void {
    if (this.disposed) {
      return;
    }

    this.latestPayload = payload;
    this.revision += 1;
    this.clearTimer("draft");
    this.clearTimer("idle");

    if (this.conflicted) {
      return;
    }

    this.draftTimer = setTimeout(() => {
      this.draftTimer = undefined;
      void this.flushDraft().catch(this.onError);
    }, this.debounceMs);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.checkpoint("idle").catch(this.onError);
    }, this.idleMs);
    this.maxWaitTimer ??= setTimeout(() => {
      this.maxWaitTimer = undefined;
      void this.checkpoint("maxWait").catch(this.onError);
    }, this.maxWaitMs);
  }

  setConflicted(conflicted: boolean): void {
    this.conflicted = conflicted;
    if (conflicted) {
      this.clearAllTimers();
    } else if (this.latestPayload !== undefined) {
      this.recordChange(this.latestPayload);
    }
  }

  /**
   * Test-driver seam: capture the actual latest scheduler payload, cancel its
   * timers, and expose the same queued persist callback used by flushDraft.
   */
  prepareDeferredDraftFlush(): (() => Promise<PersistResult>) | undefined {
    const payload = this.latestPayload;
    if (this.disposed || this.conflicted || payload === undefined) {
      return undefined;
    }
    this.clearAllTimers();
    let queued: Promise<PersistResult> | undefined;
    return () => {
      queued ??= this.operationQueue.enqueue(() => this.persistDraft(payload));
      return queued;
    };
  }

  async checkpoint(reason: CheckpointReason): Promise<void> {
    const payload = this.latestPayload;
    if (this.disposed || this.conflicted || payload === undefined) {
      return;
    }

    const checkpointRevision = this.revision;
    this.clearAllTimers();
    await this.enqueue(async () => {
      await this.writeCheckpoint(payload, reason);
      if (this.revision === checkpointRevision) {
        this.latestPayload = undefined;
      } else if (!this.conflicted) {
        this.ensureMaxWaitTimer();
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.clearAllTimers();
  }

  private async flushDraft(): Promise<void> {
    const payload = this.latestPayload;
    if (this.disposed || this.conflicted || payload === undefined) {
      return;
    }

    await this.enqueue(() => this.persistDraft(payload));
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.operationQueue.enqueue(operation);
  }

  private ensureMaxWaitTimer(): void {
    this.maxWaitTimer ??= setTimeout(() => {
      this.maxWaitTimer = undefined;
      void this.checkpoint("maxWait").catch(this.onError);
    }, this.maxWaitMs);
  }

  private clearTimer(timer: "draft" | "idle" | "maxWait"): void {
    const handle =
      timer === "draft"
        ? this.draftTimer
        : timer === "idle"
          ? this.idleTimer
          : this.maxWaitTimer;
    if (handle !== undefined) {
      clearTimeout(handle);
    }

    if (timer === "draft") {
      this.draftTimer = undefined;
    } else if (timer === "idle") {
      this.idleTimer = undefined;
    } else {
      this.maxWaitTimer = undefined;
    }
  }

  private clearAllTimers(): void {
    this.clearTimer("draft");
    this.clearTimer("idle");
    this.clearTimer("maxWait");
  }
}
