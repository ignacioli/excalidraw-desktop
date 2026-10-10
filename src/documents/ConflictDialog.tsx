import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { describeError } from "../i18n/describeError";
import { t, useI18n } from "../i18n";

export type ConflictResolution = "takeExternal" | "keepLocal" | "saveAsNew";

export interface ConflictDialogProps {
  title: string;
  path: string;
  externalMtime: number;
  localDraftUpdatedAt: number;
  onResolve: (
    resolution: ConflictResolution,
    saveAsPath?: string,
  ) => Promise<void> | void;
  onDismiss: () => void;
  requestSaveAsPath?: (title: string) => Promise<string | null>;
}

export function ConflictDialog({
  title,
  path,
  externalMtime,
  localDraftUpdatedAt,
  onResolve,
  onDismiss,
  requestSaveAsPath = chooseConflictSaveAsPath,
}: ConflictDialogProps) {
  const { t, formatDateTime } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<{ error: unknown } | null>(
    null,
  );

  useEffect(() => {
    dialogRef.current
      ?.querySelector<HTMLButtonElement>("button:not([disabled])")
      ?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (event.key === "Tab") {
      trapFocus(event);
      return;
    }
    if (event.key === "Enter" && event.target === dialogRef.current) {
      event.preventDefault();
      void resolve("takeExternal");
    }
  };

  const resolve = async (
    resolution: ConflictResolution,
    saveAsPath?: string,
  ) => {
    if (busy) {
      return;
    }
    setErrorMessage(null);
    let selectedPath: string | undefined = saveAsPath;
    if (resolution === "saveAsNew") {
      const chosen = await requestSaveAsPath(title);
      if (chosen === null) {
        return;
      }
      selectedPath = chosen;
    }
    setBusy(true);
    try {
      if (selectedPath === undefined) {
        await onResolve(resolution);
      } else {
        await onResolve(resolution, selectedPath);
      }
    } catch (error) {
      setErrorMessage({ error });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      aria-labelledby="conflict-dialog-title"
      aria-modal="true"
      className="conflict-dialog-backdrop"
      onKeyDown={handleKeyDown}
      ref={dialogRef}
      role="dialog"
    >
      <section className="conflict-dialog" role="document">
        <h1 id="conflict-dialog-title">{t("conflict.title")}</h1>
        <h2>{title}</h2>
        <p className="conflict-dialog-path">{path}</p>
        <p>{t("conflict.description")}</p>
        <dl className="conflict-version-times">
          <div>
            <dt>{t("conflict.externalChanged")}</dt>
            <dd>{formatTimestamp(externalMtime)}</dd>
          </div>
          <div>
            <dt>{t("conflict.localSaved")}</dt>
            <dd>{formatTimestamp(localDraftUpdatedAt)}</dd>
          </div>
        </dl>
        {errorMessage !== null ? (
          <p
            aria-live="assertive"
            className="conflict-dialog-error"
            role="alert"
          >
            {describeError(errorMessage.error, "error.conflictFailed")}
          </p>
        ) : null}
        <div className="conflict-dialog-actions">
          <button
            className="primary-action"
            disabled={busy}
            onClick={() => void resolve("takeExternal")}
            type="button"
          >
            {t("conflict.useExternal")}
          </button>
          <button
            disabled={busy}
            onClick={() => void resolve("keepLocal")}
            type="button"
          >
            {t("conflict.keepLocal")}
          </button>
          <button
            disabled={busy}
            onClick={() => void resolve("saveAsNew")}
            type="button"
          >
            {t("conflict.saveAsNew")}
          </button>
        </div>
      </section>
    </div>
  );

  function formatTimestamp(seconds: number): string {
    const timestamp = new Date(seconds * 1_000);
    if (Number.isNaN(timestamp.getTime())) {
      return t("conflict.unknownTime");
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

async function chooseConflictSaveAsPath(title: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    defaultPath: title,
    filters: [
      {
        name: t("conflict.saveDialog.filterName"),
        extensions: ["excalidraw", "excalidraw.json"],
      },
    ],
    title: t("conflict.saveDialog.title"),
  });
}
