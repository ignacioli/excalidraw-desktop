import { describe, expect, it } from "vitest";
import {
  formatHistoryTimestamp,
  historyAccessibleTimestamp,
  historyDateTime,
} from "./historyFormat";

describe("history timestamp formatting", () => {
  it("uses relative labels for today and yesterday, and a date for older entries", () => {
    const now = new Date();
    const today = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      12,
    );
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const older = new Date(today);
    older.setDate(older.getDate() - 3);

    expect(formatHistoryTimestamp(today.getTime() / 1000)).toMatch(/^Today · /);
    expect(formatHistoryTimestamp(yesterday.getTime() / 1000)).toMatch(
      /^Yesterday · /,
    );
    expect(formatHistoryTimestamp(older.getTime() / 1000)).not.toMatch(
      /^(Today|Yesterday) · /,
    );
  });

  it("keeps machine-readable and full accessible timestamps, including invalid input", () => {
    const timestamp = new Date(2026, 8, 23, 12, 34).getTime() / 1000;
    expect(historyDateTime(timestamp)).toBe(
      new Date(timestamp * 1000).toISOString(),
    );
    expect(historyAccessibleTimestamp(timestamp)).toContain("2026");
    expect(formatHistoryTimestamp(Number.NaN)).toBe("Unknown time");
    expect(historyAccessibleTimestamp(Number.NaN)).toBe("Unknown time");
    expect(historyDateTime(Number.NaN)).toBeUndefined();
  });
});
