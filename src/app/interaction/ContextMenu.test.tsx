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

  it("renders a description without adding a menuitem", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    render(
      <ContextMenu
        anchor={{ x: 8, y: 8 }}
        description="Files on disk will not be deleted"
        items={[
          { id: "remove", label: "Remove Workspace", onSelect: vi.fn() },
        ]}
        label="Workspace actions"
        onDismiss={vi.fn()}
        triggerRef={triggerRef}
      />,
    );

    const menu = screen.getByRole("menu");
    expect(menu).toHaveTextContent("Files on disk will not be deleted");
    expect(menu).toHaveAttribute("aria-describedby");
    expect(screen.getByRole("note")).toHaveTextContent(
      "Files on disk will not be deleted",
    );
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
  });

  it("clamps and flips the menu inside the viewport", () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    const menuRect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute("role") === "menu") {
          const left = Number.parseFloat(this.style.left || "0");
          const top = Number.parseFloat(this.style.top || "0");
          return {
            x: left,
            y: top,
            width: 160,
            height: 120,
            left,
            top,
            right: left + 160,
            bottom: top + 120,
            toJSON() {
              return {};
            },
          };
        }
        return original.call(this);
      });
    const innerWidth = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const innerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 420,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 260,
    });

    render(
      <ContextMenu
        anchor={{ x: 400, y: 240 }}
        items={[
          { id: "rename", label: "Rename", onSelect: vi.fn() },
          { id: "delete", label: "Delete", onSelect: vi.fn() },
        ]}
        label="Drawing actions"
        onDismiss={vi.fn()}
      />,
    );

    const menu = screen.getByRole("menu");
    expect(Number.parseFloat(menu.style.left)).toBeLessThanOrEqual(260);
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(0);
    expect(Number.parseFloat(menu.style.top)).toBeLessThanOrEqual(140);
    expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(0);
    expect(
      Number.parseFloat(menu.style.left) + 160,
    ).toBeLessThanOrEqual(420);
    expect(
      Number.parseFloat(menu.style.top) + 120,
    ).toBeLessThanOrEqual(260);

    if (innerWidth) Object.defineProperty(window, "innerWidth", innerWidth);
    if (innerHeight) Object.defineProperty(window, "innerHeight", innerHeight);
    menuRect.mockRestore();
  });
});
