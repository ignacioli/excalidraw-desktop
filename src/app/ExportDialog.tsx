import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ExcalidrawAdapter } from "../editor/ExcalidrawAdapter";
import {
  exportToBlob,
  exportToSvg,
  type ExportFormat,
} from "../editor/exportService";
import { serializeScene } from "../editor/sceneSerializer";
import type { ColorScheme, CommandResponse } from "../ipc/contracts";
import {
  createTauriCommandInvoker,
  type CommandInvoker,
} from "../ipc/client";

type ExportScale = 1 | 2 | 3;
type ExportBackground = "transparent" | "solid";

interface ExportDialogProps {
  adapter: ExcalidrawAdapter;
  documentTitle: string;
  documentPath: string | null;
  defaultTheme: ColorScheme;
  invoker?: CommandInvoker;
  onClose: () => void;
}

export function ExportDialog({
  adapter,
  documentTitle,
  documentPath,
  defaultTheme,
  invoker = createTauriCommandInvoker(),
  onClose,
}: ExportDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [format, setFormat] = useState<ExportFormat>("png");
  const [scale, setScale] = useState<ExportScale>(2);
  const [background, setBackground] =
    useState<ExportBackground>("transparent");
  const [theme, setTheme] = useState<ColorScheme>(defaultTheme);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [writtenPath, setWrittenPath] = useState<string | null>(null);

  useEffect(() => {
    const firstOption = dialogRef.current?.querySelector<HTMLInputElement>(
      'input:not([disabled])',
    );
    firstOption?.focus();
  }, []);

  useEffect(() => {
    const handleGlobalEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    // Excalidraw's menus swallow Escape at document capture phase, so the
    // dialog must observe the key before it reaches the canvas internals.
    window.addEventListener("keydown", handleGlobalEscape, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleGlobalEscape, {
        capture: true,
      });
  }, [onClose]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      trapFocus(event);
    }
  };

  const runExport = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setErrorMessage(null);
    setWrittenPath(null);
    try {
      const scene = adapter.readScene();
      const sceneJson = serializeScene(scene);
      const options = { scale, background, theme };
      const blob =
        format === "png"
          ? await exportToBlob(scene, options)
          : await exportToSvg(scene, options);
      const targetPath = await chooseExportPath(documentTitle, format);
      if (targetPath === null) {
        return;
      }
      const response: CommandResponse<"doc_export"> = await invoker.invoke(
        "doc_export",
        {
          path: documentPath,
          sceneJson,
          format,
          targetPath,
          options,
          bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
        },
      );
      setWrittenPath(response.writtenPath);
    } catch (error) {
      setErrorMessage(getExportErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="export-dialog-backdrop"
      onKeyDown={handleKeyDown}
      ref={dialogRef}
      role="presentation"
    >
      <section
        aria-describedby={
          errorMessage !== null ? "export-dialog-error" : undefined
        }
        aria-labelledby="export-dialog-title"
        aria-modal="true"
        className="export-dialog"
        role="dialog"
      >
        <h1 id="export-dialog-title">Export drawing</h1>
        <p>Choose the format and appearance, then pick a destination.</p>
        <form
          aria-describedby={
            errorMessage !== null ? "export-dialog-error" : undefined
          }
          onSubmit={(event) => {
            event.preventDefault();
            void runExport();
          }}
        >
          <fieldset className="export-option-group">
            <legend>Format</legend>
            <label>
              <input
                checked={format === "png"}
                name="export-format"
                onChange={() => setFormat("png")}
                type="radio"
                value="png"
              />
              <span>PNG image</span>
            </label>
            <label>
              <input
                checked={format === "svg"}
                name="export-format"
                onChange={() => setFormat("svg")}
                type="radio"
                value="svg"
              />
              <span>SVG image</span>
            </label>
          </fieldset>

          <fieldset className="export-option-group">
            <legend>Scale</legend>
            {[1, 2, 3].map((value) => (
              <label key={value}>
                <input
                  checked={scale === value}
                  name="export-scale"
                  onChange={() => setScale(value as ExportScale)}
                  type="radio"
                  value={value}
                />
                <span>{value}x</span>
              </label>
            ))}
          </fieldset>

          <fieldset className="export-option-group">
            <legend>Background</legend>
            <label>
              <input
                checked={background === "transparent"}
                name="export-background"
                onChange={() => setBackground("transparent")}
                type="radio"
                value="transparent"
              />
              <span>Transparent</span>
            </label>
            <label>
              <input
                checked={background === "solid"}
                name="export-background"
                onChange={() => setBackground("solid")}
                type="radio"
                value="solid"
              />
              <span>Solid</span>
            </label>
          </fieldset>

          <fieldset className="export-option-group">
            <legend>Theme</legend>
            {(["light", "dark"] as const).map((value) => (
              <label key={value}>
                <input
                  checked={theme === value}
                  name="export-theme"
                  onChange={() => setTheme(value)}
                  type="radio"
                  value={value}
                />
                <span>{value === "light" ? "Light" : "Dark"}</span>
              </label>
            ))}
          </fieldset>

          {errorMessage !== null ? (
            <p
              aria-live="assertive"
              className="export-dialog-error"
              id="export-dialog-error"
              role="alert"
            >
              {errorMessage}
            </p>
          ) : null}
          {writtenPath !== null ? (
            <p className="export-dialog-success" role="status">
              Exported to {writtenPath}
            </p>
          ) : null}

          <div className="export-dialog-actions">
            <button
              aria-busy={busy}
              className="primary-action"
              disabled={busy}
              type="submit"
            >
              {busy ? "Exporting…" : "Export…"}
            </button>
            <button disabled={busy} onClick={onClose} type="button">
              Cancel
            </button>
          </div>
        </form>
      </section>
    </div>
  );

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

async function chooseExportPath(
  documentTitle: string,
  format: ExportFormat,
): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const baseName = documentTitle.replace(/\.[^.]+$/, "") || "drawing";
  const extension = format === "png" ? "png" : "svg";
  return save({
    defaultPath: `${baseName}.${extension}`,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    title: `Export ${format.toUpperCase()}`,
  });
}

function getExportErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    if ("code" in error && typeof error.code === "string") {
      switch (error.code) {
        case "DISK_FULL":
          return "The destination disk is full. No file was written.";
        case "IO_ERROR":
          return "The destination could not be written. No partial file was left behind.";
        case "PATH_ACCESS_DENIED":
          return "The destination is outside the allowed locations.";
        default:
          break;
      }
    }
    if ("message" in error && typeof error.message === "string") {
      return error.message;
    }
  }
  return "The export could not be completed. No file was written.";
}
