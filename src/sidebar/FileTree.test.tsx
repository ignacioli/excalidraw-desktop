import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

vi.mock("./thumbnailRenderer", () => ({
  createThumbnailRenderer: () => ({
    render: vi.fn(async () => ({
      key: "thumbnail-key",
      webpBytes: [1, 2, 3],
    })),
    dispose: vi.fn(),
  }),
}));

function stubTauriRuntime(): void {
  (
    window as typeof window & {
      __TAURI_INTERNALS__?: {
        convertFileSrc?: (path: string) => string;
        invoke?: () => Promise<unknown>;
      };
    }
  ).__TAURI_INTERNALS__ = {
    convertFileSrc: (path: string) => `asset://${path}`,
    invoke: () => Promise.resolve(undefined),
  };
}

describe("FileTree", () => {
  afterEach(() => {
    delete (
      window as typeof window & {
        __TAURI_INTERNALS__?: {
          convertFileSrc?: (path: string) => string;
          invoke?: () => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
  });

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

  it("renders a cached thumbnail hit through the asset protocol", async () => {
    stubTauriRuntime();
    const invoke = vi.fn(async (command: string) => {
      if (command === "dir_list") {
        return [
          {
            name: "drawing.excalidraw",
            relativePath: "drawing.excalidraw",
            kind: "file",
            mtime: 1,
            fileSize: 10,
          },
        ];
      }
      if (command === "thumb_lookup") {
        return {
          hit: true,
          webpPath: "/cache/thumbnails/aa/bb/thumbnail-key.webp",
        };
      }
      throw new Error(`unexpected command ${command}`);
    }) as CommandInvoker["invoke"];

    const { container } = render(
      <FileTree
        workspaceId="workspace-1"
        workspaceRoot="/workspace"
        invoker={{ invoke }}
        theme="dark"
      />,
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("thumb_lookup", {
        path: "/workspace/drawing.excalidraw",
        theme: "dark",
      }),
    );
    await waitFor(() =>
      expect(container.querySelector("img.file-tree-thumbnail")).not.toBeNull(),
    );
    const thumbnail = container.querySelector(
      "img.file-tree-thumbnail",
    ) as HTMLImageElement;
    expect(thumbnail).toHaveAttribute(
      "src",
      "asset:///cache/thumbnails/aa/bb/thumbnail-key.webp",
    );
    expect(thumbnail).toHaveAttribute("alt", "");
    expect(thumbnail).toHaveAttribute("aria-hidden", "true");
  });

  it("generates and stores a thumbnail on a cache miss", async () => {
    stubTauriRuntime();
    const invoke = vi.fn(async (command: string) => {
      if (command === "dir_list") {
        return [
          {
            name: "drawing.excalidraw",
            relativePath: "drawing.excalidraw",
            kind: "file",
            mtime: 1,
            fileSize: 10,
          },
        ];
      }
      if (command === "thumb_lookup") {
        return { hit: false };
      }
      if (command === "doc_open") {
        return {
          scene: {
            type: "excalidraw",
            version: 2,
            elements: [],
            appState: {},
          },
          baseHash: "base",
          hasNewerDraft: false,
        };
      }
      if (command === "thumb_store") {
        return { webpPath: "/cache/thumbnails/aa/bb/thumbnail-key.webp" };
      }
      throw new Error(`unexpected command ${command}`);
    }) as CommandInvoker["invoke"];

    const { container } = render(
      <FileTree
        workspaceId="workspace-1"
        workspaceRoot="/workspace"
        invoker={{ invoke }}
      />,
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("doc_open", {
        path: "/workspace/drawing.excalidraw",
      }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("thumb_store", {
        path: "/workspace/drawing.excalidraw",
        theme: "light",
        key: "thumbnail-key",
        webpBytes: [1, 2, 3],
      }),
    );
    await waitFor(() =>
      expect(container.querySelector("img.file-tree-thumbnail")).not.toBeNull(),
    );
    const thumbnail = container.querySelector(
      "img.file-tree-thumbnail",
    ) as HTMLImageElement;
    expect(thumbnail).toHaveAttribute(
      "src",
      "asset:///cache/thumbnails/aa/bb/thumbnail-key.webp",
    );
  });
});
