import type { EventPayload } from "../ipc/contracts";
import { defaultEventListener, type EventListener } from "../ipc/events";
import {
  documentManager,
  type ConflictInfo,
  type DocumentManager,
  type DocumentSaveState,
} from "./documentStore";

const UNSAVED_SAVE_STATES: ReadonlySet<DocumentSaveState> = new Set([
  "dirty",
  "savingDraft",
  "draftSaved",
  "checkpointing",
]);

export interface ConflictDetectorOptions {
  listenFileChanged?: EventListener<"file-changed">;
  listenConflictDetected?: EventListener<"conflict-detected">;
  now?: () => number;
  onError?: (error: unknown) => void;
}

/**
 * Splits the `file-changed` event stream for open documents: a clean document
 * is reloaded automatically, a document with unsaved changes enters the
 * Conflicted state and blocks writes until the user decides (data-model state
 * machine: Reloaded / Conflicted).
 */
export class ConflictDetector {
  private readonly manager: DocumentManager;
  private readonly listenFileChanged: EventListener<"file-changed">;
  private readonly listenConflictDetected: EventListener<"conflict-detected">;
  private readonly now: () => number;
  private readonly onError: (error: unknown) => void;
  private readonly lastReloadedHash = new Map<string, string>();

  constructor(
    manager: DocumentManager,
    {
      listenFileChanged = defaultEventListener,
      listenConflictDetected = defaultEventListener,
      now = () => Math.floor(Date.now() / 1000),
      onError = () => undefined,
    }: ConflictDetectorOptions = {},
  ) {
    this.manager = manager;
    this.listenFileChanged = listenFileChanged;
    this.listenConflictDetected = listenConflictDetected;
    this.now = now;
    this.onError = onError;
  }

  async start(): Promise<() => void> {
    const unlistenFileChanged = await this.listenFileChanged(
      "file-changed",
      ({ payload }) => {
        void this.handleFileChanged(payload).catch(this.onError);
      },
    );
    const unlistenConflictDetected = await this.listenConflictDetected(
      "conflict-detected",
      ({ payload }) => {
        this.manager.updateConflictInfo(payload.path, {
          externalMtime: payload.externalMtime,
          localDraftUpdatedAt: payload.localDraftUpdatedAt,
        });
      },
    );
    return () => {
      unlistenFileChanged();
      unlistenConflictDetected();
    };
  }

  private async handleFileChanged(
    payload: EventPayload<"file-changed">,
  ): Promise<void> {
    if (payload.change !== "modified") {
      return;
    }
    const session = this.manager.sessionByPath(payload.path);
    if (session === undefined || session.saveState === "conflicted") {
      return;
    }
    if (UNSAVED_SAVE_STATES.has(session.saveState)) {
      const info: ConflictInfo = {
        externalMtime: payload.mtime ?? this.now(),
        localDraftUpdatedAt: this.now(),
      };
      this.manager.beginConflict(session.id, info);
      return;
    }
    const contentHash = payload.contentHash;
    if (
      contentHash !== undefined &&
      this.lastReloadedHash.get(payload.path) === contentHash
    ) {
      return;
    }
    if (contentHash !== undefined) {
      this.lastReloadedHash.set(payload.path, contentHash);
    }
    await this.manager.reloadFromDisk(session.id);
  }
}

export const conflictDetector = new ConflictDetector(documentManager);
