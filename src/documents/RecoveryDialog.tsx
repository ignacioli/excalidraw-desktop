import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type {
  CommandResponse,
  RecoveryAction,
  RecoveryCandidate,
} from "../ipc/contracts";

export type RecoveryApplyResponse = CommandResponse<"recovery_apply">;

export interface RecoveryDecision {
  documentId: string;
  action: RecoveryAction;
  saveAsPath?: string;
}

export interface RecoveryDialogProps {
  candidates: readonly RecoveryCandidate[];
  onApply: (
    decision: RecoveryDecision,
  ) => Promise<RecoveryApplyResponse | void>;
  onCancel?: () => void;
  requestSaveAsPath?: (candidate: RecoveryCandidate) => Promise<string | null>;
}

export function RecoveryDialog({
  candidates,
  onApply,
  onCancel,
  requestSaveAsPath,
}: RecoveryDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busyDocumentId, setBusyDocumentId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const firstButton = dialogRef.current?.querySelector<HTMLButtonElement>(
      "button:not([disabled])",
    );
    firstButton?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel?.();
      return;
    }
    if (event.key === "Tab") {
      trapFocus(event);
      return;
    }
    if (event.key === "Enter" && event.target === dialogRef.current) {
      const firstCandidate = candidates[0];
      if (firstCandidate !== undefined) {
        event.preventDefault();
        void applyDecision(firstCandidate, "restore");
      }
    }
  };

  const applyDecision = async (
    candidate: RecoveryCandidate,
    action: RecoveryAction,
  ) => {
    if (busyDocumentId !== null) {
      return;
    }
    setErrorMessage(null);
    let saveAsPath: string | undefined;
    if (action === "saveAsNew") {
      if (requestSaveAsPath === undefined) {
        setErrorMessage(
          "Choose a destination before saving the recovery as a new drawing.",
        );
        return;
      }
      const selectedPath = await requestSaveAsPath(candidate);
      if (selectedPath === null) {
        return;
      }
      saveAsPath = selectedPath;
    }

    setBusyDocumentId(candidate.documentId);
    try {
      await onApply({
        documentId: candidate.documentId,
        action,
        ...(saveAsPath === undefined ? {} : { saveAsPath }),
      });
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBusyDocumentId(null);
    }
  };

  return (
    <div
      aria-labelledby="recovery-dialog-title"
      aria-modal="true"
      className="recovery-dialog-backdrop"
      onKeyDown={handleKeyDown}
      ref={dialogRef}
      role="dialog"
    >
      <section className="recovery-dialog" role="document">
        <h1 id="recovery-dialog-title">Recover unsaved drawings</h1>
        <p>
          Excalidraw Desktop found recovery snapshots from an interrupted
          session. Choose what to do with each drawing.
        </p>
        {errorMessage !== null ? (
          <p
            aria-live="assertive"
            className="recovery-dialog-error"
            role="alert"
          >
            {errorMessage}
          </p>
        ) : null}
        <ul
          aria-label="Recovery candidates"
          className="recovery-candidate-list"
        >
          {candidates.map((candidate) => {
            const isBusy = busyDocumentId === candidate.documentId;
            return (
              <li className="recovery-candidate" key={candidate.documentId}>
                <div className="recovery-candidate-details">
                  <h2>{candidate.displayName}</h2>
                  <p>
                    Snapshot saved {formatTimestamp(candidate.snapshotSavedAt)}
                  </p>
                  {candidate.originalPath !== null ? (
                    <p className="recovery-candidate-path">
                      {candidate.originalPath}
                    </p>
                  ) : (
                    <p className="recovery-candidate-path">Untitled drawing</p>
                  )}
                </div>
                <div
                  aria-label={`Actions for ${candidate.displayName}`}
                  className="recovery-candidate-actions"
                >
                  <button
                    disabled={isBusy}
                    onClick={() => void applyDecision(candidate, "restore")}
                    type="button"
                  >
                    Restore {candidate.displayName}
                  </button>
                  <button
                    disabled={isBusy}
                    onClick={() => void applyDecision(candidate, "keepDisk")}
                    type="button"
                  >
                    Keep disk version for {candidate.displayName}
                  </button>
                  <button
                    disabled={isBusy}
                    onClick={() => void applyDecision(candidate, "saveAsNew")}
                    type="button"
                  >
                    Save {candidate.displayName} as new
                  </button>
                  <button
                    disabled={isBusy}
                    onClick={() => void applyDecision(candidate, "discard")}
                    type="button"
                  >
                    Discard recovery for {candidate.displayName}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );

  function trapFocus(event: KeyboardEvent<HTMLDivElement>) {
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

function formatTimestamp(seconds: number): string {
  const timestamp = new Date(seconds * 1_000);
  if (Number.isNaN(timestamp.getTime())) {
    return "at an unknown time";
  }
  return timestamp.toLocaleString();
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "The recovery action could not be completed.";
}
