import { describe, expect, it } from "vitest";

import {
  HISTORY_FAULT_STAGES,
  historyFaultEnvironment,
  isHistoryFaultReadyMarker,
} from "./fault";

describe("History fault barrier contract", () => {
  it("keeps the seven process-level stages stable", () => {
    expect(HISTORY_FAULT_STAGES).toEqual([
      "object_publish",
      "protection_commit",
      "intent_commit",
      "after_rename_before_parent_sync",
      "metadata_complete_before_frontend_ack",
      "eviction_delete_gc",
      "rename_delete_repair",
    ]);
  });

  it("serializes an isolated process environment without optional hashes", () => {
    expect(
      historyFaultEnvironment({
        stage: "intent_commit",
        seed: "seed-17",
        operationId: "operation-17",
        documentId: "document-17",
        targetPath: "/tmp/excalidraw-desktop-e2e-seed-17/workspace/doc.excalidraw",
      }),
    ).toEqual({
      EXCALIDRAW_E2E_HISTORY_FAULT_ARMED: "1",
      EXCALIDRAW_E2E_HISTORY_FAULT_STAGE: "intent_commit",
      EXCALIDRAW_E2E_HISTORY_FAULT_SEED: "seed-17",
      EXCALIDRAW_E2E_HISTORY_OPERATION_ID: "operation-17",
      EXCALIDRAW_E2E_HISTORY_DOCUMENT_ID: "document-17",
      EXCALIDRAW_E2E_HISTORY_TARGET_PATH:
        "/tmp/excalidraw-desktop-e2e-seed-17/workspace/doc.excalidraw",
    });
  });

  it("accepts a ready marker only when its context is complete", () => {
    const marker = {
      scenario: "history-fault-kill",
      stage: "metadata_complete_before_frontend_ack",
      seed: "seed-17",
      pid: 42,
      context: {
        operationId: "operation-17",
        documentId: "document-17",
        targetPath:
          "/tmp/excalidraw-desktop-e2e-seed-17/workspace/doc.excalidraw",
        oldSha256: "a".repeat(64),
        newSha256: "b".repeat(64),
      },
    };
    expect(isHistoryFaultReadyMarker(marker)).toBe(true);
    expect(
      isHistoryFaultReadyMarker({ ...marker, context: { operationId: "only" } }),
    ).toBe(false);
    expect(isHistoryFaultReadyMarker({ ...marker, pid: 1.5 })).toBe(false);
  });
});
