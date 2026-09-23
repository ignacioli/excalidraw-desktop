import { describe, expect, it } from "vitest";
import { validateHistoryCommandRequest } from "./client";

describe("IPC v3 history input boundary", () => {
  const document = { kind: "handle" as const, documentId: "document-1" };
  const scene = JSON.stringify({ type: "excalidraw" });

  it("accepts bounded list, mark, and protected replacement requests", () => {
    expect(() =>
      validateHistoryCommandRequest("history_list", {
        document,
        limit: 50,
      }),
    ).not.toThrow();
    expect(() =>
      validateHistoryCommandRequest("history_mark", {
        document,
        requestId: "request-1",
        sessionGeneration: 0,
        revision: 1,
        currentSceneJson: scene,
      }),
    ).not.toThrow();
    expect(() =>
      validateHistoryCommandRequest("history_replace", {
        document,
        requestId: "request-2",
        sessionGeneration: 1,
        revision: 2,
        expectedBaseHash: "a".repeat(64),
        currentSceneJson: scene,
        target: { kind: "clear" },
      }),
    ).not.toThrow();
  });

  it("rejects traversal-like malformed locator, paging, hash, and target input", () => {
    expect(() =>
      validateHistoryCommandRequest("history_list", {
        document: { kind: "path", path: "" },
      }),
    ).toThrow();
    expect(() =>
      validateHistoryCommandRequest("history_list", {
        document,
        limit: 101,
      }),
    ).toThrow();
    expect(() =>
      validateHistoryCommandRequest("history_replace", {
        document,
        requestId: "request-3",
        sessionGeneration: 1,
        revision: 2,
        expectedBaseHash: "A".repeat(64),
        currentSceneJson: scene,
        target: { kind: "restore", versionId: "version-1" },
      }),
    ).toThrow();
    expect(() =>
      validateHistoryCommandRequest("history_replace", {
        document,
        requestId: "request-4",
        sessionGeneration: 1,
        revision: 2,
        expectedBaseHash: "a".repeat(64),
        currentSceneJson: scene,
        target: { kind: "import", candidateSceneJson: "" },
      }),
    ).toThrow();
  });
});
