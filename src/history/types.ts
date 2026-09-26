import type {
  HistoryChangedEvent,
  HistoryDeleteRequest,
  HistoryDeleteResponse,
  HistoryListRequest,
  HistoryListResponse,
  HistoryMarkRequest,
  HistoryMarkResponse,
  HistoryOperationStatusRequest,
  HistoryOperationStatusResponse,
  HistoryPreviewRequest,
  HistoryPreviewResponse,
  HistoryReplaceRequest,
  HistoryReplaceResponse,
  HistoryIssueEvent,
} from "../ipc/contracts";
import type { CommandInvoker } from "../ipc/client";
import type { EventListener } from "../ipc/events";

export type {
  HistoryChangedEvent,
  HistoryDeleteRequest,
  HistoryDeleteResponse,
  HistoryDocumentLocator,
  HistoryIssueEvent,
  HistoryListRequest,
  HistoryListResponse,
  HistoryOperationStatusRequest,
  HistoryOperationStatusResponse,
  HistoryPreviewRequest,
  HistoryPreviewResponse,
  HistoryReplaceRequest,
  HistoryReplaceResponse,
  HistoryReplaceTarget,
  HistoryVersionAvailability,
  HistoryVersionItem,
} from "../ipc/contracts";

/**
 * The narrow command surface needed by the history UI. The factory accepts a
 * caller-provided invoker so tests and future document coordinators can keep
 * ownership of the Tauri boundary.
 */
export interface HistoryClient {
  list(request: HistoryListRequest): Promise<HistoryListResponse>;
  preview(request: HistoryPreviewRequest): Promise<HistoryPreviewResponse>;
  mark(request: HistoryMarkRequest): Promise<HistoryMarkResponse>;
  replace(request: HistoryReplaceRequest): Promise<HistoryReplaceResponse>;
  operationStatus(
    request: HistoryOperationStatusRequest,
  ): Promise<HistoryOperationStatusResponse>;
}

/** Phase 6 deletion surface; kept separate while existing replacement-only
 * coordinator doubles continue to implement the smaller pre-Phase 6 client. */
export interface HistoryDeleteClient {
  delete(request: HistoryDeleteRequest): Promise<HistoryDeleteResponse>;
}

/**
 * A history event is valid only while this document session is still the
 * consumer's current session. The generation is attached by the consumer;
 * Tauri's current event payloads intentionally remain unchanged and therefore
 * do not carry a frontend session generation.
 */
export interface HistoryEventScope {
  documentId: string;
  sessionGeneration: number;
  /** Returns false after tab close, replacement, or session-generation change. */
  isCurrent: () => boolean;
}

export interface HistoryEventHandlers {
  onChanged?: (event: HistoryChangedEvent, sessionGeneration: number) => void;
  onIssue?: (event: HistoryIssueEvent, sessionGeneration: number) => void;
}

export interface HistoryEventListeners {
  listenChanged?: EventListener<"history-changed">;
  listenIssue?: EventListener<"history-issue">;
}

export type HistoryCommandInvoker = CommandInvoker;
