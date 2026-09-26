import {
  convertToExcalidrawElements,
  exportToBlob,
  exportToSvg,
} from "@excalidraw/excalidraw";
import type { SceneSnapshot } from "../editor/sceneSerializer";

/** Browser-only fixture that exercises the SDK's scene-embedding export path. */
export async function exportEmbeddedSceneFixture(
  scene: SceneSnapshot,
  format: "png" | "svg",
): Promise<Blob> {
  const options = {
    elements: scene.elements,
    appState: {
      ...scene.appState,
      exportEmbedScene: true,
      exportBackground: true,
    },
    files: scene.files,
  };
  return format === "png"
    ? exportToBlob({ ...options, mimeType: "image/png" })
    : new Blob([(await exportToSvg(options)).outerHTML], {
        type: "image/svg+xml",
      });
}

export function libraryRectangleFixture() {
  return convertToExcalidrawElements(
    [
      {
        id: "history-library-rectangle",
        type: "rectangle",
        x: 20,
        y: 20,
        width: 120,
        height: 80,
      },
    ],
    { regenerateIds: false },
  );
}
