import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RecoveryManager } from "./recoveryManager";
import { RecoveryNotice, RecoveryStartup } from "./RecoveryStartup";

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
  it("shows an accurate ephemeral Recovered count", () => {
    vi.useFakeTimers();
    const view = render(<RecoveryNotice count={2} durationMs={5_000} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Recovered · 2 drawings restored",
    );

    view.rerender(<RecoveryNotice count={1} durationMs={5_000} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Recovered · 1 drawing restored",
    );
    act(() => vi.advanceTimersByTime(4_999));
    expect(screen.getByRole("status")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("routes a clean startup directly to ready without a recovery dialog", async () => {
    const states: Array<{ status: string; recoveredCount: number }> = [];
    const manager = {
      start: vi.fn(async () => ({
        handshake: {
          contractVersion: 2,
          appVersion: "0.1.0",
          abnormalExit: false,
          pendingOpenPaths: [],
        },
        candidates: [],
        dialogRequired: false,
      })),
      apply: vi.fn(),
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
        onStateChange={({ status, recoveredCount }) =>
          states.push({ status, recoveredCount })
        }
      />,
    );

    await waitFor(() => expect(states.at(-1)?.status).toBe("ready"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(manager.apply).not.toHaveBeenCalled();
    expect(documents.open).not.toHaveBeenCalled();
    expect(documents.restore).not.toHaveBeenCalled();
  });

  it("performs zero document mutation before an abnormal-exit decision", async () => {
    const manager = {
      start: vi.fn(async () => ({
        handshake: {
          contractVersion: 2,
          appVersion: "0.1.0",
          abnormalExit: true,
          pendingOpenPaths: [],
        },
        candidates: [candidate],
        dialogRequired: true,
      })),
      apply: vi.fn(),
    } as unknown as RecoveryManager;
    const documents = {
      open: vi.fn(async () => "opened"),
      restore: vi.fn(async () => "restored"),
    };

    render(<RecoveryStartup documents={documents} enabled manager={manager} />);

    expect(
      await screen.findByRole("dialog", { name: "Recover unsaved drawings" }),
    ).toBeInTheDocument();
    expect(manager.apply).not.toHaveBeenCalled();
    expect(documents.open).not.toHaveBeenCalled();
    expect(documents.restore).not.toHaveBeenCalled();
  });

  it("counts only restored and saved-as-new documents after all decisions", async () => {
    const user = userEvent.setup();
    const candidates = [
      { ...candidate, documentId: "restore", displayName: "restore.excalidraw" },
      { ...candidate, documentId: "keep", displayName: "keep.excalidraw" },
      { ...candidate, documentId: "save", displayName: "save.excalidraw" },
      { ...candidate, documentId: "discard", displayName: "discard.excalidraw" },
    ];
    const manager = {
      start: vi.fn(async () => ({
        handshake: {
          contractVersion: 2,
          appVersion: "0.1.0",
          abnormalExit: true,
          pendingOpenPaths: [],
        },
        candidates,
        dialogRequired: true,
      })),
      apply: vi.fn(async (decision: { action: string }) => {
        if (decision.action === "restore") {
          return { scene: { type: "excalidraw", version: 2, elements: [] } };
        }
        if (decision.action === "saveAsNew") {
          return { newPath: "/workspace/saved-as-new.excalidraw" };
        }
        return { scene: null, newPath: null };
      }),
    } as unknown as RecoveryManager;
    const documents = {
      open: vi.fn(async () => "opened"),
      restore: vi.fn(async () => "restored"),
    };
    const states: Array<{ status: string; recoveredCount: number }> = [];

    render(
      <RecoveryStartup
        documents={documents}
        enabled
        manager={manager}
        onStateChange={({ status, recoveredCount }) =>
          states.push({ status, recoveredCount })
        }
        requestSaveAsPath={async () => "/workspace/saved-as-new.excalidraw"}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Restore restore.excalidraw" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Keep disk version for keep.excalidraw",
      }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Save save.excalidraw as new" }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Discard recovery for discard.excalidraw",
      }),
    );

    await waitFor(() =>
      expect(states.at(-1)).toEqual({ status: "ready", recoveredCount: 2 }),
    );
    expect(documents.restore).toHaveBeenCalledOnce();
    expect(documents.open).toHaveBeenCalledOnce();
  });

  it("loads a restored snapshot into a dirty document session", async () => {
    const user = userEvent.setup();
    const scene = { type: "excalidraw", version: 2, elements: [] };
    const manager = {
      start: vi.fn(async () => ({
        handshake: {
          contractVersion: 2,
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
          contractVersion: 2,
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
          contractVersion: 2,
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

  it("reports the recovery dialog before decisions and ready after the candidate resolves", async () => {
    const user = userEvent.setup();
    const states: string[] = [];
    const manager = {
      start: vi.fn(async () => ({
        handshake: {
          contractVersion: 2,
          appVersion: "0.1.0",
          abnormalExit: true,
          pendingOpenPaths: [],
        },
        candidates: [candidate],
        dialogRequired: true,
      })),
      apply: vi.fn(async () => ({ scene: null, newPath: null })),
    } as unknown as RecoveryManager;

    render(
      <RecoveryStartup
        enabled
        manager={manager}
        onStateChange={(state) => states.push(state.status)}
      />,
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Keep disk version for drawing.excalidraw",
      }),
    );

    await waitFor(() => expect(states.at(-1)).toBe("ready"));
    expect(states).toContain("dialog");
  });

  it("keeps normal startup blocked when recovery inspection fails", async () => {
    const states: string[] = [];
    const manager = {
      start: vi.fn(async () => {
        throw new Error("Recovery service unavailable");
      }),
    } as unknown as RecoveryManager;

    render(
      <RecoveryStartup
        enabled
        manager={manager}
        onStateChange={(state) => states.push(state.status)}
      />,
    );

    await waitFor(() => expect(states.at(-1)).toBe("error"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Recovery service unavailable",
    );
  });

  it("does not dismiss unresolved recovery candidates on Escape", async () => {
    const user = userEvent.setup();
    const manager = {
      start: vi.fn(async () => ({
        handshake: {
          contractVersion: 2,
          appVersion: "0.1.0",
          abnormalExit: true,
        },
        candidates: [candidate],
        dialogRequired: true,
      })),
    } as unknown as RecoveryManager;

    render(<RecoveryStartup enabled manager={manager} />);
    const dialog = await screen.findByRole("dialog", {
      name: "Recover unsaved drawings",
    });
    await user.keyboard("{Escape}");

    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Resolve recovery candidates before continuing.",
    );
  });
});
