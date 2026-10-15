import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { relativeDocumentPath } from "../documents/documentStore";

/** Writes text to the system clipboard; tests pass their own. */
export interface ClipboardPort {
  writeText(text: string): Promise<void>;
}

/** The clipboard plugin, allowed to write text only. */
export const systemClipboard: ClipboardPort = {
  writeText: (text) => writeText(text),
};

export type CopyPathKind = "path" | "relativePath";

export interface CopyPathRequest {
  kind: CopyPathKind;
  /**
   * Reads the path when the menu item is chosen, so a renamed, moved or
   * deleted item is never copied with a stale path. Null when it no longer
   * exists.
   */
  resolve(): string | null;
}

export type CopyPathResult =
  | { status: "copied"; kind: CopyPathKind; text: string }
  | { status: "missing" }
  | { status: "failed" };

export async function copyPath(
  clipboard: ClipboardPort,
  request: CopyPathRequest,
): Promise<CopyPathResult> {
  const text = request.resolve();
  if (text === null || text === "") return { status: "missing" };
  try {
    await clipboard.writeText(text);
  } catch (error) {
    console.error("Could not copy the path.", error);
    return { status: "failed" };
  }
  return { status: "copied", kind: request.kind, text };
}

/** The `/`-separated path below `workspaceRoot`; null outside it. */
export function workspaceRelativePath(
  workspaceRoot: string,
  path: string,
): string | null {
  try {
    const relative = relativeDocumentPath(workspaceRoot, path);
    return relative === "" ? null : relative;
  } catch {
    return null;
  }
}
