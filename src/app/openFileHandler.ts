import { createTauriCommandInvoker, type CommandInvoker } from "../ipc/client";
import type { AppHandshakeResponse } from "../ipc/contracts";
import { defaultEventListener } from "../ipc/events";

export interface OpenFileManager {
  open(path: string): Promise<string>;
}

export interface OpenFileHandlerOptions {
  invoker?: CommandInvoker;
  listener?: (
    eventName: "open-file-request",
    handler: (event: { payload: { paths: string[] } }) => void,
  ) => Promise<() => void>;
  onError?: (error: unknown) => void;
}

/**
 * Wires the native "open with" path (file association + single-instance
 * handoff) into the document session manager. Every forwarded path becomes
 * its own focused tab; paths handed to this launch are drained from the
 * handshake so the first instance never races the event bus.
 */
export function registerOpenFileHandler(
  manager: OpenFileManager,
  {
    invoker: providedInvoker,
    listener = defaultEventListener,
    onError,
  }: OpenFileHandlerOptions = {},
): Promise<() => void> {
  const invoker = providedInvoker ?? createTauriCommandInvoker();

  return listener("open-file-request", (event) => {
    const paths = event.payload.paths;
    if (paths.length > 0) {
      openPaths(manager, paths, onError);
    }
  }).then((unlisten) => {
    void drainPendingStartupPaths(manager, invoker, onError);
    return unlisten;
  });
}

async function drainPendingStartupPaths(
  manager: OpenFileManager,
  invoker: CommandInvoker,
  onError: ((error: unknown) => void) | undefined,
): Promise<void> {
  try {
    const response = await invoker.invoke("app_handshake", {});
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
      await manager.open(path);
    } catch (error) {
      onError?.(error);
    }
  }
}

export type { AppHandshakeResponse };
