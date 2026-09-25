import { loadFromBlob } from "@excalidraw/excalidraw";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import {
  deserializeScene,
  documentAppState,
  serializeScene,
  type SceneSnapshot,
} from "../editor/sceneSerializer";

export type ImportFile = Blob & { readonly name?: string };
export type ImportSelection =
  ImportFile | FileList | readonly ImportFile[] | null | undefined;

export type ImportFormat = "excalidraw" | "png" | "svg";

export interface ImportedSceneCandidate {
  readonly kind: "import";
  readonly format: ImportFormat;
  readonly sourceName: string;
  readonly scene: SceneSnapshot;
  /** Canonical JSON produced after official parsing, never caller supplied. */
  readonly candidateSceneJson: string;
}

export type ImportPreparation =
  | { readonly status: "cancelled" }
  | { readonly status: "multiple"; readonly count: number }
  | { readonly status: "ordinaryImage"; readonly file: ImportFile }
  | {
      readonly status: "candidate";
      readonly candidate: ImportedSceneCandidate;
    };

export class ImportProtectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImportProtectionError";
  }
}

/**
 * Resolve the native chooser/drop result without starting a destructive
 * operation. Cancellation and multi-file selections are explicit outcomes so
 * callers cannot accidentally pass the first item to history_replace.
 */
export async function prepareImport(
  selection: ImportSelection,
): Promise<ImportPreparation> {
  const file = selectOne(selection);
  if (file.status !== "one") {
    return file;
  }

  const format = formatFor(file.file);
  if (format === undefined) {
    throw new ImportProtectionError(
      "Only .excalidraw drawings and PNG/SVG files are supported.",
    );
  }

  if (format === "png" || format === "svg") {
    try {
      return {
        status: "candidate",
        candidate: await parseEmbeddedScene(file.file, format),
      };
    } catch (error) {
      // A PNG/SVG without Excalidraw metadata is an ordinary image and must
      // remain on the existing single-insert path. It is never a protected
      // replacement candidate.
      if (error instanceof ImportProtectionError) {
        return { status: "ordinaryImage", file: file.file };
      }
      throw error;
    }
  }

  return {
    status: "candidate",
    candidate: await parseExcalidraw(file.file),
  };
}

/** Parse one supported file into a canonical, backend-verifiable candidate. */
export async function parseImportCandidate(
  file: ImportFile,
): Promise<
  ImportedSceneCandidate | { status: "ordinaryImage"; file: ImportFile }
> {
  const format = formatFor(file);
  if (format === undefined) {
    throw new ImportProtectionError(
      "Only .excalidraw drawings and PNG/SVG files are supported.",
    );
  }
  if (format === "excalidraw") {
    return parseExcalidraw(file);
  }
  try {
    return await parseEmbeddedScene(file, format);
  } catch (error) {
    if (error instanceof ImportProtectionError) {
      return { status: "ordinaryImage", file };
    }
    throw error;
  }
}

export function importTarget(candidate: ImportedSceneCandidate): {
  kind: "import";
  candidateSceneJson: string;
} {
  return {
    kind: "import",
    candidateSceneJson: candidate.candidateSceneJson,
  };
}

function selectOne(
  selection: ImportSelection,
):
  | { readonly status: "cancelled" }
  | { readonly status: "multiple"; readonly count: number }
  | { readonly status: "one"; readonly file: ImportFile } {
  if (selection === null || selection === undefined) {
    return { status: "cancelled" };
  }
  if (isFileList(selection)) {
    if (selection.length === 0) return { status: "cancelled" };
    if (selection.length !== 1) {
      return { status: "multiple", count: selection.length };
    }
    const file = selection.item(0);
    return file === null ? { status: "cancelled" } : { status: "one", file };
  }
  if (isImportFileArray(selection)) {
    if (selection.length === 0) return { status: "cancelled" };
    if (selection.length !== 1) {
      return { status: "multiple", count: selection.length };
    }
    const file = selection[0];
    return file === undefined
      ? { status: "cancelled" }
      : { status: "one", file };
  }
  return { status: "one", file: selection };
}

function isFileList(value: ImportSelection): value is FileList {
  return typeof FileList !== "undefined" && value instanceof FileList;
}

function isImportFileArray(
  value: ImportSelection,
): value is readonly ImportFile[] {
  return Array.isArray(value);
}

function formatFor(file: ImportFile): ImportFormat | undefined {
  const name = file.name?.toLowerCase() ?? "";
  if (name.endsWith(".excalidraw") || name.endsWith(".excalidraw.json")) {
    return "excalidraw";
  }
  if (name.endsWith(".png") || file.type === "image/png") return "png";
  if (name.endsWith(".svg") || file.type === "image/svg+xml") return "svg";
  return undefined;
}

async function parseExcalidraw(
  file: ImportFile,
): Promise<ImportedSceneCandidate> {
  let scene: SceneSnapshot;
  try {
    scene = deserializeScene(await file.text());
  } catch (error) {
    throw new ImportProtectionError(
      "The selected Excalidraw drawing is invalid.",
      { cause: error },
    );
  }
  return toCandidate(file, "excalidraw", scene);
}

async function parseEmbeddedScene(
  file: ImportFile,
  format: "png" | "svg",
): Promise<ImportedSceneCandidate> {
  let restored: ImportedDataState;
  try {
    restored = await loadFromBlob(file, null, null);
  } catch (error) {
    throw new ImportProtectionError(
      `The selected ${format.toUpperCase()} does not contain an Excalidraw scene.`,
      { cause: error },
    );
  }
  const scene: SceneSnapshot = {
    elements: restored.elements ?? [],
    appState: documentAppState(restored.appState ?? {}),
    files: restored.files ?? {},
  };
  return toCandidate(file, format, scene);
}

function toCandidate(
  file: ImportFile,
  format: ImportFormat,
  scene: SceneSnapshot,
): ImportedSceneCandidate {
  return {
    kind: "import",
    format,
    sourceName: file.name ?? "import",
    scene,
    candidateSceneJson: serializeScene(scene),
  };
}
