import type { HistoryChangedEvent, HistoryIssueEvent } from "../ipc/contracts";
import { defaultEventListener, type EventListener } from "../ipc/events";
import type {
  HistoryEventHandlers,
  HistoryEventListeners,
  HistoryEventScope,
} from "./types";

export function isHistoryEventForScope(
  event: Pick<HistoryChangedEvent | HistoryIssueEvent, "documentId">,
  scope: HistoryEventScope,
): boolean {
  return event.documentId === scope.documentId && scope.isCurrent();
}

/**
 * Registers only the event streams requested by the caller. No Tauri listener
 * is installed when its handler is absent, and stale document/session events
 * are dropped before reaching the owning coordinator.
 */
export async function registerHistoryEvents(
  scope: HistoryEventScope,
  handlers: HistoryEventHandlers,
  {
    listenChanged = defaultEventListener,
    listenIssue = defaultEventListener,
  }: HistoryEventListeners = {},
): Promise<() => void> {
  let unlistenChanged: (() => void) | undefined;
  let unlistenIssue: (() => void) | undefined;

  try {
    if (handlers.onChanged !== undefined) {
      unlistenChanged = await listenChanged(
        "history-changed",
        ({ payload }) => {
          if (isHistoryEventForScope(payload, scope)) {
            handlers.onChanged?.(payload, scope.sessionGeneration);
          }
        },
      );
    }
    if (handlers.onIssue !== undefined) {
      unlistenIssue = await listenIssue("history-issue", ({ payload }) => {
        if (isHistoryEventForScope(payload, scope)) {
          handlers.onIssue?.(payload, scope.sessionGeneration);
        }
      });
    }
  } catch (error) {
    unlistenChanged?.();
    throw error;
  }

  return () => {
    unlistenChanged?.();
    unlistenIssue?.();
  };
}

export async function registerHistoryChangedEvents(
  scope: HistoryEventScope,
  onChanged: HistoryEventHandlers["onChanged"],
  listenChanged: EventListener<"history-changed"> = defaultEventListener,
): Promise<() => void> {
  return registerHistoryEvents(scope, { onChanged }, { listenChanged });
}

export async function registerHistoryIssueEvents(
  scope: HistoryEventScope,
  onIssue: HistoryEventHandlers["onIssue"],
  listenIssue: EventListener<"history-issue"> = defaultEventListener,
): Promise<() => void> {
  return registerHistoryEvents(scope, { onIssue }, { listenIssue });
}
