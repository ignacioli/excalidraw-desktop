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
    expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Restore this version" }),
    ).toBeEnabled();
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
});
