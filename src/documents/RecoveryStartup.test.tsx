import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RecoveryManager } from "./recoveryManager";
import { RecoveryStartup } from "./RecoveryStartup";

vi.mock("@excalidraw/excalidraw", () => ({
  getSceneVersion: () => 0,
  restore: (scene: object) => scene,
  serializeAsJSON: () => "{}",
}));

const candidate = {
  documentId: "document-1",
  originalPath: "/workspace/drawing.excalidraw",
  displayName: "drawing.excalidraw",
  snapshotSavedAt: 1_720_000_000,
  coldFileMtime: 1_719_999_000,
  snapshotNewer: true,
};

describe("RecoveryStartup", () => {
  it("loads a restored snapshot into a dirty document session", async () => {
    const user = userEvent.setup();
    const scene = { type: "excalidraw", version: 2, elements: [] };
    const manager = {
      start: vi.fn(async () => ({
        handshake: {
          contractVersion: 1,
          appVersion: "0.1.0",
          abnormalExit: true,
        },
        candidates: [candidate],
        dialogRequired: true,
      })),
      apply: vi.fn(async () => ({ scene })),
    } as unknown as RecoveryManager;
    const documents = {
      open: vi.fn(async () => "opened"),
      restore: vi.fn(async () => "restored"),
    };

    render(<RecoveryStartup documents={documents} enabled manager={manager} />);
    await user.click(
      await screen.findByRole("button", {
        name: "Restore drawing.excalidraw",
      }),
    );

    expect(manager.apply).toHaveBeenCalledWith({
      documentId: "document-1",
      action: "restore",
    });
    expect(documents.restore).toHaveBeenCalledWith(
      "/workspace/drawing.excalidraw",
      scene,
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("requires a new destination when the cold file is missing", async () => {
    const user = userEvent.setup();
    const missingCandidate = {
      ...candidate,
      originalPath: null,
      coldFileMtime: null,
    };
    const manager = {
      start: vi.fn(async () => ({
        handshake: {
          contractVersion: 1,
          appVersion: "0.1.0",
          abnormalExit: true,
        },
        candidates: [missingCandidate],
        dialogRequired: true,
      })),
      apply: vi.fn(async () => ({
        newPath: "/workspace/recovered.excalidraw",
      })),
    } as unknown as RecoveryManager;
    const documents = {
      open: vi.fn(async () => "opened"),
      restore: vi.fn(async () => "restored"),
    };

    render(
      <RecoveryStartup
        documents={documents}
        enabled
        manager={manager}
        requestSaveAsPath={async () => "/workspace/recovered.excalidraw"}
      />,
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Restore drawing.excalidraw",
      }),
    );

    expect(manager.apply).toHaveBeenCalledWith({
      documentId: "document-1",
      action: "saveAsNew",
      saveAsPath: "/workspace/recovered.excalidraw",
    });
    expect(documents.open).toHaveBeenCalledWith(
      "/workspace/recovered.excalidraw",
    );
  });

  it("does not load nullable response fields for keep-disk actions", async () => {
    const user = userEvent.setup();
    const manager = {
      start: vi.fn(async () => ({
        handshake: {
          contractVersion: 1,
          appVersion: "0.1.0",
          abnormalExit: true,
        },
        candidates: [candidate],
        dialogRequired: true,
      })),
      apply: vi.fn(async () => ({ scene: null, newPath: null })),
    } as unknown as RecoveryManager;
    const documents = {
      open: vi.fn(async () => "opened"),
      restore: vi.fn(async () => "restored"),
    };

    render(<RecoveryStartup documents={documents} enabled manager={manager} />);
    await user.click(
      await screen.findByRole("button", {
        name: "Keep disk version for drawing.excalidraw",
      }),
    );

    expect(documents.restore).not.toHaveBeenCalled();
    expect(documents.open).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});
