import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ApplicationDialog,
  ApplicationDialogActions,
  ApplicationDialogButton,
  ApplicationDialogField,
} from "./ApplicationDialog";
import { middleEllipsis, OBJECT_PATH_MAX_LENGTH } from "./middleEllipsis";

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

  it("does not restore focus when the caller cleared returnFocusRef", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open rename dialog";
    document.body.append(trigger);
    const returnFocusRef: { current: HTMLElement | null } = {
      current: trigger,
    };
    const { unmount } = render(
      <ApplicationDialog
        onDismiss={vi.fn()}
        returnFocusRef={returnFocusRef}
        title="Rename drawing"
      >
        <button type="button">Rename</button>
      </ApplicationDialog>,
    );

    returnFocusRef.current = null;
    unmount();
    expect(trigger).not.toHaveFocus();
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

  it("keeps the default layout when no variant is requested", () => {
    render(
      <ApplicationDialog
        description="Choose a version"
        errorMessage="Could not save"
        onDismiss={vi.fn()}
        title="Conflict"
      >
        <button type="button">Keep mine</button>
      </ApplicationDialog>,
    );

    const dialog = screen.getByRole("dialog", { name: "Conflict" });
    expect(dialog).toHaveClass("application-dialog", "conflict-dialog");
    expect(dialog).not.toHaveClass("application-dialog--sidebar");
    expect(dialog).not.toHaveAttribute("data-variant");
    expect([...dialog.children].map((child) => child.tagName)).toEqual([
      "H2",
      "P",
      "BUTTON",
      "P",
    ]);
    expect(dialog.children[3]).toHaveClass("conflict-dialog-error");
    expect(dialog).toHaveAccessibleDescription(
      "Choose a version Could not save",
    );
  });

  it("orders the sidebar confirmation anatomy and focuses Cancel", async () => {
    const user = userEvent.setup();
    const cancelRef = createRef<HTMLButtonElement>();
    const onDismiss = vi.fn();
    render(
      <ApplicationDialog
        actions={
          <ApplicationDialogActions>
            <ApplicationDialogButton
              buttonRef={cancelRef}
              kind="secondary"
              onClick={() => onDismiss("cancel")}
            >
              Cancel
            </ApplicationDialogButton>
            <ApplicationDialogButton kind="danger">
              Delete
            </ApplicationDialogButton>
          </ApplicationDialogActions>
        }
        description="This drawing will be moved to the Trash."
        errorMessage="Couldn't delete"
        initialFocusRef={cancelRef}
        objectPath="~/Drawings/plan.excalidraw"
        onDismiss={onDismiss}
        title="Delete plan.excalidraw?"
        variant="sidebar"
      >
        {null}
      </ApplicationDialog>,
    );

    const dialog = screen.getByRole("dialog", {
      name: "Delete plan.excalidraw?",
    });
    expect(dialog).toHaveAttribute("data-variant", "sidebar");
    expect(dialog).not.toHaveClass("conflict-dialog");
    expect([...dialog.children].map((child) => child.className)).toEqual([
      "application-dialog-title",
      "application-dialog-description",
      "application-dialog-object-path",
      "application-dialog-error",
      "application-dialog-actions application-dialog-actions--sidebar",
    ]);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't delete");
    expect(screen.getByText("~/Drawings/plan.excalidraw")).toHaveAttribute(
      "title",
      "~/Drawings/plan.excalidraw",
    );
    expect(cancelRef.current).toHaveFocus();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute(
      "data-kind",
      "danger",
    );
    expect(screen.getByRole("button", { name: "Delete" })).toHaveAttribute(
      "type",
      "button",
    );

    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledWith("escape");
  });

  it("places a leading link action before the trailing buttons", () => {
    render(
      <ApplicationDialog
        actions={
          <ApplicationDialogActions
            leading={
              <ApplicationDialogButton kind="link">
                Close it and open here
              </ApplicationDialogButton>
            }
          >
            <ApplicationDialogButton kind="secondary">
              Cancel
            </ApplicationDialogButton>
            <ApplicationDialogButton kind="primary">
              Switch to that window
            </ApplicationDialogButton>
          </ApplicationDialogActions>
        }
        onDismiss={vi.fn()}
        title="Conflict"
        variant="sidebar"
      >
        {null}
      </ApplicationDialog>,
    );

    expect(
      screen
        .getAllByRole("button")
        .map((button) => [
          button.textContent,
          button.getAttribute("data-kind"),
        ]),
    ).toEqual([
      ["Close it and open here", "link"],
      ["Cancel", "secondary"],
      ["Switch to that window", "primary"],
    ]);
  });

  it("renders a labelled name field with a fixed suffix and keeps input on error", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ApplicationDialog
        onDismiss={vi.fn()}
        title="New drawing"
        variant="sidebar"
      >
        <ApplicationDialogField
          errorMessage="A drawing with this name already exists"
          label="Name"
          onChange={onChange}
          suffix=".excalidraw"
          value="plan"
        />
      </ApplicationDialog>,
    );

    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input).toHaveValue("plan");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(
      ".excalidraw A drawing with this name already exists",
    );
    expect(screen.getByRole("alert")).toHaveClass(
      "application-dialog-field-error",
    );
    expect(input).toHaveFocus();

    await user.type(input, "s");
    expect(onChange).toHaveBeenLastCalledWith("plans");
  });

  it("disables the field while busy", () => {
    render(
      <ApplicationDialogField
        disabled
        label="Name"
        onChange={vi.fn()}
        value="plan"
      />,
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
  });

  it("shortens long object paths in the middle", () => {
    const short = "~/Drawings/plan.excalidraw";
    expect(middleEllipsis(short)).toBe(short);
    const long = `~/${"文件夹/".repeat(20)}plan.excalidraw`;
    const shortened = middleEllipsis(long);
    expect([...shortened]).toHaveLength(OBJECT_PATH_MAX_LENGTH);
    expect(shortened.startsWith("~/文件夹")).toBe(true);
    expect(shortened.endsWith("plan.excalidraw")).toBe(true);
    expect(shortened).toContain("…");
  });
});
