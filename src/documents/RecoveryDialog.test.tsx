import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { RecoveryDialog } from "./RecoveryDialog";

const recoveryCandidate = {
  documentId: "document-1",
  originalPath: "/workspace/drawing.excalidraw",
  displayName: "drawing.excalidraw",
  snapshotSavedAt: 1_720_000_000,
  coldFileMtime: 1_719_999_000,
  snapshotNewer: true,
};

describe("RecoveryDialog", () => {
  it("offers all four recovery decisions with an accessible modal name", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn(async () => ({
      scene: undefined,
      newPath: undefined,
    }));
    render(
      <RecoveryDialog
        candidates={[recoveryCandidate]}
        onApply={onApply}
        requestSaveAsPath={async () => "/workspace/recovered.excalidraw"}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Recover unsaved drawings" }),
    ).toBeInTheDocument();
    expect(screen.getByText("drawing.excalidraw")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Restore drawing.excalidraw" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Keep disk version for drawing.excalidraw",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save drawing.excalidraw as new" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Discard recovery for drawing.excalidraw",
      }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Restore drawing.excalidraw" }),
    );
    expect(onApply).toHaveBeenCalledWith({
      documentId: "document-1",
      action: "restore",
    });
  });

  it("closes on Escape and traps Tab focus inside the dialog", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <RecoveryDialog
        candidates={[recoveryCandidate]}
        onApply={vi.fn(async () => ({ scene: undefined, newPath: undefined }))}
        onCancel={onCancel}
      />,
    );
    const restore = screen.getByRole("button", {
      name: "Restore drawing.excalidraw",
    });
    const discard = screen.getByRole("button", {
      name: "Discard recovery for drawing.excalidraw",
    });
    expect(restore).toHaveFocus();

    discard.focus();
    await user.tab();
    expect(restore).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
