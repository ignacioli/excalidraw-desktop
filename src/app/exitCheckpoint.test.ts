import { describe, expect, it, vi } from "vitest";
import type { CloseRequestedEvent } from "@tauri-apps/api/window";
import {
  registerExitCheckpoint,
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
