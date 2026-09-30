import {
  useRef,
  type KeyboardEvent,
  type RefCallback,
  type ReactNode,
} from "react";
import type { HistoryVersionItem } from "./types";
import {
  formatHistoryTimestamp,
  historyDateTime,
  historySourceLabel,
} from "./historyFormat";

export interface HistoryVersionView extends HistoryVersionItem {
  /** A caller-owned coarse description of the adjacent canvas change. */
  summary?: string;
  /** False means the caller cannot reliably describe the canvas change. */
  summaryReliable?: boolean;
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
  renderRowActions?: (item: HistoryVersionView) => ReactNode;
}

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
  renderRowActions,
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
        const source = historySourceLabel(item);
        const dateTime = historyDateTime(item.recordedAt);
        const summary =
          item.summaryReliable === false ||
          item.summary === undefined ||
          item.summary === ""
            ? "Canvas changed"
            : item.summary;
        const statusLabel = unavailable
          ? "Unavailable"
          : current
            ? "Current"
            : preview
              ? "Preview"
              : item.marked
                ? "Marked"
                : "Ready";
        const accessibleLabel = [
          source,
          formatHistoryTimestamp(item.recordedAt),
          summary,
          statusLabel,
        ].join(" · ");

        return (
          <li className="history-list-item" key={item.versionId}>
            <div
              className={`history-list-row${selected ? " is-selected" : ""}${
                current ? " is-current" : ""
              }${preview ? " is-preview" : ""}${unavailable ? " is-unavailable" : ""}`}
            >
              <button
                aria-label={accessibleLabel}
                aria-selected={selected}
                aria-disabled={unavailable}
                className="history-list-row-select"
                onClick={() => onSelect?.(item)}
                onKeyDown={(event) => handleKeyDown(event, index, item)}
                ref={registerRow(item.versionId)}
                role="option"
                tabIndex={
                  selected || (selectedVersionId === null && index === 0)
                    ? 0
                    : -1
                }
                type="button"
              >
                <span className="history-list-row-main">
                  <span className="history-list-summary">{summary}</span>
                  <span className="history-list-metadata">
                    <time dateTime={dateTime}>
                      {formatHistoryTimestamp(item.recordedAt)}
                    </time>
                    <span aria-hidden="true">·</span>
                    <span className="history-list-source">{source}</span>
                  </span>
                </span>
                <span className="history-list-statuses">
                  {unavailable ? (
                    <span className="history-list-status history-list-status--unavailable">
                      <svg
                        aria-hidden="true"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                      >
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7v6m0 4h.01" />
                      </svg>
                      Unavailable
                    </span>
                  ) : (
                    <span
                      className={[
                        "history-list-status",
                        item.marked && !current && !preview
                          ? "history-list-status--marked"
                          : "history-list-status--ready",
                      ].join(" ")}
                    >
                      {statusLabel}
                    </span>
                  )}
                </span>
              </button>
              {renderRowActions?.(item)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
