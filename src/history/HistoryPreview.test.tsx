import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HistoryPreview } from "./HistoryPreview";
import type { HistoryVersionView } from "./HistoryList";

const previewItem: HistoryVersionView = {
  versionId: "version-1",
  source: "automatic",
  recordedAt: Date.UTC(2026, 8, 23, 12, 34) / 1000,
  sequence: 1,
  contentHash: "hash-1",
  availability: { status: "available" },
  marked: false,
  summary: "Two shapes added",
};

describe("HistoryPreview", () => {
  it("marks the preview read-only and keeps the current drawing separate", () => {
    render(
      <HistoryPreview
        content={<p>Independent scene</p>}
        item={previewItem}
        onExit={vi.fn()}
        onRestore={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("region", { name: "Version preview" }),
    ).toHaveAttribute("aria-readonly", "true");
    expect(screen.getByText("Preview — read only")).toBeInTheDocument();
    expect(
      screen.getByText("The current drawing remains separate and unchanged."),
    ).toBeInTheDocument();
    expect(screen.getByText("Independent scene")).toBeInTheDocument();
  });

  it("calls exit, restore, and exposes the future actions slot", async () => {
    const user = userEvent.setup();
    const onExit = vi.fn();
    const onRestore = vi.fn();
    render(
      <HistoryPreview
        item={previewItem}
        moreActions={<button type="button">More version actions</button>}
        onExit={onExit}
        onRestore={onRestore}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Restore this version" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Exit version preview" }),
    );
    expect(onRestore).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "More version actions" }),
    ).toBeInTheDocument();
  });

  it("returns Escape to the caller and disables restore while loading or processing", async () => {
    const user = userEvent.setup();
    const onExit = vi.fn();
    render(
      <HistoryPreview
        item={previewItem}
        onExit={onExit}
        onRestore={vi.fn()}
        processing
        state="loading"
      />,
    );

    expect(
      screen.getByRole("button", { name: "Restore this version" }),
    ).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(onExit).toHaveBeenCalledOnce();
  });
});
