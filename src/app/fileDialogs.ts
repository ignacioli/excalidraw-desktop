import {
  documentManager,
  type DocumentManager,
} from "../documents/documentStore";
import { t } from "../i18n";

export interface FileDialogAdapter {
  openDrawing(): Promise<string | null>;
  chooseNewDrawingPath(): Promise<string | null>;
}

export interface FileDialogActions {
  createDocument(): Promise<string | null>;
  openDocument(): Promise<string | null>;
}

const drawingFilters = () => [
  {
    name: t("shell.dialog.drawingFilter"),
    extensions: ["excalidraw", "excalidraw.json"],
  },
];

export function createTauriFileDialogAdapter(): FileDialogAdapter {
  return {
    async openDrawing() {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: false,
        multiple: false,
        filters: drawingFilters(),
        title: t("shell.dialog.openDrawing"),
      });
      return typeof selected === "string" ? selected : null;
    },
    async chooseNewDrawingPath() {
      const { save } = await import("@tauri-apps/plugin-dialog");
      return save({
        defaultPath: `${t("tabs.untitled")}.excalidraw`,
        filters: drawingFilters(),
        title: t("shell.dialog.newDrawing"),
      });
    },
  };
}

export function createFileDialogActions(
  dialogs: FileDialogAdapter,
  manager: DocumentManager,
): FileDialogActions {
  return {
    async createDocument() {
      const selectedPath = await dialogs.chooseNewDrawingPath();
      if (selectedPath === null) {
        return null;
      }
      return manager.create(ensureDrawingExtension(selectedPath));
    },
    async openDocument() {
      const selectedPath = await dialogs.openDrawing();
      if (selectedPath === null) {
        return null;
      }
      return manager.openRouted(selectedPath);
    },
  };
}

function ensureDrawingExtension(path: string): string {
  if (/\.excalidraw(?:\.json)?$/i.test(path)) {
    return path;
  }
  return `${path}.excalidraw`;
}

export const fileDialogActions = createFileDialogActions(
  createTauriFileDialogAdapter(),
  documentManager,
);
