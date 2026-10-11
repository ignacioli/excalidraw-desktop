import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { describeError, errorCodeOf } from "../../i18n/describeError";
import { t as translateNow, useI18n, type MessageKey } from "../../i18n";
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
  const { t } = useI18n();
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
  const [failure, setFailure] = useState<{ reason: unknown } | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const extensionId = useId();

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const submit = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await onSubmit(value);
    } catch (reason) {
      setFailure({ reason });
      setBusy(false);
    }
  };

  const title = t(
    mode === "newDrawing"
      ? "entry.naming.newDrawing"
      : mode === "newDirectory"
        ? "entry.naming.newFolder"
        : mode === "renameDrawing"
          ? "entry.naming.renameDrawing"
          : "entry.naming.renameFolder",
  );
  const error = failure === null ? null : namingDialogError(failure.reason);

  return (
    <ApplicationDialog
      busy={busy}
      errorMessage={error}
      initialFocusRef={inputRef}
      onDismiss={() => {
        if (!busy) onCancel();
      }}
      returnFocusRef={returnFocusRef}
      title={title}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void submit();
        }}
      >
        <label htmlFor={inputId}>{t("entry.naming.name")}</label>
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
            <span
              id={extensionId}
              aria-label={t("entry.naming.fixedExtension", { suffix })}
            >
              {suffix}
            </span>
          ) : null}
        </span>
        <div className="application-dialog-actions conflict-dialog-actions">
          <button disabled={busy} onClick={onCancel} type="button">
            {t("dialog.cancel")}
          </button>
          <button disabled={busy} type="submit">
            {t(
              mode.startsWith("new")
                ? "entry.naming.create"
                : "entry.naming.rename",
            )}
          </button>
        </div>
      </form>
    </ApplicationDialog>
  );
}

const NAMING_ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  NAME_CONFLICT: "entry.naming.error.nameConflict",
  INVALID_NAME: "entry.naming.error.invalidName",
  PATH_ACCESS_DENIED: "entry.naming.error.outsideWorkspace",
};

function namingDialogError(reason: unknown): string {
  const code = errorCodeOf(reason);
  const contextual = code === undefined ? undefined : NAMING_ERROR_KEYS[code];
  return contextual !== undefined
    ? translateNow(contextual)
    : describeError(reason, "entry.naming.error.saveFailed");
}

function drawingSuffix(name: string | undefined): string {
  return name?.toLowerCase().endsWith(".excalidraw.json")
    ? ".excalidraw.json"
    : ".excalidraw";
}

function stripDrawingSuffix(name: string): string {
  return name.replace(/\.excalidraw(?:\.json)?$/i, "");
}
