import {
  exportToBlob as exportSceneToBlob,
  exportToSvg as exportSceneToSvg,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";
import type { ColorScheme, ExportOptions } from "../ipc/contracts";
import type { SceneSnapshot } from "./sceneSerializer";

export type ExportFormat = "png" | "svg";

export class ExportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExportError";
  }
}

export function exportToBlob(
  scene: SceneSnapshot,
  options: ExportOptions,
): Promise<Blob> {
  const scale = options.scale ?? 1;
  return exportSceneToBlob({
    elements: visibleElements(scene.elements),
    appState: buildExportAppState(scene, options),
    files: scene.files,
    mimeType: "image/png",
    getDimensions: (width: number, height: number) => ({
      width: Math.round(width * scale),
      height: Math.round(height * scale),
      scale,
    }),
  });
}

export async function exportToSvg(
  scene: SceneSnapshot,
  options: ExportOptions,
): Promise<Blob> {
  const svg = await exportSceneToSvg({
    elements: visibleElements(scene.elements),
    appState: buildExportAppState(scene, options),
    files: scene.files,
  });
  const markup = new XMLSerializer().serializeToString(svg);
  assertEmbeddedFonts(markup, scene.elements);
  return new Blob([markup], { type: "image/svg+xml" });
}

function buildExportAppState(
  scene: SceneSnapshot,
  options: ExportOptions,
): Partial<AppState> {
  const solid = options.background === "solid";
  return {
    ...scene.appState,
    theme: resolveTheme(scene.appState, options.theme),
    exportBackground: solid,
    ...(solid ? { viewBackgroundColor: solidBackgroundColor(scene) } : {}),
  };
}

function resolveTheme(
  appState: Partial<AppState>,
  preferred: ColorScheme | undefined,
): ColorScheme {
  if (preferred !== undefined) {
    return preferred;
  }
  return appState.theme === "dark" ? "dark" : "light";
}

function solidBackgroundColor(scene: SceneSnapshot): string {
  const sceneColor = scene.appState.viewBackgroundColor;
  if (
    typeof sceneColor === "string" &&
    sceneColor !== "" &&
    sceneColor !== "transparent"
  ) {
    return sceneColor;
  }
  return "#ffffff";
}

function visibleElements(
  elements: readonly ExcalidrawElement[],
): readonly ExcalidrawElement[] {
  return elements.filter((element) => element.isDeleted !== true);
}

function assertEmbeddedFonts(
  markup: string,
  elements: readonly ExcalidrawElement[],
): void {
  if (!elements.some((element) => element.type === "text")) {
    return;
  }
  if (!markup.includes("data:font/woff2")) {
    throw new ExportError(
      "The SVG export did not embed the drawing fonts. The export was not written.",
    );
  }
}
