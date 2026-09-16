import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { interactionStore } from "../app/interaction";
import type { Workspace, WorkspaceEntry } from "../ipc/contracts";
import {
  buildWorkspaceTreeRows,
  captureScrollAnchor,
  getAdjacentRowKey,
  getPageTargetRowKey,
  resolveScrollAnchor,
  type ActiveDrawingReference,
  type WorkspaceTreeEntriesByWorkspace,
  type WorkspaceTreeRow,
} from "./workspaceTreeModel";
import drawingIcon from "../../docs/design/desktop-shell/hf-2/icons/new-drawing.svg";
import directoryIcon from "../../docs/design/desktop-shell/hf-2/icons/new-folder.svg";
import workspaceIcon from "../../docs/design/desktop-shell/hf-2/icons/sidebar.svg";
import collapseIcon from "../../docs/design/desktop-shell/hf-2/icons/collapse-all.svg";
import expandIcon from "../../docs/design/desktop-shell/hf-2/icons/expand-all.svg";
import moreVerticalIcon from "../../docs/design/desktop-shell/hf-2/icons/more-vertical.svg";

export interface WorkspaceTreeProps {
  workspaces: readonly Workspace[];
  entriesByWorkspace: WorkspaceTreeEntriesByWorkspace;
  currentWorkspaceId?: string | null;
  expandedWorkspaceIds?: ReadonlySet<string>;
  expandedDirectoryKeys?: ReadonlySet<string>;
  activeDrawing?: ActiveDrawingReference | null;
  activeDocumentPath?: string | null;
  onToggleWorkspace?: (workspaceId: string, expanded: boolean) => void;
  onToggleDirectory?: (entry: WorkspaceEntry, expanded: boolean) => void;
  onOpenDrawing?: (entry: WorkspaceEntry) => void;
  onSelectRow?: (row: WorkspaceTreeRow) => void;
  onRowAction?: (
    row: WorkspaceTreeRow,
    trigger: HTMLButtonElement,
    pointer?: { x: number; y: number },
  ) => void;
  onScroll?: () => void;
  focusRequestKey?: string | null;
  onFocusRequestApplied?: () => void;
  ariaLabel?: string;
  className?: string;
  rowHeight?: number;
  overscan?: number;
  captureFocus?: boolean;
}

const DEFAULT_ROW_HEIGHT = 28;
const DEFAULT_OVERSCAN = 8;
const FALLBACK_VISIBLE_ROWS = 40;

