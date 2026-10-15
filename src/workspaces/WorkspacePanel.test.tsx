import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandInvoker } from "../ipc/client";
import { createInteractionState, interactionStore } from "../app/interaction";
import { ShellPreferences } from "../app/shellPreferences";
import type { Workspace, WorkspaceEntry } from "../ipc/contracts";
import { documentManager } from "../documents/documentStore";
import { en } from "../i18n/messages/en.ts";
import { WorkspacePanel } from "./WorkspacePanel";
import type { CopyPathRequest } from "../app/clipboard";

vi.mock("@excalidraw/excalidraw", () => ({
  getSceneVersion: () => 2,
  restore: (scene: { elements: unknown[]; appState: object; files: object }) =>
    scene,
  serializeAsJSON: () => "{}",
}));

const WORKSPACES = [
  {
    id: "workspace-1",
    name: "Sketches",
    rootPath: "/workspace/one",
    createdAt: 1,
  },
  {
    id: "workspace-2",
    name: "Blueprints",
    rootPath: "/workspace/two",
    createdAt: 2,
  },
] as const;

const ROOT_ENTRIES = WORKSPACES.flatMap((workspace) => [
  {
    workspaceId: workspace.id,
    kind: "directory" as const,
    canonicalPath: `${workspace.rootPath}/notes`,
    relativePath: "notes",
    parentRelativePath: "",
    name: "notes",
    displayName: "notes",
    mtime: 1,
    fileSize: 0,
  },
  {
    workspaceId: workspace.id,
    kind: "drawing" as const,
    canonicalPath: `${workspace.rootPath}/drawing.excalidraw`,
    relativePath: "drawing.excalidraw",
    parentRelativePath: "",
    name: "drawing.excalidraw",
    displayName: "drawing",
    mtime: 1,
    fileSize: 10,
  },
]);

function resetInteractionStore(): void {
  const { dispatch } = interactionStore.getState();
  interactionStore.setState({
    ...createInteractionState(),
    dispatch,
  });
}

const testLocalStorage = new Map<string, string>();

beforeEach(() => {
  resetInteractionStore();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => testLocalStorage.get(key) ?? null,
      setItem: (key: string, value: string) => testLocalStorage.set(key, value),
      removeItem: (key: string) => testLocalStorage.delete(key),
      clear: () => testLocalStorage.clear(),
    },
  });
});

afterEach(() => {
  testLocalStorage.clear();
  resetInteractionStore();
});

function createInvoker(
  workspaces: readonly Workspace[] = WORKSPACES,
  addedWorkspace: Workspace = WORKSPACES[1],
): { invoke: CommandInvoker["invoke"] } {
  const invoke = vi.fn(
    async (command: string, args: Record<string, unknown>) => {
      if (command === "workspace_list") return workspaces;
      if (command === "workspace_entry_list") {
        const workspaceId = String(args.workspaceId ?? "");
        const parentRelativePath = String(args.parentRelativePath ?? "");
        return ROOT_ENTRIES.filter(
          (entry) =>
            entry.workspaceId === workspaceId &&
            entry.parentRelativePath === parentRelativePath,
        );
      }
      if (command === "window_probe_workspace") {
        return {
          kind: "claimed",
          workspace: null,
          replaced: null,
          shell: null,
        };
      }
      if (command === "window_claim_workspace") {
        return {
          kind: "claimed",
          workspace: addedWorkspace,
          replaced: null,
          shell: null,
        };
      }
      if (command === "workspace_entry_create") {
        const workspace = workspaces.find(
          (item) => item.id === String(args.workspaceId ?? ""),
        );
        const parentRelativePath = String(args.parentRelativePath ?? "");
        const baseName = String(args.baseName ?? "Untitled");
        const kind = args.kind === "directory" ? "directory" : "drawing";
        const relativePath =
          parentRelativePath.length === 0
            ? baseName
            : `${parentRelativePath}/${baseName}`;
        return {
          operationId: "operation-1",
          entry: {
            workspaceId: String(args.workspaceId ?? ""),
            kind,
            canonicalPath: `${workspace?.rootPath ?? "/workspace"}/${relativePath}`,
            relativePath,
            parentRelativePath,
            name: baseName,
            displayName: baseName,
            mtime: 1,
            fileSize: 0,
          },
        };
      }
      if (command === "window_release_workspace") return {};
      throw new Error(`Unexpected command ${command}`);
    },
  ) as CommandInvoker["invoke"];
  return { invoke };
}

