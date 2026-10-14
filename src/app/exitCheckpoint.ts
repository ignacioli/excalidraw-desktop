import type { UnlistenFn } from "@tauri-apps/api/event";
import type { CloseRequestedEvent } from "@tauri-apps/api/window";
import type { DocumentManager } from "../documents/documentStore";
import { createTauriCommandInvoker } from "../ipc/client";
import { defaultEventListener } from "../ipc/events";

interface ExitWindow {
  destroy(): Promise<void>;
  onCloseRequested(
    handler: (event: CloseRequestedEvent) => void | Promise<void>,
  ): Promise<UnlistenFn>;
}

export interface PeerCloseOptions {
  listener?: (
    eventName: "window-close-requested-by-peer",
    handler: (event: { payload: { requestId: string } }) => void,
  ) => Promise<UnlistenFn>;
  /** Tell the window that asked that this window stayed open. */
  reportFailed?: (requestId: string) => Promise<void>;
}

/**
 * Closing the window checkpoints every drawing first, and stays open when
 * that fails. Another window may ask for the same close ("Close it and open
 * here"); a failed close is then reported back to it.
 */
export async function registerExitCheckpoint(
  manager: Pick<DocumentManager, "checkpointAll">,
  onError: (error: unknown) => void,
  resolveWindow: () => Promise<ExitWindow> = async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow();
  },
  {
    listener = defaultEventListener,
    reportFailed = async (requestId) => {
      await createTauriCommandInvoker().invoke("window_peer_close_failed", {
        requestId,
      });
    },
  }: PeerCloseOptions = {},
): Promise<UnlistenFn> {
  const appWindow = await resolveWindow();
  let destroying = false;
  /** `true` once the window is being destroyed. */
  const close = async (): Promise<boolean> => {
    if (destroying) return true;
    try {
      await manager.checkpointAll("appExit");
      destroying = true;
      await appWindow.destroy();
      return true;
    } catch (error) {
      onError(error);
      return false;
    }
  };
  const [unlistenClose, unlistenPeer] = await Promise.all([
    appWindow.onCloseRequested(async (event) => {
      if (destroying) {
        return;
      }
      event.preventDefault();
      await close();
    }),
    listener("window-close-requested-by-peer", (event) => {
      void close().then(async (closing) => {
        if (closing) return;
        try {
          await reportFailed(event.payload.requestId);
        } catch (error) {
          onError(error);
        }
      });
    }),
  ]);
  return () => {
    unlistenClose();
    unlistenPeer();
  };
}

export function hasNativeWindowRuntime(): boolean {
  const internals = (
    globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: { transformCallback?: unknown };
    }
  ).__TAURI_INTERNALS__;
  return typeof internals?.transformCallback === "function";
}
