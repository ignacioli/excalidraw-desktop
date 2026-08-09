import type { UnlistenFn } from "@tauri-apps/api/event";
import type { CloseRequestedEvent } from "@tauri-apps/api/window";
import type { DocumentManager } from "../documents/documentStore";

interface ExitWindow {
  destroy(): Promise<void>;
  onCloseRequested(
    handler: (event: CloseRequestedEvent) => void | Promise<void>,
  ): Promise<UnlistenFn>;
}

export async function registerExitCheckpoint(
  manager: Pick<DocumentManager, "checkpointAll">,
  onError: (error: unknown) => void,
  resolveWindow: () => Promise<ExitWindow> = async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow();
  },
): Promise<UnlistenFn> {
  const appWindow = await resolveWindow();
  let destroying = false;
  return appWindow.onCloseRequested(async (event) => {
    if (destroying) {
      return;
    }
    event.preventDefault();
    try {
      await manager.checkpointAll("appExit");
      destroying = true;
      await appWindow.destroy();
    } catch (error) {
      onError(error);
    }
  });
}

export function hasNativeWindowRuntime(): boolean {
  const internals = (
    globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: { transformCallback?: unknown };
    }
  ).__TAURI_INTERNALS__;
  return typeof internals?.transformCallback === "function";
}
