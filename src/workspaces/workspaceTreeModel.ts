import type { Workspace, WorkspaceEntry } from "../ipc/contracts";

/** Entries are grouped by Workspace and by the parent path returned by IPC. */
export type WorkspaceTreeEntriesByWorkspace = Readonly<
  Record<string, Readonly<Record<string, readonly WorkspaceEntry[]>>>
>;

export interface ActiveDrawingReference {
  workspaceId: string;
  relativePath: string;
}

export interface WorkspaceTreeModelOptions {
  workspaces: readonly Workspace[];
  entriesByWorkspace: WorkspaceTreeEntriesByWorkspace;
  currentWorkspaceId?: string | null;
  expandedWorkspaceIds?: ReadonlySet<string>;
  expandedDirectoryKeys?: ReadonlySet<string>;
  activeDrawing?: ActiveDrawingReference | null;
  activeDocumentPath?: string | null;
}

interface WorkspaceTreeRowBase {
  key: string;
  workspaceId: string;
  relativePath: string;
  parentRowKey: string | null;
  depth: number;
  displayName: string;
  canonicalPath: string;
  isActive: boolean;
  siblingIndex: number;
  siblingCount: number;
}

export interface WorkspaceTreeWorkspaceRow extends WorkspaceTreeRowBase {
  kind: "workspace";
  workspace: Workspace;
  relativePath: "";
  parentRowKey: null;
}

export interface WorkspaceTreeEntryRow extends WorkspaceTreeRowBase {
  kind: WorkspaceEntry["kind"];
  entry: WorkspaceEntry;
}

export type WorkspaceTreeRow =
  WorkspaceTreeWorkspaceRow | WorkspaceTreeEntryRow;

/**
 * Workspace IDs and relative paths are kept in separate key namespaces. A
 * relative path is unique within a Workspace, so the key remains unchanged
 * when an entry list is refreshed or reordered.
 */
export function makeWorkspaceRowKey(workspaceId: string): string {
  return `workspace:${encodeURIComponent(workspaceId)}`;
}

export function makeEntryRowKey(
  workspaceId: string,
  relativePath: string,
): string {
  return `entry:${encodeURIComponent(workspaceId)}:${encodeURIComponent(relativePath)}`;
}

export function buildWorkspaceTreeRows(
  options: WorkspaceTreeModelOptions,
): WorkspaceTreeRow[] {
  const {
    workspaces,
    entriesByWorkspace,
    currentWorkspaceId,
    expandedWorkspaceIds = new Set<string>(),
    expandedDirectoryKeys = new Set<string>(),
    activeDrawing = null,
    activeDocumentPath = null,
  } = options;
  const visibleWorkspaces =
    currentWorkspaceId === undefined
      ? workspaces
      : workspaces.filter((workspace) => workspace.id === currentWorkspaceId);
  const rows: WorkspaceTreeRow[] = [];
  const visitedKeys = new Set<string>();
  const workspaceSiblingCount = new Set(
    visibleWorkspaces.map((workspace) => workspace.id),
  ).size;
  let workspaceSiblingIndex = 0;

  for (const workspace of visibleWorkspaces) {
    const workspaceKey = makeWorkspaceRowKey(workspace.id);
    if (visitedKeys.has(workspaceKey)) continue;
    visitedKeys.add(workspaceKey);
    workspaceSiblingIndex += 1;
    rows.push({
      key: workspaceKey,
      kind: "workspace",
      workspace,
      workspaceId: workspace.id,
      relativePath: "",
      parentRowKey: null,
      depth: 0,
      displayName: workspace.name,
      canonicalPath: workspace.rootPath,
      isActive: false,
      siblingIndex: workspaceSiblingIndex,
      siblingCount: workspaceSiblingCount,
    });

    if (expandedWorkspaceIds.has(workspace.id)) {
      appendEntries(
        rows,
        visitedKeys,
        entriesByWorkspace,
        workspace,
        "",
        1,
        workspaceKey,
        expandedDirectoryKeys,
        activeDrawing,
        activeDocumentPath,
        new Set<string>(),
      );
    }
  }

  return rows;
}

