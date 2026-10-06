import type { HistoryVersionItem } from "./types";

const SOURCE_LABELS: Record<HistoryVersionItem["source"], string> = {
  automatic: "Automatic",
  manual: "Manual",
  protected: "Protected",
};

const PROTECTED_ACTION_LABELS: Record<
  NonNullable<HistoryVersionItem["protectedAction"]>,
  string
> = {
  restore: "Before restore",
  clear: "Before clear",
  import: "Before import",
};

export function historySourceLabel(item: HistoryVersionItem): string {
  if (item.source === "protected" && item.protectedAction !== undefined) {
    return PROTECTED_ACTION_LABELS[item.protectedAction];
  }
  return SOURCE_LABELS[item.source];
}

export function formatHistoryTimestamp(recordedAt: number): string {
  const date = historyDate(recordedAt);
  if (date === undefined) return "Unknown time";
  const today = new Date();
  const dayDifference = calendarDayDifference(today, date);
  const time = new Intl.DateTimeFormat(undefined, {
    timeStyle: "short",
  }).format(date);
  if (dayDifference === 0) return `Today · ${time}`;
  if (dayDifference === 1) return `Yesterday · ${time}`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    date,
  );
}

export function historyAccessibleTimestamp(recordedAt: number): string {
  const date = historyDate(recordedAt);
  if (date === undefined) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  }).format(date);
}

function calendarDayDifference(today: Date, date: Date): number {
  const todayStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const dateStart = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  );
  return Math.round((todayStart.getTime() - dateStart.getTime()) / 86_400_000);
}

function historyDate(recordedAt: number): Date | undefined {
  if (!Number.isFinite(recordedAt)) return undefined;
  const date = new Date(recordedAt * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function historyDateTime(recordedAt: number): string | undefined {
  return historyDate(recordedAt)?.toISOString();
}
