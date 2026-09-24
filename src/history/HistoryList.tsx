import { useRef, type KeyboardEvent, type RefCallback } from "react";
import type { HistoryVersionItem } from "./types";

export interface HistoryVersionView extends HistoryVersionItem {
  /** A caller-owned coarse description of the adjacent canvas change. */
  summary?: string;
  /** False means the caller cannot reliably describe the canvas change. */
  summaryReliable?: boolean;
  /** Manual versions may be marked for long-term retention. */
  marked?: boolean;
}

export interface HistoryListProps {
  items: readonly HistoryVersionView[];
  selectedVersionId?: string | null;
  currentVersionId?: string | null;
  previewVersionId?: string | null;
  onSelect?: (item: HistoryVersionView) => void;
  onPreview?: (item: HistoryVersionView) => void;
  onRegisterRow?: (
    versionId: string,
    element: HTMLButtonElement | null,
  ) => void;
}

const SOURCE_LABELS: Record<HistoryVersionView["source"], string> = {
  automatic: "Automatic",
  manual: "Manual",
  protected: "Protected",
};

const PROTECTED_ACTION_LABELS: Record<
  NonNullable<HistoryVersionView["protectedAction"]>,
  string
> = {
  restore: "Before restore",
  clear: "Before clear",
  import: "Before import",
};

/**
 * A roving-tabindex history list. Arrow navigation changes selection only;
 * Enter asks the caller to open an independent, read-only preview.
 */
export function HistoryList({
  items,
  selectedVersionId = null,
  currentVersionId = null,
  previewVersionId = null,
  onSelect,
  onPreview,
  onRegisterRow,
}: HistoryListProps) {
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const registerRow = (versionId: string): RefCallback<HTMLButtonElement> => {
    return (element) => {
      if (element === null) {
        rowRefs.current.delete(versionId);
      } else {
        rowRefs.current.set(versionId, element);
      }
      onRegisterRow?.(versionId, element);
    };
  };

  const focusItem = (index: number) => {
    const item = items[index];
    if (item === undefined) return;
    onSelect?.(item);
    rowRefs.current.get(item.versionId)?.focus();
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    item: HistoryVersionView,
  ) => {
    let nextIndex: number | undefined;
    switch (event.key) {
      case "ArrowDown":
        nextIndex = Math.min(items.length - 1, index + 1);
        break;
      case "ArrowUp":
        nextIndex = Math.max(0, index - 1);
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = Math.max(0, items.length - 1);
        break;
      case "Enter":
        event.preventDefault();
        if (item.availability.status === "available") {
          onPreview?.(item);
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    if (nextIndex !== undefined && nextIndex !== index) {
      focusItem(nextIndex);
    }
  };

  return (
    <ul aria-label="Version history" className="history-list" role="listbox">
      {items.map((item, index) => {
        const selected = item.versionId === selectedVersionId;
        const current = item.versionId === currentVersionId;
        const preview = item.versionId === previewVersionId;
        const unavailable = item.availability.status === "unavailable";
        const source = sourceLabel(item);
        const dateTime = historyDateTime(item.recordedAt);
        const summary =
          item.summaryReliable === false ||
          item.summary === undefined ||
          item.summary === ""
            ? "Canvas changed"
            : item.summary;
        const statusLabels = [
          current ? "Current" : null,
          preview ? "Preview" : null,
          !current && !preview && !unavailable ? "Ready" : null,
          unavailable ? "Unavailable" : null,
          item.marked ? "Marked" : null,
        ].filter((label): label is string => label !== null);
        const accessibleLabel = [
          source,
          formatHistoryTimestamp(item.recordedAt),
          summary,
          ...statusLabels,
        ].join(" · ");

        return (
          <li className="history-list-item" key={item.versionId}>
            <button
              aria-label={accessibleLabel}
              aria-selected={selected}
              aria-disabled={unavailable}
              className={`history-list-row${selected ? " is-selected" : ""}${
                current ? " is-current" : ""
              }${preview ? " is-preview" : ""}${unavailable ? " is-unavailable" : ""}`}
              onClick={() => onSelect?.(item)}
              onKeyDown={(event) => handleKeyDown(event, index, item)}
              ref={registerRow(item.versionId)}
              role="option"
              tabIndex={
                selected || (selectedVersionId === null && index === 0) ? 0 : -1
              }
              type="button"
            >
              <span className="history-list-row-main">
                <time dateTime={dateTime}>
                  {formatHistoryTimestamp(item.recordedAt)}
                </time>
                <span className="history-list-source">{source}</span>
                <span className="history-list-summary">{summary}</span>
              </span>
              <span
                aria-label={statusLabels.join(", ") || undefined}
                className="history-list-statuses"
              >
                {current ? (
                  <span className="history-list-status">Current</span>
                ) : null}
                {preview ? (
                  <span className="history-list-status">Preview</span>
                ) : null}
                {!current && !preview && !unavailable ? (
                  <span className="history-list-status">Ready</span>
                ) : null}
                {item.marked ? (
                  <span className="history-list-status">Manual · Marked</span>
                ) : null}
                {unavailable ? (
                  <span className="history-list-status">Unavailable</span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function sourceLabel(item: HistoryVersionView): string {
  if (item.source === "protected" && item.protectedAction !== undefined) {
    return PROTECTED_ACTION_LABELS[item.protectedAction];
  }
  return SOURCE_LABELS[item.source];
}

function formatHistoryTimestamp(recordedAt: number): string {
  const date = historyDate(recordedAt);
  if (date === undefined) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function historyDate(recordedAt: number): Date | undefined {
  if (!Number.isFinite(recordedAt)) return undefined;
  const date = new Date(recordedAt);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function historyDateTime(recordedAt: number): string | undefined {
  return historyDate(recordedAt)?.toISOString();
}
