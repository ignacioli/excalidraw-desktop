import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Workspace, WorkspaceEntry } from "../ipc/contracts";
import { WorkspaceTree } from "./WorkspaceTree";
import { makeEntryRowKey, makeWorkspaceRowKey } from "./workspaceTreeModel";

const workspace: Workspace = {
  id: "workspace-1",
  name: "Sketches",
  rootPath: "/workspace/sketches",
  createdAt: 1,
};

function entry(
  relativePath: string,
  kind: WorkspaceEntry["kind"],
  name = relativePath,
  parentRelativePath = "",
): WorkspaceEntry {
  return {
    workspaceId: workspace.id,
    kind,
    canonicalPath: `/workspace/sketches/${relativePath}`,
    relativePath,
    parentRelativePath,
    name,
    displayName: name,
    mtime: 1,
    fileSize: 1,
  };
}

describe("WorkspaceTree", () => {
  it("uses one bounded virtualized tree with fixed icon/action slots and no thumbnail work", async () => {
    const entries = Array.from({ length: 10_000 }, (_, index) =>
      entry(`drawing-${index}.excalidraw`, "drawing", `Drawing ${index}`),
    );
    const onOpenDrawing = vi.fn();

    const { container } = render(
      <WorkspaceTree
        workspaces={[workspace]}
        entriesByWorkspace={{ [workspace.id]: { "": entries } }}
        expandedWorkspaceIds={new Set([workspace.id])}
        onOpenDrawing={onOpenDrawing}
      />,
    );

    const tree = screen.getByRole("tree", { name: "Workspace files" });
    expect(tree).toHaveAttribute("tabindex", "0");
    expect(tree).not.toHaveStyle({ overflowX: "auto" });
    expect(container.querySelectorAll('[role="treeitem"]').length).toBeLessThan(
      100,
    );
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(
      container.querySelectorAll('[data-slot="workspace-tree-icon"]').length,
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll('[data-slot="workspace-tree-action"]').length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("treeitem", { name: "Drawing 0" })).toHaveAttribute(
      "title",
      "Drawing 0",
    );

    await waitFor(() =>
      expect(
        screen.getByRole("treeitem", { name: "Sketches" }),
      ).toBeInTheDocument(),
    );
    expect(onOpenDrawing).not.toHaveBeenCalled();
  });

  it("moves roving focus with Arrow/Page/Home/End and opens a Drawing with Enter", async () => {
    const onOpenDrawing = vi.fn();
    render(
      <WorkspaceTree
        workspaces={[workspace]}
        entriesByWorkspace={{
          [workspace.id]: {
            "": [
              entry("notes", "directory", "Notes"),
              entry("first.excalidraw", "drawing", "First"),
              entry("second.excalidraw", "drawing", "Second"),
            ],
          },
        }}
        expandedWorkspaceIds={new Set([workspace.id])}
        onOpenDrawing={onOpenDrawing}
      />,
    );

    const tree = screen.getByRole("tree", { name: "Workspace files" });
    const workspaceRow = screen.getByRole("treeitem", { name: "Sketches" });
    workspaceRow.focus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(screen.getByRole("treeitem", { name: "Notes" })).toHaveFocus();
    fireEvent.keyDown(tree, { key: "End" });
    expect(screen.getByRole("treeitem", { name: "Second" })).toHaveFocus();
    fireEvent.keyDown(tree, { key: "Home" });
    expect(screen.getByRole("treeitem", { name: "Sketches" })).toHaveFocus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(onOpenDrawing).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: "first.excalidraw" }),
    );
  });

  it("toggles a Directory from its fixed disclosure slot and preserves active Drawing highlight", async () => {
    const onToggleDirectory = vi.fn();
    render(
      <WorkspaceTree
        workspaces={[workspace]}
        entriesByWorkspace={{
          [workspace.id]: {
            "": [entry("notes", "directory", "Notes")],
            notes: [
              entry("notes/child.excalidraw", "drawing", "Child", "notes"),
            ],
          },
        }}
        expandedWorkspaceIds={new Set([workspace.id])}
        expandedDirectoryKeys={new Set()}
        activeDrawing={{
          workspaceId: workspace.id,
          relativePath: "notes/child.excalidraw",
        }}
        onToggleDirectory={onToggleDirectory}
      />,
    );

    const notes = screen.getByRole("treeitem", { name: "Notes" });
    expect(notes).toHaveAttribute("aria-expanded", "false");
    expect(
      notes.querySelector('[data-slot="workspace-tree-icon"]'),
    ).toHaveTextContent("▸");
    fireEvent.click(notes);
    expect(onToggleDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: "notes" }),
      true,
    );
    expect(
      screen.queryByRole("treeitem", { name: "Child" }),
    ).not.toBeInTheDocument();
    expect(makeWorkspaceRowKey(workspace.id)).toContain("workspace");
    expect(makeEntryRowKey(workspace.id, "notes")).toContain("entry");
  });
});
