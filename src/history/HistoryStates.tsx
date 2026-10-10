import type { ReactNode } from "react";
import { useI18n, type MessageKey } from "../i18n";

export type HistoryStateKind =
  | "loading"
  | "empty"
  | "processing"
  | "permissionDenied"
  | "conflict"
  | "resourceUnavailable"
  | "error";

export interface HistoryStateViewProps {
  state: HistoryStateKind;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
  children?: ReactNode;
}

interface StateCopy {
  title: MessageKey;
  message: MessageKey;
  role: "status" | "alert";
}

const STATE_COPY: Record<HistoryStateKind, StateCopy> = {
  loading: {
    title: "history.state.loading.title",
    message: "history.state.loading.message",
    role: "status",
  },
  empty: {
    title: "history.state.empty.title",
    message: "history.state.empty.message",
    role: "status",
  },
  processing: {
    title: "history.state.processing.title",
    message: "history.state.processing.message",
    role: "status",
  },
  permissionDenied: {
    title: "history.state.permissionDenied.title",
    message: "history.state.permissionDenied.message",
    role: "alert",
  },
  conflict: {
    title: "history.state.conflict.title",
    message: "history.state.conflict.message",
    role: "alert",
  },
  resourceUnavailable: {
    title: "history.state.resourceUnavailable.title",
    message: "history.state.resourceUnavailable.message",
    role: "alert",
  },
  error: {
    title: "history.state.error.title",
    message: "history.state.error.message",
    role: "alert",
  },
};

/**
 * Presentational state feedback for the history drawer. It deliberately knows
 * nothing about IPC error codes or retry policy; callers provide the message
 * and action that belong to their data boundary.
 */
export function HistoryStateView({
  state,
  message,
  onRetry,
  retryLabel,
  children,
}: HistoryStateViewProps) {
  const { t } = useI18n();
  const copy = STATE_COPY[state];
  const announcement = message ?? t(copy.message);

  return (
    <section
      aria-busy={state === "loading" || state === "processing"}
      aria-live={copy.role === "alert" ? "assertive" : "polite"}
      className={`history-state history-state--${state}`}
      role={copy.role}
    >
      <h2>{t(copy.title)}</h2>
      {announcement.length > 0 ? <p>{announcement}</p> : null}
      {children}
      {onRetry !== undefined && state !== "empty" ? (
        <button className="primary-action" onClick={onRetry} type="button">
          {retryLabel ?? t("history.state.retry")}
        </button>
      ) : null}
    </section>
  );
}
