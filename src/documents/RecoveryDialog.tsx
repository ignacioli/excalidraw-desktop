import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type {
  CommandResponse,
  RecoveryAction,
  RecoveryCandidate,
} from "../ipc/contracts";
import { describeError, LocalizedError } from "../i18n/describeError";
import { useI18n } from "../i18n";

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
  const { t, formatDateTime } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busyDocumentId, setBusyDocumentId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<{
    error: unknown;
  } | null>(null);

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
    setBusyDocumentId(candidate.documentId);
    try {
      let saveAsPath: string | undefined;
      if (action === "saveAsNew") {
        if (requestSaveAsPath === undefined) {
          setErrorMessage({
            error: new LocalizedError("recovery.error.chooseDestination"),
          });
          return;
        }
        const selectedPath = await requestSaveAsPath(candidate);
        if (selectedPath === null) {
          return;
        }
        saveAsPath = selectedPath;
      }
      await onApply({
        documentId: candidate.documentId,
        action,
        ...(saveAsPath === undefined ? {} : { saveAsPath }),
      });
    } catch (error) {
      setErrorMessage({ error });
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
        <h1 id="recovery-dialog-title">{t("recovery.title")}</h1>
        <p>{t("recovery.description")}</p>
        {errorMessage !== null ? (
          <p
            aria-live="assertive"
            className="recovery-dialog-error"
            role="alert"
          >
            {describeError(errorMessage.error, "error.recoveryFailed")}
          </p>
        ) : null}
        <ul
          aria-label={t("recovery.candidatesLabel")}
          className="recovery-candidate-list"
        >
          {candidates.map((candidate) => {
            return (
              <li className="recovery-candidate" key={candidate.documentId}>
                <div className="recovery-candidate-details">
                  <h2>{candidate.displayName}</h2>
                  <p>
                    {t("recovery.snapshotSaved", {
                      time: formatTimestamp(candidate.snapshotSavedAt),
                    })}
                  </p>
                  {candidate.originalPath !== null ? (
                    <p className="recovery-candidate-path">
                      {candidate.originalPath}
                    </p>
                  ) : (
                    <p className="recovery-candidate-path">
                      {t("recovery.untitled")}
                    </p>
                  )}
                </div>
                <div
                  aria-label={t("recovery.actionsFor", {
                    name: candidate.displayName,
                  })}
                  className="recovery-candidate-actions"
                >
                  <button
                    disabled={busyDocumentId !== null}
                    onClick={() => void applyDecision(candidate, "restore")}
                    type="button"
                  >
                    {t("recovery.restore", { name: candidate.displayName })}
                  </button>
                  <button
                    disabled={busyDocumentId !== null}
                    onClick={() => void applyDecision(candidate, "keepDisk")}
                    type="button"
                  >
                    {t("recovery.keepDisk", { name: candidate.displayName })}
                  </button>
                  <button
                    disabled={busyDocumentId !== null}
                    onClick={() => void applyDecision(candidate, "saveAsNew")}
                    type="button"
                  >
                    {t("recovery.saveAsNew", { name: candidate.displayName })}
                  </button>
                  <button
                    disabled={busyDocumentId !== null}
                    onClick={() => void applyDecision(candidate, "discard")}
                    type="button"
                  >
                    {t("recovery.discard", { name: candidate.displayName })}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );

  function formatTimestamp(seconds: number): string {
    const timestamp = new Date(seconds * 1_000);
    if (Number.isNaN(timestamp.getTime())) {
      return t("recovery.unknownTime");
    }
    return formatDateTime(timestamp);
  }

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
