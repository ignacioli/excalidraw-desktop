import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApplicationDialog } from "./ApplicationDialog";

describe("ApplicationDialog", () => {
  it("focuses the requested control, traps focus, and dismisses on Escape", async () => {
    const user = userEvent.setup();
    const trigger = document.createElement("button");
    trigger.textContent = "Open rename dialog";
    document.body.append(trigger);
    const initialFocusRef = createRef<HTMLInputElement>();
    const returnFocusRef = { current: trigger };
    const onDismiss = vi.fn();

    const { unmount } = render(
      <ApplicationDialog
        errorMessage="Name already exists"
        initialFocusRef={initialFocusRef}
        onDismiss={onDismiss}
        returnFocusRef={returnFocusRef}
        title="Rename drawing"
      >
        <input ref={initialFocusRef} aria-label="Drawing name" />
        <button type="button">Cancel</button>
        <button type="button">Rename</button>
      </ApplicationDialog>,
    );

    expect(
      screen.getByRole("dialog", { name: "Rename drawing" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Name already exists");
    expect(initialFocusRef.current).toHaveFocus();

    screen.getByRole("button", { name: "Rename" }).focus();
    await user.tab();
    expect(initialFocusRef.current).toHaveFocus();
    initialFocusRef.current?.focus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Rename" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledWith("escape");
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("does not dismiss on Escape while busy", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <ApplicationDialog busy onDismiss={onDismiss} title="Deleting">
        <button disabled type="button">
          Cancel
        </button>
        <button disabled type="button">
          Delete
        </button>
      </ApplicationDialog>,
    );

    await user.keyboard("{Escape}");
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
  });
});
