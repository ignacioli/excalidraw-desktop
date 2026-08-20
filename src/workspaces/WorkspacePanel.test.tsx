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
import {
  SHELL_PREFERENCES_STORAGE_KEY,
  SHELL_PREFERENCES_VERSION,
} from "../app/shellPreferences";
import type { Workspace } from "../ipc/contracts";
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

const testLocalStorage = new Map<string, string>();

beforeEach(() => {
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
      if (command === "dir_list") {
        const workspaceId = String(args.workspaceId ?? "");
        const relativePath = String(args.relativePath ?? "");
        return ROOT_ENTRIES.filter(
          (entry) =>
            entry.workspaceId === workspaceId &&
            entry.parentRelativePath === relativePath,
        ).map((entry) => ({
          name: entry.name,
          relativePath: entry.relativePath,
          kind: entry.kind === "directory" ? "dir" : "file",
          mtime: entry.mtime,
          fileSize: entry.fileSize,
        }));
      }
      if (command === "workspace_add") return addedWorkspace;
      if (command === "workspace_remove") return {};
      throw new Error(`Unexpected command ${command}`);
    },
  ) as CommandInvoker["invoke"];
  return { invoke };
}

describe("WorkspacePanel", () => {
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

    render(
      <WorkspacePanel
        invoker={{ invoke }}
        onWorkspacePresenceChange={onWorkspacePresenceChange}
        selectDirectory={async () => "/workspace"}
      />,
    );

    await waitFor(() =>
      expect(onWorkspacePresenceChange).toHaveBeenCalledWith(false),
    );
    await user.click(screen.getByRole("button", { name: "Mount folder…" }));
    expect(
      await screen.findByRole("button", { name: "Sketches" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(invoke).toHaveBeenCalledWith("workspace_add", {
      rootPath: "/workspace",
    });
  });

  it("renders multiple workspaces in parallel and collapses each independently", async () => {
    const user = userEvent.setup();
    const workspaces = [
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
    ];
    const invoke = vi.fn(async (command: string) => {
      if (command === "workspace_list") return workspaces;
      if (command === "dir_list") return [];
      throw new Error(`Unexpected command ${command}`);
    }) as CommandInvoker["invoke"];

    render(
      <WorkspacePanel
        invoker={{ invoke }}
        selectDirectory={async () => null}
      />,
    );

    const firstToggle = await screen.findByRole("button", {
      name: "Sketches",
    });
    const secondToggle = screen.getByRole("button", {
      name: "Blueprints",
    });
    expect(firstToggle).toHaveAttribute("aria-expanded", "true");
    expect(secondToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("tree")).toHaveLength(1);

    await user.click(firstToggle);
    expect(firstToggle).toHaveAttribute("aria-expanded", "false");
    expect(secondToggle).toHaveAttribute("aria-expanded", "true");
    const collapsedFiles = document.getElementById(
      "workspace-files-workspace-1",
    );
    expect(collapsedFiles).toHaveAttribute("hidden");
    expect(
      document.getElementById("workspace-files-workspace-2"),
    ).not.toHaveAttribute("hidden");
  });

  it("restores and persists each Workspace expansion preference", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      SHELL_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: SHELL_PREFERENCES_VERSION,
        sidebarPinned: false,
        expandedWorkspaceIds: ["workspace-1"],
      }),
    );
    const invoker = createInvoker();

    const firstRender = render(
      <WorkspacePanel invoker={invoker} selectDirectory={async () => null} />,
    );
    const sketches = await screen.findByRole("button", { name: "Sketches" });
    const blueprints = screen.getByRole("button", { name: "Blueprints" });
    expect(sketches).toHaveAttribute("aria-expanded", "true");
    expect(blueprints).toHaveAttribute("aria-expanded", "false");

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
      await screen.findByRole("button", { name: "Sketches" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Blueprints" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
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

    render(
      <WorkspacePanel
        invoker={invoker}
        selectDirectory={async () => workspace.rootPath}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Mount folder…" }),
    );

    const mounted = await screen.findByRole("button", {
      name: "New sketches",
    });
    expect(mounted).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps Remove Workspace in the Workspace header menu and confirms mount-only removal", async () => {
    const user = userEvent.setup();
    const invoker = createInvoker();
    render(
      <WorkspacePanel invoker={invoker} selectDirectory={async () => null} />,
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
    expect(menu).toHaveTextContent("Files on disk will not be deleted");

    await user.click(
      screen.getByRole("menuitem", { name: "Remove Workspace" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Files on disk will not be deleted");
    await user.click(
      within(dialog).getByRole("button", { name: "Remove Workspace" }),
    );
    await waitFor(() =>
      expect(invoker.invoke).toHaveBeenCalledWith("workspace_remove", {
        workspaceId: "workspace-1",
      }),
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
    const secondActions = screen.getByRole("button", {
      name: "Actions for Blueprints",
    });
    await user.click(firstActions);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    await user.click(secondActions);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menu")).toHaveTextContent("Remove Workspace");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(secondActions).toHaveFocus();

    await user.click(firstActions);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(firstActions).toHaveFocus();

    await user.click(secondActions);
    await user.click(screen.getByRole("button", { name: "Blueprints" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
