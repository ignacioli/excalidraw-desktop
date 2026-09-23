import { describe, expect, it, vi } from "vitest";
import type { CommandInvoker } from "../ipc/client";
import type { HistoryReplaceRequest } from "../ipc/contracts";
import { createDocumentGateway } from "./documentGateway";

describe("DocumentGateway protected replacement seam", () => {
  it("forwards the typed request without registering a frontend handler", async () => {
    const invoke = vi.fn().mockResolvedValue({
      status: "pendingReconciliation",
      requestId: "request-1",
      replacementCommitted: null,
      operationState: "pendingReconciliation",
    });
    const gateway = createDocumentGateway({ invoke } as unknown as CommandInvoker);
    const request: HistoryReplaceRequest = {
      document: { kind: "handle", documentId: "document-1" },
      requestId: "request-1",
      sessionGeneration: 4,
      revision: 9,
      expectedBaseHash: "a".repeat(64),
      currentSceneJson: '{"type":"excalidraw","version":2,"elements":[]}',
      target: { kind: "clear" },
    };

    expect(gateway.historyReplace).toBeDefined();
    await expect(gateway.historyReplace!(request)).resolves.toMatchObject({
      status: "pendingReconciliation",
    });
    expect(invoke).toHaveBeenCalledWith("history_replace", request);
  });
});
