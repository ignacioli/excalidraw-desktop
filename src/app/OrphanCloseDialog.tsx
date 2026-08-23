import { useRef } from "react";
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
  const saveAsRef = useRef<HTMLButtonElement>(null);

  return (
    <ApplicationDialog
      title="File is unavailable"
      description={`${documentTitle} can no longer be saved to its original location. Save it somewhere else, close without saving, or cancel.`}
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
          Save As
        </button>
        <button onClick={onDiscard} type="button" disabled={busy}>
          Close Without Saving
        </button>
        <button onClick={onCancel} type="button" disabled={busy}>
          Cancel
        </button>
      </div>
    </ApplicationDialog>
  );
}
