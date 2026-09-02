import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WelcomeScreen } from "./WelcomeScreen";

const workspaces = [
  {
    id: "old",
    name: "Older",
    rootPath: "/workspace/older",
    createdAt: 1,
  },
  {
    id: "new",
    name: "Newer",
    rootPath: "/workspace/newer",
    createdAt: 2,
  },
];

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
      screen.getByRole("heading", { name: "Welcome" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New Drawing" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Workspace" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Recent Workspaces")).not.toBeInTheDocument();
  });

  it("invokes actions without making cancellation a mutation", async () => {
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

    await user.click(screen.getByRole("button", { name: "Open Workspace" }));
    expect(onOpenWorkspace).toHaveBeenCalledOnce();
    expect(onNewDrawing).not.toHaveBeenCalled();
  });

  it("sorts Recent Workspaces by createdAt and exposes only name and path", async () => {
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
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Newer");
    expect(rows[0]).toHaveTextContent("/workspace/newer");
    expect(rows[0]).not.toHaveTextContent("drawings");
    await user.click(rows[0]);
    expect(onOpenRecentWorkspace).toHaveBeenCalledWith(workspaces[1]);
  });
});
