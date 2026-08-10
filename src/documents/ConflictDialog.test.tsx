import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConflictDialog } from "./ConflictDialog";

function renderDialog(overrides: Partial<Parameters<typeof ConflictDialog>[0]> = {}) {
  const onResolve = vi.fn(async () => undefined);
  const onDismiss = vi.fn();
  render(
    <ConflictDialog
      externalMtime={1_720_000_100}
      localDraftUpdatedAt={1_720_000_050}
      onDismiss={onDismiss}
      onResolve={onResolve}
      path="/workspace/drawing.excalidraw"
      title="drawing.excalidraw"
      {...overrides}
    />,
  );
  return { onResolve, onDismiss };
}

describe("ConflictDialog", () => {
  it("offers the three conflict decisions with an accessible modal name", () => {
    renderDialog();
    expect(
      screen.getByRole("dialog", { name: "File changed on disk" }),
    ).toBeInTheDocument();
    expect(screen.getByText("drawing.excalidraw")).toBeInTheDocument();
    expect(screen.getByText(/External version changed/)).toBeInTheDocument();
    expect(screen.getByText(/Local draft last saved/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Use external version" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Keep local changes" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save local changes as new…" }),
    ).toBeInTheDocument();
  });

  it("focuses the first action and traps Tab focus inside the dialog", async () => {
    const user = userEvent.setup();
    renderDialog();
    const first = screen.getByRole("button", {
      name: "Use external version",
    });
    const last = screen.getByRole("button", {
      name: "Save local changes as new…",
    });
    expect(first).toHaveFocus();

    last.focus();
    await user.tab();
    expect(first).toHaveFocus();

    first.focus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it("dismisses on Escape and resolves the default action on Enter", async () => {
    const user = userEvent.setup();
    const { onResolve, onDismiss } = renderDialog();
    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledOnce();

    const backdrop = document.querySelector(".conflict-dialog-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.keyDown(backdrop!, { key: "Enter" });
    expect(onResolve).toHaveBeenCalledWith("takeExternal");
  });

  it("resolves each decision through the callback", async () => {
    const user = userEvent.setup();
    const { onResolve } = renderDialog();
    await user.click(
      screen.getByRole("button", { name: "Use external version" }),
    );
    expect(onResolve).toHaveBeenCalledWith("takeExternal");

    await user.click(
      screen.getByRole("button", { name: "Keep local changes" }),
    );
    expect(onResolve).toHaveBeenCalledWith("keepLocal");
  });

  it("requests a destination before saving as a new drawing", async () => {
    const user = userEvent.setup();
    const requestSaveAsPath = vi.fn(async () => "/workspace/copy.excalidraw");
    const { onResolve } = renderDialog({ requestSaveAsPath });
    await user.click(
      screen.getByRole("button", { name: "Save local changes as new…" }),
    );
    expect(requestSaveAsPath).toHaveBeenCalledWith("drawing.excalidraw");
    expect(onResolve).toHaveBeenCalledWith(
      "saveAsNew",
      "/workspace/copy.excalidraw",
    );
  });
});