export function WorkspaceTree({
  workspaces,
  entriesByWorkspace,
  currentWorkspaceId,
  expandedWorkspaceIds: controlledWorkspaceIds,
  expandedDirectoryKeys: controlledDirectoryKeys,
  activeDrawing = null,
  activeDocumentPath = null,
  onToggleWorkspace,
  onToggleDirectory,
  onOpenDrawing,
  onSelectRow,
  onRowAction,
  onScroll,
  focusRequestKey = null,
  onFocusRequestApplied,
  ariaLabel = "Workspace files",
  className,
  rowHeight = DEFAULT_ROW_HEIGHT,
  overscan = DEFAULT_OVERSCAN,
  captureFocus = true,
}: WorkspaceTreeProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingFocusKey = useRef<string | null>(null);
  const knownWorkspaceIdsRef = useRef<Set<string> | null>(null);
  const previousRowsRef = useRef<readonly WorkspaceTreeRow[]>([]);
  const [internalWorkspaceIds, setInternalWorkspaceIds] = useState<Set<string>>(
    () => new Set(workspaces.map((workspace) => workspace.id)),
  );
  const [internalDirectoryKeys, setInternalDirectoryKeys] = useState<
    Set<string>
  >(() => new Set());
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);

  useEffect(() => {
    if (controlledWorkspaceIds !== undefined) return;
    setInternalWorkspaceIds((current) => {
      const known = knownWorkspaceIdsRef.current;
      const liveIds = new Set(workspaces.map((workspace) => workspace.id));
      const next = new Set<string>();
      for (const workspace of workspaces) {
        const seen = known?.has(workspace.id) ?? false;
        if (!seen || current.has(workspace.id)) {
          next.add(workspace.id);
        }
      }
      knownWorkspaceIdsRef.current = liveIds;
      return next;
    });
  }, [controlledWorkspaceIds, workspaces]);

  const expandedWorkspaceIds = controlledWorkspaceIds ?? internalWorkspaceIds;
  const expandedDirectoryKeys =
    controlledDirectoryKeys ?? internalDirectoryKeys;
  const rows = useMemo(
    () =>
      buildWorkspaceTreeRows({
        workspaces,
        entriesByWorkspace,
        currentWorkspaceId,
        expandedWorkspaceIds,
        expandedDirectoryKeys,
        activeDrawing,
        activeDocumentPath,
      }),
    [
      activeDocumentPath,
      activeDrawing,
      entriesByWorkspace,
      expandedDirectoryKeys,
      expandedWorkspaceIds,
      currentWorkspaceId,
      workspaces,
    ],
  );

  // TanStack Virtual exposes an intentionally imperative virtualizer object.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
    initialRect: { width: 320, height: 320 },
  });
  const virtualItems = virtualizer.getVirtualItems();
  const renderedRows =
    virtualItems.length > 0
      ? virtualItems.map((item) => ({
          row: rows[item.index],
          index: item.index,
          start: item.start,
        }))
      : rows.slice(0, FALLBACK_VISIBLE_ROWS).map((row, index) => ({
          row,
          index,
          start: index * rowHeight,
        }));

  useEffect(() => {
    const previousRows = previousRowsRef.current;
    previousRowsRef.current = rows;
    if (previousRows.length === 0) return;
    if (
      previousRows.length === rows.length &&
      previousRows.every((row, index) => row.key === rows[index]?.key)
    ) {
      return;
    }
    const scrollElement = scrollRef.current;
    if (scrollElement === null) return;
    const firstVisibleIndex = Math.max(
      0,
      Math.floor(scrollElement.scrollTop / rowHeight),
    );
    const offset = scrollElement.scrollTop - firstVisibleIndex * rowHeight;
    const resolved = resolveScrollAnchor(
      previousRows,
      rows,
      captureScrollAnchor(previousRows, firstVisibleIndex, offset),
    );
    if (resolved === null) return;
    virtualizer.scrollToOffset(resolved.index * rowHeight + resolved.offset);
  }, [rowHeight, rows, virtualizer]);

  useEffect(() => {
    if (
      focusedRowKey !== null &&
      rows.some((row) => row.key === focusedRowKey)
    ) {
      return;
    }
    const preferred =
      (activeDrawing === null
        ? undefined
        : rows.find((row) => row.isActive)?.key) ??
      rows[0]?.key ??
      null;
    setFocusedRowKey(preferred);
  }, [activeDrawing, focusedRowKey, rows]);

  useEffect(() => {
    if (!captureFocus) return;
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      active.closest('[role="dialog"], [aria-modal="true"]') !== null
    ) {
      return;
    }
    scrollRef.current?.focus({ preventScroll: true });
  }, [captureFocus]);

  useEffect(() => {
    const rowKey = pendingFocusKey.current;
    if (rowKey === null) return;
    const row = rowRefs.current.get(rowKey);
    if (row === undefined) return;
    row.focus();
    pendingFocusKey.current = null;
    if (focusRequestKey === rowKey) onFocusRequestApplied?.();
  }, [
    focusRequestKey,
    focusedRowKey,
    onFocusRequestApplied,
    rows,
    virtualItems,
  ]);

  useEffect(() => {
    if (focusRequestKey === null) return;
    const index = rows.findIndex((row) => row.key === focusRequestKey);
    if (index < 0) return;
    setFocusedRowKey(focusRequestKey);
    pendingFocusKey.current = focusRequestKey;
    virtualizer.scrollToIndex(index, { align: "auto" });
    const row = rowRefs.current.get(focusRequestKey);
    if (row !== undefined) {
      row.focus();
      pendingFocusKey.current = null;
      onFocusRequestApplied?.();
    }
  }, [focusRequestKey, onFocusRequestApplied, rows, virtualizer]);

  const focusRow = (rowKey: string | null): void => {
    if (rowKey === null) return;
    const index = rows.findIndex((row) => row.key === rowKey);
    if (index < 0) return;
    setFocusedRowKey(rowKey);
    pendingFocusKey.current = rowKey;
    virtualizer.scrollToIndex(index, { align: "auto" });
    const row = rowRefs.current.get(rowKey);
    if (row !== undefined) {
      row.focus();
      pendingFocusKey.current = null;
    }
  };

  const actionTriggerForRow = (rowKey: string): HTMLButtonElement | null => {
    return (
      rowRefs.current
        .get(rowKey)
        ?.querySelector<HTMLButtonElement>(".workspace-tree-action") ?? null
    );
  };

  const toggleWorkspace = (row: WorkspaceTreeRow): void => {
    if (row.kind !== "workspace") return;
    const nextExpanded = !expandedWorkspaceIds.has(row.workspaceId);
    if (controlledWorkspaceIds === undefined) {
      setInternalWorkspaceIds((current) => {
        const next = new Set(current);
        if (nextExpanded) next.add(row.workspaceId);
        else next.delete(row.workspaceId);
        return next;
      });
    }
    onToggleWorkspace?.(row.workspaceId, nextExpanded);
  };

  const toggleDirectory = (row: WorkspaceTreeRow): void => {
    if (row.kind !== "directory") return;
    const nextExpanded = !expandedDirectoryKeys.has(row.key);
    if (controlledDirectoryKeys === undefined) {
      setInternalDirectoryKeys((current) => {
        const next = new Set(current);
        if (nextExpanded) next.add(row.key);
        else next.delete(row.key);
        return next;
      });
    }
    onToggleDirectory?.(row.entry, nextExpanded);
  };

  const activateRow = (row: WorkspaceTreeRow): void => {
    setFocusedRowKey(row.key);
    onSelectRow?.(row);
    if (row.kind === "workspace") {
      toggleWorkspace(row);
    } else if (row.kind === "directory") {
      toggleDirectory(row);
    } else {
      onOpenDrawing?.(row.entry);
    }
  };

  const handleTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const currentRow = rows.find((row) => row.key === focusedRowKey);
    if (currentRow === undefined) return;

    let targetKey: string | null = null;
    if (event.key === "ArrowDown") {
      targetKey = getAdjacentRowKey(rows, currentRow.key, "next");
    } else if (event.key === "ArrowUp") {
      targetKey = getAdjacentRowKey(rows, currentRow.key, "previous");
    } else if (event.key === "PageDown" || event.key === "PageUp") {
      const viewportHeight = scrollRef.current?.clientHeight || 320;
      const pageSize = Math.max(1, Math.floor(viewportHeight / rowHeight));
      targetKey = getPageTargetRowKey(
        rows,
        currentRow.key,
        event.key === "PageDown" ? "next" : "previous",
        pageSize,
      );
    } else if (event.key === "Home") {
      targetKey = rows[0]?.key ?? null;
    } else if (event.key === "End") {
      targetKey = rows.at(-1)?.key ?? null;
    } else if (event.key === "ArrowRight") {
      if (
        currentRow.kind === "workspace" &&
        !expandedWorkspaceIds.has(currentRow.workspaceId)
      ) {
        toggleWorkspace(currentRow);
      } else if (
        currentRow.kind === "directory" &&
        !expandedDirectoryKeys.has(currentRow.key)
      ) {
        toggleDirectory(currentRow);
      } else {
        const next =
          rows[rows.findIndex((row) => row.key === currentRow.key) + 1];
        if (next !== undefined && next.depth > currentRow.depth)
          targetKey = next.key;
      }
    } else if (event.key === "ArrowLeft") {
      const isExpanded =
        currentRow.kind === "workspace"
          ? expandedWorkspaceIds.has(currentRow.workspaceId)
          : currentRow.kind === "directory" &&
            expandedDirectoryKeys.has(currentRow.key);
      if (isExpanded) {
        if (currentRow.kind === "workspace") toggleWorkspace(currentRow);
        else if (currentRow.kind === "directory") toggleDirectory(currentRow);
      } else {
        targetKey = currentRow.parentRowKey;
      }
    } else if (event.key === "Enter" || event.key === " ") {
      activateRow(currentRow);
    } else if (
      event.key === "F2" ||
      event.key === "ContextMenu" ||
      event.key === "Apps" ||
      (event.key === "F10" && event.shiftKey)
    ) {
      const trigger = actionTriggerForRow(currentRow.key);
      if (trigger !== null) onRowAction?.(currentRow, trigger);
    } else {
      return;
    }

    event.preventDefault();
    if (targetKey !== null) focusRow(targetKey);
  };

  return (
    <div
      ref={scrollRef}
      className={className ? `workspace-tree ${className}` : "workspace-tree"}
      role="tree"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={handleTreeKeyDown}
      onScroll={() => onScroll?.()}
      style={{
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        overflowX: "hidden",
        overflowY: "auto",
      }}
    >
      <div
        className="workspace-tree-rows"
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          minWidth: 0,
          position: "relative",
          width: "100%",
        }}
      >
        {renderedRows.map(({ row, start }) => (
          <WorkspaceTreeRowView
            key={row.key}
            row={row}
            rowHeight={rowHeight}
            start={start}
            expanded={
              row.kind === "workspace"
                ? expandedWorkspaceIds.has(row.workspaceId)
                : row.kind === "directory"
                  ? expandedDirectoryKeys.has(row.key)
                  : undefined
            }
            focused={row.key === focusedRowKey}
            onFocus={() => setFocusedRowKey(row.key)}
            onActivate={() => activateRow(row)}
            onAction={(trigger, pointer) =>
              onRowAction?.(row, trigger, pointer)
            }
            registerRef={(element) => {
              if (element === null) rowRefs.current.delete(row.key);
              else rowRefs.current.set(row.key, element);
            }}
          />
        ))}
      </div>
    </div>
  );
}

