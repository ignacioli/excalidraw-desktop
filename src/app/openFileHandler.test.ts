import type { AppHandshakeResponse } from "../ipc/contracts";
import { describe, expect, it, vi } from "vitest";
import { registerOpenFileHandler } from "./openFileHandler";

const welcomeWindow: AppHandshakeResponse["window"] = {
  label: "window-1",
  workspace: null,
  unavailableWorkspace: null,
  restore: null,
  shell: null,
  openWorkspaceNames: [],
};

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
    openRouted: vi.fn(async (path: string): Promise<string | null> => {
      opened.push(path);
      return path;
    }),
  };
  const activated: Array<(event: { payload: { path: string } }) => void> = [];
  const activateListener = vi.fn(
    (
      _eventName: "window-activate-document",
      handler: (event: { payload: { path: string } }) => void,
    ) => {
      activated.push(handler);
      return Promise.resolve(unlisten);
    },
  );
  return {
    activated,
    activateListener,
    captured,
    listener,
    manager,
    opened,
    unlisten,
  };
}

describe("registerOpenFileHandler", () => {
  it("registers an open-file-request listener and forwards each path to the manager", async () => {
    const handlers = installHandlers();
    const invoker = { invoke: vi.fn() };

    await registerOpenFileHandler(handlers.manager, {
      invoker,
      listener: handlers.listener,
      activateListener: handlers.activateListener,
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
            contractVersion: 2,
            appVersion: "0.1.0",
            abnormalExit: false,
            pendingOpenPaths: ["/startup.excalidraw"],
            preferredLanguages: [],
            window: welcomeWindow,
          };
        }
        throw new Error(`Unexpected command ${command}`);
      }),
    };

    await registerOpenFileHandler(handlers.manager, {
      invoker,
      listener: handlers.listener,
      activateListener: handlers.activateListener,
    });

    await vi.waitFor(() => {
      expect(handlers.opened).toEqual(["/startup.excalidraw"]);
    });
  });

  it("continues opening remaining paths when one fails and reports the error", async () => {
    const handlers = installHandlers();
    handlers.manager.openRouted
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
        contractVersion: 2,
        appVersion: "0.1.0",
        abnormalExit: false,
        pendingOpenPaths: [],
        preferredLanguages: [],
        window: welcomeWindow,
      })),
    };

    await registerOpenFileHandler(handlers.manager, {
      invoker,
      listener: handlers.listener,
      activateListener: handlers.activateListener,
      onError,
    });
    await handlers.captured[0].handler({
      payload: { paths: ["/one.excalidraw", "/two.excalidraw"] },
    });

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(handlers.opened).toEqual(["/two.excalidraw"]);
  });

  it("switches to or opens the drawing another window asked this one to show", async () => {
    const handlers = installHandlers();
    const invoker = {
      invoke: vi.fn(async () => ({
        contractVersion: 5,
        appVersion: "0.1.0",
        abnormalExit: false,
        pendingOpenPaths: [],
        preferredLanguages: [],
        window: welcomeWindow,
      })),
    };

    await registerOpenFileHandler(handlers.manager, {
      invoker,
      listener: handlers.listener,
      activateListener: handlers.activateListener,
    });
    expect(handlers.activateListener).toHaveBeenCalledWith(
      "window-activate-document",
      expect.any(Function),
    );
    handlers.activated[0]({ payload: { path: "/a/note.excalidraw" } });

    await vi.waitFor(() => {
      expect(handlers.opened).toEqual(["/a/note.excalidraw"]);
    });
  });

  it("opens nothing here for a drawing another window has", async () => {
    const handlers = installHandlers();
    handlers.manager.openRouted.mockResolvedValue(null);
    const onError = vi.fn();
    const invoker = {
      invoke: vi.fn(async () => ({
        contractVersion: 5,
        appVersion: "0.1.0",
        abnormalExit: false,
        pendingOpenPaths: [],
        preferredLanguages: [],
        window: welcomeWindow,
      })),
    };

    await registerOpenFileHandler(handlers.manager, {
      invoker,
      listener: handlers.listener,
      activateListener: handlers.activateListener,
      onError,
    });
    await handlers.captured[0].handler({
      payload: { paths: ["/b/owned.excalidraw"] },
    });

    expect(handlers.manager.openRouted).toHaveBeenCalledWith(
      "/b/owned.excalidraw",
    );
    expect(onError).not.toHaveBeenCalled();
  });
});
