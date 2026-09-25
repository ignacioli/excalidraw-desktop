import { describe, expect, it, vi } from "vitest";
import type { EventListener } from "../ipc/events";
import type { HistoryChangedEvent, HistoryIssueEvent } from "../ipc/contracts";
import { isHistoryEventForScope, registerHistoryEvents } from "./historyEvents";

type ChangedHandler = (event: { payload: HistoryChangedEvent }) => void;
type IssueHandler = (event: { payload: HistoryIssueEvent }) => void;

describe("history event session boundary", () => {
  const changed: HistoryChangedEvent = {
    documentId: "document-1",
    listRevision: 3,
    change: "manual",
  };
  const issue: HistoryIssueEvent = {
    documentId: "document-1",
    source: "automatic",
    error: {
      code: "DB_ERROR",
      message: "database unavailable",
      retriable: true,
    },
  };

  it("matches document identity and current session, not another tab", () => {
    let current = true;
    const scope = {
      documentId: "document-1",
      sessionGeneration: 4,
      isCurrent: () => current,
    };
    expect(isHistoryEventForScope(changed, scope)).toBe(true);
    expect(
      isHistoryEventForScope({ ...changed, documentId: "document-2" }, scope),
    ).toBe(false);
    current = false;
    expect(isHistoryEventForScope(changed, scope)).toBe(false);
  });

  it("filters stale events before callbacks and returns both unlisten functions", async () => {
    let changedHandler: ChangedHandler | undefined;
    let issueHandler: IssueHandler | undefined;
    const unlistenChanged = vi.fn();
    const unlistenIssue = vi.fn();
    const listenChanged = vi.fn(async (_eventName, handler) => {
      changedHandler = handler as ChangedHandler;
      return unlistenChanged;
    }) as unknown as EventListener<"history-changed">;
    const listenIssue = vi.fn(async (_eventName, handler) => {
      issueHandler = handler as IssueHandler;
      return unlistenIssue;
    }) as unknown as EventListener<"history-issue">;
    let current = true;
    const onChanged = vi.fn();
    const onIssue = vi.fn();
    const unlisten = await registerHistoryEvents(
      {
        documentId: "document-1",
        sessionGeneration: 9,
        isCurrent: () => current,
      },
      { onChanged, onIssue },
      { listenChanged, listenIssue },
    );

    changedHandler?.({ payload: { ...changed, documentId: "document-2" } });
    issueHandler?.({ payload: issue });
    expect(onChanged).not.toHaveBeenCalled();
    expect(onIssue).toHaveBeenCalledWith(issue, 9);

    current = false;
    issueHandler?.({ payload: issue });
    expect(onIssue).toHaveBeenCalledOnce();

    unlisten();
    expect(unlistenChanged).toHaveBeenCalledOnce();
    expect(unlistenIssue).toHaveBeenCalledOnce();
  });

  it("passes the independent current-file save outcome through unchanged", async () => {
    let issueHandler: IssueHandler | undefined;
    const listenIssue = vi.fn(async (_eventName, handler) => {
      issueHandler = handler as IssueHandler;
      return vi.fn();
    }) as unknown as EventListener<"history-issue">;
    const onIssue = vi.fn();

    await registerHistoryEvents(
      { documentId: "document-1", sessionGeneration: 2, isCurrent: () => true },
      { onIssue },
      { listenIssue },
    );
    issueHandler?.({
      payload: {
        ...issue,
        operation: "mark",
        source: "manual",
        currentFileSaveOutcome: "succeeded",
      },
    });

    expect(onIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "mark",
        source: "manual",
        currentFileSaveOutcome: "succeeded",
      }),
      2,
    );
  });

  it("does not install listeners for omitted handlers", async () => {
    const listenChanged = vi.fn();
    const listenIssue = vi.fn();
    await registerHistoryEvents(
      { documentId: "document-1", sessionGeneration: 0, isCurrent: () => true },
      {},
      {
        listenChanged:
          listenChanged as unknown as EventListener<"history-changed">,
        listenIssue: listenIssue as unknown as EventListener<"history-issue">,
      },
    );
    expect(listenChanged).not.toHaveBeenCalled();
    expect(listenIssue).not.toHaveBeenCalled();
  });

  it("cleans up a changed listener when issue listener installation fails", async () => {
    const unlistenChanged = vi.fn();
    const listenChanged = vi.fn(
      async () => unlistenChanged,
    ) as unknown as EventListener<"history-changed">;
    const listenIssue = vi.fn(async () => {
      throw new Error("listener unavailable");
    }) as unknown as EventListener<"history-issue">;

    await expect(
      registerHistoryEvents(
        {
          documentId: "document-1",
          sessionGeneration: 0,
          isCurrent: () => true,
        },
        { onChanged: vi.fn(), onIssue: vi.fn() },
        { listenChanged, listenIssue },
      ),
    ).rejects.toThrow("listener unavailable");
    expect(unlistenChanged).toHaveBeenCalledOnce();
  });
});
