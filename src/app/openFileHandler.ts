import type { CommandInvoker } from "../ipc/client";
import type {
  AppHandshakeResponse,
  WindowRestoreBootstrap,
} from "../ipc/contracts";
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
  /** Some tabs of the previous session could not be reopened. */
  onRestoreSkipped?: (count: number) => void;
}

/**
 * Wires the native "open with" path (file association + single-instance
 * handoff) into the document session manager. Every forwarded path becomes
 * its own focused tab; paths handed to this launch are drained from the
 * handshake so the first instance never races the event bus. The tabs of
 * the previous session reopen first, so launch files end up in front. A drawing that
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
    onRestoreSkipped,
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
    void drainPendingStartupPaths(
      manager,
      providedInvoker,
      onError,
      onRestoreSkipped,
    );
    return () => {
      unlistenOpen();
      unlistenActivate();
    };
  });
}

/**
 * Handshakes whose restore tabs and launch paths were already opened. The
 * handshake is read once per window, so a handler registered again (React
 * Strict Mode mounts effects twice) must not open the same tabs twice.
 */
const drainedHandshakes = new WeakSet<AppHandshakeResponse>();

async function drainPendingStartupPaths(
  manager: OpenFileManager,
  invoker: CommandInvoker | undefined,
  onError: ((error: unknown) => void) | undefined,
  onRestoreSkipped: ((count: number) => void) | undefined,
): Promise<void> {
  try {
    const response = await loadStartupHandshake(invoker);
    if (drainedHandshakes.has(response)) return;
    drainedHandshakes.add(response);
    // Handshake test doubles from before the per-window bootstrap omit it.
    const restore = response.window?.restore ?? null;
    if (restore !== null) {
      const skipped = await restoreTabs(manager, restore);
      if (skipped > 0) onRestoreSkipped?.(skipped);
    }
    const paths = response.pendingOpenPaths;
    if (paths.length > 0) {
      await openPaths(manager, paths, onError);
    }
  } catch (error) {
    onError?.(error);
  }
}

/**
 * Reopen the previous session's tabs in order, then switch to the tab that
 * was active. Returns how many tabs could not be reopened, including those
 * the backend already dropped.
 */
export async function restoreTabs(
  manager: OpenFileManager,
  restore: WindowRestoreBootstrap,
): Promise<number> {
  let skipped = restore.skipped;
  const reopened = new Set<string>();
  for (const path of restore.tabs) {
    try {
      if ((await manager.openRouted(path)) === null) skipped += 1;
      else reopened.add(path);
    } catch {
      skipped += 1;
    }
  }
  const active = restore.activePath;
  if (active !== null && reopened.has(active)) {
    try {
      await manager.openRouted(active);
    } catch {
      // The tab is open; it simply stays in the background.
    }
  }
  return skipped;
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
