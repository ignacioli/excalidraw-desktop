import { describe, expect, it, vi } from "vitest";

import { formatHistoryFrontendError } from "./historyFrontendError";

describe("formatHistoryFrontendError", () => {
  it("preserves structured IPC error details for process evidence", () => {
    expect(
      formatHistoryFrontendError({
        code: "HISTORY_RESOURCE_MISSING",
        message: "History asset is missing.",
        retriable: false,
      }),
    ).toBe("HISTORY_RESOURCE_MISSING: History asset is missing.");
  });

  it("keeps Error messages and serializes other objects", () => {
    expect(formatHistoryFrontendError(new Error("frontend failed"))).toBe(
      "frontend failed",
    );
    expect(formatHistoryFrontendError({ reason: "unknown" })).toBe(
      "reason=unknown",
    );
  });

  it("retains nested transport and status-query causes", () => {
    expect(
      formatHistoryFrontendError(
        new Error("replacement could not be verified", {
          cause: {
            originalError: { code: "TRANSPORT", message: "request failed" },
            statusError: new Error("status unavailable"),
          },
        }),
      ),
    ).toBe(
      "replacement could not be verified; cause: originalError=TRANSPORT: request failed, statusError=status unavailable",
    );
  });
});

const driverMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  list: vi.fn(),
  preview: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: driverMocks.invoke }));
vi.mock("../ipc/client", () => ({
  hasTauriCommandRuntime: () => true,
  createTauriCommandInvoker: () => ({}),
}));
vi.mock("../documents/documentStore", () => ({ documentManager: {} }));
vi.mock("../history/historyClient", () => ({
  createHistoryClient: () => ({
    list: driverMocks.list,
    preview: driverMocks.preview,
  }),
}));
vi.mock("../history/historyCoordinator", () => ({
  HistoryCoordinator: class {
    replace = driverMocks.replace;
  },
}));
vi.mock("../history/assetAdoption", () => ({
  adoptSceneAssets: async (scene: unknown) => scene,
}));
vi.mock("../editor/sceneSerializer", () => ({
  deserializeSceneData: (scene: unknown) => scene,
}));

import { NativeHistoryFrontendDriver } from "./historyFrontendDriver";
import type { DocumentManager } from "../documents/documentStore";
import type { ExcalidrawAdapter } from "../editor/ExcalidrawAdapter";

it("publishes evidence before requesting production window close", async () => {
  const request = {
    documentPath: "/workspace/doc.excalidraw",
    targetVersionId: "version-a",
    requestId: "request-a",
  };
  const scene = { elements: [], files: {}, appState: {} };
  let resolvePublish: (() => void) | undefined;
  driverMocks.invoke.mockImplementation(
    async (command: string, args?: { evidence?: { scenario?: string } }) => {
      if (command === "e2e_history_frontend_bootstrap") return request;
      if (args?.evidence?.scenario === "history-frontend-adoption") {
        await new Promise<void>((resolve) => {
          resolvePublish = resolve;
        });
      }
    },
  );
  driverMocks.list.mockResolvedValue({ items: [{ versionId: "version-a" }] });
  driverMocks.preview.mockResolvedValue({ versionId: "version-a", scene });
  driverMocks.replace.mockResolvedValue({ adopted: true });
  const documents = {
    store: {
      getState: () => ({
        sessionsById: { doc: { id: "doc", path: request.documentPath } },
      }),
    },
  } as unknown as DocumentManager;
  const adapter = {
    isEditable: () => true,
    readScene: () => scene,
  } as unknown as ExcalidrawAdapter;
  const driver = new NativeHistoryFrontendDriver(documents);
  driver.attachEditor("doc", adapter);
  driver.start();
  await vi.waitFor(() => expect(resolvePublish).toBeDefined());
  expect(driverMocks.invoke).not.toHaveBeenCalledWith(
    "e2e_history_frontend_close",
    {},
  );
  resolvePublish?.();
  await vi.waitFor(() =>
    expect(driverMocks.invoke).toHaveBeenCalledWith(
      "e2e_history_frontend_close",
      {},
    ),
  );
  expect(driverMocks.invoke).toHaveBeenCalledWith(
    "e2e_history_frontend_publish",
    {
      evidence: expect.objectContaining({
        listedVersionIds: ["version-a"],
        previewVersionId: "version-a",
        beforeReplacement: expect.objectContaining({ elements: [] }),
        previewReadback: expect.objectContaining({ elements: [] }),
      }),
    },
  );
});
