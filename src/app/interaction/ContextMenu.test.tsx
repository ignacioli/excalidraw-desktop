import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";

describe("ContextMenu", () => {
  it("supports initial focus, menu keys, selection, Escape, and focus return", async () => {
    const user = userEvent.setup();
    const triggerRef = createRef<HTMLButtonElement>();
    const onDismiss = vi.fn();
    const onRename = vi.fn();
    const { rerender } = render(
      <>
        <button ref={triggerRef} type="button">
          Drawing actions
        </button>
        <ContextMenu
          anchor={{ x: 40, y: 50 }}
          items={[
            { id: "rename", label: "Rename", onSelect: onRename },
            { id: "delete", label: "Delete", onSelect: vi.fn() },
          ]}
          label="Drawing actions"
          onDismiss={onDismiss}
          triggerRef={triggerRef}
        />
      </>,
    );

    const rename = screen.getByRole("menuitem", { name: "Rename" });
    const deleteItem = screen.getByRole("menuitem", { name: "Delete" });
    expect(rename).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(deleteItem).toHaveFocus();
    await user.keyboard("{Home}");
    expect(rename).toHaveFocus();
    await user.keyboard("{End}");
    expect(deleteItem).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onDismiss).toHaveBeenCalledWith("escape");

    rerender(
      <button ref={triggerRef} type="button">
        Drawing actions
      </button>,
    );
    expect(triggerRef.current).toHaveFocus();
  });
});
