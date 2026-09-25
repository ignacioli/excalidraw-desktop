import { describe, expect, it, vi } from "vitest";
import type { CommandInvoker } from "../ipc/client";
import type {
  CommandName,
  HistoryOperationStatusResponse,
  HistoryReplaceRequest,
} from "../ipc/contracts";
import {
  createHistoryClient,
  HistoryReplaceResponseLostError,
  HistoryReplaceStatusError,
} from "./historyClient";

const document = { kind: "handle" as const, documentId: "document-1" };
const replaceRequest: HistoryReplaceRequest = {
  document,
  requestId: "replace-1",
  sessionGeneration: 2,
  revision: 8,
  expectedBaseHash: "a".repeat(64),
  currentSceneJson: '{"type":"excalidraw","elements":[]}',
  target: { kind: "clear" },
};

function createInvoker(
  invoke: (command: CommandName, request: unknown) => Promise<unknown>,
): CommandInvoker {
  return { invoke } as unknown as CommandInvoker;
}

describe("history client", () => {
  it("defaults list pages to 50 and preserves an opaque cursor", async () => {
    const response = {
      documentId: "document-1",
      items: [],
      nextCursor: "opaque/backend-token==",
      listRevision: 7,
    };
    const invoke = vi.fn().mockResolvedValue(response);
    const client = createHistoryClient(createInvoker(invoke));

    await expect(
      client.list({
        document,
        cursor: "opaque/backend-token==",
      }),
    ).resolves.toEqual(response);

    expect(invoke).toHaveBeenCalledWith("history_list", {
      document,
      cursor: "opaque/backend-token==",
      limit: 50,
    });
  });

  it("allows the 100-item page cap and rejects larger pages before invoking", async () => {
    const invoke = vi.fn().mockResolvedValue({
      documentId: "document-1",
      items: [],
      listRevision: 1,
    });
    const client = createHistoryClient(createInvoker(invoke));

    await expect(client.list({ document, limit: 100 })).resolves.toBeDefined();
    await expect(client.list({ document, limit: 101 })).rejects.toThrow(
      "between 1 and 100",
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("forwards preview and status through the typed command boundary", async () => {
    const status: HistoryOperationStatusResponse = {
      requestId: "replace-1",
      state: "completed",
      replacementCommitted: true,
      protectionVersionId: "version-1",
      adoptedScene: { type: "excalidraw" },
      newBaseHash: "b".repeat(64),
      newSessionGeneration: 3,
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        versionId: "version-1",
        scene: { type: "excalidraw" },
      })
      .mockResolvedValueOnce(status);
    const client = createHistoryClient(createInvoker(invoke));

    await expect(
      client.preview({ document, versionId: "version-1" }),
    ).resolves.toEqual({
      versionId: "version-1",
      scene: { type: "excalidraw" },
    });
    await expect(
      client.operationStatus({ document, requestId: "replace-1" }),
    ).resolves.toEqual(status);
    expect(invoke).toHaveBeenNthCalledWith(1, "history_preview", {
      document,
      versionId: "version-1",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "history_operation_status", {
      document,
      requestId: "replace-1",
    });
  });

  it("forwards a mark request and waits for the durable response", async () => {
    const response = {
      versionId: "manual-1",
      recordedAt: 123,
      source: "manual" as const,
      contentHash: "hash-1",
    };
    const invoke = vi.fn().mockResolvedValue(response);
    const client = createHistoryClient(createInvoker(invoke));
    const request = {
      document,
      requestId: "mark-1",
      sessionGeneration: 2,
      revision: 8,
      currentSceneJson: '{"type":"excalidraw","elements":[]}',
    };

    await expect(client.mark(request)).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledWith("history_mark", request);
  });

  it("recovers a lost replacement response by querying status once, never replaying replace", async () => {
    const status: HistoryOperationStatusResponse = {
      requestId: "replace-1",
      state: "completed",
      replacementCommitted: true,
      protectionVersionId: "version-protection",
      adoptedScene: { type: "excalidraw", elements: [] },
      newBaseHash: "b".repeat(64),
      newSessionGeneration: 3,
    };
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport response lost"))
      .mockResolvedValueOnce(status);
    const client = createHistoryClient(createInvoker(invoke));

    await expect(client.replace(replaceRequest)).resolves.toEqual({
      status: "completed",
      requestId: "replace-1",
      replacementCommitted: true,
      protectionVersionId: "version-protection",
      adoptedScene: { type: "excalidraw", elements: [] },
      newBaseHash: "b".repeat(64),
      newSessionGeneration: 3,
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      "history_replace",
      replaceRequest,
    );
    expect(invoke).toHaveBeenNthCalledWith(2, "history_operation_status", {
      document,
      requestId: "replace-1",
    });
  });

  it("returns pending reconciliation after an uncertain status", async () => {
    const status: HistoryOperationStatusResponse = {
      requestId: "replace-1",
      state: "pendingReconciliation",
      replacementCommitted: null,
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(status);
    const client = createHistoryClient(createInvoker(invoke));

    await expect(client.replace(replaceRequest)).resolves.toEqual({
      status: "pendingReconciliation",
      requestId: "replace-1",
      replacementCommitted: null,
      operationState: "pendingReconciliation",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not query or replay when the backend returns a structured error", async () => {
    const error = {
      code: "HISTORY_BUSY",
      message: "busy",
      retriable: true,
    };
    const invoke = vi.fn().mockRejectedValue(error);
    const client = createHistoryClient(createInvoker(invoke));

    await expect(client.replace(replaceRequest)).rejects.toEqual(error);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("classifies a transport error plus unavailable status as response-lost", async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport response lost"))
      .mockRejectedValueOnce(new Error("status transport unavailable"));
    const client = createHistoryClient(createInvoker(invoke));

    await expect(client.replace(replaceRequest)).rejects.toBeInstanceOf(
      HistoryReplaceResponseLostError,
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("surfaces a terminal status without attempting another replacement", async () => {
    const status: HistoryOperationStatusResponse = {
      requestId: "replace-1",
      state: "aborted",
      replacementCommitted: false,
    };
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce(status);
    const client = createHistoryClient(createInvoker(invoke));

    await expect(client.replace(replaceRequest)).rejects.toBeInstanceOf(
      HistoryReplaceStatusError,
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not invoke reserved commands merely by constructing the client", () => {
    const invoke = vi.fn();
    createHistoryClient(createInvoker(invoke));
    expect(invoke).not.toHaveBeenCalled();
  });
});
