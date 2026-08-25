import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EntryNamingDialog } from "./EntryNamingDialog";

describe("EntryNamingDialog", () => {
  it("selects the Drawing basename and presents a fixed extension", () => {
    render(
      <EntryNamingDialog
        mode="renameDrawing"
        currentName="plan.excalidraw.json"
        onCancel={vi.fn()}
        onSubmit={vi.fn(async () => undefined)}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toHaveValue("plan");
    expect(input).toHaveFocus();
    expect(
      screen.getByLabelText("Fixed extension .excalidraw.json"),
    ).toBeInTheDocument();
  });

  it("keeps conflict errors inline and preserves the entered value", async () => {
    const user = userEvent.setup();
    render(
      <EntryNamingDialog
        mode="newDrawing"
        onCancel={vi.fn()}
        onSubmit={vi.fn(async () => {
          throw {
            code: "NAME_CONFLICT",
            message: "conflict",
            retriable: false,
          };
        })}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    await user.clear(input);
    await user.type(input, "Taken");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already exists",
    );
    expect(input).toHaveValue("Taken");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("announces permission-denied create failures without closing", async () => {
    const user = userEvent.setup();
    render(
      <EntryNamingDialog
        mode="newDrawing"
        onCancel={vi.fn()}
        onSubmit={vi.fn(async () => {
          throw {
            code: "PATH_ACCESS_DENIED",
            message: "escaped",
            retriable: false,
          };
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "outside the Workspace",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("cancels without submitting", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <EntryNamingDialog
        mode="newDirectory"
        onCancel={onCancel}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.getByRole("textbox")).toHaveValue("Untitled Folder");
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the dialog open when submit rejects with a null reason", async () => {
    const user = userEvent.setup();
    render(
      <EntryNamingDialog
        mode="newDrawing"
        onCancel={vi.fn()}
        onSubmit={vi.fn(async () => {
          throw null;
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be saved",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not cancel while a submit is in flight", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    let finish: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    render(
      <EntryNamingDialog
        mode="newDrawing"
        onCancel={onCancel}
        onSubmit={vi.fn(async () => pending)}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
    finish();
  });
});
