import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { HistoryStateView } from "./HistoryStates";
import type { HistoryVersionView } from "./HistoryList";

export type HistoryPreviewState = "loading" | "ready" | "error";

export interface HistoryPreviewProps {
  item: HistoryVersionView;
  state?: HistoryPreviewState;
  errorMessage?: string;
  content?: ReactNode;
  processing?: boolean;
  onExit(): void;
}

/** Independent read-only preview surface; it never owns the current canvas. */
export function HistoryPreview({
  item,
  state = "ready",
  errorMessage,
  content,
  processing = false,
  onExit,
}: HistoryPreviewProps) {
  const exitButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    exitButtonRef.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onExit();
  };

  return (
    <section
      aria-label="Version preview"
      aria-readonly="true"
      className="history-preview"
      data-history-preview-readonly="true"
      onKeyDown={handleKeyDown}
    >
      <div className="history-preview-header">
        <div>
          <h2>
            Preview · v-{String(item.sequence).padStart(3, "0")} ·{" "}
            {formatPreviewTitle(item)}
          </h2>
          <p className="history-preview-separation">
            Read-only snapshot. The current drawing remains separate and
            unchanged.
          </p>
        </div>
        <button
          aria-label="Exit version preview"
          className="icon-button"
          onClick={onExit}
          ref={exitButtonRef}
          type="button"
        >
          <CloseIcon />
          <span className="visually-hidden">Exit preview</span>
        </button>
      </div>

      <div
        aria-busy={state === "loading" || processing}
        aria-label="Read-only canvas preview"
        className="history-preview-content"
        role="region"
      >
        {state === "loading" ? (
          <HistoryStateView state="loading" />
        ) : state === "error" ? (
          <HistoryStateView message={errorMessage} state="error" />
        ) : (
          (content ?? (
            <p className="history-preview-placeholder">
              Preview content is ready.
            </p>
          ))
        )}
      </div>
    </section>
  );
}

function formatPreviewTitle(item: HistoryVersionView): string {
  return item.summary !== undefined &&
    item.summary !== "" &&
    item.summaryReliable !== false
    ? item.summary
    : "Canvas changed";
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
      <path
        d="m4 4 8 8M12 4l-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}
