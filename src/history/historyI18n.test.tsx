import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  formatDateTimeIn,
  getBrowserLocaleController,
  initializeBrowserLocaleController,
} from "../i18n";
import { LocalizedError, describeError } from "../i18n/describeError";
import { en } from "../i18n/messages/en.ts";
import { es } from "../i18n/messages/es.ts";
import { ja } from "../i18n/messages/ja.ts";
import { zhCN } from "../i18n/messages/zh-CN.ts";
import { HistoryPanel } from "./HistoryPanel";
import type { HistoryVersionView } from "./HistoryList";
import { formatHistoryTimestamp, historySourceLabel } from "./historyFormat";

function makeItem(): HistoryVersionView {
  return {
    versionId: "version-1",
    source: "manual",
    recordedAt: Date.UTC(2020, 0, 2, 3, 4) / 1000,
    sequence: 1,
    contentHash: "hash-1",
    availability: { status: "available" },
    marked: true,
    summary: "Two shapes added",
  };
}

describe("History language switching", () => {
  it("re-renders panel copy, labels and dates when the language changes", () => {
    initializeBrowserLocaleController(["en"]);
    const controller = getBrowserLocaleController();
    render(
      <HistoryPanel
        fileName="a.excalidraw"
        items={[makeItem()]}
        onClose={() => undefined}
        onMark={() => undefined}
      />,
    );
    expect(
      screen.getByRole("heading", { name: en["history.panel.title"] }),
    ).toBeInTheDocument();
    expect(historySourceLabel(makeItem())).toBe(en["history.source.manual"]);

    act(() => controller.setPreference("zh-CN"));

    expect(
      screen.getByRole("heading", { name: zhCN["history.panel.title"] }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: zhCN["history.panel.markCurrent"] }),
    ).toBeInTheDocument();
    expect(screen.getByRole("listbox")).toHaveAccessibleName(
      zhCN["history.list.label"],
    );
    expect(historySourceLabel(makeItem())).toBe(zhCN["history.source.manual"]);
    expect(formatHistoryTimestamp(makeItem().recordedAt)).toMatch(/2020/);
    expect(
      describeError(new LocalizedError("history.input.dropMissingData")),
    ).toBe(zhCN["history.input.dropMissingData"]);

    for (const [preference, catalog] of [
      ["es", es],
      ["ja", ja],
    ] as const) {
      act(() => controller.setPreference(preference));
      expect(
        screen.getByRole("heading", { name: catalog["history.panel.title"] }),
      ).toBeInTheDocument();
      expect(historySourceLabel(makeItem())).toBe(
        catalog["history.source.manual"],
      );
      const recordedAt = makeItem().recordedAt;
      const formatted = formatHistoryTimestamp(recordedAt);
      expect(formatted).toBe(
        formatDateTimeIn(preference, new Date(recordedAt * 1000), {
          dateStyle: "medium",
        }),
      );
      expect(formatted).not.toBe(
        formatDateTimeIn("en", new Date(recordedAt * 1000), {
          dateStyle: "medium",
        }),
      );
    }

    act(() => controller.setPreference("en"));
    expect(
      screen.getByRole("heading", { name: en["history.panel.title"] }),
    ).toBeInTheDocument();
  });
});
