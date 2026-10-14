import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBrowserLocaleController,
  initializeBrowserLocaleController,
} from "../i18n";
import { zhCN } from "../i18n/messages/zh-CN.ts";
import {
  NestedWorkspaceDialog,
  type NestedWorkspaceDialogProps,
} from "./NestedWorkspaceDialog";

function renderDialog(overrides: Partial<NestedWorkspaceDialogProps> = {}) {
  const props: NestedWorkspaceDialogProps = {
    targetName: "Documents",
    targetPath: "/Users/me/Documents",
    openWorkspaceName: "My Drawings",
    openWorkspacePath: "/Users/me/Documents/My Drawings",
    status: "idle",
    onSwitch: vi.fn(),
    onCloseAndOpen: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<NestedWorkspaceDialog {...props} />) };
}

describe("NestedWorkspaceDialog", () => {
  afterEach(() => {
    initializeBrowserLocaleController(["en"]);
  });

  it("names both folders and focuses Switch to that window", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog", {
      name: "“Documents” contains an open Workspace",
    });
    expect(dialog).toHaveAttribute("data-variant", "sidebar");
    expect(dialog).toHaveAccessibleDescription(
      "“My Drawings” is already open in another window. A Workspace can't be opened inside another one.",
    );
    expect(
      screen.getByText("/Users/me/Documents ⊃ /Users/me/Documents/My Drawings"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Switch to that window" }),
    ).toHaveFocus();
  });

  it("orders the link action first and Switch to that window last", () => {
    renderDialog();

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Close it and open here",
      "Cancel",
      "Switch to that window",
    ]);
    expect(buttons.map((button) => button.dataset.kind)).toEqual([
      "link",
      "secondary",
      "primary",
    ]);
  });

  it("runs each action and cancels on Escape", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();

    await user.click(
      screen.getByRole("button", { name: "Close it and open here" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(
      screen.getByRole("button", { name: "Switch to that window" }),
    );
    await user.keyboard("{Escape}");

    expect(props.onCloseAndOpen).toHaveBeenCalledTimes(1);
    expect(props.onSwitch).toHaveBeenCalledTimes(1);
    expect(props.onCancel).toHaveBeenCalledTimes(2);
  });

  it("disables every action while the other window closes", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({ status: "closing" });

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
    expect(
      screen.getByRole("button", { name: "Closing that window…" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("explains that nothing opened when the other window stayed open", () => {
    renderDialog({ status: "notClosed" });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "“My Drawings” was not closed, so “Documents” was not opened.",
    );
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeEnabled();
    }
  });

  it("shows another failure above the actions", () => {
    renderDialog({ errorMessage: "Could not open the folder." });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not open the folder.",
    );
  });

  it("follows the UI language", () => {
    initializeBrowserLocaleController(["en"]);
    renderDialog();

    act(() => getBrowserLocaleController().setPreference("zh-CN"));

    expect(
      screen.getByRole("dialog", {
        name: "「Documents」包含一个已打开的工作区",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: zhCN["workspace.nested.switch"] }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: zhCN["workspace.nested.closeAndOpen"],
      }),
    ).toBeInTheDocument();
  });
});
