import { describe, expect, it, vi } from "vitest";
import type { CommandInvoker } from "../ipc/client";
import { createNewDrawingFile, NEW_DRAWING_NAME_ATTEMPTS } from "./newDrawing";

const workspace = {
  id: "workspace-drawings",
  name: "Drawings",
  rootPath: "/Users/me/Drawings",
  createdAt: 1,
};

function createInvoker(existingNames: Iterable<string> = []) {
  const existing = new Set(existingNames);
  const invoke = vi.fn(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "workspace_add") return workspace;
      if (command === "workspace_entry_create") {
        const name = `${String(args?.baseName)}.excalidraw`;
        if (existing.has(name)) {
          throw { code: "NAME_CONFLICT", message: "exists" };
        }
        existing.add(name);
        return {
          operationId: name,
          entry: {
            workspaceId: String(args?.workspaceId),
            kind: "drawing",
            canonicalPath: `${workspace.rootPath}/${name}`,
            relativePath: name,
            parentRelativePath: "",
            name,
            displayName: String(args?.baseName),
            mtime: 1,
            fileSize: 0,
          },
        };
      }
      throw new Error(`Unexpected command ${command}`);
    },
  );
  return {
    invoke: invoke as unknown as CommandInvoker["invoke"],
    mock: invoke,
  };
}

describe("createNewDrawingFile", () => {
  it("asks for a folder on first use and mounts it before creating Untitled", async () => {
    const invoker = createInvoker();
    const selectDirectory = vi.fn(async () => workspace.rootPath);

    const result = await createNewDrawingFile({
      invoker,
      mountedWorkspaces: [],
      preferredWorkspaceId: null,
      selectDirectory,
      untitledBaseName: "Untitled",
    });

    expect(selectDirectory).toHaveBeenCalledOnce();
    expect(invoker.mock).toHaveBeenCalledWith("workspace_add", {
      rootPath: workspace.rootPath,
    });
    expect(result).toMatchObject({
      status: "created",
      workspace,
      mounted: true,
      entry: { canonicalPath: `${workspace.rootPath}/Untitled.excalidraw` },
    });
  });

  it("reuses the remembered mounted workspace without prompting and never overwrites", async () => {
    const invoker = createInvoker([
      "Untitled.excalidraw",
      "Untitled 2.excalidraw",
    ]);
    const selectDirectory = vi.fn(async () => null);

    const result = await createNewDrawingFile({
      invoker,
      mountedWorkspaces: [workspace],
      preferredWorkspaceId: workspace.id,
      selectDirectory,
      untitledBaseName: "Untitled",
    });

    expect(selectDirectory).not.toHaveBeenCalled();
    expect(invoker.mock).not.toHaveBeenCalledWith(
      "workspace_add",
      expect.anything(),
    );
    expect(result).toMatchObject({
      status: "created",
      mounted: false,
      entry: { canonicalPath: `${workspace.rootPath}/Untitled 3.excalidraw` },
    });
  });

  it("reuses an already mounted workspace when the chosen folder is its root", async () => {
    const invoker = createInvoker();

    const result = await createNewDrawingFile({
      invoker,
      mountedWorkspaces: [workspace],
      preferredWorkspaceId: "workspace-removed",
      selectDirectory: async () => workspace.rootPath,
      untitledBaseName: "Untitled",
    });

    expect(invoker.mock).not.toHaveBeenCalledWith(
      "workspace_add",
      expect.anything(),
    );
    expect(result).toMatchObject({ status: "created", mounted: false });
  });

  it("creates nothing when the folder choice is cancelled", async () => {
    const invoker = createInvoker();

    await expect(
      createNewDrawingFile({
        invoker,
        mountedWorkspaces: [],
        preferredWorkspaceId: null,
        selectDirectory: async () => null,
        untitledBaseName: "Untitled",
      }),
    ).resolves.toEqual({ status: "cancelled" });
    expect(invoker.mock).not.toHaveBeenCalled();
  });

  it("propagates errors other than a name conflict", async () => {
    const failure = { code: "DISK_FULL", message: "full" };
    const invoke = vi.fn(async () => {
      throw failure;
    }) as unknown as CommandInvoker["invoke"];

    await expect(
      createNewDrawingFile({
        invoker: { invoke },
        mountedWorkspaces: [workspace],
        preferredWorkspaceId: workspace.id,
        selectDirectory: async () => null,
        untitledBaseName: "Untitled",
      }),
    ).rejects.toBe(failure);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("reports the conflict after the bounded number of name attempts", async () => {
    const invoke = vi.fn(async () => {
      throw { code: "NAME_CONFLICT", message: "exists" };
    }) as unknown as CommandInvoker["invoke"];

    await expect(
      createNewDrawingFile({
        invoker: { invoke },
        mountedWorkspaces: [workspace],
        preferredWorkspaceId: workspace.id,
        selectDirectory: async () => null,
        untitledBaseName: "Untitled",
      }),
    ).rejects.toMatchObject({ code: "NAME_CONFLICT" });
    expect(invoke).toHaveBeenCalledTimes(NEW_DRAWING_NAME_ATTEMPTS);
  });
});
