import { useRef } from "react";
import { useI18n } from "../i18n";
import { ApplicationDialog } from "./interaction/ApplicationDialog";

interface OrphanCloseDialogProps {
  documentTitle: string;
  busy?: boolean;
  onSaveAs(): void;
  onDiscard(): void;
  onCancel(): void;
}

export function OrphanCloseDialog({
  documentTitle,
  busy = false,
  onSaveAs,
  onDiscard,
  onCancel,
}: OrphanCloseDialogProps) {
  const { t } = useI18n();
  const saveAsRef = useRef<HTMLButtonElement>(null);

  return (
    <ApplicationDialog
      title={t("dialog.orphan.title")}
      description={t("dialog.orphan.description", { title: documentTitle })}
      busy={busy}
      initialFocusRef={saveAsRef}
      onDismiss={(reason) => {
        if (reason === "action") return;
        onCancel();
      }}
    >
      <div className="conflict-dialog-actions">
        <button
          onClick={onSaveAs}
          ref={saveAsRef}
          type="button"
          disabled={busy}
        >
          {t("dialog.orphan.saveAs")}
        </button>
        <button onClick={onDiscard} type="button" disabled={busy}>
          {t("dialog.orphan.closeWithoutSaving")}
        </button>
        <button onClick={onCancel} type="button" disabled={busy}>
          {t("dialog.cancel")}
        </button>
      </div>
    </ApplicationDialog>
  );
}
