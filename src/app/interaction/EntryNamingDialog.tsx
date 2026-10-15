import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { describeError, errorCodeOf } from "../../i18n/describeError";
import { t as translateNow, useI18n, type MessageKey } from "../../i18n";
import {
  ApplicationDialog,
  ApplicationDialogActions,
  ApplicationDialogButton,
  ApplicationDialogField,
} from "./ApplicationDialog";

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

  // The editable name starts selected; the fixed suffix is not part of it.
  useEffect(() => {
    inputRef.current?.select();
  }, []);

  // A failed submit keeps the typed name and returns focus to the field,
  // which was disabled while submitting.
  useEffect(() => {
    if (failure !== null && !busy) inputRef.current?.focus();
  }, [failure, busy]);

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
      initialFocusRef={inputRef}
      onDismiss={() => {
        if (!busy) onCancel();
      }}
      returnFocusRef={returnFocusRef}
      title={title}
      variant="sidebar"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) void submit();
        }}
      >
        <ApplicationDialogField
          disabled={busy}
          errorMessage={error}
          inputRef={inputRef}
          label={t("entry.naming.name")}
          onChange={setValue}
          suffix={drawing ? suffix : undefined}
          suffixLabel={
            drawing ? t("entry.naming.fixedExtension", { suffix }) : undefined
          }
          value={value}
        />
        <ApplicationDialogActions>
          <ApplicationDialogButton
            disabled={busy}
            kind="secondary"
            onClick={onCancel}
          >
            {t("dialog.cancel")}
          </ApplicationDialogButton>
          <ApplicationDialogButton
            disabled={busy}
            kind="primary"
            onClick={() => {
              if (!busy) void submit();
            }}
          >
            {t(
              mode.startsWith("new")
                ? "entry.naming.create"
                : "entry.naming.rename",
            )}
          </ApplicationDialogButton>
        </ApplicationDialogActions>
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
