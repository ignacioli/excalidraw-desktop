import type { CheckpointReason } from "../ipc/contracts";

export interface DraftSchedulerOptions<Payload = string> {
  persistDraft: (payload: Payload) => Promise<void>;
  checkpoint: (payload: Payload, reason: CheckpointReason) => Promise<void>;
  onError?: (error: unknown) => void;
  debounceMs?: number;
  idleMs?: number;
  maxWaitMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_IDLE_MS = 3_000;
const DEFAULT_MAX_WAIT_MS = 60_000;

export class DraftScheduler<Payload = string> {
  private readonly persistDraft: DraftSchedulerOptions<Payload>["persistDraft"];
  private readonly writeCheckpoint: DraftSchedulerOptions<Payload>["checkpoint"];
  private readonly onError: (error: unknown) => void;
  private readonly debounceMs: number;
  private readonly idleMs: number;
  private readonly maxWaitMs: number;
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  private latestPayload: Payload | undefined;
  private revision = 0;
  private conflicted = false;
  private disposed = false;
  private writeQueue = Promise.resolve();

  constructor({
    persistDraft,
    checkpoint,
    onError = () => undefined,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    idleMs = DEFAULT_IDLE_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
  }: DraftSchedulerOptions<Payload>) {
    this.persistDraft = persistDraft;
    this.writeCheckpoint = checkpoint;
    this.onError = onError;
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

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation);
    this.writeQueue = next.catch(() => undefined);
    return next;
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
