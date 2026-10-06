import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTauriCommandInvoker,
  validateHistoryCommandRequest,
} from "./client";

const { tauriInvoke } = vi.hoisted(() => ({ tauriInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriInvoke }));

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
      validateHistoryCommandRequest("history_set_marked", {
        document,
        requestId: "mark-version-1",
        versionId: "version-1",
        marked: true,
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

  it("rejects malformed selected-version mark requests", () => {
    for (const request of [
      { document, requestId: "", versionId: "version-1", marked: true },
      { document, requestId: "request-1", versionId: "", marked: false },
      { document, requestId: "request-1", versionId: "version-1", marked: 1 },
    ]) {
      expect(() =>
        validateHistoryCommandRequest("history_set_marked", request),
      ).toThrow();
    }
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

describe("Tauri command envelope", () => {
  beforeEach(() => {
    tauriInvoke.mockReset();
  });

  it("wraps history commands in the Rust request argument", async () => {
    tauriInvoke.mockResolvedValue({
      documentId: "document-1",
      items: [],
      listRevision: 1,
    });
    const request = {
      document: { kind: "handle" as const, documentId: "document-1" },
      limit: 50,
    };

    await createTauriCommandInvoker().invoke("history_list", request);

    expect(tauriInvoke).toHaveBeenCalledWith("history_list", { request });
  });

  it("wraps selected-version mark commands in the Rust request argument", async () => {
    tauriInvoke.mockResolvedValue({ versionId: "version-1", marked: true });
    const request = {
      document: { kind: "handle" as const, documentId: "document-1" },
      requestId: "mark-version-1",
      versionId: "version-1",
      marked: true,
    };

    await createTauriCommandInvoker().invoke("history_set_marked", request);

    expect(tauriInvoke).toHaveBeenCalledWith("history_set_marked", { request });
  });

  it("keeps legacy flat command arguments unchanged", async () => {
    tauriInvoke.mockResolvedValue([]);
    const request = { workspaceId: "workspace-1", parentRelativePath: "" };

    await createTauriCommandInvoker().invoke("workspace_entry_list", request);

    expect(tauriInvoke).toHaveBeenCalledWith("workspace_entry_list", request);
  });
});
