import type { OpenWorkspaceName, Workspace } from "../ipc/contracts";
import type { MessageKey, MessageParams } from "../i18n";

/** The title of a window with neither a Workspace nor an active drawing. */
export const APP_TITLE = "Excalidraw";

type Translate = (key: MessageKey, params?: MessageParams) => string;

export interface WindowTitleInput {
  workspace: Pick<Workspace, "id" | "name" | "rootPath"> | null;
  /** Workspaces open in any window, this one included. */
  openWorkspaces: readonly OpenWorkspaceName[];
  /** The active tab's title, or `null` without an active drawing. */
  activeDrawing: string | null;
  t: Translate;
}

function parentFolderName(rootPath: string): string | null {
  const parts = rootPath.split(/[/\\]/u).filter(Boolean);
  return parts.length >= 2 ? (parts.at(-2) ?? null) : null;
}

/**
 * The Workspace part of a title. When another open Workspace has the same
 * name, the parent folder's name tells them apart.
 */
export function workspaceTitle(
  workspace: Pick<Workspace, "id" | "name" | "rootPath">,
  openWorkspaces: readonly OpenWorkspaceName[],
  t: Translate,
): string {
  const shared = openWorkspaces.some(
    (open) => open.workspaceId !== workspace.id && open.name === workspace.name,
  );
  const parent = shared ? parentFolderName(workspace.rootPath) : null;
  return parent === null
    ? workspace.name
    : t("shell.windowTitle.sameName", { workspace: workspace.name, parent });
}

/** `{drawing} — {workspace}`, the Workspace alone, or the app name. */
export function windowTitle({
  workspace,
  openWorkspaces,
  activeDrawing,
  t,
}: WindowTitleInput): string {
  const context =
    workspace === null
      ? APP_TITLE
      : workspaceTitle(workspace, openWorkspaces, t);
  return activeDrawing === null
    ? context
    : t("shell.windowTitle.drawing", { drawing: activeDrawing, context });
}
