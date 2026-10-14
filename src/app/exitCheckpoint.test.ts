import { describe, expect, it, vi } from "vitest";
import type { CloseRequestedEvent } from "@tauri-apps/api/window";
import {
  registerExitCheckpoint,
  registerQuitCheckpoint,
  type PeerCloseOptions,
} from "./exitCheckpoint";

const noPeer: PeerCloseOptions = {
  listener: async () => () => undefined,
  reportFailed: async () => undefined,
};

describe("registerExitCheckpoint", () => {
  it("blocks close until every dirty document checkpoints", async () => {
    let closeHandler:
      ((event: CloseRequestedEvent) => void | Promise<void>) | undefined;
    const checkpointAll = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    const preventDefault = vi.fn();
    const unlisten: () => void = vi.fn();

    await registerExitCheckpoint(
      { checkpointAll },
      vi.fn(),
      async () => ({
        destroy,
        async onCloseRequested(handler) {
          closeHandler = handler;
          return unlisten;
        },
      }),
      noPeer,
    );

    await closeHandler?.({
      preventDefault,
    } as unknown as CloseRequestedEvent);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(checkpointAll).toHaveBeenCalledWith("appExit");
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("does not destroy the window before the app-exit checkpoint completes", async () => {
    let closeHandler:
      ((event: CloseRequestedEvent) => void | Promise<void>) | undefined;
    let resolveCheckpoint: (() => void) | undefined;
    const checkpointAll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCheckpoint = resolve;
        }),
    );
    const destroy = vi.fn(async () => undefined);
    const unlisten: () => void = vi.fn();

    await registerExitCheckpoint(
      { checkpointAll },
      vi.fn(),
      async () => ({
        destroy,
        async onCloseRequested(handler) {
          closeHandler = handler;
          return unlisten;
        },
      }),
      noPeer,
    );

    const closeResult = closeHandler?.({
      preventDefault: vi.fn(),
    } as unknown as CloseRequestedEvent);

    expect(closeHandler).toBeTypeOf("function");
    expect(checkpointAll).toHaveBeenCalledWith("appExit");
    expect(destroy).not.toHaveBeenCalled();

    resolveCheckpoint?.();
    await closeResult;

    expect(destroy).toHaveBeenCalledOnce();
  });

  it("keeps the window open and reports a checkpoint failure", async () => {
    let closeHandler:
      ((event: CloseRequestedEvent) => void | Promise<void>) | undefined;
    const failure = new Error("checkpoint failed");
    const onError = vi.fn();
    const destroy = vi.fn(async () => undefined);

    await registerExitCheckpoint(
      { checkpointAll: vi.fn(async () => Promise.reject(failure)) },
      onError,
      async () => ({
        destroy,
        async onCloseRequested(handler) {
          closeHandler = handler;
          const unlisten: () => void = vi.fn();
          return unlisten;
        },
      }),
      noPeer,
    );

    await closeHandler?.({
      preventDefault: vi.fn(),
    } as unknown as CloseRequestedEvent);

    expect(onError).toHaveBeenCalledWith(failure);
    expect(destroy).not.toHaveBeenCalled();
  });
  describe("when another window asks this one to close", () => {
    function setup(checkpointAll: () => Promise<void>) {
      let peerHandler:
        ((event: { payload: { requestId: string } }) => void) | undefined;
      const destroy = vi.fn(async () => undefined);
      const onError = vi.fn();
      const reportFailed = vi.fn(async () => undefined);
      const unlistenClose = vi.fn();
      const unlistenPeer = vi.fn();
      const registered = registerExitCheckpoint(
        { checkpointAll },
        onError,
        async () => ({
          destroy,
          async onCloseRequested() {
            return unlistenClose;
          },
        }),
        {
          listener: async (eventName, handler) => {
            expect(eventName).toBe("window-close-requested-by-peer");
            peerHandler = handler;
            return unlistenPeer;
          },
          reportFailed,
        },
      );
      return {
        registered,
        destroy,
        onError,
        reportFailed,
        unlistenClose,
        unlistenPeer,
        request: (requestId: string) =>
          peerHandler?.({ payload: { requestId } }),
      };
    }

    it("checkpoints and closes the normal way", async () => {
      const checkpointAll = vi.fn(async () => undefined);
      const peer = setup(checkpointAll);
      await peer.registered;

      peer.request("request-1");

      await vi.waitFor(() => expect(peer.destroy).toHaveBeenCalledOnce());
      expect(checkpointAll).toHaveBeenCalledWith("appExit");
      expect(peer.reportFailed).not.toHaveBeenCalled();
    });

    it("stays open and reports the failed close back", async () => {
      const failure = new Error("checkpoint failed");
      const peer = setup(async () => Promise.reject(failure));
      await peer.registered;

      peer.request("request-1");

      await vi.waitFor(() =>
        expect(peer.reportFailed).toHaveBeenCalledWith("request-1"),
      );
      expect(peer.onError).toHaveBeenCalledWith(failure);
      expect(peer.destroy).not.toHaveBeenCalled();
    });

    it("stops listening for both closes", async () => {
      const peer = setup(vi.fn(async () => undefined));
      const unlisten = await peer.registered;

      unlisten();

      expect(peer.unlistenClose).toHaveBeenCalledOnce();
      expect(peer.unlistenPeer).toHaveBeenCalledOnce();
    });
  });
});

