import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { historyDefaultSummary, historyVersionLabel } from "./historyFormat";
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
  const { t } = useI18n();
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
      aria-label={t("history.preview.label")}
      aria-readonly="true"
      className="history-preview"
      data-history-preview-readonly="true"
      onKeyDown={handleKeyDown}
    >
      <div className="history-preview-header">
        <div>
          <h2>
            {t("history.preview.title", {
              version: historyVersionLabel(item.sequence),
              summary: formatPreviewTitle(item),
            })}
          </h2>
          <p className="history-preview-separation">
            {t("history.preview.separation")}
          </p>
        </div>
        <button
          aria-label={t("history.preview.exitLabel")}
          className="icon-button"
          onClick={onExit}
          ref={exitButtonRef}
          type="button"
        >
          <CloseIcon />
          <span className="visually-hidden">{t("history.preview.exit")}</span>
        </button>
      </div>

      <div
        aria-busy={state === "loading" || processing}
        aria-label={t("history.preview.canvasRegion")}
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
              {t("history.preview.ready")}
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
    : historyDefaultSummary();
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
