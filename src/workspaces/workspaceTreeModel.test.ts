import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceEntry } from "../ipc/contracts";
import {
  buildWorkspaceTreeRows,
  captureScrollAnchor,
  getAdjacentRowKey,
  getPageTargetRowKey,
  makeEntryRowKey,
  makeWorkspaceRowKey,
  resolveScrollAnchor,
  type WorkspaceTreeEntriesByWorkspace,
} from "./workspaceTreeModel";

const workspaces: Workspace[] = [
  {
    id: "workspace-1",
    name: "Sketches",
    rootPath: "/workspace/sketches",
    createdAt: 1,
  },
  {
    id: "workspace-2",
    name: "Blueprints",
    rootPath: "/workspace/blueprints",
    createdAt: 2,
  },
];

function entry(
  workspaceId: string,
  relativePath: string,
  kind: WorkspaceEntry["kind"],
  name = relativePath.split("/").at(-1) ?? relativePath,
  parentRelativePath = relativePath.includes("/")
    ? relativePath.slice(0, relativePath.lastIndexOf("/"))
    : "",
): WorkspaceEntry {
  return {
    workspaceId,
    kind,
    canonicalPath: `/workspace/${workspaceId}/${relativePath}`,
    relativePath,
    parentRelativePath,
    name,
    displayName: name,
    mtime: 1,
    fileSize: 1,
  };
}

function entries(): WorkspaceTreeEntriesByWorkspace {
  return {
    "workspace-1": {
      "": [
        entry("workspace-1", "notes", "directory"),
        entry("workspace-1", "first.excalidraw", "drawing"),
      ],
      notes: [entry("workspace-1", "notes/nested.excalidraw", "drawing")],
    },
    "workspace-2": {
      "": [entry("workspace-2", "plan.excalidraw", "drawing")],
    },
  };
}

