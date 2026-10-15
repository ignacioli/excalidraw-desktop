import type { StoreApi } from "zustand/vanilla";
import type { DocumentStoreState } from "../documents/documentStore";
import type { CommandRequest } from "../ipc/contracts";

/** Tab changes within this window are reported once. */
export const WINDOW_SESSION_REPORT_DELAY_MS = 250;

type WindowSessionReport = CommandRequest<"window_session_update">;

function sessionReport(state: DocumentStoreState): WindowSessionReport {
  const tabs = state.tabOrder
    .map((id) => state.sessionsById[id]?.path)
    .filter((path): path is string => path !== undefined);
  const active =
    state.activeDocumentId === null
      ? undefined
      : state.sessionsById[state.activeDocumentId]?.path;
  return { tabs, activePath: active ?? null };
}

function sameReport(a: WindowSessionReport, b: WindowSessionReport): boolean {
  return (
    a.activePath === b.activePath &&
    a.tabs.length === b.tabs.length &&
    a.tabs.every((tab, index) => tab === b.tabs[index])
  );
}

/**
 * Report this window's tabs and active tab for the Window Session whenever
 * a tab opens, closes, is activated, is reordered, or moves to another path.
 * Changes are reported after a short pause, and only when they differ from
 * the last report. Edits inside a drawing are never reported.
 */
export function reportWindowSession(
  store: Pick<StoreApi<DocumentStoreState>, "getState" | "subscribe">,
  send: (report: WindowSessionReport) => Promise<unknown>,
  onError: (error: unknown) => void,
  delayMs = WINDOW_SESSION_REPORT_DELAY_MS,
): () => void {
  let last = sessionReport(store.getState());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const next = sessionReport(store.getState());
    if (sameReport(next, last)) return;
    last = next;
    send(next).catch(onError);
  };
  const unsubscribe = store.subscribe((state) => {
    if (timer !== undefined || sameReport(sessionReport(state), last)) return;
    timer = setTimeout(flush, delayMs);
  });
  return () => {
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
  };
}
