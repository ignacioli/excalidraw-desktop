import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CommandInvoker } from "../ipc/client";
import { FileTree } from "./FileTree";

function createInvoker(): CommandInvoker {
  return {
    invoke: vi.fn(async (command: string) => {
      if (command === "dir_list") {
        return [
          {
            name: "nested",
            relativePath: "nested",
            kind: "dir",
            mtime: 1,
            fileSize: 0,
          },
          {
            name: "drawing.excalidraw",
            relativePath: "drawing.excalidraw",
            kind: "file",
            mtime: 1,
            fileSize: 10,
          },
        ];
      }
      throw new Error(`unexpected command ${command}`);
    }) as CommandInvoker["invoke"],
  };
}

describe("FileTree", () => {
  it("renders entries, lazily loads directories, and exposes keyboard actions", async () => {
    const invoker = createInvoker();
    render(
      <FileTree
        workspaceId="workspace-1"
        workspaceRoot="/workspace"
        invoker={invoker}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("drawing.excalidraw")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand nested" }));
    await waitFor(() =>
      expect(invoker.invoke).toHaveBeenCalledWith("dir_list", {
        workspaceId: "workspace-1",
        relativePath: "nested",
      }),
    );

    expect(screen.getByRole("tree")).toHaveAttribute("tabindex", "0");
    expect(
      screen.getAllByRole("button", { name: "Actions for drawing.excalidraw" })
        .length,
    ).toBeGreaterThan(0);
  });
});