function appendEntries(
  rows: WorkspaceTreeRow[],
  visitedKeys: Set<string>,
  entriesByWorkspace: WorkspaceTreeEntriesByWorkspace,
  workspace: Workspace,
  parentRelativePath: string,
  depth: number,
  parentRowKey: string,
  expandedDirectoryKeys: ReadonlySet<string>,
  activeDrawing: ActiveDrawingReference | null,
  activeDocumentPath: string | null,
  ancestry: ReadonlySet<string>,
): void {
  const entries = entriesByWorkspace[workspace.id]?.[parentRelativePath] ?? [];
  const siblingCount = entries.filter(
    (entry) => entry.workspaceId === workspace.id,
  ).length;
  let siblingIndex = 0;
  for (const entry of entries) {
    if (entry.workspaceId !== workspace.id) continue;
    const key = makeEntryRowKey(workspace.id, entry.relativePath);
    if (visitedKeys.has(key)) continue;
    visitedKeys.add(key);
    siblingIndex += 1;
    const isActive =
      entry.kind === "drawing" &&
      ((activeDrawing?.workspaceId === workspace.id &&
        activeDrawing.relativePath === entry.relativePath) ||
        activeDocumentPath === entry.canonicalPath);
    rows.push({
      key,
      kind: entry.kind,
      entry,
      workspaceId: workspace.id,
      relativePath: entry.relativePath,
      parentRowKey,
      depth,
      displayName: entry.displayName || entry.name,
      canonicalPath: entry.canonicalPath,
      isActive,
      siblingIndex,
      siblingCount,
    });

    if (entry.kind !== "directory") continue;
    if (ancestry.has(entry.relativePath)) continue;
    if (!expandedDirectoryKeys.has(key)) continue;

    const nextAncestry = new Set(ancestry);
    nextAncestry.add(entry.relativePath);
    appendEntries(
      rows,
      visitedKeys,
      entriesByWorkspace,
      workspace,
      entry.relativePath,
      depth + 1,
      key,
      expandedDirectoryKeys,
      activeDrawing,
      activeDocumentPath,
      nextAncestry,
    );
  }
}

export interface ScrollAnchor {
  rowKey: string;
  offset: number;
}

export interface ResolvedScrollAnchor extends ScrollAnchor {
  index: number;
}

export function captureScrollAnchor(
  rows: readonly WorkspaceTreeRow[],
  firstVisibleIndex: number,
  offset = 0,
): ScrollAnchor | null {
  const row = rows[firstVisibleIndex];
  return row === undefined ? null : { rowKey: row.key, offset };
}

/**
 * Resolve an anchor after a refresh. The original row wins; when it was
 * removed, scan toward the preceding row first, then the following row. This
 * gives collapse/removal a deterministic nearest-survivor behavior while
 * keeping the original pixel offset.
 */
export function resolveScrollAnchor(
  previousRows: readonly WorkspaceTreeRow[],
  nextRows: readonly WorkspaceTreeRow[],
  anchor: ScrollAnchor | null,
): ResolvedScrollAnchor | null {
  if (anchor === null || nextRows.length === 0) return null;
  const directIndex = nextRows.findIndex((row) => row.key === anchor.rowKey);
  if (directIndex >= 0) {
    return { ...anchor, index: directIndex };
  }

  const previousIndex = previousRows.findIndex(
    (row) => row.key === anchor.rowKey,
  );
  const nextKeys = new Set(nextRows.map((row) => row.key));
  if (previousIndex >= 0) {
    for (let distance = 1; distance < previousRows.length; distance += 1) {
      const preceding = previousRows[previousIndex - distance];
      if (preceding !== undefined && nextKeys.has(preceding.key)) {
        return {
          rowKey: preceding.key,
          index: nextRows.findIndex((row) => row.key === preceding.key),
          offset: anchor.offset,
        };
      }
      const following = previousRows[previousIndex + distance];
      if (following !== undefined && nextKeys.has(following.key)) {
        return {
          rowKey: following.key,
          index: nextRows.findIndex((row) => row.key === following.key),
          offset: anchor.offset,
        };
      }
    }
  }

  return {
    rowKey: nextRows[0].key,
    index: 0,
    offset: anchor.offset,
  };
}

export function getAdjacentRowKey(
  rows: readonly WorkspaceTreeRow[],
  currentRowKey: string | null,
  direction: "previous" | "next",
): string | null {
  if (rows.length === 0) return null;
  const currentIndex = rows.findIndex((row) => row.key === currentRowKey);
  if (currentIndex < 0) return rows[0].key;
  const delta = direction === "next" ? 1 : -1;
  return rows[Math.max(0, Math.min(rows.length - 1, currentIndex + delta))].key;
}

export function getPageTargetRowKey(
  rows: readonly WorkspaceTreeRow[],
  currentRowKey: string | null,
  direction: "previous" | "next",
  pageSize: number,
): string | null {
  if (rows.length === 0) return null;
  const currentIndex = rows.findIndex((row) => row.key === currentRowKey);
  const safeIndex = currentIndex < 0 ? 0 : currentIndex;
  const distance = Math.max(1, Math.floor(pageSize));
  const delta = direction === "next" ? distance : -distance;
  return rows[Math.max(0, Math.min(rows.length - 1, safeIndex + delta))].key;
}
