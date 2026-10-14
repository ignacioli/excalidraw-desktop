import { useEffect } from "react";
import { useI18n } from "../i18n";
import {
  FEEDBACK_TOAST_DURATION_MS,
  type FeedbackToastMessage,
} from "./feedbackToastState";
import { middleEllipsis } from "./interaction/middleEllipsis";

interface FeedbackToastProps {
  toast: FeedbackToastMessage | null;
  onDismiss(): void;
}

/** MW-COPY-FEEDBACK: bottom-centered copy and reveal feedback. */
export function FeedbackToast({ toast, onDismiss }: FeedbackToastProps) {
  const { t } = useI18n();
  const toastId = toast?.id;
  const durationMs =
    toast === null
      ? null
      : (toast.durationMs ?? FEEDBACK_TOAST_DURATION_MS[toast.tone]);

  useEffect(() => {
    if (toastId === undefined || durationMs === null) return;
    const timer = window.setTimeout(onDismiss, durationMs);
    return () => window.clearTimeout(timer);
  }, [toastId, durationMs, onDismiss]);

  if (toast === null) return null;
  const failure = toast.tone === "failure";
  return (
    <div
      key={toast.id}
      aria-live={failure ? "assertive" : "polite"}
      className="feedback-toast"
      data-tone={toast.tone}
      role={failure ? "alert" : "status"}
    >
      <span aria-hidden="true" className="feedback-toast-symbol">
        {failure ? "!" : "✓"}
      </span>
      <span className="feedback-toast-message">{toast.message}</span>
      {toast.path ? (
        <span className="feedback-toast-path" title={toast.path}>
          {middleEllipsis(toast.path)}
        </span>
      ) : null}
      {failure ? (
        <button
          aria-label={t("shell.feedback.dismiss")}
          className="feedback-toast-dismiss"
          onClick={onDismiss}
          type="button"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}
