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
      />,
    );

    expect(
      screen.getByRole("region", { name: "Version preview" }),
    ).toHaveAttribute("aria-readonly", "true");
    expect(
      screen.getByRole("heading", {
        name: "Preview · v-001 · Two shapes added",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Read-only snapshot. The current drawing remains separate and unchanged.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Independent scene")).toBeInTheDocument();
  });

  it("calls exit and exposes the preview toolbar summary", async () => {
    const user = userEvent.setup();
    const onExit = vi.fn();
    render(<HistoryPreview item={previewItem} onExit={onExit} />);

    await user.click(
      screen.getByRole("button", { name: "Exit version preview" }),
    );
    expect(onExit).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("heading", {
        name: "Preview · v-001 · Two shapes added",
      }),
    ).toBeInTheDocument();
  });

  it("returns Escape to the caller and exposes loading state", async () => {
    const user = userEvent.setup();
    const onExit = vi.fn();
    render(
      <HistoryPreview
        item={previewItem}
        onExit={onExit}
        processing
        state="loading"
      />,
    );

    expect(
      screen.getByRole("region", { name: "Read-only canvas preview" }),
    ).toHaveAttribute("aria-busy", "true");
    await user.keyboard("{Escape}");
    expect(onExit).toHaveBeenCalledOnce();
  });
});
