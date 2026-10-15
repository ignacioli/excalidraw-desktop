import { useCallback, useRef, useState } from "react";

export type FeedbackToastTone = "success" | "failure";

/** How long each kind of feedback stays before it disappears on its own. */
export const FEEDBACK_TOAST_DURATION_MS = {
  /** Copy succeeded. */
  success: 2000,
  /** A sub-folder was revealed in the Workspace already open in this window. */
  locate: 3000,
  /** Copy failed; the toast can also be dismissed by hand. */
  failure: 6000,
} as const;

export interface FeedbackToastInput {
  tone: FeedbackToastTone;
  message: string;
  /** Optional path shown after the message, shortened in the middle. */
  path?: string;
  /** Defaults to the success or failure duration for `tone`. */
  durationMs?: number;
}

export interface FeedbackToastMessage extends FeedbackToastInput {
  id: number;
}

/**
 * Holds the window's single feedback toast. Showing a new toast replaces the
 * current one and restarts its timer.
 */
export function useFeedbackToast() {
  const [toast, setToast] = useState<FeedbackToastMessage | null>(null);
  const nextId = useRef(0);
  const showToast = useCallback((input: FeedbackToastInput) => {
    nextId.current += 1;
    setToast({ ...input, id: nextId.current });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);
  return { toast, showToast, dismissToast };
}
