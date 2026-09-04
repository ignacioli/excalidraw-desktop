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
    expect(container.querySelectorAll('img[src*="thumb"]').length).toBe(0);
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
      notes.querySelector('[data-slot="workspace-tree-icon"] img'),
    ).not.toBeNull();
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

  it("keeps a collapsed Workspace collapsed when the list refreshes", async () => {
    const second: Workspace = {
      id: "workspace-2",
      name: "Blueprints",
      rootPath: "/workspace/blueprints",
      createdAt: 2,
    };
    const { rerender } = render(
      <WorkspaceTree
        workspaces={[workspace]}
        entriesByWorkspace={{ [workspace.id]: { "": [] } }}
      />,
    );
    const sketches = await screen.findByRole("treeitem", { name: "Sketches" });
    expect(sketches).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(sketches);
    expect(sketches).toHaveAttribute("aria-expanded", "false");

    rerender(
      <WorkspaceTree
        workspaces={[workspace, second]}
        entriesByWorkspace={{
          [workspace.id]: { "": [] },
          [second.id]: { "": [] },
        }}
      />,
    );
    expect(screen.getByRole("treeitem", { name: "Sketches" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(
      screen.getByRole("treeitem", { name: "Blueprints" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("exposes sibling aria-posinset and opens row actions from the keyboard", async () => {
    const onRowAction = vi.fn();
    render(
      <WorkspaceTree
        workspaces={[workspace]}
        entriesByWorkspace={{
          [workspace.id]: {
            "": [
              entry("notes", "directory", "Notes"),
              entry("first.excalidraw", "drawing", "First"),
            ],
          },
        }}
        expandedWorkspaceIds={new Set([workspace.id])}
        onRowAction={onRowAction}
      />,
    );

    const sketches = screen.getByRole("treeitem", { name: "Sketches" });
    const notes = screen.getByRole("treeitem", { name: "Notes" });
    const first = screen.getByRole("treeitem", { name: "First" });
    expect(sketches).toHaveAttribute("aria-posinset", "1");
    expect(sketches).toHaveAttribute("aria-setsize", "1");
    expect(notes).toHaveAttribute("aria-posinset", "1");
    expect(notes).toHaveAttribute("aria-setsize", "2");
    expect(first).toHaveAttribute("aria-posinset", "2");
    expect(first).toHaveAttribute("aria-setsize", "2");

    const tree = screen.getByRole("tree", { name: "Workspace files" });
    sketches.focus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(notes).toHaveFocus();
    fireEvent.keyDown(tree, { key: "F2" });
    expect(onRowAction).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: "notes" }),
      expect.any(HTMLButtonElement),
    );
    onRowAction.mockClear();
    fireEvent.keyDown(tree, { key: "F10", shiftKey: true });
    expect(onRowAction).toHaveBeenCalledOnce();
  });

  it("keeps arrow navigation after the row action button is focused", () => {
    render(
      <WorkspaceTree
        workspaces={[workspace]}
        entriesByWorkspace={{
          [workspace.id]: {
            "": [
              entry("notes", "directory", "Notes"),
              entry("first.excalidraw", "drawing", "First"),
            ],
          },
        }}
        expandedWorkspaceIds={new Set([workspace.id])}
      />,
    );

    const sketches = screen.getByRole("treeitem", { name: "Sketches" });
    const notes = screen.getByRole("treeitem", { name: "Notes" });
    const first = screen.getByRole("treeitem", { name: "First" });
    const tree = screen.getByRole("tree", { name: "Workspace files" });
    sketches.focus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(notes).toHaveFocus();
    const action = screen.getByRole("button", { name: "Actions for Notes" });
    action.focus();
    fireEvent.keyDown(action, { key: "ArrowDown" });
    expect(first).toHaveFocus();
  });

  it("passes pointer origin from contextmenu and reports tree scroll", () => {
    const onRowAction = vi.fn();
    const onScroll = vi.fn();
    render(
      <WorkspaceTree
        workspaces={[workspace]}
        entriesByWorkspace={{
          [workspace.id]: {
            "": [entry("notes", "directory", "Notes")],
          },
        }}
        expandedWorkspaceIds={new Set([workspace.id])}
        onRowAction={onRowAction}
        onScroll={onScroll}
      />,
    );

    const notes = screen.getByRole("treeitem", { name: "Notes" });
    fireEvent.contextMenu(notes, { clientX: 12, clientY: 34 });
    expect(onRowAction).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: "notes" }),
      expect.any(HTMLButtonElement),
      { x: 12, y: 34 },
    );

    fireEvent.scroll(screen.getByRole("tree", { name: "Workspace files" }));
    expect(onScroll).toHaveBeenCalledOnce();
  });

  it("does not steal focus from an already open dialog", async () => {
    const { rerender } = render(
      <div aria-modal="true" role="dialog">
        <button type="button">Keep</button>
      </div>,
    );
    screen.getByRole("button", { name: "Keep" }).focus();
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();

    rerender(
      <>
        <div aria-modal="true" role="dialog">
          <button type="button">Keep</button>
        </div>
        <WorkspaceTree
          entriesByWorkspace={{ [workspace.id]: { "": [] } }}
          expandedWorkspaceIds={new Set([workspace.id])}
          workspaces={[workspace]}
        />
      </>,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("tree", { name: "Workspace files" }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();
  });

  it("focuses a requested row after the tree has that key", async () => {
    const onFocusRequestApplied = vi.fn();
    render(
      <WorkspaceTree
        entriesByWorkspace={{
          [workspace.id]: { "": [entry("notes", "directory", "Notes")] },
        }}
        expandedWorkspaceIds={new Set([workspace.id])}
        focusRequestKey={makeEntryRowKey(workspace.id, "notes")}
        onFocusRequestApplied={onFocusRequestApplied}
        workspaces={[workspace]}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("treeitem", { name: "Notes" })).toHaveFocus(),
    );
    expect(onFocusRequestApplied).toHaveBeenCalled();
  });
});
