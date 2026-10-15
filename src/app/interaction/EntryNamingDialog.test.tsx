import { render, screen, waitFor } from "@testing-library/react";
import { useRef, useState as useStateForTest } from "react";
import type React from "react";
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
    expect(input).toHaveAccessibleDescription(
      "Fixed extension .excalidraw.json",
    );
    expect(screen.getByText(".excalidraw.json")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
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

  it("uses the sidebar anatomy: name field with a suffix, Cancel then the primary action", () => {
    render(
      <EntryNamingDialog
        mode="newDrawing"
        onCancel={vi.fn()}
        onSubmit={vi.fn(async () => undefined)}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "New drawing" });
    expect(dialog).toHaveAttribute("data-variant", "sidebar");
    const input = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Name",
    });
    expect(input).toHaveValue("Untitled");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Untitled".length);
    expect(input).toHaveAccessibleDescription("Fixed extension .excalidraw");
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Cancel",
      "Create",
    ]);
    expect(buttons[0]).toHaveAttribute("data-kind", "secondary");
    expect(buttons[1]).toHaveAttribute("data-kind", "primary");
  });

  it("folders have no suffix", () => {
    render(
      <EntryNamingDialog
        mode="renameDirectory"
        currentName="plans"
        onCancel={vi.fn()}
        onSubmit={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("plans");
    expect(screen.queryByText(/Fixed extension/u)).toBeNull();
    expect(screen.getByRole("button", { name: "Rename" })).toHaveAttribute(
      "data-kind",
      "primary",
    );
  });

  it("submits with Enter", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => undefined);
    render(
      <EntryNamingDialog
        mode="newDrawing"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    await user.keyboard("Plan{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("Plan");
  });

  it("disables the field and every action while submitting", async () => {
    const user = userEvent.setup();
    const pending = new Promise<void>(() => undefined);
    render(
      <EntryNamingDialog
        mode="newDrawing"
        onCancel={vi.fn()}
        onSubmit={vi.fn(async () => pending)}
      />,
    );
    await user.keyboard("{Enter}");
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("keeps the input and its focus after an error", async () => {
    const user = userEvent.setup();
    render(
      <EntryNamingDialog
        mode="newDrawing"
        onCancel={vi.fn()}
        onSubmit={vi.fn(async () => {
          throw { code: "INVALID_NAME", message: "bad", retriable: false };
        })}
      />,
    );
    await user.keyboard("bad/name{Enter}");
    const input = screen.getByRole("textbox", { name: "Name" });
    const alert = await screen.findByRole("alert");
    expect(input).toHaveValue("bad/name");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(
      expect.stringContaining(alert.textContent ?? ""),
    );
    await waitFor(() => expect(input).toHaveFocus());
  });

  it("returns focus to the control that opened it", async () => {
    const user = userEvent.setup();
    function Harness() {
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button">
            Trigger
          </button>
          <Wrapper triggerRef={triggerRef} />
        </>
      );
    }
    function Wrapper({
      triggerRef,
    }: {
      triggerRef: React.RefObject<HTMLButtonElement | null>;
    }) {
      return (
        <ToggleDialog>
          {(close) => (
            <EntryNamingDialog
              mode="newDirectory"
              onCancel={close}
              onSubmit={vi.fn(async () => undefined)}
              returnFocusRef={triggerRef}
            />
          )}
        </ToggleDialog>
      );
    }
    render(<Harness />);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Trigger" })).toHaveFocus();
  });
});

function ToggleDialog({
  children,
}: {
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useStateForTest(true);
  return open ? <>{children(() => setOpen(false))}</> : null;
}
