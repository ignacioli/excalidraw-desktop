import { describe, expect, it, vi } from "vitest";
import { registerOpenFileHandler } from "./openFileHandler";

interface CapturedListener {
  eventName: string;
  handler: (event: { payload: { paths: string[] } }) => void;
}

function installHandlers() {
  const captured: CapturedListener[] = [];
  const unlisten = vi.fn(() => undefined);
  const listener = vi.fn(
    (
      eventName: string,
      handler: (event: { payload: { paths: string[] } }) => void,
    ) => {
      captured.push({ eventName, handler });
      return Promise.resolve(unlisten);
    },
  );
  const opened: string[] = [];
  const manager = {
    open: vi.fn(async (path: string) => {
      opened.push(path);
      return path;
    }),
  };
  return { captured, listener, manager, opened, unlisten };
}

describe("registerOpenFileHandler", () => {
  it("registers an open-file-request listener and forwards each path to the manager", async () => {
    const handlers = installHandlers();
    const invoker = { invoke: vi.fn() };

    await registerOpenFileHandler(handlers.manager, {
      invoker,
      listener: handlers.listener,
    });

    expect(handlers.listener).toHaveBeenCalledWith(
      "open-file-request",
      expect.any(Function),
    );
    await handlers.captured[0].handler({
      payload: { paths: ["/one.excalidraw", "/two.excalidraw"] },
    });
    expect(handlers.opened).toEqual(["/one.excalidraw", "/two.excalidraw"]);
  });

  it("drains startup paths from the handshake without racing the event bus", async () => {
    const handlers = installHandlers();
    const invoker = {
      invoke: vi.fn(async (command: string) => {
        if (command === "app_handshake") {
          return {
            contractVersion: 1,
            appVersion: "0.1.0",
            abnormalExit: false,
            pendingOpenPaths: ["/startup.excalidraw"],
          };
        }
        throw new Error(`Unexpected command ${command}`);
      }),
    };

    await registerOpenFileHandler(handlers.manager, {
      invoker,
      listener: handlers.listener,
    });

    await vi.waitFor(() => {
      expect(handlers.opened).toEqual(["/startup.excalidraw"]);
    });
  });

  it("continues opening remaining paths when one fails and reports the error", async () => {
    const handlers = installHandlers();
    handlers.manager.open
      .mockImplementationOnce(async () => {
        throw new Error("corrupt scene");
      })
      .mockImplementationOnce(async (path: string) => {
        handlers.opened.push(path);
        return path;
      });
    const onError = vi.fn();
    const invoker = {
      invoke: vi.fn(async () => ({
        contractVersion: 1,
        appVersion: "0.1.0",
        abnormalExit: false,
        pendingOpenPaths: [],
      })),
    };

    await registerOpenFileHandler(handlers.manager, {
      invoker,
      listener: handlers.listener,
      onError,
    });
    await handlers.captured[0].handler({
      payload: { paths: ["/one.excalidraw", "/two.excalidraw"] },
    });

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(handlers.opened).toEqual(["/two.excalidraw"]);
  });
});
