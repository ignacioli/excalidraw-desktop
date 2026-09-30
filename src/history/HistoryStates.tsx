import type { ReactNode } from "react";

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
  title: string;
  message: string;
  role: "status" | "alert";
}

const STATE_COPY: Record<HistoryStateKind, StateCopy> = {
  loading: {
    title: "Loading version history",
    message: "Retrieving saved versions…",
    role: "status",
  },
  empty: {
    title: "No saved versions",
    message: "Versions will appear here after this drawing is saved.",
    role: "status",
  },
  processing: {
    title: "Updating version history",
    message:
      "This operation is still being processed. The current file is unchanged.",
    role: "status",
  },
  permissionDenied: {
    title: "Version history access denied",
    message:
      "This file does not allow access to its version history. Check its permissions and try again.",
    role: "alert",
  },
  conflict: {
    title: "Version history conflict",
    message:
      "The file changed outside Excalidraw Desktop. Resolve the conflict before restoring a version.",
    role: "alert",
  },
  resourceUnavailable: {
    title: "Version resource unavailable",
    message:
      "A saved version or one of its resources is unavailable. The current file has not changed.",
    role: "alert",
  },
  error: {
    title: "Version history could not be loaded",
    message:
      "Your current file is unchanged. Try loading version history again.",
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
  retryLabel = "Try again",
  children,
}: HistoryStateViewProps) {
  const copy = STATE_COPY[state];
  const announcement = message ?? copy.message;

  return (
    <section
      aria-busy={state === "loading" || state === "processing"}
      aria-live={copy.role === "alert" ? "assertive" : "polite"}
      className={`history-state history-state--${state}`}
      role={copy.role}
    >
      <h2>{copy.title}</h2>
      <p>{announcement}</p>
      {children}
      {onRetry !== undefined && state !== "empty" ? (
        <button className="primary-action" onClick={onRetry} type="button">
          {retryLabel}
        </button>
      ) : null}
    </section>
  );
}