describe("WorkspacePanel", () => {
  it("targets header creation at the root or selected directory and keeps cancel side-effect free", async () => {
    const user = userEvent.setup();
    const invoker = createInvoker();
    render(
      <WorkspacePanel invoker={invoker} selectDirectory={async () => null} />,
    );

    const newDrawing = await screen.findByRole("button", {
      name: "New Drawing",
    });
    await user.click(newDrawing);
    expect(
      screen.getByRole("dialog", { name: "New drawing" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(invoker.invoke).not.toHaveBeenCalledWith(
      "workspace_entry_create",
      expect.anything(),
    );

    await user.click(screen.getByRole("button", { name: "New Drawing" }));
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(invoker.invoke).toHaveBeenCalledWith("workspace_entry_create", {
      workspaceId: "workspace-1",
      parentRelativePath: "",
      kind: "drawing",
      baseName: "Untitled",
    });

    await user.click(await screen.findByRole("treeitem", { name: "notes" }));
    await user.click(screen.getByRole("button", { name: "New Folder" }));
    const dialog = screen.getByRole("dialog", { name: "New folder" });
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(invoker.invoke).toHaveBeenCalledWith("workspace_entry_create", {
      workspaceId: "workspace-1",
      parentRelativePath: "notes",
      kind: "directory",
      baseName: "Untitled Folder",
    });
  });

  it("keeps a conflicting header create side-effect free and retryable", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    let listCount = 0;
    const invoke = vi.fn(
      async (command: string, args: Record<string, unknown>) => {
        if (command === "workspace_list") return [WORKSPACES[0]];
        if (command === "workspace_entry_list") {
          listCount += 1;
          return ROOT_ENTRIES.filter(
            (entry) =>
              entry.workspaceId === "workspace-1" &&
              entry.parentRelativePath ===
                String(args.parentRelativePath ?? ""),
          );
        }
        if (command === "workspace_entry_create") {
          throw {
            code: "NAME_CONFLICT",
            message: "already exists",
            retriable: false,
          };
        }
        throw new Error(`Unexpected command ${command}`);
      },
    ) as CommandInvoker["invoke"];

    render(
      <WorkspacePanel
        invoker={{ invoke }}
        onOpenFile={onOpenFile}
        selectDirectory={async () => null}
      />,
    );

    await screen.findByRole("treeitem", { name: "notes" });
    const listCountBeforeCreate = listCount;
    await user.click(screen.getByRole("button", { name: "New Drawing" }));
    const input = screen.getByRole("textbox", { name: "Name" });
    await user.clear(input);
    await user.type(input, "drawing");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already exists",
    );
    expect(
      screen.getByRole("dialog", { name: "New drawing" }),
    ).toBeInTheDocument();
    expect(input).toHaveValue("drawing");
    expect(listCount).toBe(listCountBeforeCreate);
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(listCountBeforeCreate + 2);
  });

  it("toggles the single next-action expand/collapse control and refreshes the current Workspace", async () => {
    const user = userEvent.setup();
    const invoker = createInvoker();
    render(
      <WorkspacePanel invoker={invoker} selectDirectory={async () => null} />,
    );

    const expandAll = await screen.findByRole("button", { name: "Expand all" });
    expect(expandAll.querySelector("img")).not.toHaveClass(
      "workspace-panel-collapse-all-icon",
    );
    await user.click(expandAll);
    expect(
      screen.getByRole("button", { name: "Collapse all" }).querySelector("img"),
    ).toHaveClass("workspace-panel-collapse-all-icon");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(invoker.invoke).toHaveBeenCalledWith("workspace_entry_list", {
      workspaceId: "workspace-1",
      parentRelativePath: "",
    });
  });

  it("loads every not-yet-loaded nested directory from one Expand all activation", async () => {
    const user = userEvent.setup();
    const nestedEntries: Record<string, WorkspaceEntry[]> = {
      "": [
        {
          workspaceId: "workspace-1",
          kind: "directory" as const,
          canonicalPath: "/workspace/one/notes",
          relativePath: "notes",
          parentRelativePath: "",
          name: "notes",
          displayName: "notes",
          mtime: 1,
          fileSize: 0,
        },
      ],
      notes: [
        {
          workspaceId: "workspace-1",
          kind: "directory" as const,
          canonicalPath: "/workspace/one/notes/deep",
          relativePath: "notes/deep",
          parentRelativePath: "notes",
          name: "deep",
          displayName: "deep",
          mtime: 1,
          fileSize: 0,
        },
      ],
      "notes/deep": [
        {
          workspaceId: "workspace-1",
          kind: "drawing" as const,
          canonicalPath: "/workspace/one/notes/deep/drawing.excalidraw",
          relativePath: "notes/deep/drawing.excalidraw",
          parentRelativePath: "notes/deep",
          name: "drawing.excalidraw",
          displayName: "drawing",
          mtime: 1,
          fileSize: 10,
        },
      ],
    };
    const invoke = vi.fn(
      async (command: string, args: Record<string, unknown>) => {
        if (command === "workspace_list") return [WORKSPACES[0]];
        if (command === "workspace_entry_list") {
          return nestedEntries[String(args.parentRelativePath ?? "")] ?? [];
        }
        throw new Error(`Unexpected command ${command}`);
      },
    ) as CommandInvoker["invoke"];

    render(
      <WorkspacePanel
        invoker={{ invoke }}
        selectDirectory={async () => null}
      />,
    );

    await screen.findByRole("treeitem", { name: "notes" });
    await user.click(screen.getByRole("button", { name: "Expand all" }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("workspace_entry_list", {
        workspaceId: "workspace-1",
        parentRelativePath: "notes/deep",
      });
    });
    expect(
      await screen.findByRole("treeitem", { name: "drawing" }),
    ).toBeInTheDocument();
    const collapseAll = screen.getByRole("button", { name: "Collapse all" });
    expect(collapseAll).toHaveAttribute("title", "Collapse all");
    await user.click(collapseAll);
    expect(screen.getByRole("button", { name: "Expand all" })).toHaveAttribute(
      "title",
      "Expand all",
    );
    expect(
      screen.queryByRole("treeitem", { name: "notes" }),
    ).not.toBeInTheDocument();
  });

  it("mounts a workspace and reports sidebar presence", async () => {
    const user = userEvent.setup();
    const workspace = {
      id: "workspace-1",
      name: "Sketches",
      rootPath: "/workspace",
      createdAt: 1,
    };
    const { invoke } = createInvoker([], workspace);
    const onWorkspacePresenceChange = vi.fn();
    const onWorkspacesChange = vi.fn();

    render(
      <WorkspacePanel
        invoker={{ invoke }}
        onWorkspacePresenceChange={onWorkspacePresenceChange}
        onWorkspacesChange={onWorkspacesChange}
        selectDirectory={async () => "/workspace"}
      />,
    );

    await waitFor(() =>
      expect(onWorkspacePresenceChange).toHaveBeenCalledWith(false),
    );
    await user.click(screen.getByRole("button", { name: "Mount folder…" }));
    expect(
      await screen.findByRole("treeitem", { name: "Sketches" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(invoke).toHaveBeenCalledWith("window_probe_workspace", {
      rootPath: "/workspace",
    });
    expect(invoke).toHaveBeenCalledWith("window_claim_workspace", {
      rootPath: "/workspace",
    });
    expect(onWorkspacesChange).toHaveBeenLastCalledWith([workspace]);
  });

  it("stays empty when another window owns the chosen folder", async () => {
    const user = userEvent.setup();
    const invoke = vi.fn(async (command: string) => {
      if (command === "workspace_list") return [];
      if (command === "workspace_entry_list") return [];
      if (
        command === "window_probe_workspace" ||
        command === "window_claim_workspace"
      ) {
        return { kind: "ownedBy", label: "window-2", workspaceId: "other" };
      }
      throw new Error(`Unexpected command ${command}`);
    }) as CommandInvoker["invoke"];
    const closeMany = vi.spyOn(documentManager, "closeMany");

    render(
      <WorkspacePanel
        invoker={{ invoke }}
        selectDirectory={async () => "/workspace/other"}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Mount folder…" }),
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("window_claim_workspace", {
        rootPath: "/workspace/other",
      }),
    );
    expect(closeMany).not.toHaveBeenCalled();
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mount folder…" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("hands a folder that contains another window's Workspace to the shell", async () => {
    const user = userEvent.setup();
    const invoke = vi.fn(async (command: string) => {
      if (command === "workspace_list") return [];
      if (command === "window_probe_workspace") {
        return {
          kind: "containsOpen",
          label: "window-2",
          workspaceId: "inner",
        };
      }
      throw new Error(`Unexpected command ${command}`);
    }) as CommandInvoker["invoke"];
    const closeMany = vi.spyOn(documentManager, "closeMany");
    const onNestedConflict = vi.fn(async () => undefined);

    render(
      <WorkspacePanel
        invoker={{ invoke }}
        onNestedConflict={onNestedConflict}
        selectDirectory={async () => "/workspace"}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Mount folder…" }),
    );

    await waitFor(() =>
      expect(onNestedConflict).toHaveBeenCalledWith("/workspace", {
        kind: "containsOpen",
        label: "window-2",
        workspaceId: "inner",
      }),
    );
    expect(closeMany).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith(
      "window_claim_workspace",
      expect.anything(),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("announces folder loading then permission-denied list errors", async () => {
    let rejectList: (reason: unknown) => void = () => undefined;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectList = reject;
    });
    const invoke = vi.fn(async (command: string) => {
      if (command === "workspace_list") return WORKSPACES;
      if (command === "workspace_entry_list") return pending;
      throw new Error(`Unexpected command ${command}`);
    }) as CommandInvoker["invoke"];

    render(
      <WorkspacePanel
        invoker={{ invoke }}
        selectDirectory={async () => null}
      />,
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Loading folder…",
    );
    expect(screen.getByRole("region", { name: "Workspaces" })).toHaveAttribute(
      "aria-busy",
      "true",
    );

    rejectList({
      code: "PATH_ACCESS_DENIED",
      message: "Path is outside the mounted workspaces.",
      retriable: false,
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This location is outside the Workspace.",
    );
    expect(screen.queryByText("Loading folder…")).not.toBeInTheDocument();
  });

  it("reveals a nested folder by expanding down to it and selecting it", async () => {
    const directory = (relativePath: string): WorkspaceEntry => {
      const slash = relativePath.lastIndexOf("/");
      const name = relativePath.slice(slash + 1);
      return {
        workspaceId: "workspace-1",
        kind: "directory",
        canonicalPath: `/workspace/one/${relativePath}`,
        relativePath,
        parentRelativePath: slash < 0 ? "" : relativePath.slice(0, slash),
        name,
        displayName: name,
        mtime: 1,
        fileSize: 0,
      };
    };
    const listings: Record<string, WorkspaceEntry[]> = {
      "": [directory("notes")],
      notes: [directory("notes/deep")],
      "notes/deep": [],
    };
    const invoke = vi.fn(
      async (command: string, args: Record<string, unknown>) => {
        if (command === "workspace_list") return [WORKSPACES[0]];
        if (command === "workspace_entry_list") {
          return listings[String(args.parentRelativePath ?? "")] ?? [];
        }
        throw new Error(`Unexpected command ${command}`);
      },
    ) as CommandInvoker["invoke"];
    const save = vi.fn();
    const preferences = new ShellPreferences(save);
    preferences.loadWorkspace({
      sidebarPinned: false,
      sidebarWidth: 360,
      expanded: [],
    });
    const onRevealLocationApplied = vi.fn();

    render(
      <WorkspacePanel
        currentWorkspaceId="workspace-1"
        invoker={{ invoke }}
        onRevealLocationApplied={onRevealLocationApplied}
        preferences={preferences}
        revealLocation={{
          workspaceId: "workspace-1",
          directoryRelativePath: "notes/deep",
        }}
        selectDirectory={async () => null}
      />,
    );

    const deep = await screen.findByRole("treeitem", { name: "deep" });
    await waitFor(() => expect(deep).toHaveFocus());
    expect(screen.getByRole("treeitem", { name: "Sketches" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("treeitem", { name: "notes" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(onRevealLocationApplied).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith({
      sidebarPinned: false,
      sidebarWidth: 360,
      expanded: [""],
    });
  });

  it("renders only the current Workspace and collapses it", async () => {
    const user = userEvent.setup();
    const invoker = createInvoker();

    render(
      <WorkspacePanel invoker={invoker} selectDirectory={async () => null} />,
    );

    const firstToggle = await screen.findByRole("treeitem", {
      name: "Sketches",
    });
    expect(firstToggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.queryByRole("treeitem", { name: "Blueprints" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("tree")).toHaveLength(1);
    expect(
      await screen.findAllByRole("treeitem", { name: "notes" }),
    ).toHaveLength(1);

    await user.click(firstToggle);
    expect(firstToggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("treeitem", { name: "notes" }),
    ).not.toBeInTheDocument();
  });

  it("follows the shared Current Workspace when Recent selection changes it", async () => {
    const invoker = createInvoker();
    const view = render(
      <WorkspacePanel
        currentWorkspaceId="workspace-1"
        invoker={invoker}
        selectDirectory={async () => null}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Sketches" }),
    ).toBeInTheDocument();

    view.rerender(
      <WorkspacePanel
        currentWorkspaceId="workspace-2"
        invoker={invoker}
        selectDirectory={async () => null}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Blueprints" }),
      ).toBeInTheDocument();
    });
  });

  it("restores and saves the Workspace's own expansion", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    const preferences = new ShellPreferences(save);
    preferences.loadWorkspace({
      sidebarPinned: false,
      sidebarWidth: 360,
      expanded: [""],
    });
    const invoker = createInvoker([WORKSPACES[0]]);

    const firstRender = render(
      <WorkspacePanel
        invoker={invoker}
        preferences={preferences}
        selectDirectory={async () => null}
      />,
    );
    const sketches = await screen.findByRole("treeitem", { name: "Sketches" });
    expect(sketches).toHaveAttribute("aria-expanded", "true");

    await user.click(sketches);
    expect(sketches).toHaveAttribute("aria-expanded", "false");
    expect(save).toHaveBeenLastCalledWith({
      sidebarPinned: false,
      sidebarWidth: 360,
      expanded: [],
    });

    firstRender.unmount();
    const reopened = new ShellPreferences();
    reopened.loadWorkspace(save.mock.lastCall?.[0] ?? null);
    render(
      <WorkspacePanel
        invoker={invoker}
        preferences={reopened}
        selectDirectory={async () => null}
      />,
    );
    expect(
      await screen.findByRole("treeitem", { name: "Sketches" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("expands a newly mounted Workspace even when an existing preference is collapsed", async () => {
    const user = userEvent.setup();
    const preferences = new ShellPreferences();
    preferences.showWithoutWorkspace({
      sidebarPinned: false,
      sidebarWidth: 360,
      expanded: [],
    });
    const workspace = {
      id: "workspace-new",
      name: "New sketches",
      rootPath: "/workspace/new",
      createdAt: 3,
    };
    const invoker = createInvoker([], workspace);
    const onCurrentWorkspaceChange = vi.fn();
    const onWorkspacesChange = vi.fn();

    render(
      <WorkspacePanel
        invoker={invoker}
        preferences={preferences}
        onCurrentWorkspaceChange={onCurrentWorkspaceChange}
        onWorkspacesChange={onWorkspacesChange}
        selectDirectory={async () => workspace.rootPath}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Mount folder…" }),
    );

    const mounted = await screen.findByRole("treeitem", {
      name: "New sketches",
    });
    expect(mounted).toHaveAttribute("aria-expanded", "true");
    expect(onCurrentWorkspaceChange).toHaveBeenLastCalledWith(workspace);
  });

  it("keeps Remove Workspace in the Workspace header menu and confirms mount-only removal", async () => {
    const user = userEvent.setup();
    const invoker = createInvoker();
    const onCurrentWorkspaceChange = vi.fn();
    const onWorkspacesChange = vi.fn();
    const closeWorkspaceDocuments = vi
      .spyOn(documentManager, "closeWorkspaceDocuments")
      .mockResolvedValue({ status: "closed" });
    render(
      <WorkspacePanel
        invoker={invoker}
        onCurrentWorkspaceChange={onCurrentWorkspaceChange}
        onWorkspacesChange={onWorkspacesChange}
        selectDirectory={async () => null}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Remove" }),
    ).not.toBeInTheDocument();
    const actions = await screen.findByRole("button", {
      name: "Actions for Sketches",
    });
    await user.click(actions);
    const menu = screen.getByRole("menu");
    expect(menu).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "Remove Workspace" }),
    ).toBeVisible();
    expect(menu).toHaveAccessibleDescription(
      "Files on disk will not be deleted",
    );

    await user.click(
      screen.getByRole("menuitem", { name: "Remove Workspace" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Open drawings from this Workspace will be saved and closed",
    );
    // Sidebar confirmation anatomy: root path, Cancel first with focus, and
    // a primary (not destructive) Remove Workspace.
    expect(dialog).toHaveAttribute("data-variant", "sidebar");
    expect(within(dialog).getByText("/workspace/one")).toBeInTheDocument();
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Cancel", "Remove Workspace"]);
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus();
    expect(
      within(dialog).getByRole("button", { name: "Remove Workspace" }),
    ).toHaveAttribute("data-kind", "primary");
    await user.click(
      within(dialog).getByRole("button", { name: "Remove Workspace" }),
    );
    await waitFor(() =>
      expect(invoker.invoke).toHaveBeenCalledWith(
        "window_release_workspace",
        {},
      ),
    );
    expect(closeWorkspaceDocuments).toHaveBeenCalledWith("/workspace/one");
    expect(closeWorkspaceDocuments.mock.invocationCallOrder[0]).toBeLessThan(
      vi
        .mocked(invoker.invoke)
        .mock.invocationCallOrder.find(
          (_, index) =>
            vi.mocked(invoker.invoke).mock.calls[index]?.[0] ===
            "window_release_workspace",
        ) ?? Number.POSITIVE_INFINITY,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("treeitem", { name: "Blueprints" }),
      ).toHaveFocus(),
    );
    expect(onCurrentWorkspaceChange).toHaveBeenLastCalledWith(WORKSPACES[1]);
    expect(onWorkspacesChange).toHaveBeenLastCalledWith([WORKSPACES[1]]);
  });

  it("keeps the Workspace mounted when an open drawing cannot close", async () => {
    const user = userEvent.setup();
    const invoker = createInvoker();
    vi.spyOn(documentManager, "closeWorkspaceDocuments").mockResolvedValue({
      status: "failed",
      documentId: "drawing-1",
      message: "The drawing could not be saved.",
    });
    render(
      <WorkspacePanel invoker={invoker} selectDirectory={async () => null} />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Actions for Sketches" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Remove Workspace" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Remove Sketches?" });
    await user.click(
      within(dialog).getByRole("button", { name: "Remove Workspace" }),
    );

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The drawing could not be saved.",
    );
    expect(invoker.invoke).not.toHaveBeenCalledWith(
      "window_release_workspace",
      expect.anything(),
    );
  });

  it("enforces one global menu, every dismissal path, and trigger focus restoration", async () => {
    const user = userEvent.setup();
    const invoker = createInvoker();
    render(
      <WorkspacePanel invoker={invoker} selectDirectory={async () => null} />,
    );

    const firstActions = await screen.findByRole("button", {
      name: "Actions for Sketches",
    });
    const secondActions = await screen.findByRole("button", {
      name: "Actions for notes",
    });
    await user.click(firstActions);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    await user.click(secondActions);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu")).toHaveTextContent("New Drawing");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(secondActions).toHaveFocus();

    await user.click(firstActions);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(firstActions).toHaveFocus();

    await user.click(secondActions);
    await user.click(screen.getByRole("treeitem", { name: "notes" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Sketches" }), {
      clientX: 24,
      clientY: 48,
    });
    expect(screen.getByRole("menu")).toBeVisible();
    await user.click(firstActions);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows Remove failures inside the confirmation dialog and restores trigger focus", async () => {
    const user = userEvent.setup();
    const invoke = vi.fn(
      async (command: string, args: Record<string, unknown>) => {
        if (command === "workspace_list") return WORKSPACES;
        if (command === "workspace_entry_list") {
          const workspaceId = String(args.workspaceId ?? "");
          const parentRelativePath = String(args.parentRelativePath ?? "");
          return ROOT_ENTRIES.filter(
            (entry) =>
              entry.workspaceId === workspaceId &&
              entry.parentRelativePath === parentRelativePath,
          );
        }
        if (command === "window_release_workspace") {
          throw {
            code: "IO_ERROR",
            message: "Workspace is still in use.",
            retriable: false,
          };
        }
        throw new Error(`Unexpected command ${command}`);
      },
    ) as CommandInvoker["invoke"];

    render(
      <WorkspacePanel
        invoker={{ invoke }}
        selectDirectory={async () => null}
      />,
    );
    const remove = await screen.findByRole("button", {
      name: "Actions for Sketches",
    });
    await user.click(remove);
    await user.click(
      screen.getByRole("menuitem", { name: "Remove Workspace" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Remove Sketches?",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Remove Workspace" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      en["error.IO_ERROR"],
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    // Focus returns to the row: its actions button is hidden once the row
    // is neither hovered nor focused.
    expect(screen.getByRole("treeitem", { name: "Sketches" })).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("drops cached directory children after rename so a recreated folder is fetched again", async () => {
    const user = userEvent.setup();
    const entries = [
      {
        workspaceId: "workspace-1",
        kind: "directory" as const,
        canonicalPath: "/workspace/one/notes",
        relativePath: "notes",
        parentRelativePath: "",
        name: "notes",
        displayName: "notes",
        mtime: 1,
        fileSize: 0,
      },
      {
        workspaceId: "workspace-1",
        kind: "drawing" as const,
        canonicalPath: "/workspace/one/notes/old-child.excalidraw",
        relativePath: "notes/old-child.excalidraw",
        parentRelativePath: "notes",
        name: "old-child.excalidraw",
        displayName: "old-child",
        mtime: 1,
        fileSize: 10,
      },
    ];
    let notesListCount = 0;
    const invoke = vi.fn(
      async (command: string, args: Record<string, unknown>) => {
        if (command === "workspace_list") return [WORKSPACES[0]];
        if (command === "workspace_entry_list") {
          const parentRelativePath = String(args.parentRelativePath ?? "");
          if (parentRelativePath === "notes") notesListCount += 1;
          return entries.filter(
            (entry) => entry.parentRelativePath === parentRelativePath,
          );
        }
        if (command === "workspace_entry_rename") {
          const oldRelativePath = String(args.relativePath ?? "");
          const baseName = String(args.baseName ?? "");
          const source = entries.find(
            (entry) => entry.relativePath === oldRelativePath,
          );
          if (source === undefined) throw new Error("missing entry");
          const newRelativePath = baseName;
          for (const entry of entries) {
            if (
              entry.relativePath === oldRelativePath ||
              entry.relativePath.startsWith(`${oldRelativePath}/`)
            ) {
              entry.relativePath = entry.relativePath.replace(
                oldRelativePath,
                newRelativePath,
              );
              entry.canonicalPath = entry.canonicalPath.replace(
                `/${oldRelativePath}`,
                `/${newRelativePath}`,
              );
              if (entry.parentRelativePath === oldRelativePath) {
                entry.parentRelativePath = newRelativePath;
              }
            }
          }
          source.name = baseName;
          source.displayName = baseName;
          return {
            operationId: "rename-1",
            entry: { ...source },
            oldRelativePath,
            newRelativePath,
            pathMigrations: [],
          };
        }
        if (command === "workspace_entry_create") {
          const created = {
            workspaceId: "workspace-1",
            kind: "directory" as const,
            canonicalPath: "/workspace/one/notes",
            relativePath: "notes",
            parentRelativePath: "",
            name: "notes",
            displayName: "notes",
            mtime: 2,
            fileSize: 0,
          };
          entries.push(created);
          return { operationId: "create-1", entry: created };
        }
        throw new Error(`Unexpected command ${command}`);
      },
    ) as CommandInvoker["invoke"];

    render(
      <WorkspacePanel
        invoker={{ invoke }}
        selectDirectory={async () => null}
      />,
    );

    const notes = await screen.findByRole("treeitem", { name: "notes" });
    await user.click(notes);
    expect(
      await screen.findByRole("treeitem", { name: "old-child" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Actions for notes" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const renameInput = screen.getByRole("textbox", { name: "Name" });
    await user.clear(renameInput);
    await user.type(renameInput, "archived");
    await user.click(screen.getByRole("button", { name: "Rename" }));
    expect(
      await screen.findByRole("treeitem", { name: "archived" }),
    ).toHaveFocus();
    expect(
      screen.queryByRole("treeitem", { name: "old-child" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Actions for Sketches" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "New Folder" }));
    const createInput = screen.getByRole("textbox", { name: "Name" });
    await user.clear(createInput);
    await user.type(createInput, "notes");
    await user.click(screen.getByRole("button", { name: "Create" }));

    const recreated = await screen.findByRole("treeitem", { name: "notes" });
    expect(recreated).toHaveFocus();
    await user.click(recreated);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("workspace_entry_list", {
        workspaceId: "workspace-1",
        parentRelativePath: "notes",
      }),
    );
    expect(
      screen.queryByRole("treeitem", { name: "old-child" }),
    ).not.toBeInTheDocument();
    expect(notesListCount).toBeGreaterThanOrEqual(2);
  });

  it("reports the selected folder as the creation target until it is deleted", async () => {
    const user = userEvent.setup();
    const onTargetFolderChange = vi.fn();
    const entries = ROOT_ENTRIES.filter(
      (entry) => entry.workspaceId === "workspace-1",
    );
    const invoke = vi.fn(
      async (command: string, args: Record<string, unknown>) => {
        if (command === "workspace_list") return [WORKSPACES[0]];
        if (command === "workspace_entry_list") {
          const parentRelativePath = String(args.parentRelativePath ?? "");
          return entries.filter(
            (entry) => entry.parentRelativePath === parentRelativePath,
          );
        }
        if (command === "workspace_entry_delete_preflight") {
          const entry = entries.find(
            (item) => item.relativePath === String(args.relativePath ?? ""),
          );
          if (entry === undefined) throw new Error("missing entry");
          return { status: "confirmable", entry };
        }
        if (command === "workspace_entry_delete") {
          const relativePath = String(args.relativePath ?? "");
          const index = entries.findIndex(
            (entry) => entry.relativePath === relativePath,
          );
          if (index >= 0) entries.splice(index, 1);
          return {
            operationId: "delete-notes",
            kind: "directory",
            oldRelativePath: relativePath,
          };
        }
        throw new Error(`Unexpected command ${command}`);
      },
    ) as CommandInvoker["invoke"];

    render(
      <WorkspacePanel
        invoker={{ invoke }}
        onTargetFolderChange={onTargetFolderChange}
        selectDirectory={async () => null}
      />,
    );

    await user.click(await screen.findByRole("treeitem", { name: "notes" }));
    expect(onTargetFolderChange).toHaveBeenLastCalledWith({
      workspaceId: "workspace-1",
      relativePath: "notes",
    });

    await user.click(screen.getByRole("button", { name: "Actions for notes" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete notes?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(onTargetFolderChange).toHaveBeenLastCalledWith({
        workspaceId: "workspace-1",
        relativePath: "",
      }),
    );
  });

  it("focuses the parent workspace row after a drawing is deleted", async () => {
    const user = userEvent.setup();
    const entries = ROOT_ENTRIES.filter(
      (entry) => entry.workspaceId === "workspace-1",
    );
    const invoke = vi.fn(
      async (command: string, args: Record<string, unknown>) => {
        if (command === "workspace_list") return [WORKSPACES[0]];
        if (command === "workspace_entry_list") {
          const parentRelativePath = String(args.parentRelativePath ?? "");
          return entries.filter(
            (entry) => entry.parentRelativePath === parentRelativePath,
          );
        }
        if (command === "workspace_entry_delete_preflight") {
          const entry = entries.find(
            (item) => item.relativePath === String(args.relativePath ?? ""),
          );
          if (entry === undefined) throw new Error("missing entry");
          return { status: "confirmable", entry };
        }
        if (command === "workspace_entry_delete") {
          const relativePath = String(args.relativePath ?? "");
          const index = entries.findIndex(
            (entry) => entry.relativePath === relativePath,
          );
          if (index >= 0) entries.splice(index, 1);
          return {
            operationId: "delete-1",
            kind: "drawing",
            oldRelativePath: relativePath,
            historyMaintenance: "pendingReplay",
          };
        }
        throw new Error(`Unexpected command ${command}`);
      },
    ) as CommandInvoker["invoke"];

    render(
      <WorkspacePanel
        invoker={{ invoke }}
        selectDirectory={async () => null}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Actions for drawing" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete drawing.excalidraw?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("treeitem", { name: "drawing" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("treeitem", { name: "Sketches" })).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent(
      en["workspace.notice.historyCleanupPending"],
    );
  });

  it("reports deferred physical history cleanup after deleting a drawing", async () => {
    const user = userEvent.setup();
    const entries = ROOT_ENTRIES.filter(
      (entry) => entry.workspaceId === "workspace-1",
    );
    const invoke = vi.fn(
      async (command: string, args: Record<string, unknown>) => {
        if (command === "workspace_list") return [WORKSPACES[0]];
        if (command === "workspace_entry_list") {
          const parentRelativePath = String(args.parentRelativePath ?? "");
          return entries.filter(
            (entry) => entry.parentRelativePath === parentRelativePath,
          );
        }
        if (command === "workspace_entry_delete_preflight") {
          const entry = entries.find(
            (item) => item.relativePath === String(args.relativePath ?? ""),
          );
          if (entry === undefined) throw new Error("missing entry");
          return { status: "confirmable", entry };
        }
        if (command === "workspace_entry_delete") {
          const relativePath = String(args.relativePath ?? "");
          const index = entries.findIndex(
            (entry) => entry.relativePath === relativePath,
          );
          if (index >= 0) entries.splice(index, 1);
          return {
            operationId: "delete-2",
            kind: "drawing",
            oldRelativePath: relativePath,
            historyMaintenance: "cleanupPending",
          };
        }
        throw new Error(`Unexpected command ${command}`);
      },
    ) as CommandInvoker["invoke"];

    render(
      <WorkspacePanel
        invoker={{ invoke }}
        selectDirectory={async () => null}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Actions for drawing" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete drawing.excalidraw?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      en["workspace.notice.historyResourcesPending"],
    );
    expect(
      screen.queryByRole("treeitem", { name: "drawing" }),
    ).not.toBeInTheDocument();
  });

  it("offers the copy items per row kind and copies the entry's current paths", async () => {
    const user = userEvent.setup();
    const root = "/Users/me/My Drawings";
    const workspace = {
      id: "workspace-1",
      name: "My Drawings",
      rootPath: root,
      createdAt: 1,
    };
    const entries: WorkspaceEntry[] = [
      {
        workspaceId: workspace.id,
        kind: "directory",
        canonicalPath: `${root}/我的 文件夹`,
        relativePath: "我的 文件夹",
        parentRelativePath: "",
        name: "我的 文件夹",
        displayName: "我的 文件夹",
        mtime: 1,
        fileSize: 0,
      },
      {
        workspaceId: workspace.id,
        kind: "drawing",
        canonicalPath: `${root}/计划 草图.excalidraw`,
        relativePath: "计划 草图.excalidraw",
        parentRelativePath: "",
        name: "计划 草图.excalidraw",
        displayName: "计划 草图",
        mtime: 1,
        fileSize: 10,
      },
    ];
    const invoke = vi.fn(
      async (command: string, args: Record<string, unknown>) => {
        if (command === "workspace_list") return [workspace];
        if (command === "workspace_entry_list") {
          return entries.filter(
            (entry) => entry.parentRelativePath === args.parentRelativePath,
          );
        }
        throw new Error(`Unexpected command ${command}`);
      },
    ) as CommandInvoker["invoke"];
    const onCopyPath = vi.fn<(request: CopyPathRequest) => void>();
    render(
      <WorkspacePanel
        invoker={{ invoke }}
        onCopyPath={onCopyPath}
        selectDirectory={async () => null}
      />,
    );

    const menuOf = async (name: string) => {
      await user.click(
        await screen.findByRole("button", { name: `Actions for ${name}` }),
      );
      const menu = screen.getByRole("menu");
      return {
        menu,
        labels: within(menu)
          .getAllByRole("menuitem")
          .map((item) => item.textContent),
        separators: within(menu).getAllByRole("separator", { hidden: true })
          .length,
      };
    };
    const copy = async (name: string, item: string) => {
      const { menu } = await menuOf(name);
      await user.click(within(menu).getByRole("menuitem", { name: item }));
      return onCopyPath.mock.calls.at(-1)?.[0];
    };

    const rootMenu = await menuOf("My Drawings");
    expect(rootMenu.labels).toEqual([
      "New Drawing",
      "New Folder",
      "Copy Path",
      "Remove Workspace",
    ]);
    expect(rootMenu.separators).toBe(2);
    await user.keyboard("{Escape}");

    const folderMenu = await menuOf("我的 文件夹");
    expect(folderMenu.labels).toEqual([
      "New Drawing",
      "New Folder",
      "Copy Path",
      "Copy Relative Path",
      "Rename",
      "Delete",
    ]);
    expect(folderMenu.separators).toBe(3);
    await user.keyboard("{Escape}");

    const drawingMenu = await menuOf("计划 草图");
    expect(drawingMenu.labels).toEqual([
      "Rename",
      "Copy Path",
      "Copy Relative Path",
      "Delete",
    ]);
    expect(drawingMenu.separators).toBe(2);
    await user.keyboard("{Escape}");

    const rootPath = await copy("My Drawings", "Copy Path");
    expect(rootPath?.kind).toBe("path");
    expect(rootPath?.resolve()).toBe(root);
    const drawingPath = await copy("计划 草图", "Copy Path");
    expect(drawingPath?.resolve()).toBe(`${root}/计划 草图.excalidraw`);
    const drawingRelative = await copy("计划 草图", "Copy Relative Path");
    expect(drawingRelative?.kind).toBe("relativePath");
    expect(drawingRelative?.resolve()).toBe("计划 草图.excalidraw");
    const folderRelative = await copy("我的 文件夹", "Copy Relative Path");
    expect(folderRelative?.resolve()).toBe("我的 文件夹");
  });

  it("copies nothing for an entry that no longer exists", async () => {
    const REFRESH_LABEL = en["workspace.refresh"];
    const user = userEvent.setup();
    const invoker = createInvoker();
    const onCopyPath = vi.fn<(request: CopyPathRequest) => void>();
    render(
      <WorkspacePanel
        invoker={invoker}
        onCopyPath={onCopyPath}
        selectDirectory={async () => null}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Actions for drawing" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Copy Path" }));
    const request = onCopyPath.mock.calls[0]?.[0];
    expect(request?.resolve()).toBe("/workspace/one/drawing.excalidraw");

    // The listing refreshes without the drawing (deleted on disk).
    const index = ROOT_ENTRIES.findIndex(
      (entry) =>
        entry.workspaceId === "workspace-1" && entry.kind === "drawing",
    );
    const [removed] = ROOT_ENTRIES.splice(index, 1);
    try {
      await user.click(screen.getByRole("button", { name: REFRESH_LABEL }));
      await waitFor(() =>
        expect(
          screen.queryByRole("treeitem", { name: "drawing" }),
        ).not.toBeInTheDocument(),
      );
      expect(request?.resolve()).toBeNull();
    } finally {
      if (removed !== undefined) ROOT_ENTRIES.splice(index, 0, removed);
    }
  });
});
