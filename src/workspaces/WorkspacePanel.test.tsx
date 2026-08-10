import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CommandInvoker } from "../ipc/client";
import { WorkspacePanel } from "./WorkspacePanel";

describe("WorkspacePanel", () => {
  it("mounts and removes a workspace without implying file deletion", async () => {
    const user = userEvent.setup();
    const workspace = {
      id: "workspace-1",
      name: "Sketches",
      rootPath: "/workspace",
      createdAt: 1,
    };
    const invoke = vi.fn(async (command: string) => {
      if (command === "workspace_list") return [];
      if (command === "workspace_add") return workspace;
      if (command === "dir_list") return [];
      if (command === "workspace_remove") return {};
      throw new Error(`Unexpected command ${command}`);
    }) as CommandInvoker["invoke"];
    const onWorkspacePresenceChange = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);

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

    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(window.confirm).toHaveBeenCalledWith(
      "Remove “Sketches” from this app? Files on disk will not be deleted.",
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("workspace_remove", {
        workspaceId: "workspace-1",
      }),
    );
    expect(onWorkspacePresenceChange).toHaveBeenLastCalledWith(false);
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
    expect(screen.getAllByRole("tree")).toHaveLength(2);

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
});
