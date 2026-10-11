import { useRef, type RefObject } from "react";
import { useI18n } from "../../i18n";
import { ApplicationDialog } from "./ApplicationDialog";

interface DeleteConfirmationDialogProps {
  displayName: string;
  busy?: boolean;
  errorMessage?: string | null;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onCancel(): void;
  onDelete(): void;
}

export function EntryDeleteConfirmationDialog({
  displayName,
  busy = false,
  errorMessage,
  returnFocusRef,
  onCancel,
  onDelete,
}: DeleteConfirmationDialogProps) {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <ApplicationDialog
      busy={busy}
      errorMessage={errorMessage}
      initialFocusRef={cancelRef}
      onDismiss={() => {
        if (!busy) onCancel();
      }}
      returnFocusRef={returnFocusRef}
      title={t("entry.delete.title", { name: displayName })}
    >
      <p>{t("entry.delete.body")}</p>
      <div className="application-dialog-actions conflict-dialog-actions">
        <button
          ref={cancelRef}
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          {t("dialog.cancel")}
        </button>
        <button disabled={busy} onClick={onDelete} type="button">
          {t("entry.delete.confirm")}
        </button>
      </div>
    </ApplicationDialog>
  );
}

interface DirectoryNotEmptyDialogProps {
  busy?: boolean;
  errorMessage?: string | null;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onCancel(): void;
  onReveal(): void;
}

export function DirectoryNotEmptyDialog({
  busy = false,
  errorMessage,
  returnFocusRef,
  onCancel,
  onReveal,
}: DirectoryNotEmptyDialogProps) {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <ApplicationDialog
      busy={busy}
      errorMessage={errorMessage}
      initialFocusRef={cancelRef}
      onDismiss={() => {
        if (!busy) onCancel();
      }}
      returnFocusRef={returnFocusRef}
      title={t("entry.notEmpty.title")}
    >
      <p>{t("entry.notEmpty.body")}</p>
      <div className="application-dialog-actions conflict-dialog-actions">
        <button
          ref={cancelRef}
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          {t("dialog.cancel")}
        </button>
        <button disabled={busy} onClick={onReveal} type="button">
          {t("entry.notEmpty.reveal")}
        </button>
      </div>
    </ApplicationDialog>
  );
}
