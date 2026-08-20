import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { IpcError } from "../../ipc/contracts";
import { ApplicationDialog } from "./ApplicationDialog";

export type EntryNamingMode =
  "newDrawing" | "newDirectory" | "renameDrawing" | "renameDirectory";

interface EntryNamingDialogProps {
  mode: EntryNamingMode;
  currentName?: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onCancel(): void;
  onSubmit(baseName: string): Promise<void>;
}

export function EntryNamingDialog({
  mode,
  currentName,
  returnFocusRef,
  onCancel,
  onSubmit,
}: EntryNamingDialogProps) {
  const drawing = mode === "newDrawing" || mode === "renameDrawing";
  const suffix = drawing ? drawingSuffix(currentName) : "";
  const initial = useMemo(
    () =>
      mode === "newDrawing"
        ? "Untitled"
        : mode === "newDirectory"
          ? "Untitled Folder"
          : drawing
            ? stripDrawingSuffix(currentName ?? "")
            : (currentName ?? ""),
    [currentName, drawing, mode],
  );
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const extensionId = useId();

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value);
    } catch (reason) {
      const ipc = reason as Partial<IpcError>;
      setError(
        ipc.code === "NAME_CONFLICT"
          ? "An entry with that name already exists."
          : ipc.code === "INVALID_NAME"
            ? "Enter a valid name."
            : reason instanceof Error
              ? reason.message
              : "The entry could not be saved.",
      );
      setBusy(false);
    }
  };

  const title =
    mode === "newDrawing"
      ? "New drawing"
      : mode === "newDirectory"
        ? "New folder"
        : mode === "renameDrawing"
          ? "Rename drawing"
          : "Rename folder";

  return (
    <ApplicationDialog
      busy={busy}
      errorMessage={error}
      initialFocusRef={inputRef}
      onDismiss={onCancel}
      returnFocusRef={returnFocusRef}
      title={title}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void submit();
        }}
      >
        <label htmlFor={inputId}>Name</label>
        <span className="entry-name-input-row">
          <input
            ref={inputRef}
            id={inputId}
            aria-describedby={drawing ? extensionId : undefined}
            disabled={busy}
            onChange={(event) => setValue(event.currentTarget.value)}
            value={value}
          />
          {drawing ? (
            <span id={extensionId} aria-label={`Fixed extension ${suffix}`}>
              {suffix}
            </span>
          ) : null}
        </span>
        <div className="application-dialog-actions conflict-dialog-actions">
          <button disabled={busy} onClick={onCancel} type="button">
            Cancel
          </button>
          <button disabled={busy} type="submit">
            {mode.startsWith("new") ? "Create" : "Rename"}
          </button>
        </div>
      </form>
    </ApplicationDialog>
  );
}

function drawingSuffix(name: string | undefined): string {
  return name?.toLowerCase().endsWith(".excalidraw.json")
    ? ".excalidraw.json"
    : ".excalidraw";
}

function stripDrawingSuffix(name: string): string {
  return name.replace(/\.excalidraw(?:\.json)?$/i, "");
}
