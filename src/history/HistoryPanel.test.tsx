import { createRef } from "react";
import { render, screen, within } from "@testing-library/react";
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
    recordedAt: Date.UTC(2026, 8, 23, 12, 34) / 1000,
    sequence: 1,
    contentHash: "hash-1",
    availability: { status: "available" },
    marked: false,
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

  it.each(["selected action", "preview"] as const)(
    "%s Restore requires confirmation, and cancel or Escape never calls restore",
    async (entryPoint) => {
      const user = userEvent.setup();
      const onRestore = vi.fn();
      render(
        <HistoryPanel
          documentId="document-a"
          fileName="drawing.excalidraw"
          items={[makeItem()]}
          onClose={vi.fn()}
          onRestore={onRestore}
        />,
      );

      if (entryPoint === "preview") {
        await user.click(screen.getByRole("button", { name: "Preview" }));
      }
      await user.click(
        screen.getByRole("button", { name: "Restore this version" }),
      );

      const dialog = screen.getByRole("dialog", {
        name: "Restore this version?",
      });
      expect(dialog).toHaveTextContent("Target: v-001 · Two shapes added");
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
      expect(onRestore).not.toHaveBeenCalled();

      if (entryPoint === "preview") {
        await user.keyboard("{Escape}");
      } else {
        await user.click(screen.getByRole("button", { name: "Cancel" }));
      }
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Restore this version" }),
      ).toHaveFocus();
      expect(onRestore).not.toHaveBeenCalled();
    },
  );

  it("keeps the confirmed Restore bound to its original document and version", async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn(async () => undefined);
    const first = makeItem();
    const second = makeItem({
      versionId: "version-2",
      sequence: 2,
      summary: "A later change",
    });
    const { rerender } = render(
      <HistoryPanel
        documentId="document-a"
        fileName="drawing.excalidraw"
        items={[first, second]}
        onClose={vi.fn()}
        onRestore={onRestore}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    await user.click(screen.getByRole("option", { name: /A later change/ }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Target: v-001 · Two shapes added",
    );
    await user.click(screen.getByRole("button", { name: "Restore version" }));
    expect(onRestore).toHaveBeenCalledExactlyOnceWith(first);

    rerender(
      <HistoryPanel
        documentId="document-a"
        fileName="drawing.excalidraw"
        items={[second]}
        onClose={vi.fn()}
        onRestore={onRestore}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onRestore).toHaveBeenCalledExactlyOnceWith(first);
  });

  it("blocks a pending confirmation if its document changes", async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    const item = makeItem();
    const { rerender } = render(
      <HistoryPanel
        documentId="document-a"
        fileName="drawing.excalidraw"
        items={[item]}
        onClose={vi.fn()}
        onRestore={onRestore}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    rerender(
      <HistoryPanel
        documentId="document-b"
        fileName="other.excalidraw"
        items={[item]}
        onClose={vi.fn()}
        onRestore={onRestore}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "loading"] as const)(
    "keeps an invalidated Restore confirmation blocked after %s",
    async (invalidatedBy) => {
      const user = userEvent.setup();
      const onRestore = vi.fn();
      const available = makeItem();
      const { rerender } = render(
        <HistoryPanel
          documentId="document-a"
          fileName="drawing.excalidraw"
          items={[available]}
          onClose={vi.fn()}
          onRestore={onRestore}
        />,
      );

      await user.click(
        screen.getByRole("button", { name: "Restore this version" }),
      );
      rerender(
        <HistoryPanel
          documentId="document-a"
          fileName="drawing.excalidraw"
          items={
            invalidatedBy === "unavailable"
              ? [
                  makeItem({
                    availability: {
                      status: "unavailable",
                      error: {
                        code: "HISTORY_RESOURCE_MISSING",
                        message: "The stored resource is missing.",
                        retriable: false,
                      },
                    },
                  }),
                ]
              : [available]
          }
          onClose={vi.fn()}
          onRestore={onRestore}
          status={invalidatedBy === "loading" ? "loading" : "available"}
        />,
      );

      const dialog = screen.getByRole("dialog", {
        name: "Restore this version?",
      });
      expect(within(dialog).getByRole("alert")).toHaveTextContent(
        invalidatedBy === "loading"
          ? "Version history is changing"
          : "This version is no longer available",
      );
      expect(
        within(dialog).getByRole("button", { name: "Restore version" }),
      ).toBeDisabled();
      expect(
        within(dialog).getByRole("button", { name: "Cancel" }),
      ).toBeEnabled();

      if (invalidatedBy === "loading") {
        rerender(
          <HistoryPanel
            documentId="document-a"
            fileName="drawing.excalidraw"
            items={[available]}
            onClose={vi.fn()}
            onRestore={onRestore}
            status="available"
          />,
        );
        expect(screen.getByRole("dialog")).toBe(dialog);
        expect(
          within(dialog).getByRole("button", { name: "Restore version" }),
        ).toBeEnabled();
      }
      expect(onRestore).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

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

  it("moves focus into More version actions and returns it on Escape", async () => {
    const user = userEvent.setup();
    render(
      <HistoryPanel
        fileName="drawing.excalidraw"
        items={[makeItem()]}
        onClose={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: /More actions for v-001/,
    });
    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Delete version" }),
    ).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("marks and unmarks the selected version through caller-owned persistence", async () => {
    const user = userEvent.setup();
    const onSetMarked = vi.fn(async () => undefined);
    const item = makeItem();
    const { rerender } = render(
      <HistoryPanel
        fileName="drawing.excalidraw"
        items={[item]}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onSetMarked={onSetMarked}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /More actions for v-001/ }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Mark version" }));
    await vi.waitFor(() =>
      expect(onSetMarked).toHaveBeenCalledWith(item, true),
    );

    onSetMarked.mockClear();
    rerender(
      <HistoryPanel
        fileName="drawing.excalidraw"
        items={[{ ...item, marked: true }]}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onSetMarked={onSetMarked}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /More actions for v-001/ }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Unmark version" }));
    await vi.waitFor(() =>
      expect(onSetMarked).toHaveBeenCalledWith(
        { ...item, marked: true },
        false,
      ),
    );
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

  it("announces when a saved current mark reuses an existing version and stays quiet on cancellation", async () => {
    const user = userEvent.setup();
    const onMark = vi
      .fn<() => Promise<{ versionId: string; reused: boolean } | null>>()
      .mockResolvedValueOnce({ versionId: "existing-mark", reused: true })
      .mockResolvedValueOnce(null);
    const { rerender } = render(
      <HistoryPanel
        fileName="drawing.excalidraw"
        onClose={vi.fn()}
        onMark={onMark}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Mark current version" }),
    );
    expect(
      screen.getByText("Already marked. Selected the existing version."),
    ).toBeInTheDocument();

    rerender(
      <HistoryPanel
        fileName="drawing.excalidraw"
        onClose={vi.fn()}
        onMark={onMark}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Mark current version" }),
    );
    expect(
      screen.queryByText("Already marked. Selected the existing version."),
    ).not.toBeInTheDocument();
  });

  it("explains when unmarking lets the retention policy remove the version", async () => {
    const user = userEvent.setup();
    render(
      <HistoryPanel
        fileName="drawing.excalidraw"
        items={[makeItem({ marked: true })]}
        onClose={vi.fn()}
        onSetMarked={vi.fn(async () => ({
          versionId: "version-1",
          marked: false,
          retained: false,
        }))}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /More actions for v-001/ }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Unmark version" }));
    expect(
      await screen.findByText(/removed by the retention policy/),
    ).toBeInTheDocument();
  });

  it("keeps the selected target and per-row menu usable in a 50-version list", async () => {
    const user = userEvent.setup();
    const items = Array.from({ length: 50 }, (_, index) =>
      makeItem({
        versionId: "version-" + (index + 1),
        sequence: index + 1,
        summary: "Canvas change " + (index + 1),
      }),
    );
    render(
      <HistoryPanel
        fileName="drawing.excalidraw"
        items={items}
        onClose={vi.fn()}
        onSetMarked={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getAllByRole("option")).toHaveLength(50);
    screen.getAllByRole("option")[0]?.focus();
    await user.keyboard("{End}");
    const lastRow = screen.getAllByRole("option")[49];
    expect(lastRow).toHaveFocus();
    expect(lastRow).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("region", { name: "Selected version actions" }),
    ).toHaveTextContent("v-050 · Canvas change 50");
    const details = within(
      screen.getByRole("region", { name: "Selected version actions" }),
    );
    expect(details.getByRole("time")).toHaveAttribute(
      "dateTime",
      new Date(items[49]!.recordedAt * 1000).toISOString(),
    );
    expect(details.getByText(/Automatic/)).toBeInTheDocument();

    await user.click(
      screen.getAllByRole("button", { name: /More actions for/ })[49]!,
    );
    expect(screen.getByRole("menu")).toHaveTextContent(
      "v-050 · Canvas change 50",
    );
    await user.keyboard("{Escape}");
    expect(
      screen.getAllByRole("button", { name: /More actions for/ })[49],
    ).toHaveFocus();
  });

  it("resizes with keyboard limits while preserving the selected action target", async () => {
    const user = userEvent.setup();
    const target = makeItem({
      sequence: 7,
      summary: "Unreliable raw summary",
      summaryReliable: false,
    });
    render(
      <HistoryPanel
        documentId="document-a"
        fileName="drawing.excalidraw"
        items={[target]}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onSetMarked={vi.fn()}
      />,
    );

    const panel = screen.getByRole("complementary");
    const separator = screen.getByRole("separator", {
      name: "Resize version history panel",
    });
    expect(screen.getByRole("complementary")).toHaveAttribute(
      "style",
      "--history-panel-width: 360px;",
    );
    const trigger = screen.getByRole("button", {
      name: "More actions for v-007 · Canvas changed",
    });
    await user.click(trigger);
    const title = within(screen.getByRole("menu")).getByText(
      "v-007 · Canvas changed",
    );
    expect(title).toHaveAttribute("title", "v-007 · Canvas changed");
    expect(
      screen.queryByText(/Unreliable raw summary/),
    ).not.toBeInTheDocument();
    expect(separator).toHaveAttribute("aria-valuenow", "360");

    separator.focus();
    await user.keyboard("{Home}");
    expect(separator).toHaveAttribute("aria-valuenow", "300");
    expect(separator).toHaveFocus();
    expect(panel).toHaveAttribute("data-compact", "true");
    expect(
      screen.getByRole("region", { name: "Selected version actions" }),
    ).toHaveTextContent("v-007 · Canvas changed");

    await user.keyboard("{ArrowRight}");
    expect(separator).toHaveAttribute("aria-valuenow", "300");
    await user.keyboard("{End}");
    expect(separator).toHaveAttribute("aria-valuenow", "360");
    await user.keyboard("{ArrowLeft}");
    expect(separator).toHaveAttribute("aria-valuenow", "360");
  });

  it("keeps an open menu bound to its original version and reports when it disappears", async () => {
    const user = userEvent.setup();
    const first = makeItem({ versionId: "version-1", sequence: 1 });
    const second = makeItem({ versionId: "version-2", sequence: 2 });
    const onSetMarked = vi.fn(async () => undefined);
    const props = {
      documentId: "document-a",
      fileName: "drawing.excalidraw",
      items: [first, second],
      onClose: vi.fn(),
      onSetMarked,
    };
    const { rerender } = render(
      <HistoryPanel {...props} selectedVersionId="version-1" />,
    );

    await user.click(
      screen.getByRole("button", { name: /More actions for v-001/ }),
    );
    rerender(<HistoryPanel {...props} selectedVersionId="version-2" />);
    await user.click(screen.getByRole("menuitem", { name: "Mark version" }));
    expect(onSetMarked).toHaveBeenCalledWith(first, true);

    rerender(
      <HistoryPanel
        {...props}
        items={[second]}
        selectedVersionId="version-2"
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /More actions for v-002/ }),
    );
    rerender(<HistoryPanel {...props} selectedVersionId="version-2" />);
    await user.click(
      screen.getByRole("button", { name: /More actions for v-001/ }),
    );
    rerender(
      <HistoryPanel
        {...props}
        items={[second]}
        selectedVersionId="version-2"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This version is no longer available",
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /More actions for v-002/ }),
    );
    rerender(
      <HistoryPanel
        {...props}
        documentId="document-b"
        items={[second]}
        selectedVersionId="version-2"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The history document changed",
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("focuses a controlled target when its version arrives after the initial load", () => {
    const item = makeItem({ versionId: "selected-late", sequence: 9 });
    const { rerender } = render(
      <HistoryPanel
        fileName="drawing.excalidraw"
        items={[]}
        onClose={vi.fn()}
        selectedVersionId="selected-late"
      />,
    );

    rerender(
      <HistoryPanel
        fileName="drawing.excalidraw"
        items={[item]}
        onClose={vi.fn()}
        selectedVersionId="selected-late"
      />,
    );

    expect(screen.getByRole("option")).toHaveFocus();
  });

  it("keeps Mark action focus and scroll stable when the selected item refreshes", async () => {
    const previousScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      const user = userEvent.setup();
      const item = makeItem();
      const onSetMarked = vi.fn(async () => undefined);
      const { rerender } = render(
        <HistoryPanel
          fileName="drawing.excalidraw"
          items={[item]}
          onClose={vi.fn()}
          onSetMarked={onSetMarked}
          selectedVersionId={item.versionId}
        />,
      );
      scrollIntoView.mockClear();

      const actionsTrigger = screen.getByRole("button", {
        name: /More actions for v-001/,
      });
      await user.click(actionsTrigger);
      await user.click(screen.getByRole("menuitem", { name: "Mark version" }));
      await vi.waitFor(() => expect(actionsTrigger).toHaveFocus());
      expect(onSetMarked).toHaveBeenCalledOnce();

      rerender(
        <HistoryPanel
          fileName="drawing.excalidraw"
          items={[makeItem({ marked: true })]}
          onClose={vi.fn()}
          onSetMarked={onSetMarked}
          selectedVersionId={item.versionId}
        />,
      );

      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(actionsTrigger).toHaveFocus();
    } finally {
      if (previousScrollIntoView === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      } else {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          previousScrollIntoView,
        );
      }
    }
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

    const trigger = screen.getByRole("button", {
      name: /More actions for v-001/,
    });
    await user.click(trigger);
    await user.click(screen.getByRole("menuitem", { name: "Delete version" }));
    expect(
      screen.getByRole("dialog", { name: "Delete v-001?" }),
    ).toHaveTextContent("Delete the automatic version from history?");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /^Delete$/ }));
    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        versionId: "version-1",
      }),
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    resolveDelete?.();
    await vi.waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Version deleted from history.",
      );
    });
    expect(
      screen.getByRole("button", { name: "Close version history" }),
    ).toHaveFocus();
  });

  it("closes delete confirmation when the active document changes", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(async () => undefined);
    const first = makeItem();
    const second = makeItem({ versionId: "version-2", sequence: 2 });
    const { rerender } = render(
      <HistoryPanel
        documentId="document-a"
        fileName="a.excalidraw"
        items={[first]}
        onClose={vi.fn()}
        onDelete={onDelete}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /More actions for v-001/ }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete version" }));
    expect(
      screen.getByRole("dialog", { name: "Delete v-001?" }),
    ).toBeInTheDocument();

    rerender(
      <HistoryPanel
        documentId="document-b"
        fileName="b.excalidraw"
        items={[second]}
        onClose={vi.fn()}
        onDelete={onDelete}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The history document changed",
    );
    expect(onDelete).not.toHaveBeenCalled();
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
      screen.getAllByRole("button", { name: /More actions for/ })[0]!,
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete version" }));
    await user.click(screen.getByRole("button", { name: /^Delete$/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Version is in use.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
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

    await user.click(
      screen.getAllByRole("button", { name: /More actions for/ })[0]!,
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete version" }));
    await user.click(screen.getByRole("button", { name: /^Delete$/ }));
    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: "unavailable-version" }),
    );
    const options = screen.getAllByRole("option");
    await user.click(options[1]);
    await user.click(
      screen.getAllByRole("button", { name: /More actions for/ })[1]!,
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete version" }));
    await user.click(screen.getByRole("button", { name: /^Delete$/ }));
    expect(onDelete).toHaveBeenLastCalledWith(
      expect.objectContaining({ versionId: "available-version" }),
    );
  });
});
