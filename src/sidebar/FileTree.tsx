import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { documentManager } from "../documents/documentStore";
import {
  DirectoryNotEmptyDialog,
  EntryDeleteConfirmationDialog,
  EntryNamingDialog,
  type EntryNamingMode,
} from "../app/interaction";
import type { CommandInvoker } from "../ipc/client";
import {
  createTauriCommandInvoker,
  hasTauriCommandRuntime,
} from "../ipc/client";
import type {
  ColorScheme,
  DirEntry,
  FileEntry,
  WorkspaceEntry,
} from "../ipc/contracts";
import { useThumbnails } from "./useThumbnails";

interface TreeNode {
  entry: DirEntry;
  depth: number;
  parentPath: string;
}

export interface FileTreeProps {
  workspaceId: string;
  workspaceRoot?: string;
  invoker?: CommandInvoker;
  onOpenFile?: (entry: FileEntry) => void;
  theme?: ColorScheme;
  ariaLabel?: string;
}

export function FileTree({
  workspaceId,
  workspaceRoot,
  invoker: providedInvoker,
  onOpenFile,
  theme = "light",
  ariaLabel = "Workspace files",
}: FileTreeProps) {
  const fallbackInvoker = useMemo(() => createTauriCommandInvoker(), []);
  const invoker = providedInvoker ?? fallbackInvoker;
  const tauriRuntime = useMemo(() => hasTauriCommandRuntime(), []);
  const [entriesByPath, setEntriesByPath] = useState<
    Record<string, DirEntry[]>
  >({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    node: TreeNode;
    x: number;
    y: number;
  } | null>(null);
  const [naming, setNaming] = useState<{
    mode: EntryNamingMode;
    parentPath: string;
    node?: TreeNode;
  } | null>(null);
  const [deleting, setDeleting] = useState<{
    node: TreeNode;
    phase: "confirmation" | "nonEmpty";
    busy: boolean;
    error: string | null;
  } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadDirectory = useCallback(
    async (relativePath: string, force = false) => {
      if (
        !force &&
        (relativePath in entriesByPath || loading.has(relativePath))
      )
        return;
      setLoading((current) => new Set(current).add(relativePath));
      setError(null);
      try {
        const entries = await invoker.invoke("dir_list", {
          workspaceId,
          relativePath,
        });
        setEntriesByPath((current) => ({
          ...current,
          [relativePath]: entries,
        }));
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Unable to load this folder.",
        );
      } finally {
        setLoading((current) => {
          const next = new Set(current);
          next.delete(relativePath);
          return next;
        });
      }
    },
    [entriesByPath, invoker, loading, workspaceId],
  );

  useEffect(() => {
    setEntriesByPath({});
    setExpanded(new Set());
    void loadDirectory("");
  }, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps -- reset only when switching workspace

  const nodes = useMemo(() => {
    const result: TreeNode[] = [];
    const visit = (
      parentPath: string,
      depth: number,
      seen = new Set<string>(),
    ) => {
      if (seen.has(parentPath)) return;
      const nextSeen = new Set(seen).add(parentPath);
      for (const entry of entriesByPath[parentPath] ?? []) {
        result.push({ entry, depth, parentPath });
        if (entry.kind === "dir" && expanded.has(entry.relativePath)) {
          visit(entry.relativePath, depth + 1, nextSeen);
        }
      }
    };
    visit("", 0);
    return result;
  }, [entriesByPath, expanded]);

  // TanStack Virtual exposes an intentionally imperative virtualizer object.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: nodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 32,
    overscan: 8,
    initialRect: { width: 320, height: 320 },
  });
  const virtualRows = virtualizer.getVirtualItems();
  const rows =
    virtualRows.length > 0
      ? virtualRows.map((virtualRow) => ({
          node: nodes[virtualRow.index],
          index: virtualRow.index,
          start: virtualRow.start,
        }))
      : nodes
          .slice(0, 20)
          .map((node, index) => ({ node, index, start: index * 32 }));

  const visibleFilePaths = useMemo(
    () =>
      rows
        .filter((row) => row.node.entry.kind === "file")
        .map((row) => absolutePath(workspaceRoot, row.node.entry.relativePath)),
    [rows, workspaceRoot],
  );
  const thumbnailStates = useThumbnails({
    invoker,
    theme,
    enabled: tauriRuntime,
    visiblePaths: visibleFilePaths,
  });

  const toggleDirectory = async (node: TreeNode) => {
    const path = node.entry.relativePath;
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!expanded.has(path)) await loadDirectory(path);
  };

  const submitNaming = async (baseName: string) => {
    if (naming === null) return;
    if (naming.mode === "newDrawing" || naming.mode === "newDirectory") {
      const created = await invoker.invoke("workspace_entry_create", {
        workspaceId,
        parentRelativePath: naming.parentPath,
        kind: naming.mode === "newDrawing" ? "drawing" : "directory",
        baseName,
      });
      await loadDirectory(naming.parentPath, true);
      if (created.entry.kind === "drawing")
        onOpenFile?.(asFileEntry(created.entry));
      else {
        setExpanded((current) =>
          new Set(current).add(created.entry.relativePath),
        );
        await loadDirectory(created.entry.relativePath, true);
      }
    } else if (naming.node !== undefined) {
      const node = naming.node;
      const source = absolutePath(workspaceRoot, node.entry.relativePath);
      await documentManager.coordinateEntryRename(
        workspaceRoot ?? "",
        source,
        (expectedOpenDocuments) =>
          invoker.invoke("workspace_entry_rename", {
            workspaceId,
            relativePath: node.entry.relativePath,
            baseName,
            expectedOpenDocuments,
          }),
      );
      await loadDirectory(node.parentPath, true);
    }
    setNaming(null);
  };

  const requestDelete = async (node: TreeNode) => {
    setMenu(null);
    try {
      const canonicalPath = absolutePath(
        workspaceRoot,
        node.entry.relativePath,
      );
      const blockedDocumentId = documentManager.entryDeleteBlock(canonicalPath);
      if (blockedDocumentId !== null) {
        await documentManager.activate(blockedDocumentId);
        setError("Save the open drawing before deleting it.");
        return;
      }
      const preflight = await invoker.invoke(
        "workspace_entry_delete_preflight",
        {
          workspaceId,
          relativePath: node.entry.relativePath,
        },
      );
      setDeleting({
        node,
        phase:
          preflight.status === "directoryNotEmpty"
            ? "nonEmpty"
            : "confirmation",
        busy: false,
        error: null,
      });
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "The file operation failed.",
      );
    }
  };

  const confirmDelete = async () => {
    if (deleting === null) return;
    const { node } = deleting;
    setDeleting({ ...deleting, busy: true, error: null });
    try {
      await documentManager.coordinateCleanEntryDelete(
        workspaceRoot ?? "",
        absolutePath(workspaceRoot, node.entry.relativePath),
        (expectedOpenDocument) =>
          invoker.invoke("workspace_entry_delete", {
            workspaceId,
            relativePath: node.entry.relativePath,
            ...(expectedOpenDocument === undefined
              ? {}
              : { expectedOpenDocument }),
          }),
      );
      setDeleting(null);
      await loadDirectory(node.parentPath, true);
    } catch (nextError) {
      setDeleting({
        ...deleting,
        busy: false,
        error:
          nextError instanceof Error
            ? nextError.message
            : "The entry could not be deleted.",
      });
    }
  };

  return (
    <section className="file-tree" aria-label={ariaLabel}>
      {error ? <p role="alert">{error}</p> : null}
      <button
        type="button"
        className="file-tree-new-button"
        onClick={() => setNaming({ mode: "newDrawing", parentPath: "" })}
      >
        New drawing
      </button>
      <button
        type="button"
        className="file-tree-new-button"
        onClick={() => setNaming({ mode: "newDirectory", parentPath: "" })}
      >
        New folder
      </button>
      <div
        ref={scrollRef}
        className="file-tree-scroll"
        role="tree"
        tabIndex={0}
        style={{ height: "100%", minHeight: "8rem", overflow: "auto" }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: "relative",
            width: "100%",
          }}
        >
          {rows.map((virtualRow) => {
            const node = virtualRow.node;
            const isDirectory = node.entry.kind === "dir";
            const isExpanded = expanded.has(node.entry.relativePath);
            const thumbnailState = isDirectory
              ? undefined
              : thumbnailStates.get(
                  absolutePath(workspaceRoot, node.entry.relativePath),
                );
            return (
              <div
                key={`${node.parentPath}:${node.entry.kind}:${node.entry.relativePath}`}
                role="treeitem"
                aria-level={node.depth + 1}
                aria-expanded={isDirectory ? isExpanded : undefined}
                className="file-tree-row"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                  paddingInlineStart: `${node.depth * 16 + 4}px`,
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ node, x: event.clientX, y: event.clientY });
                }}
              >
                <button
                  type="button"
                  className="file-tree-label"
                  aria-label={`${isDirectory ? (isExpanded ? "Collapse" : "Expand") : "Open"} ${node.entry.name}`}
                  onClick={() => {
                    if (isDirectory) void toggleDirectory(node);
                    else
                      onOpenFile?.({
                        canonicalPath: absolutePath(
                          workspaceRoot,
                          node.entry.relativePath,
                        ),
                        workspaceId,
                        displayName: node.entry.name,
                        relativePath: node.entry.relativePath,
                        mtime: node.entry.mtime,
                        fileSize: node.entry.fileSize,
                      });
                  }}
                >
                  {thumbnailState?.phase === "ready" &&
                  thumbnailState.webpPath !== undefined ? (
                    <img
                      className="file-tree-thumbnail"
                      src={thumbnailState.webpPath}
                      alt=""
                      aria-hidden="true"
                      loading="lazy"
                      style={{
                        width: "2rem",
                        height: "1.25rem",
                        objectFit: "cover",
                        flex: "none",
                        borderRadius: "0.25rem",
                        border: "1px solid var(--border-subtle)",
                      }}
                    />
                  ) : null}
                  <span aria-hidden="true">
                    {isDirectory ? (isExpanded ? "▾" : "▸") : "·"}
                  </span>{" "}
                  {node.entry.name}
                </button>
                <button
                  type="button"
                  className="file-tree-menu-button"
                  aria-label={`Actions for ${node.entry.name}`}
                  onClick={(event) =>
                    setMenu({
                      node,
                      x: event.currentTarget.getBoundingClientRect().right,
                      y: event.currentTarget.getBoundingClientRect().bottom,
                    })
                  }
                >
                  •••
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {menu ? (
        <div
          className="file-tree-menu"
          role="menu"
          style={{ position: "fixed", left: menu.x, top: menu.y }}
        >
          {menu.node.entry.kind === "dir" ? (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                setNaming({
                  mode: "newDrawing",
                  parentPath: menu.node.entry.relativePath,
                });
                setMenu(null);
              }}
            >
              New drawing
            </button>
          ) : null}
          {menu.node.entry.kind === "dir" ? (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                setNaming({
                  mode: "newDirectory",
                  parentPath: menu.node.entry.relativePath,
                });
                setMenu(null);
              }}
            >
              New folder
            </button>
          ) : null}
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setNaming({
                mode:
                  menu.node.entry.kind === "file"
                    ? "renameDrawing"
                    : "renameDirectory",
                parentPath: menu.node.parentPath,
                node: menu.node,
              });
              setMenu(null);
            }}
          >
            Rename
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => void requestDelete(menu.node)}
          >
            Delete
          </button>
        </div>
      ) : null}
      {naming ? (
        <EntryNamingDialog
          currentName={naming.node?.entry.name}
          mode={naming.mode}
          onCancel={() => setNaming(null)}
          onSubmit={submitNaming}
        />
      ) : null}
      {deleting?.phase === "confirmation" ? (
        <EntryDeleteConfirmationDialog
          busy={deleting.busy}
          displayName={deleting.node.entry.name}
          errorMessage={deleting.error}
          onCancel={() => setDeleting(null)}
          onDelete={() => void confirmDelete()}
        />
      ) : null}
      {deleting?.phase === "nonEmpty" ? (
        <DirectoryNotEmptyDialog
          onCancel={() => setDeleting(null)}
          onReveal={() => {
            void invoker.invoke("workspace_entry_reveal", {
              workspaceId,
              relativePath: deleting.node.entry.relativePath,
            });
            setDeleting(null);
          }}
        />
      ) : null}
    </section>
  );
}

function asFileEntry(entry: WorkspaceEntry): FileEntry {
  return {
    canonicalPath: entry.canonicalPath,
    workspaceId: entry.workspaceId,
    displayName: entry.displayName,
    relativePath: entry.relativePath,
    mtime: entry.mtime,
    fileSize: entry.fileSize,
  };
}

function absolutePath(root: string | undefined, relativePath: string): string {
  if (!root) return relativePath;
  const separator = root.endsWith("/") ? "" : "/";
  return `${root}${separator}${relativePath}`;
}
