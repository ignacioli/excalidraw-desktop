import { useEffect, useMemo, useState } from "react";
import type { CommandInvoker } from "../ipc/client";
import { createTauriCommandInvoker } from "../ipc/client";
import type { ColorScheme, Workspace } from "../ipc/contracts";
import { FileTree } from "../sidebar/FileTree";

export interface WorkspacePanelProps {
  invoker?: CommandInvoker;
  selectDirectory?: () => Promise<string | null>;
  onOpenFile?: (entry: import("../ipc/contracts").FileEntry) => void;
  onWorkspacePresenceChange?: (hasAny: boolean) => void;
  theme?: ColorScheme;
}

export function WorkspacePanel({
  invoker: providedInvoker,
  selectDirectory: providedSelectDirectory,
  onOpenFile,
  onWorkspacePresenceChange,
  theme = "light",
}: WorkspacePanelProps) {
  const fallbackInvoker = useMemo(() => createTauriCommandInvoker(), []);
  const invoker = providedInvoker ?? fallbackInvoker;
  const selectDirectory = providedSelectDirectory ?? selectNativeDirectory;
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    let disposed = false;
    void invoker
      .invoke("workspace_list", {})
      .then((items) => {
        if (!disposed) {
          setWorkspaces(items);
          onWorkspacePresenceChange?.(items.length > 0);
        }
      })
      .catch((nextError: unknown) => {
        if (!disposed)
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Unable to load workspaces.",
          );
      });
    return () => {
      disposed = true;
    };
  }, [invoker, onWorkspacePresenceChange]);

  const mountWorkspace = async () => {
    if (!selectDirectory) {
      setError(
        "Choose a directory from the native file dialog to mount a workspace.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const rootPath = await selectDirectory();
      if (rootPath) {
        const workspace = await invoker.invoke("workspace_add", { rootPath });
        setWorkspaces((current) => [...current, workspace]);
        onWorkspacePresenceChange?.(true);
      }
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to mount this workspace.",
      );
    } finally {
      setBusy(false);
    }
  };

  const removeWorkspace = async (workspace: Workspace) => {
    if (
      !window.confirm(
        `Remove “${workspace.name}” from this app? Files on disk will not be deleted.`,
      )
    )
      return;
    setBusy(true);
    try {
      await invoker.invoke("workspace_remove", { workspaceId: workspace.id });
      const next = workspaces.filter((item) => item.id !== workspace.id);
      setWorkspaces(next);
      setCollapsedIds((current) => {
        const withoutRemoved = new Set(current);
        withoutRemoved.delete(workspace.id);
        return withoutRemoved;
      });
      onWorkspacePresenceChange?.(next.length > 0);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to remove this workspace.",
      );
    } finally {
      setBusy(false);
    }
  };

  const toggleCollapsed = (workspaceId: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  };

  return (
    <section className="workspace-panel" aria-label="Workspaces">
      <div className="workspace-panel-header">
        <h2>Workspaces</h2>
        <button
          type="button"
          disabled={busy}
          onClick={() => void mountWorkspace()}
        >
          Mount folder…
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {workspaces.length === 0 ? (
        <p className="sidebar-placeholder">No workspace mounted.</p>
      ) : null}
      {workspaces.map((workspace) => (
        <article className="workspace-section" key={workspace.id}>
          <header className="workspace-section-header">
            <button
              type="button"
              className="workspace-section-toggle"
              aria-expanded={!collapsedIds.has(workspace.id)}
              aria-controls={`workspace-files-${workspace.id}`}
              title={workspace.rootPath}
              onClick={() => toggleCollapsed(workspace.id)}
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              <span aria-hidden="true">
                {collapsedIds.has(workspace.id) ? "▸" : "▾"}
              </span>{" "}
              <span className="workspace-section-name">{workspace.name}</span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void removeWorkspace(workspace)}
            >
              Remove
            </button>
          </header>
          <div
            id={`workspace-files-${workspace.id}`}
            className="workspace-files"
            hidden={collapsedIds.has(workspace.id)}
          >
            <FileTree
              workspaceId={workspace.id}
              workspaceRoot={workspace.rootPath}
              invoker={invoker}
              onOpenFile={onOpenFile}
              theme={theme}
              ariaLabel={`Workspace files for ${workspace.name}`}
            />
          </div>
        </article>
      ))}
    </section>
  );
}

async function selectNativeDirectory(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Mount workspace folder",
  });
  return typeof selected === "string" ? selected : null;
}
