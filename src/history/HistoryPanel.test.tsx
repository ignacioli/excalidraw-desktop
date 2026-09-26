import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HistoryPanel } from "./HistoryPanel";
import type { HistoryVersionView } from "./HistoryList";

function makeItem(
  overrides: Partial<HistoryVersionView> = {},
): HistoryVersionView {
  return {
    versionId: "version-1",
    source: "automatic",
    recordedAt: Date.UTC(2026, 8, 23, 12, 34),
    sequence: 1,
    contentHash: "hash-1",
    availability: { status: "available" },
    summary: "Two shapes added",
    ...overrides,
  };
}

describe("HistoryPanel", () => {
  it("composes the drawer header, list actions, and an available state", () => {
    const onClose = vi.fn();
    const onRestore = vi.fn();
    render(
      <HistoryPanel
        currentVersionId="version-1"
        fileName="planning.excalidraw"
        items={[makeItem()]}
        onClose={onClose}
        onRestore={onRestore}
      />,
    );

    expect(
      screen.getByRole("complementary", { name: "Version History" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Version History" }),
    ).toBeInTheDocument();
    expect(screen.getByText("planning.excalidraw")).toBeInTheDocument();
    expect(
      screen.getByText(/newest 20 entries.*do not expire by age/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Restore this version" }),
    ).toBeEnabled();
  });

  it("fails closed when the caller cannot provide a rendered preview", () => {
    render(
      <HistoryPanel
        fileName="planning.excalidraw"
        items={[makeItem()]}
        onClose={vi.fn()}
        onRestore={vi.fn()}
        restoreEnabled={false}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Restore this version" }),
    ).toBeDisabled();
  });

  it.each([
    ["loading", "Loading version history"],
    ["empty", "No saved versions"],
    ["processing", "Updating version history"],
    ["permissionDenied", "Version history access denied"],
    ["conflict", "Version history conflict"],
    ["resourceUnavailable", "Version resource unavailable"],
    ["error", "Version history could not be loaded"],
  ] as const)("renders the %s panel state", (status, title) => {
    render(
      <HistoryPanel
        fileName="drawing.excalidraw"
        onClose={vi.fn()}
        status={status}
      />,
    );
    expect(
      screen.getByRole(
        status === "loading" || status === "empty" || status === "processing"
          ? "status"
          : "alert",
      ),
    ).toHaveTextContent(title);
  });

  it("keeps preview separate and returns Escape focus to the triggering row", async () => {
    const user = userEvent.setup();
    const trigger = document.createElement("button");
    trigger.textContent = "Open history";
    document.body.append(trigger);
    const onClose = vi.fn();
    const onExitPreview = vi.fn();
    render(
      <HistoryPanel
        currentVersionId="version-1"
        fileName="drawing.excalidraw"
        items={[makeItem()]}
        onClose={onClose}
        onExitPreview={onExitPreview}
        triggerRef={{ current: trigger }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(screen.getByText("Preview — read only")).toBeInTheDocument();
    expect(
      screen.getByText("The current drawing remains separate and unchanged."),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onExitPreview).toHaveBeenCalledOnce();
    expect(screen.getByRole("option")).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
    trigger.remove();
  });

  it("returns drawer Escape to the trigger and disables actions for unavailable or processing items", async () => {
    const user = userEvent.setup();
    const trigger = createRef<HTMLButtonElement>();
    const onClose = vi.fn();
    render(
      <>
        <button ref={trigger} type="button">
          Open history
        </button>
        <HistoryPanel
          fileName="drawing.excalidraw"
          items={[
            makeItem({
              availability: {
                status: "unavailable",
                error: {
                  code: "HISTORY_RESOURCE_MISSING",
                  message: "Missing resource",
                  retriable: false,
                },
              },
            }),
          ]}
          onClose={onClose}
          processing
          triggerRef={trigger}
        />
      </>,
    );

    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Restore this version" }),
    ).toBeDisabled();
    screen.getByRole("option").focus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(trigger.current).toHaveFocus();
  });

  it("shows durable mark feedback inline without opening a named dialog", async () => {
    const user = userEvent.setup();
    const onMark = vi.fn(async () => undefined);
    render(
      <HistoryPanel
        fileName="drawing.excalidraw"
        items={[makeItem()]}
        onClose={vi.fn()}
        onMark={onMark}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Mark current version" }),
    );

    expect(onMark).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Version marked and saved to history.",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not report success before the durable mark callback resolves", async () => {
    const user = userEvent.setup();
    let resolveMark: (() => void) | undefined;
    const onMark = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveMark = resolve;
        }),
    );
    render(
      <HistoryPanel
        fileName="drawing.excalidraw"
        onClose={vi.fn()}
        onMark={onMark}
      />,
    );
    const markButton = screen.getByRole("button", {
      name: "Mark current version",
    });

    await user.click(markButton);

    expect(markButton).toBeDisabled();
    expect(
      screen.queryByText("Version marked and saved to history."),
    ).not.toBeInTheDocument();
    resolveMark?.();
    await vi.waitFor(() => {
      expect(
        screen.getByText("Version marked and saved to history."),
      ).toBeInTheDocument();
    });
    expect(markButton).toBeEnabled();
  });

  it("keeps the panel usable and reports a failed mark inline", async () => {
    const user = userEvent.setup();
    const onMark = vi.fn(async () => {
      throw new Error("History is unavailable.");
    });
    render(
      <HistoryPanel
        fileName="drawing.excalidraw"
        onClose={vi.fn()}
        onMark={onMark}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Mark current version" }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "History is unavailable.",
    );
    expect(
      screen.getByRole("button", { name: "Mark current version" }),
    ).toBeEnabled();
  });

  it("deletes only the selected version after the durable callback resolves", async () => {
    const user = userEvent.setup();
    let resolveDelete: (() => void) | undefined;
    const onDelete = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    render(
      <HistoryPanel
        fileName="drawing.excalidraw"
        items={[makeItem()]}
        onClose={vi.fn()}
        onDelete={onDelete}
      />,
    );

    const deleteButton = screen.getByRole("button", {
      name: "Delete this version",
    });
    await user.click(deleteButton);
    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        versionId: "version-1",
      }),
    );
    expect(deleteButton).toBeDisabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    resolveDelete?.();
    await vi.waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Version deleted from history.",
      );
    });
  });

  it("reports a failed deletion without changing the selection", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => {
      throw new Error("Version is in use.");
    });
    render(
      <HistoryPanel
        fileName="drawing.excalidraw"
        items={[makeItem()]}
        onClose={vi.fn()}
        onDelete={onDelete}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Delete this version" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Version is in use.");
    expect(screen.getByRole("option")).toHaveAttribute("aria-selected", "true");
  });

  it("keeps an unavailable version from blocking deletion of another selected version", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => undefined);
    render(
      <HistoryPanel
        fileName="drawing.excalidraw"
        items={[
          makeItem({
            versionId: "unavailable-version",
            availability: {
              status: "unavailable",
              error: {
                code: "HISTORY_RESOURCE_MISSING",
                message: "Missing scene object",
                retriable: false,
              },
            },
          }),
          makeItem({ versionId: "available-version", sequence: 2 }),
        ]}
        onClose={vi.fn()}
        onDelete={onDelete}
      />,
    );

    const deleteButton = screen.getByRole("button", {
      name: "Delete this version",
    });
    expect(deleteButton).toBeEnabled();
    await user.click(deleteButton);
    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: "unavailable-version" }),
    );
    const options = screen.getAllByRole("option");
    await user.click(options[1]);
    expect(deleteButton).toBeEnabled();
    await user.click(deleteButton);
    expect(onDelete).toHaveBeenLastCalledWith(
      expect.objectContaining({ versionId: "available-version" }),
    );
  });
});
