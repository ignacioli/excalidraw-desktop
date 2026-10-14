import { describe, expect, it, vi } from "vitest";
import type { CommandInvoker } from "../ipc/client";
import type { IpcEvents } from "../ipc/contracts";
import { closeOtherAndClaim, describeNestedConflict } from "./nestedWorkspace";

type ClaimResult = IpcEvents["window-claim-result"];

const INNER = {
  id: "workspace-inner",
  name: "My Drawings",
  rootPath: "/Users/me/Documents/My Drawings",
  createdAt: 1,
};

const CLAIMED = {
  kind: "claimed" as const,
  workspace: {
    id: "workspace-outer",
    name: "Documents",
    rootPath: "/Users/me/Documents",
    createdAt: 2,
  },
  replaced: null,
  shell: null,
};

function harness(onClose: (emit: (result: ClaimResult) => void) => void) {
  let handler: ((event: { payload: ClaimResult }) => void) | undefined;
  const unlisten = vi.fn();
  const emit = (result: ClaimResult) => handler?.({ payload: result });
  const invoke = vi.fn(async (command: string) => {
    if (command === "window_close_other_and_claim") {
      onClose(emit);
      return { status: "closing", requestId: "request-1" };
    }
    throw new Error(`Unexpected command ${command}`);
  }) as unknown as CommandInvoker["invoke"];
  return {
    invoke,
    unlisten,
    emit,
    listener: vi.fn(
      async (
        _eventName: "window-claim-result",
        next: (event: { payload: ClaimResult }) => void,
      ) => {
        handler = next;
        return unlisten;
      },
    ),
  };
}

describe("describeNestedConflict", () => {
  it("names the folder and the Workspace inside it", async () => {
    const invoke = vi.fn(async () => [
      INNER,
    ]) as unknown as CommandInvoker["invoke"];

    await expect(
      describeNestedConflict({ invoke }, "/Users/me/Documents/", {
        label: "window-2",
        workspaceId: INNER.id,
      }),
    ).resolves.toEqual({
      targetName: "Documents",
      targetPath: "/Users/me/Documents/",
      label: "window-2",
      workspaceId: INNER.id,
      openWorkspaceName: "My Drawings",
      openWorkspacePath: "/Users/me/Documents/My Drawings",
    });
  });

  it("reports the overlap when the Workspace inside is unknown", async () => {
    const invoke = vi.fn(async () => []) as unknown as CommandInvoker["invoke"];

    await expect(
      describeNestedConflict({ invoke }, "/Users/me/Documents", {
        label: "window-2",
        workspaceId: INNER.id,
      }),
    ).rejects.toMatchObject({ key: "error.WORKSPACE_OVERLAP" });
  });
});

describe("closeOtherAndClaim", () => {
  const conflict = { label: "window-2", targetPath: "/Users/me/Documents" };

  it("closes this window's tabs, then waits for its own result", async () => {
    const order: string[] = [];
    const h = harness(() => order.push("ask"));
    const closeTabs = vi.fn(async () => {
      order.push("tabs");
    });

    const pending = closeOtherAndClaim({
      invoker: { invoke: h.invoke },
      conflict,
      closeTabs,
      listener: h.listener,
    });
    await vi.waitFor(() => expect(order).toEqual(["tabs", "ask"]));
    h.emit({ requestId: "other-request", outcome: { kind: "cancelled" } });
    h.emit({ requestId: "request-1", outcome: CLAIMED });

    await expect(pending).resolves.toEqual(CLAIMED);
    expect(h.invoke).toHaveBeenCalledWith("window_close_other_and_claim", {
      targetLabel: "window-2",
      rootPath: "/Users/me/Documents",
    });
    expect(h.unlisten).toHaveBeenCalledOnce();
  });

  it("keeps a result that arrives before the request id", async () => {
    const h = harness((emit) =>
      emit({ requestId: "request-1", outcome: { kind: "cancelled" } }),
    );

    await expect(
      closeOtherAndClaim({
        invoker: { invoke: h.invoke },
        conflict,
        closeTabs: async () => undefined,
        listener: h.listener,
      }),
    ).resolves.toEqual({ kind: "cancelled" });
    expect(h.unlisten).toHaveBeenCalledOnce();
  });

  it("asks nothing when a tab of this window stays open", async () => {
    const h = harness(() => undefined);
    const failure = new Error("close cancelled");

    await expect(
      closeOtherAndClaim({
        invoker: { invoke: h.invoke },
        conflict,
        closeTabs: async () => Promise.reject(failure),
        listener: h.listener,
      }),
    ).rejects.toBe(failure);
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.listener).not.toHaveBeenCalled();
  });
});
