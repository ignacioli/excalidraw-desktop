import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeBrowserLocaleController } from "../i18n";
import { CanvasEmptyState } from "./CanvasEmptyState";

const locale = initializeBrowserLocaleController(["en-US"]);
afterEach(() => act(() => locale.setPreference("en")));

function renderEmptyState(
  props: Partial<Parameters<typeof CanvasEmptyState>[0]> = {},
) {
  const onNewDrawing = vi.fn();
  const onShowSidebar = vi.fn();
  const view = render(
    <CanvasEmptyState
      onNewDrawing={onNewDrawing}
      onShowSidebar={onShowSidebar}
      sidebarPinned={false}
      {...props}
    />,
  );
  return { ...view, onNewDrawing, onShowSidebar };
}

describe("CanvasEmptyState", () => {
  it("names the empty canvas area and shows the hint without an editor", () => {
    const { container } = renderEmptyState();
    const region = screen.getByRole("region", { name: "Empty canvas area" });
    expect(
      within(region).getByText("Pick a drawing from the sidebar"),
    ).toBeVisible();
    expect(within(region).getByText("or start a new one")).toBeVisible();
    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector(".excalidraw")).toBeNull();
  });

  it("offers New Drawing and Show Sidebar, in that order, without shortcut hints", () => {
    renderEmptyState();
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "New Drawing",
      "Show Sidebar",
    ]);
    expect(screen.queryByText(/⌘/u)).toBeNull();
  });

  it("runs each action from the keyboard", async () => {
    const user = userEvent.setup();
    const { onNewDrawing, onShowSidebar } = renderEmptyState();
    await user.tab();
    expect(screen.getByRole("button", { name: "New Drawing" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onNewDrawing).toHaveBeenCalledTimes(1);
    await user.tab();
    expect(screen.getByRole("button", { name: "Show Sidebar" })).toHaveFocus();
    await user.keyboard(" ");
    expect(onShowSidebar).toHaveBeenCalledTimes(1);
  });

  it("keeps the pointer to the sidebar decorative", () => {
    const { container } = renderEmptyState();
    const pointer = container.querySelector(".canvas-empty-state__pointer");
    expect(pointer).not.toBeNull();
    expect(pointer).toHaveAttribute("aria-hidden", "true");
    expect(pointer).toHaveTextContent("Your drawings live here");
  });

  it("shows only New Drawing and no pointer when the sidebar is pinned", () => {
    const { container } = renderEmptyState({ sidebarPinned: true });
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "New Drawing" })).toBeVisible();
    expect(container.querySelector(".canvas-empty-state__pointer")).toBeNull();
    expect(screen.queryByText("Your drawings live here")).toBeNull();
  });

  it("disables New Drawing while one is being created", () => {
    renderEmptyState({ busy: true });
    expect(screen.getByRole("button", { name: "New Drawing" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show Sidebar" })).toBeEnabled();
  });

  it("follows a language change", () => {
    renderEmptyState();
    act(() => locale.setPreference("zh-CN"));
    expect(
      screen.getByRole("region", { name: "空白画布区域" }),
    ).toBeInTheDocument();
    expect(screen.getByText("从左侧选择一个绘图")).toBeVisible();
    expect(screen.getByText("或者新建一个，开始画吧")).toBeVisible();
    expect(screen.getByRole("button", { name: "新建绘图" })).toBeVisible();
    expect(screen.getByRole("button", { name: "显示侧边栏" })).toBeVisible();
    expect(screen.queryByText("Pick a drawing from the sidebar")).toBeNull();
  });
});