describe("workspaceTreeModel", () => {
  it("flattens expanded workspaces into one depth-first visible row list", () => {
    const rows = buildWorkspaceTreeRows({
      workspaces,
      entriesByWorkspace: entries(),
      expandedWorkspaceIds: new Set(["workspace-1", "workspace-2"]),
      expandedDirectoryKeys: new Set([makeEntryRowKey("workspace-1", "notes")]),
      activeDrawing: {
        workspaceId: "workspace-1",
        relativePath: "first.excalidraw",
      },
    });

    expect(rows.map((row) => row.key)).toEqual([
      makeWorkspaceRowKey("workspace-1"),
      makeEntryRowKey("workspace-1", "notes"),
      makeEntryRowKey("workspace-1", "notes/nested.excalidraw"),
      makeEntryRowKey("workspace-1", "first.excalidraw"),
      makeWorkspaceRowKey("workspace-2"),
      makeEntryRowKey("workspace-2", "plan.excalidraw"),
    ]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 1, 0, 1]);
    expect(
      rows.find(
        (row) => row.key === makeEntryRowKey("workspace-1", "first.excalidraw"),
      ),
    ).toMatchObject({ kind: "drawing", isActive: true });
  });

  it("keeps row keys stable across refresh ordering and identifies the parent row", () => {
    const first = buildWorkspaceTreeRows({
      workspaces: [workspaces[0]],
      entriesByWorkspace: entries(),
      expandedWorkspaceIds: new Set(["workspace-1"]),
    });
    const originalEntries = entries();
    const refreshedEntries: WorkspaceTreeEntriesByWorkspace = {
      ...originalEntries,
      "workspace-1": {
        ...originalEntries["workspace-1"],
        "": [
          originalEntries["workspace-1"][""][1],
          originalEntries["workspace-1"][""][0],
        ],
      },
    };
    const refreshed = buildWorkspaceTreeRows({
      workspaces: [workspaces[0]],
      entriesByWorkspace: refreshedEntries,
      expandedWorkspaceIds: new Set(["workspace-1"]),
    });

    expect(new Set(first.map((row) => row.key))).toEqual(
      new Set(refreshed.map((row) => row.key)),
    );
    expect(refreshed.find((row) => row.kind === "drawing")).toMatchObject({
      parentRowKey: makeWorkspaceRowKey("workspace-1"),
    });
  });

  it("restores the first surviving anchor or its nearest neighbor after rows disappear", () => {
    const previous = buildWorkspaceTreeRows({
      workspaces: [workspaces[0]],
      entriesByWorkspace: entries(),
      expandedWorkspaceIds: new Set(["workspace-1"]),
      expandedDirectoryKeys: new Set([makeEntryRowKey("workspace-1", "notes")]),
    });
    const anchor = captureScrollAnchor(previous, 2, 11);
    expect(anchor).toEqual({
      rowKey: makeEntryRowKey("workspace-1", "notes/nested.excalidraw"),
      offset: 11,
    });

    const collapsed = buildWorkspaceTreeRows({
      workspaces: [workspaces[0]],
      entriesByWorkspace: entries(),
      expandedWorkspaceIds: new Set(["workspace-1"]),
    });
    expect(resolveScrollAnchor(previous, collapsed, anchor)).toEqual({
      rowKey: makeEntryRowKey("workspace-1", "notes"),
      index: 1,
      offset: 11,
    });
  });

  it("calculates visible-order focus movement including page and edge targets", () => {
    const rows = buildWorkspaceTreeRows({
      workspaces,
      entriesByWorkspace: entries(),
      expandedWorkspaceIds: new Set(["workspace-1", "workspace-2"]),
    });
    const current = makeEntryRowKey("workspace-1", "first.excalidraw");
    expect(getAdjacentRowKey(rows, current, "next")).toBe(
      makeWorkspaceRowKey("workspace-2"),
    );
    expect(getAdjacentRowKey(rows, current, "previous")).toBe(
      makeEntryRowKey("workspace-1", "notes"),
    );
    expect(getPageTargetRowKey(rows, current, "next", 2)).toBe(
      makeEntryRowKey("workspace-2", "plan.excalidraw"),
    );
    expect(getPageTargetRowKey(rows, current, "previous", 2)).toBe(
      makeWorkspaceRowKey("workspace-1"),
    );
  });

  it("assigns sibling posinset among a shared parent, not the flattened list", () => {
    const rows = buildWorkspaceTreeRows({
      workspaces,
      entriesByWorkspace: entries(),
      expandedWorkspaceIds: new Set(["workspace-1", "workspace-2"]),
      expandedDirectoryKeys: new Set([makeEntryRowKey("workspace-1", "notes")]),
    });
    expect(
      rows.find((row) => row.key === makeWorkspaceRowKey("workspace-1")),
    ).toMatchObject({ siblingIndex: 1, siblingCount: 2 });
    expect(
      rows.find((row) => row.key === makeEntryRowKey("workspace-1", "notes")),
    ).toMatchObject({ siblingIndex: 1, siblingCount: 2 });
    expect(
      rows.find(
        (row) => row.key === makeEntryRowKey("workspace-1", "first.excalidraw"),
      ),
    ).toMatchObject({ siblingIndex: 2, siblingCount: 2 });
    expect(
      rows.find(
        (row) =>
          row.key === makeEntryRowKey("workspace-1", "notes/nested.excalidraw"),
      ),
    ).toMatchObject({ siblingIndex: 1, siblingCount: 1 });
  });

  it("does not expand a Directory from a bare relative path or another Workspace", () => {
    const withBarePath = buildWorkspaceTreeRows({
      workspaces,
      entriesByWorkspace: {
        ...entries(),
        "workspace-2": {
          "": [entry("workspace-2", "notes", "directory")],
          notes: [entry("workspace-2", "notes/other.excalidraw", "drawing")],
        },
      },
      expandedWorkspaceIds: new Set(["workspace-1", "workspace-2"]),
      expandedDirectoryKeys: new Set(["notes"]),
    });
    expect(withBarePath.map((row) => row.relativePath)).not.toContain(
      "notes/nested.excalidraw",
    );
    expect(withBarePath.map((row) => row.relativePath)).not.toContain(
      "notes/other.excalidraw",
    );

    const withScopedKey = buildWorkspaceTreeRows({
      workspaces,
      entriesByWorkspace: {
        ...entries(),
        "workspace-2": {
          "": [entry("workspace-2", "notes", "directory")],
          notes: [entry("workspace-2", "notes/other.excalidraw", "drawing")],
        },
      },
      expandedWorkspaceIds: new Set(["workspace-1", "workspace-2"]),
      expandedDirectoryKeys: new Set([makeEntryRowKey("workspace-1", "notes")]),
    });
    expect(withScopedKey.map((row) => row.relativePath)).toContain(
      "notes/nested.excalidraw",
    );
    expect(withScopedKey.map((row) => row.relativePath)).not.toContain(
      "notes/other.excalidraw",
    );
  });
});