interface WorkspaceTreeRowViewProps {
  row: WorkspaceTreeRow;
  rowHeight: number;
  start: number;
  focused: boolean;
  onFocus: () => void;
  onActivate: () => void;
  onAction: (
    trigger: HTMLButtonElement,
    pointer?: { x: number; y: number },
  ) => void;
  registerRef: (element: HTMLDivElement | null) => void;
  expanded: boolean | undefined;
}

function WorkspaceTreeRowView({
  row,
  rowHeight,
  start,
  expanded,
  focused,
  onFocus,
  onActivate,
  onAction,
  registerRef,
}: WorkspaceTreeRowViewProps) {
  const isExpandable = row.kind === "workspace" || row.kind === "directory";
  const iconSrc =
    row.kind === "workspace"
      ? workspaceIcon
      : row.kind === "directory"
        ? directoryIcon
        : drawingIcon;
  const disclosureSrc = expanded ? collapseIcon : expandIcon;
  const [pointerFocused, setPointerFocused] = useState(false);

  return (
    <div
      ref={registerRef}
      role="treeitem"
      aria-label={row.displayName}
      aria-level={row.depth + 1}
      aria-posinset={row.siblingIndex}
      aria-setsize={row.siblingCount}
      aria-expanded={isExpandable ? expanded : undefined}
      aria-selected={row.isActive || undefined}
      className={`workspace-tree-row${row.isActive ? " is-active" : ""}`}
      data-pointer-focus={pointerFocused ? "true" : "false"}
      data-row-key={row.key}
      data-kind={row.kind}
      tabIndex={focused ? 0 : -1}
      title={row.displayName}
      onPointerEnter={() => setPointerFocused(true)}
      onPointerLeave={() => setPointerFocused(false)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        interactionStore.getState().dispatch({
          type: "addHold",
          reason: "drag",
        });
        const release = (upEvent: PointerEvent) => {
          interactionStore.getState().dispatch({
            type: "removeHold",
            reason: "drag",
          });
          window.removeEventListener("pointerup", release);
          window.removeEventListener("pointercancel", release);
          const sidebar = document.querySelector(".file-sidebar");
          if (
            sidebar instanceof Element &&
            upEvent.target instanceof Node &&
            !sidebar.contains(upEvent.target)
          ) {
            const active = document.activeElement;
            if (active instanceof HTMLElement && sidebar.contains(active)) {
              active.blur();
            }
          }
        };
        window.addEventListener("pointerup", release);
        window.addEventListener("pointercancel", release);
      }}
      onClick={onActivate}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const trigger = event.currentTarget.querySelector<HTMLButtonElement>(
          ".workspace-tree-action",
        );
        if (trigger !== null) {
          onAction(trigger, { x: event.clientX, y: event.clientY });
        }
      }}
      onFocus={onFocus}
      style={{
        alignItems: "center",
        display: "flex",
        gap: "0.25rem",
        height: `${rowHeight}px`,
        left: 0,
        minWidth: 0,
        overflow: "hidden",
        paddingInlineStart: `${row.depth * 16 + 4}px`,
        paddingInlineEnd: "0.25rem",
        position: "absolute",
        top: 0,
        transform: `translateY(${start}px)`,
        userSelect: "none",
        width: "100%",
      }}
    >
      <span
        aria-hidden="true"
        data-slot="workspace-tree-icon"
        className="workspace-tree-icon-slot"
        style={{
          display: "inline-flex",
          flex: "0 0 2.25rem",
          justifyContent: "center",
          width: "2.25rem",
        }}
      >
        {isExpandable ? (
          <img
            alt=""
            aria-hidden="true"
            className="workspace-tree-disclosure-icon"
            src={disclosureSrc}
          />
        ) : null}
        <img
          alt=""
          aria-hidden="true"
          className="workspace-tree-leading-icon"
          src={iconSrc}
        />
      </span>
      <span
        className="workspace-tree-label"
        data-slot="workspace-tree-label"
        style={{
          flex: "1 1 auto",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.displayName}
      </span>
      {row.isActive ? (
        <span
          aria-hidden="true"
          className="workspace-tree-active-indicator"
          data-slot="workspace-tree-active-indicator"
          title="Active drawing"
        />
      ) : null}
      <span
        data-slot="workspace-tree-action"
        className="workspace-tree-action-slot"
        style={{
          display: "inline-flex",
          flex: "0 0 2rem",
          justifyContent: "flex-end",
          width: "2rem",
        }}
      >
        <button
          type="button"
          aria-label={`Actions for ${row.displayName}`}
          className="workspace-tree-action"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.stopPropagation();
            }
          }}
          onClick={(event) => {
            event.stopPropagation();
            onAction(event.currentTarget);
          }}
          tabIndex={-1}
          title={`Actions for ${row.displayName}`}
          style={{ minWidth: "2rem" }}
        >
          <img alt="" aria-hidden="true" src={moreVerticalIcon} />
        </button>
      </span>
    </div>
  );
}
