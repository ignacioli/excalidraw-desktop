import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import type {
  DocumentSession,
  DocumentStoreState,
} from "../documents/documentStore";
import { reportWindowSession } from "./windowSession";

function session(id: string, path: string): DocumentSession {
  return { id, path } as DocumentSession;
}

function storeWith(paths: string[], active: number | null) {
  const sessions = paths.map((path, index) => session(`d${index}`, path));
  return createStore<DocumentStoreState>(() => ({
    sessionsById: Object.fromEntries(sessions.map((s) => [s.id, s])),
    tabOrder: sessions.map((s) => s.id),
    activeDocumentId: active === null ? null : (sessions[active]?.id ?? null),
  }));
}

describe("reportWindowSession", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports tab changes once after a pause", async () => {
    const store = storeWith(["/a/one.excalidraw"], 0);
    const send = vi.fn(async () => undefined);
    reportWindowSession(store, send, vi.fn());

    const two = session("d1", "/a/two.excalidraw");
    store.setState((state) => ({
      sessionsById: { ...state.sessionsById, d1: two },
      tabOrder: [...state.tabOrder, "d1"],
    }));
    store.setState({ activeDocumentId: "d1" });
    await vi.advanceTimersByTimeAsync(249);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      tabs: ["/a/one.excalidraw", "/a/two.excalidraw"],
      activePath: "/a/two.excalidraw",
    });
  });

  it("reports reordering and closing the last tab", async () => {
    const store = storeWith(["/a/one.excalidraw", "/a/two.excalidraw"], 1);
    const send = vi.fn(async () => undefined);
    reportWindowSession(store, send, vi.fn());

    store.setState({ tabOrder: ["d1", "d0"] });
    await vi.advanceTimersByTimeAsync(250);
    store.setState({ sessionsById: {}, tabOrder: [], activeDocumentId: null });
    await vi.advanceTimersByTimeAsync(250);

    expect(send.mock.calls).toEqual([
      [
        {
          tabs: ["/a/two.excalidraw", "/a/one.excalidraw"],
          activePath: "/a/two.excalidraw",
        },
      ],
      [{ tabs: [], activePath: null }],
    ]);
  });

  it("does not report edits inside a drawing or a change undone in time", async () => {
    const store = storeWith(["/a/one.excalidraw", "/a/two.excalidraw"], 0);
    const send = vi.fn(async () => undefined);
    reportWindowSession(store, send, vi.fn());

    store.setState((state) => ({
      sessionsById: {
        ...state.sessionsById,
        d0: { ...state.sessionsById.d0, revision: 2 } as DocumentSession,
      },
    }));
    store.setState({ activeDocumentId: "d1" });
    store.setState({ activeDocumentId: "d0" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(send).not.toHaveBeenCalled();
  });

  it("reports a failed update and stops after unsubscribe", async () => {
    const store = storeWith(["/a/one.excalidraw"], 0);
    const failure = new Error("offline");
    const send = vi.fn(async () => Promise.reject(failure));
    const onError = vi.fn();
    const stop = reportWindowSession(store, send, onError);

    store.setState({ activeDocumentId: null });
    await vi.advanceTimersByTimeAsync(250);
    expect(onError).toHaveBeenCalledWith(failure);

    stop();
    store.setState({ activeDocumentId: "d0" });
    await vi.advanceTimersByTimeAsync(250);
    expect(send).toHaveBeenCalledOnce();
  });
});
