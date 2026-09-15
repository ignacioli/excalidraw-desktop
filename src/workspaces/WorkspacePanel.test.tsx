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
import {
  SHELL_PREFERENCES_STORAGE_KEY,
  SHELL_PREFERENCES_VERSION,
  ShellPreferences,
} from "../app/shellPreferences";
import type { Workspace, WorkspaceEntry } from "../ipc/contracts";
import { documentManager } from "../documents/documentStore";
import { WorkspacePanel } from "./WorkspacePanel";

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
      if (command === "workspace_add") return addedWorkspace;
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
      if (command === "workspace_remove") return {};
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
    expect(invoke).toHaveBeenCalledWith("workspace_add", {
      rootPath: "/workspace",
    });
    expect(onWorkspacesChange).toHaveBeenLastCalledWith([workspace]);
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
    const preferences = new ShellPreferences();
    preferences.setCurrentWorkspaceId("workspace-1");
    const invoker = createInvoker();
    render(
      <WorkspacePanel
        invoker={invoker}
        preferences={preferences}
        selectDirectory={async () => null}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Sketches" }),
    ).toBeInTheDocument();

    preferences.setCurrentWorkspaceId("workspace-2");

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Blueprints" }),
      ).toBeInTheDocument();
    });
  });

  it("restores and persists each Workspace expansion preference", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      SHELL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: SHELL_PREFERENCES_VERSION,
        sidebarPinned: false,
        expandedWorkspaceIds: ["workspace-1"],
        currentWorkspaceId: "workspace-1",
      }),
    );
    const invoker = createInvoker();

    const firstRender = render(
      <WorkspacePanel invoker={invoker} selectDirectory={async () => null} />,
    );
    const sketches = await screen.findByRole("treeitem", { name: "Sketches" });
    expect(sketches).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.queryByRole("treeitem", { name: "Blueprints" }),
    ).not.toBeInTheDocument();

    await user.click(sketches);
    expect(sketches).toHaveAttribute("aria-expanded", "false");
    expect(
      JSON.parse(
        window.localStorage.getItem(SHELL_PREFERENCES_STORAGE_KEY) ?? "{}",
      ),
    ).toMatchObject({ expandedWorkspaceIds: [] });

    firstRender.unmount();
    render(
      <WorkspacePanel invoker={invoker} selectDirectory={async () => null} />,
    );
    expect(
      await screen.findByRole("treeitem", { name: "Sketches" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("treeitem", { name: "Blueprints" }),
    ).not.toBeInTheDocument();
  });

  it("expands a newly mounted Workspace even when an existing preference is collapsed", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      SHELL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: SHELL_PREFERENCES_VERSION,
        sidebarPinned: false,
        expandedWorkspaceIds: [],
      }),
    );
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
    await user.click(
      within(dialog).getByRole("button", { name: "Remove Workspace" }),
    );
    await waitFor(() =>
      expect(invoker.invoke).toHaveBeenCalledWith("workspace_remove", {
        workspaceId: "workspace-1",
      }),
    );
    expect(closeWorkspaceDocuments).toHaveBeenCalledWith("/workspace/one");
    expect(closeWorkspaceDocuments.mock.invocationCallOrder[0]).toBeLessThan(
      vi
        .mocked(invoker.invoke)
        .mock.invocationCallOrder.find(
          (_, index) =>
            vi.mocked(invoker.invoke).mock.calls[index]?.[0] ===
            "workspace_remove",
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
      "workspace_remove",
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
        if (command === "workspace_remove") {
          throw new Error("Workspace is still in use.");
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
      "Workspace is still in use.",
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(remove).toHaveFocus();
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
  });
});
