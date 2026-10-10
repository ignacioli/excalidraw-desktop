import { formatDateTime, t, type MessageKey } from "../i18n";
import type { HistoryVersionItem } from "./types";

const SOURCE_LABELS: Record<HistoryVersionItem["source"], MessageKey> = {
  automatic: "history.source.automatic",
  manual: "history.source.manual",
  protected: "history.source.protected",
};

const PROTECTED_ACTION_LABELS: Record<
  NonNullable<HistoryVersionItem["protectedAction"]>,
  MessageKey
> = {
  restore: "history.source.beforeRestore",
  clear: "history.source.beforeClear",
  import: "history.source.beforeImport",
};

export function historySourceLabel(item: HistoryVersionItem): string {
  if (item.source === "protected" && item.protectedAction !== undefined) {
    return t(PROTECTED_ACTION_LABELS[item.protectedAction]);
  }
  return t(SOURCE_LABELS[item.source]);
}

export function formatHistoryTimestamp(recordedAt: number): string {
  const date = historyDate(recordedAt);
  if (date === undefined) return t("history.time.unknown");
  const today = new Date();
  const dayDifference = calendarDayDifference(today, date);
  const time = formatDateTime(date, { timeStyle: "short" });
  if (dayDifference === 0) return t("history.time.today", { time });
  if (dayDifference === 1) return t("history.time.yesterday", { time });
  return formatDateTime(date, { dateStyle: "medium" });
}

export function historyAccessibleTimestamp(recordedAt: number): string {
  const date = historyDate(recordedAt);
  if (date === undefined) return t("history.time.unknown");
  return formatDateTime(date, { dateStyle: "full", timeStyle: "long" });
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

/** Coarse summary used when the caller has no reliable canvas description. */
export function historyDefaultSummary(): string {
  return t("history.summary.canvasChanged");
}

/** `v-001` style identity; a notation, not translated copy. */
export function historyVersionLabel(sequence: number): string {
  return `v-${String(sequence).padStart(3, "0")}`;
}
