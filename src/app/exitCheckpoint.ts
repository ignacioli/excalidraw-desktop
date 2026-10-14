import type { UnlistenFn } from "@tauri-apps/api/event";
import type { CloseRequestedEvent } from "@tauri-apps/api/window";
import type { DocumentManager } from "../documents/documentStore";
import { describeError, LocalizedError } from "../i18n/describeError";
import { createTauriCommandInvoker } from "../ipc/client";
import type { CommandRequest } from "../ipc/contracts";
import { defaultEventListener, type EventListener } from "../ipc/events";

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

export interface QuitCheckpointOptions {
  /** This window's label. */
  resolveLabel?: () => Promise<string>;
  requestListener?: EventListener<"app-quit-requested">;
  cancelListener?: EventListener<"app-quit-cancelled">;
  reportReady?: (answer: CommandRequest<"app_quit_ready">) => Promise<void>;
}

/**
 * Quitting the app checkpoints every drawing of this window first and
 * reports the result. When this window cannot checkpoint, or answers too
 * late, the quit is cancelled and this window shows why; the window stays
 * open and keeps its drawings either way.
 */
export async function registerQuitCheckpoint(
  manager: Pick<DocumentManager, "checkpointAll">,
  onError: (error: unknown) => void,
  {
    resolveLabel = async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      return getCurrentWindow().label;
    },
    requestListener = defaultEventListener,
    cancelListener = defaultEventListener,
    reportReady = async (answer) => {
      await createTauriCommandInvoker().invoke("app_quit_ready", answer);
    },
  }: QuitCheckpointOptions = {},
): Promise<UnlistenFn> {
  const label = await resolveLabel();
  /** Requests this window already explained as its own failure. */
  const failed = new Set<string>();
  const answer = async (
    request: CommandRequest<"app_quit_ready">,
  ): Promise<void> => {
    try {
      await reportReady(request);
    } catch (error) {
      onError(error);
    }
  };
  const [unlistenRequest, unlistenCancel] = await Promise.all([
    requestListener("app-quit-requested", (event) => {
      const { requestId } = event.payload;
      void manager.checkpointAll("appExit").then(
        () => answer({ requestId, ok: true }),
        (error: unknown) => {
          failed.add(requestId);
          onError(
            new LocalizedError(
              "shell.quit.cancelled",
              { reason: describeError(error, "error.fileOperationFailed") },
              { cause: error },
            ),
          );
          return answer({
            requestId,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          });
        },
      );
    }),
    cancelListener("app-quit-cancelled", (event) => {
      const { requestId, failedLabel } = event.payload;
      // A window that did not answer in time learns it here.
      if (failedLabel === label && !failed.has(requestId)) {
        onError(new LocalizedError("error.QUIT_CHECKPOINT_FAILED"));
      }
      failed.delete(requestId);
    }),
  ]);
  return () => {
    unlistenRequest();
    unlistenCancel();
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
