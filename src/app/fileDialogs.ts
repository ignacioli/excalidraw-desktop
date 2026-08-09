import {
  documentManager,
  type DocumentManager,
} from "../documents/documentStore";

export interface FileDialogAdapter {
  openDrawing(): Promise<string | null>;
  chooseNewDrawingPath(): Promise<string | null>;
}

export interface FileDialogActions {
  createDocument(): Promise<string | null>;
  openDocument(): Promise<string | null>;
}

const drawingFilters = [
  {
    name: "Excalidraw drawing",
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
        filters: drawingFilters,
        title: "Open drawing",
      });
      return typeof selected === "string" ? selected : null;
    },
    async chooseNewDrawingPath() {
      const { save } = await import("@tauri-apps/plugin-dialog");
      return save({
        defaultPath: "Untitled.excalidraw",
        filters: drawingFilters,
        title: "New drawing",
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
      return manager.open(selectedPath);
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
