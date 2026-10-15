import { useEffect, useState } from "react";
import type {
  AppHandshakeResponse,
  OpenWorkspaceName,
  Workspace,
} from "../ipc/contracts";
import { defaultEventListener, type EventListener } from "../ipc/events";
import { useI18n } from "../i18n";
import { hasNativeWindowRuntime } from "./exitCheckpoint";
import { windowTitle } from "./windowTitle";

const NO_OPEN_WORKSPACES: readonly OpenWorkspaceName[] = [];

async function setCurrentWindowTitle(title: string): Promise<void> {
  if (!hasNativeWindowRuntime()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setTitle(title);
}

export interface UseWindowTitleOptions {
  workspace: Pick<Workspace, "id" | "name" | "rootPath"> | null;
  activeDrawing: string | null;
  handshake: AppHandshakeResponse | null;
  listen?: EventListener<"open-workspaces-changed">;
  setNativeTitle?: (title: string) => Promise<void>;
}

/**
 * Keep the window title in step with the Workspace, the active drawing, and
 * the Workspaces open in other windows. Returns the title.
 */
export function useWindowTitle({
  workspace,
  activeDrawing,
  handshake,
  listen = defaultEventListener,
  setNativeTitle = setCurrentWindowTitle,
}: UseWindowTitleOptions): string {
  const { t } = useI18n();
  const [announced, setAnnounced] = useState<
    readonly OpenWorkspaceName[] | null
  >(null);

  useEffect(() => {
    if (listen === defaultEventListener && !hasNativeWindowRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("open-workspaces-changed", ({ payload }) => {
      setAnnounced(payload.workspaces);
    }).then(
      (nextUnlisten) => {
        if (disposed) nextUnlisten();
        else unlisten = nextUnlisten;
      },
      (error: unknown) => {
        console.error("Could not follow the open Workspaces.", error);
      },
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [listen]);

  // Handshake test doubles from before the per-window bootstrap omit `window`.
  const openWorkspaces =
    announced ?? handshake?.window?.openWorkspaceNames ?? NO_OPEN_WORKSPACES;
  const title = windowTitle({ workspace, openWorkspaces, activeDrawing, t });

  useEffect(() => {
    document.title = title;
    setNativeTitle(title).catch((error: unknown) => {
      console.error("Could not set the window title.", error);
    });
  }, [title, setNativeTitle]);

  return title;
}
