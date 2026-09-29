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
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function historyDate(recordedAt: number): Date | undefined {
  if (!Number.isFinite(recordedAt)) return undefined;
  const date = new Date(recordedAt * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function historyDateTime(recordedAt: number): string | undefined {
  return historyDate(recordedAt)?.toISOString();
}
