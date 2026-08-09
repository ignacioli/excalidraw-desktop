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
      await screen.findByRole("heading", { name: "Sketches" }),
    ).toBeVisible();
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
});
