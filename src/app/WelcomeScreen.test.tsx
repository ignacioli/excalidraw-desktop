import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WelcomeScreen } from "./WelcomeScreen";

const workspaces = Array.from({ length: 6 }, (_, index) => ({
  id: `workspace-${index + 1}`,
  name: `Workspace ${index + 1}`,
  rootPath: `/workspace/${index + 1}`,
  createdAt: index + 1,
}));

describe("WelcomeScreen", () => {
  it("shows Welcome actions and no fabricated Recent Workspace", () => {
    render(
      <WelcomeScreen
        workspaces={[]}
        onNewDrawing={vi.fn()}
        onOpenRecentWorkspace={vi.fn()}
        onOpenWorkspace={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Draw locally. Keep every workspace close.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New Drawing" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Workspace" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Recent Workspaces")).not.toBeInTheDocument();
  });

  it("delegates New Drawing without opening a workspace or persistence UI", async () => {
    const user = userEvent.setup();
    const onNewDrawing = vi.fn();
    const onOpenWorkspace = vi.fn();
    render(
      <WelcomeScreen
        workspaces={[]}
        onNewDrawing={onNewDrawing}
        onOpenRecentWorkspace={vi.fn()}
        onOpenWorkspace={onOpenWorkspace}
      />,
    );

    await user.click(screen.getByRole("button", { name: "New Drawing" }));
    expect(onNewDrawing).toHaveBeenCalledOnce();
    expect(onOpenWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps Welcome unchanged when Open Workspace is cancelled", async () => {
    const user = userEvent.setup();
    const onOpenWorkspace = vi.fn(async () => undefined);
    render(
      <WelcomeScreen
        workspaces={workspaces}
        onNewDrawing={vi.fn()}
        onOpenRecentWorkspace={vi.fn()}
        onOpenWorkspace={onOpenWorkspace}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open Workspace" }));

    expect(onOpenWorkspace).toHaveBeenCalledOnce();
    expect(
      screen.getAllByRole("button", { name: /Open workspace/ }),
    ).toHaveLength(6);
    expect(screen.getByTestId("welcome-screen")).toBeInTheDocument();
  });

  it("sorts and retains every Recent Workspace while exposing approved fields only", async () => {
    const user = userEvent.setup();
    const onOpenRecentWorkspace = vi.fn();
    render(
      <WelcomeScreen
        workspaces={workspaces}
        onNewDrawing={vi.fn()}
        onOpenRecentWorkspace={onOpenRecentWorkspace}
        onOpenWorkspace={vi.fn()}
      />,
    );

    const rows = screen.getAllByRole("button", { name: /Open workspace/ });
    expect(rows).toHaveLength(6);
    expect(rows[0]).toHaveTextContent("Workspace 6");
    expect(rows[0]).toHaveTextContent("/workspace/6");
    expect(rows[0]).not.toHaveTextContent("drawings");
    expect(rows[0]).not.toHaveTextContent("opened");
    expect(screen.getByRole("list", { name: "Recent Workspaces" })).toHaveClass(
      "recent-workspace-list",
    );
    await user.click(rows[0]);
    expect(onOpenRecentWorkspace).toHaveBeenCalledWith(workspaces[5]);
  });

  it("preserves an inaccessible Recent row while presenting its readable error", async () => {
    const user = userEvent.setup();
    const onOpenRecentWorkspace = vi.fn();
    render(
      <WelcomeScreen
        error="Workspace is no longer accessible."
        workspaces={[workspaces[0]]}
        onNewDrawing={vi.fn()}
        onOpenRecentWorkspace={onOpenRecentWorkspace}
        onOpenWorkspace={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Open workspace Workspace 1" }),
    );

    expect(onOpenRecentWorkspace).toHaveBeenCalledWith(workspaces[0]);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Workspace is no longer accessible.",
    );
    expect(
      screen.getByRole("button", { name: "Open workspace Workspace 1" }),
    ).toBeInTheDocument();
  });

  it("covers primary, secondary, loading, and disabled Welcome Action variants", () => {
    const { rerender } = render(
      <WelcomeScreen
        busy
        workspaces={[]}
        onNewDrawing={vi.fn()}
        onOpenRecentWorkspace={vi.fn()}
        onOpenWorkspace={vi.fn()}
      />,
    );

    const actions = screen.getByText("New Drawing").closest(".welcome-actions");
    const primary = screen.getByRole("button", { name: "New Drawing" });
    const secondary = screen.getByRole("button", { name: "Open Workspace" });
    expect(actions).toHaveAttribute("aria-busy", "true");
    expect(primary).toHaveClass("welcome-action", "primary-action");
    expect(secondary).toHaveClass("welcome-action");
    expect(secondary).not.toHaveClass("primary-action");
    expect(primary).toBeDisabled();
    expect(secondary).toBeDisabled();
    expect(primary.querySelector("img")).toHaveAttribute("aria-hidden", "true");
    expect(secondary.querySelector("img")).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    rerender(
      <WelcomeScreen
        workspaces={[]}
        onNewDrawing={vi.fn()}
        onOpenRecentWorkspace={vi.fn()}
        onOpenWorkspace={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "New Drawing" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Open Workspace" }),
    ).toBeEnabled();
  });
});