describe("registerQuitCheckpoint", () => {
  type Handler<Payload> = (event: { payload: Payload }) => void;

  function setup(checkpointAll: () => Promise<void>) {
    let requested: Handler<{ requestId: string }> | undefined;
    let cancelled:
      Handler<{ requestId: string; failedLabel: string }> | undefined;
    const onError = vi.fn();
    const reportReady = vi.fn(async () => undefined);
    const unlistenRequest = vi.fn();
    const unlistenCancel = vi.fn();
    const registration = registerQuitCheckpoint(
      { checkpointAll: vi.fn(checkpointAll) },
      onError,
      {
        resolveLabel: async () => "window-2",
        requestListener: async (_name, handler) => {
          requested = handler;
          return unlistenRequest;
        },
        cancelListener: async (_name, handler) => {
          cancelled = handler;
          return unlistenCancel;
        },
        reportReady,
      },
    );
    return {
      registration,
      onError,
      reportReady,
      unlistenRequest,
      unlistenCancel,
      request: (requestId: string) => requested?.({ payload: { requestId } }),
      cancel: (requestId: string, failedLabel: string) =>
        cancelled?.({ payload: { requestId, failedLabel } }),
    };
  }

  it("checkpoints every drawing, then reports ready", async () => {
    const checkpoint = vi.fn(async () => undefined);
    const h = setup(checkpoint);
    await h.registration;

    h.request("quit-1");

    await vi.waitFor(() =>
      expect(h.reportReady).toHaveBeenCalledWith({
        requestId: "quit-1",
        ok: true,
      }),
    );
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("reports a failed checkpoint and shows that the app did not quit", async () => {
    const h = setup(async () => Promise.reject(new Error("disk full")));
    await h.registration;

    h.request("quit-1");

    await vi.waitFor(() =>
      expect(h.reportReady).toHaveBeenCalledWith({
        requestId: "quit-1",
        ok: false,
        message: "disk full",
      }),
    );
    expect(h.onError).toHaveBeenCalledOnce();
    expect(h.onError.mock.calls[0]?.[0]).toMatchObject({
      key: "shell.quit.cancelled",
    });
    // The cancel that follows does not repeat the explanation.
    h.cancel("quit-1", "window-2");
    expect(h.onError).toHaveBeenCalledOnce();
  });

  it("explains a cancel caused by this window answering too late", async () => {
    const h = setup(() => new Promise<void>(() => undefined));
    await h.registration;
    h.request("quit-1");

    h.cancel("quit-1", "window-1");
    expect(h.onError).not.toHaveBeenCalled();
    h.cancel("quit-1", "window-2");

    expect(h.onError).toHaveBeenCalledOnce();
    expect(h.onError.mock.calls[0]?.[0]).toMatchObject({
      key: "error.QUIT_CHECKPOINT_FAILED",
    });
  });

  it("stops listening when unregistered", async () => {
    const h = setup(async () => undefined);
    const unlisten = await h.registration;

    unlisten();

    expect(h.unlistenRequest).toHaveBeenCalledOnce();
    expect(h.unlistenCancel).toHaveBeenCalledOnce();
  });
});
