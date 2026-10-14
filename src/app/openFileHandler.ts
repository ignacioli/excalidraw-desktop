import type { CommandInvoker } from "../ipc/client";
import type { AppHandshakeResponse } from "../ipc/contracts";
import { defaultEventListener } from "../ipc/events";
import { loadStartupHandshake } from "./startupRoute";

export interface OpenFileManager {
  /** `null`: another window has the drawing and now shows it. */
  openRouted(path: string): Promise<string | null>;
}

export interface OpenFileHandlerOptions {
  invoker?: CommandInvoker;
  listener?: (
    eventName: "open-file-request",
    handler: (event: { payload: { paths: string[] } }) => void,
  ) => Promise<() => void>;
  activateListener?: (
    eventName: "window-activate-document",
    handler: (event: { payload: { path: string } }) => void,
  ) => Promise<() => void>;
  onError?: (error: unknown) => void;
}

/**
 * Wires the native "open with" path (file association + single-instance
 * handoff) into the document session manager. Every forwarded path becomes
 * its own focused tab; paths handed to this launch are drained from the
 * handshake so the first instance never races the event bus. A drawing that
 * another window has stays there. `window-activate-document` switches to
 * the drawing's tab, opening it when this window does not have it yet.
 */
export function registerOpenFileHandler(
  manager: OpenFileManager,
  {
    invoker: providedInvoker,
    listener = defaultEventListener,
    activateListener = defaultEventListener,
    onError,
  }: OpenFileHandlerOptions = {},
): Promise<() => void> {
  return Promise.all([
    listener("open-file-request", (event) => {
      const paths = event.payload.paths;
      if (paths.length > 0) {
        void openPaths(manager, paths, onError);
      }
    }),
    activateListener("window-activate-document", (event) => {
      void openPaths(manager, [event.payload.path], onError);
    }),
  ]).then(([unlistenOpen, unlistenActivate]) => {
    void drainPendingStartupPaths(manager, providedInvoker, onError);
    return () => {
      unlistenOpen();
      unlistenActivate();
    };
  });
}

async function drainPendingStartupPaths(
  manager: OpenFileManager,
  invoker: CommandInvoker | undefined,
  onError: ((error: unknown) => void) | undefined,
): Promise<void> {
  try {
    const response = await loadStartupHandshake(invoker);
    const paths = response.pendingOpenPaths;
    if (paths.length > 0) {
      await openPaths(manager, paths, onError);
    }
  } catch (error) {
    onError?.(error);
  }
}

async function openPaths(
  manager: OpenFileManager,
  paths: readonly string[],
  onError: ((error: unknown) => void) | undefined,
): Promise<void> {
  for (const path of paths) {
    try {
      await manager.openRouted(path);
    } catch (error) {
      onError?.(error);
    }
  }
}

export type { AppHandshakeResponse };
