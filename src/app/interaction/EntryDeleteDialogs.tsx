import { useRef, type RefObject } from "react";
import { useI18n } from "../../i18n";
import { abbreviateHome, useHomeDirectory } from "../../workspaces/displayPath";
import {
  ApplicationDialog,
  ApplicationDialogActions,
  ApplicationDialogButton,
} from "./ApplicationDialog";

interface DeleteConfirmationDialogProps {
  displayName: string;
  /** The entry's path, shown below the description. */
  path?: string;
  busy?: boolean;
  errorMessage?: string | null;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onCancel(): void;
  onDelete(): void;
}

/**
 * Sidebar confirmation anatomy: title, consequence, object path, error, then
 * Cancel (initial focus) → Delete, the only destructive action.
 */
export function EntryDeleteConfirmationDialog({
  displayName,
  path,
  busy = false,
  errorMessage,
  returnFocusRef,
  onCancel,
  onDelete,
}: DeleteConfirmationDialogProps) {
  const { t } = useI18n();
  const home = useHomeDirectory();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <ApplicationDialog
      actions={
        <ApplicationDialogActions>
          <ApplicationDialogButton
            buttonRef={cancelRef}
            disabled={busy}
            kind="secondary"
            onClick={onCancel}
          >
            {t("dialog.cancel")}
          </ApplicationDialogButton>
          <ApplicationDialogButton
            disabled={busy}
            kind="danger"
            onClick={onDelete}
          >
            {t("entry.delete.confirm")}
          </ApplicationDialogButton>
        </ApplicationDialogActions>
      }
      busy={busy}
      description={t("entry.delete.body")}
      errorMessage={errorMessage}
      initialFocusRef={cancelRef}
      objectPath={path === undefined ? undefined : abbreviateHome(path, home)}
      onDismiss={() => {
        if (!busy) onCancel();
      }}
      returnFocusRef={returnFocusRef}
      title={t("entry.delete.title", { name: displayName })}
      variant="sidebar"
    >
      {null}
    </ApplicationDialog>
  );
}

interface DirectoryNotEmptyDialogProps {
  /** The folder's path, shown below the description. */
  path?: string;
  busy?: boolean;
  errorMessage?: string | null;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onCancel(): void;
  onReveal(): void;
}

/** Opening the folder in Finder is not destructive: primary style. */
export function DirectoryNotEmptyDialog({
  path,
  busy = false,
  errorMessage,
  returnFocusRef,
  onCancel,
  onReveal,
}: DirectoryNotEmptyDialogProps) {
  const { t } = useI18n();
  const home = useHomeDirectory();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <ApplicationDialog
      actions={
        <ApplicationDialogActions>
          <ApplicationDialogButton
            buttonRef={cancelRef}
            disabled={busy}
            kind="secondary"
            onClick={onCancel}
          >
            {t("dialog.cancel")}
          </ApplicationDialogButton>
          <ApplicationDialogButton
            disabled={busy}
            kind="primary"
            onClick={onReveal}
          >
            {t("entry.notEmpty.reveal")}
          </ApplicationDialogButton>
        </ApplicationDialogActions>
      }
      busy={busy}
      description={t("entry.notEmpty.body")}
      errorMessage={errorMessage}
      initialFocusRef={cancelRef}
      objectPath={path === undefined ? undefined : abbreviateHome(path, home)}
      onDismiss={() => {
        if (!busy) onCancel();
      }}
      returnFocusRef={returnFocusRef}
      title={t("entry.notEmpty.title")}
      variant="sidebar"
    >
      {null}
    </ApplicationDialog>
  );
}
