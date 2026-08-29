import { describe, expect, it, vi } from "vitest";
import type { CloseRequestedEvent } from "@tauri-apps/api/window";
import { registerExitCheckpoint } from "./exitCheckpoint";

describe("registerExitCheckpoint", () => {
  it("blocks close until every dirty document checkpoints", async () => {
    let closeHandler:
      ((event: CloseRequestedEvent) => void | Promise<void>) | undefined;
    const checkpointAll = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    const preventDefault = vi.fn();
    const unlisten: () => void = vi.fn();

    await registerExitCheckpoint({ checkpointAll }, vi.fn(), async () => ({
      destroy,
      async onCloseRequested(handler) {
        closeHandler = handler;
        return unlisten;
      },
    }));

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

    await registerExitCheckpoint({ checkpointAll }, vi.fn(), async () => ({
      destroy,
      async onCloseRequested(handler) {
        closeHandler = handler;
        return unlisten;
      },
    }));

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
    );

    await closeHandler?.({
      preventDefault: vi.fn(),
    } as unknown as CloseRequestedEvent);

    expect(onError).toHaveBeenCalledWith(failure);
    expect(destroy).not.toHaveBeenCalled();
  });
});
