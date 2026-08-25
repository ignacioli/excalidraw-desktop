import { useRef, type RefObject } from "react";
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
      title={`Delete ${displayName}?`}
    >
      <p>This item will be moved to the operating-system Trash.</p>
      <div className="application-dialog-actions conflict-dialog-actions">
        <button
          ref={cancelRef}
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button disabled={busy} onClick={onDelete} type="button">
          Delete
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
      title="Folder isn’t empty"
    >
      <p>
        Hidden or unsupported items may exist. Excalidraw Desktop never deletes
        non-empty folders.
      </p>
      <div className="application-dialog-actions conflict-dialog-actions">
        <button
          ref={cancelRef}
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button disabled={busy} onClick={onReveal} type="button">
          Open in Finder
        </button>
      </div>
    </ApplicationDialog>
  );
}
