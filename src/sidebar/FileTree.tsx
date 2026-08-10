import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CommandInvoker } from "../ipc/client";
import {
  createTauriCommandInvoker,
  hasTauriCommandRuntime,
} from "../ipc/client";
import type { ColorScheme, DirEntry, FileEntry } from "../ipc/contracts";
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

  const runFileAction = async (
    node: TreeNode,
    action: "create" | "rename" | "delete",
  ) => {
    setMenu(null);
    try {
      if (action === "create") {
        const name = window.prompt("New drawing name", "drawing.excalidraw");
        if (!name) return;
        const created = await invoker.invoke("file_create", {
          workspaceId,
          relativePath: `${node.entry.relativePath}/${name}`,
        });
        onOpenFile?.(created);
        await loadDirectory(node.entry.relativePath, true);
      } else if (action === "rename") {
        const name = window.prompt("Rename drawing", node.entry.name);
        if (!name || name === node.entry.name) return;
        await invoker.invoke("file_rename", {
          path: absolutePath(workspaceRoot, node.entry.relativePath),
          newName: name,
        });
        await loadDirectory(node.parentPath, true);
      } else if (window.confirm(`Move ${node.entry.name} to the Trash?`)) {
        await invoker.invoke("file_delete", {
          path: absolutePath(workspaceRoot, node.entry.relativePath),
        });
        await loadDirectory(node.parentPath, true);
      }
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "The file operation failed.",
      );
    }
  };

  const createDrawing = async (directory: string) => {
    const name = window.prompt("New drawing name", "drawing.excalidraw");
    if (!name) return;
    try {
      const created = await invoker.invoke("file_create", {
        workspaceId,
        relativePath: directory ? `${directory}/${name}` : name,
      });
      onOpenFile?.(created);
      await loadDirectory(directory, true);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "The file operation failed.",
      );
    }
  };

  return (
    <section className="file-tree" aria-label={ariaLabel}>
      {error ? <p role="alert">{error}</p> : null}
      <button
        type="button"
        className="file-tree-new-button"
        onClick={() => void createDrawing("")}
      >
        New drawing
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
              onClick={() => void runFileAction(menu.node, "create")}
            >
              New drawing
            </button>
          ) : null}
          {menu.node.entry.kind === "file" ? (
            <button
              role="menuitem"
              type="button"
              onClick={() => void runFileAction(menu.node, "rename")}
            >
              Rename
            </button>
          ) : null}
          {menu.node.entry.kind === "file" ? (
            <button
              role="menuitem"
              type="button"
              onClick={() => void runFileAction(menu.node, "delete")}
            >
              Move to Trash
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function absolutePath(root: string | undefined, relativePath: string): string {
  if (!root) return relativePath;
  const separator = root.endsWith("/") ? "" : "/";
  return `${root}${separator}${relativePath}`;
}
