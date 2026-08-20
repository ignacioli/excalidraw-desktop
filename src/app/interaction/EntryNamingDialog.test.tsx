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
});
