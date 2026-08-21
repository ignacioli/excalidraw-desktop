import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  DirectoryNotEmptyDialog,
  EntryDeleteConfirmationDialog,
} from "./EntryDeleteDialogs";

describe("Entry delete dialogs", () => {
  it("initially focuses Cancel and requires explicit delete confirmation", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(
      <EntryDeleteConfirmationDialog
        displayName="drawing"
        onCancel={vi.fn()}
        onDelete={onDelete}
      />,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(screen.getByText(/operating-system Trash/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("blocks a non-empty folder and reveals only after explicit action", async () => {
    const user = userEvent.setup();
    const onReveal = vi.fn();
    render(<DirectoryNotEmptyDialog onCancel={vi.fn()} onReveal={onReveal} />);
    expect(
      screen.getByRole("dialog", { name: "Folder isn’t empty" }),
    ).toBeInTheDocument();
    expect(onReveal).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Open in Finder" }));
    expect(onReveal).toHaveBeenCalledOnce();
  });

  it("keeps confirmation open on Escape while delete is busy", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <EntryDeleteConfirmationDialog
        busy
        displayName="drawing"
        onCancel={onCancel}
        onDelete={vi.fn()}
      />,
    );
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("shows a Finder reveal failure inside the non-empty folder dialog", () => {
    render(
      <DirectoryNotEmptyDialog
        errorMessage="Finder could not open this folder."
        onCancel={vi.fn()}
        onReveal={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Finder could not open this folder.",
    );
  });
});
