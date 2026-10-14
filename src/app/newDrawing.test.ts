import { describe, expect, it, vi } from "vitest";
import type { CommandInvoker } from "../ipc/client";
import type { ClaimWorkspaceOutcome } from "../ipc/contracts";
import { createNewDrawingFile, NEW_DRAWING_NAME_ATTEMPTS } from "./newDrawing";

const workspace = {
  id: "workspace-drawings",
  name: "Drawings",
  rootPath: "/Users/me/Drawings",
  createdAt: 1,
};

const claimed: ClaimWorkspaceOutcome = {
  kind: "claimed",
  workspace,
  replaced: null,
  shell: null,
};

function createInvoker(
  existingNames: Iterable<string> = [],
  claim: ClaimWorkspaceOutcome = claimed,
) {
  const existing = new Set(existingNames);
  const invoke = vi.fn(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "window_claim_workspace") return claim;
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
  it("asks for a folder and claims it before creating Untitled", async () => {
    const invoker = createInvoker();
    const selectDirectory = vi.fn(async () => workspace.rootPath);

    const result = await createNewDrawingFile({
      invoker,
      selectDirectory,
      untitledBaseName: "Untitled",
    });

    expect(selectDirectory).toHaveBeenCalledOnce();
    expect(invoker.mock).toHaveBeenCalledWith("window_claim_workspace", {
      rootPath: workspace.rootPath,
    });
    expect(result).toMatchObject({
      status: "created",
      workspace,
      replaced: null,
      entry: { canonicalPath: `${workspace.rootPath}/Untitled.excalidraw` },
    });
  });

  it("reports the Workspace this window held before", async () => {
    const invoker = createInvoker([], {
      kind: "claimed",
      workspace,
      replaced: "workspace-previous",
      shell: null,
    });

    await expect(
      createNewDrawingFile({
        invoker,
        selectDirectory: async () => workspace.rootPath,
        untitledBaseName: "Untitled",
      }),
    ).resolves.toMatchObject({
      status: "created",
      replaced: "workspace-previous",
    });
  });

  it.each<ClaimWorkspaceOutcome>([
    { kind: "ownedBy", label: "window-2", workspaceId: workspace.id },
    {
      kind: "insideOpen",
      label: "window-2",
      workspaceId: "workspace-parent",
      relativePath: "Drawings",
    },
    { kind: "containsOpen", label: "window-2", workspaceId: "workspace-child" },
  ])(
    "creates nothing when another window holds the folder ($kind)",
    async (outcome) => {
      const invoker = createInvoker([], outcome);

      await expect(
        createNewDrawingFile({
          invoker,
          selectDirectory: async () => workspace.rootPath,
          untitledBaseName: "Untitled",
        }),
      ).resolves.toEqual({ status: "declined", outcome });
      expect(invoker.mock).not.toHaveBeenCalledWith(
        "workspace_entry_create",
        expect.anything(),
      );
    },
  );

  it("steps past existing names to the next free Untitled N and never overwrites", async () => {
    const invoker = createInvoker([
      "Untitled.excalidraw",
      "Untitled 2.excalidraw",
    ]);

    const result = await createNewDrawingFile({
      invoker,
      selectDirectory: async () => workspace.rootPath,
      untitledBaseName: "Untitled",
    });

    expect(result).toMatchObject({
      status: "created",
      entry: { canonicalPath: `${workspace.rootPath}/Untitled 3.excalidraw` },
    });
  });

  it("creates nothing when the folder choice is cancelled", async () => {
    const invoker = createInvoker();

    await expect(
      createNewDrawingFile({
        invoker,
        selectDirectory: async () => null,
        untitledBaseName: "Untitled",
      }),
    ).resolves.toEqual({ status: "cancelled" });
    expect(invoker.mock).not.toHaveBeenCalled();
  });

  it("propagates errors other than a name conflict", async () => {
    const failure = { code: "DISK_FULL", message: "full" };
    const invoke = vi.fn(async (command: string) => {
      if (command === "window_claim_workspace") return claimed;
      throw failure;
    }) as unknown as CommandInvoker["invoke"];

    await expect(
      createNewDrawingFile({
        invoker: { invoke },
        selectDirectory: async () => workspace.rootPath,
        untitledBaseName: "Untitled",
      }),
    ).rejects.toBe(failure);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("reports the conflict after the bounded number of name attempts", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "window_claim_workspace") return claimed;
      throw { code: "NAME_CONFLICT", message: "exists" };
    }) as unknown as CommandInvoker["invoke"];

    await expect(
      createNewDrawingFile({
        invoker: { invoke },
        selectDirectory: async () => workspace.rootPath,
        untitledBaseName: "Untitled",
      }),
    ).rejects.toMatchObject({ code: "NAME_CONFLICT" });
    // One claim, then one create per name attempt.
    expect(invoke).toHaveBeenCalledTimes(NEW_DRAWING_NAME_ATTEMPTS + 1);
  });
});
