import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HistoryList, type HistoryVersionView } from "./HistoryList";

const recordedAt = Date.UTC(2026, 8, 23, 12, 34) / 1000;

function item(overrides: Partial<HistoryVersionView> = {}): HistoryVersionView {
  return {
    versionId: "version-1",
    source: "automatic",
    recordedAt,
    sequence: 1,
    contentHash: "hash-1",
    availability: { status: "available" },
    marked: false,
    ...overrides,
  };
}

describe("HistoryList", () => {
  it("renders source, time, summary fallback, and explicit current/preview labels", () => {
    render(
      <HistoryList
        currentVersionId="version-1"
        items={[
          item({ summary: "Two shapes added" }),
          item({
            versionId: "version-2",
            source: "protected",
            protectedAction: "restore",
            summaryReliable: false,
          }),
          item({
            versionId: "version-3",
            source: "manual",
            marked: true,
            summary: "A title changed",
          }),
        ]}
        previewVersionId="version-2"
        selectedVersionId="version-2"
      />,
    );

    expect(screen.getByText("Automatic")).toBeInTheDocument();
    expect(screen.getByText("Before restore")).toBeInTheDocument();
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText("Marked")).toBeInTheDocument();
    expect(screen.getByText("Two shapes added")).toBeInTheDocument();
    const timestamp = screen
      .getByText("Two shapes added")
      .parentElement?.querySelector("time");
    expect(timestamp).toHaveAttribute("datetime", "2026-09-23T12:34:00.000Z");
    expect(timestamp).toHaveTextContent(/Sep 23, 2026/);
    expect(screen.getAllByText("Canvas changed")).toHaveLength(1);
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Current/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Preview/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("uses Before clear and Before import labels for protected snapshots", () => {
    render(
      <HistoryList
        items={[
          item({
            versionId: "clear",
            protectedAction: "clear",
            source: "protected",
          }),
          item({
            versionId: "import",
            protectedAction: "import",
            source: "protected",
          }),
        ]}
      />,
    );

    expect(screen.getByText("Before clear")).toBeInTheDocument();
    expect(screen.getByText("Before import")).toBeInTheDocument();
  });

  it("announces unavailable rows without relying on color", () => {
    render(
      <HistoryList
        items={[
          item({
            availability: {
              status: "unavailable",
              error: {
                code: "HISTORY_RESOURCE_MISSING",
                message: "Image bytes are missing.",
                retriable: false,
              },
            },
          }),
        ]}
      />,
    );

    const row = screen.getByRole("option", { name: /Unavailable/ });
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });

  it("supports roving Arrow/Home/End selection and Enter preview", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onPreview = vi.fn();
    const items = [
      item(),
      item({ versionId: "version-2", sequence: 2 }),
      item({ versionId: "version-3", sequence: 3 }),
    ];
    const { rerender } = render(
      <HistoryList
        items={items}
        onPreview={onPreview}
        onSelect={onSelect}
        selectedVersionId="version-1"
      />,
    );

    const first = screen.getAllByRole("option", { name: /Automatic/ })[0];
    if (first === undefined) throw new Error("History list has no first row.");
    first.focus();
    await user.keyboard("{ArrowDown}");
    expect(onSelect).toHaveBeenLastCalledWith(items[1]);
    rerender(
      <HistoryList
        items={items}
        onPreview={onPreview}
        onSelect={onSelect}
        selectedVersionId="version-2"
      />,
    );
    expect(screen.getAllByRole("option")[1]).toHaveFocus();

    await user.keyboard("{End}");
    expect(onSelect).toHaveBeenLastCalledWith(items[2]);
    rerender(
      <HistoryList
        items={items}
        onPreview={onPreview}
        onSelect={onSelect}
        selectedVersionId="version-3"
      />,
    );
    await user.keyboard("{Home}");
    expect(onSelect).toHaveBeenLastCalledWith(items[0]);
    rerender(
      <HistoryList
        items={items}
        onPreview={onPreview}
        onSelect={onSelect}
        selectedVersionId="version-1"
      />,
    );
    await user.keyboard("{Enter}");
    expect(onPreview).toHaveBeenCalledWith(items[0]);
  });
});
