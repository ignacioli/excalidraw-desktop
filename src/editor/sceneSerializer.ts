import { restore, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

export interface SceneSnapshot {
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
}

export class SceneSerializationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SceneSerializationError";
  }
}

export function createEmptyScene(): SceneSnapshot {
  return { elements: [], appState: {}, files: {} };
}

export function serializeScene(scene: SceneSnapshot): string {
  return serializeAsJSON(scene.elements, scene.appState, scene.files, "local");
}

export function deserializeScene(sceneJson: string): SceneSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sceneJson);
  } catch (error) {
    throw new SceneSerializationError("The drawing is not valid JSON.", {
      cause: error,
    });
  }

  if (!isSerializedExcalidrawScene(parsed)) {
    throw new SceneSerializationError(
      "The drawing is not a supported Excalidraw scene.",
    );
  }

  try {
    const restored = restore(parsed, null, null);
    return {
      elements: restored.elements,
      appState: {
        gridModeEnabled: restored.appState.gridModeEnabled,
        gridSize: restored.appState.gridSize,
        gridStep: restored.appState.gridStep,
        viewBackgroundColor: restored.appState.viewBackgroundColor,
      },
      files: restored.files,
    };
  } catch (error) {
    throw new SceneSerializationError(
      "The drawing contains invalid Excalidraw data.",
      { cause: error },
    );
  }
}

export function deserializeSceneData(scene: unknown): SceneSnapshot {
  if (typeof scene === "string") {
    return deserializeScene(scene);
  }

  try {
    return deserializeScene(JSON.stringify(scene));
  } catch (error) {
    if (error instanceof SceneSerializationError) {
      throw error;
    }
    throw new SceneSerializationError("The drawing could not be decoded.", {
      cause: error,
    });
  }
}

function isSerializedExcalidrawScene(
  value: unknown,
): value is ImportedDataState {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return (
    "type" in value &&
    value.type === "excalidraw" &&
    "version" in value &&
    typeof value.version === "number" &&
    "elements" in value &&
    Array.isArray(value.elements) &&
    (!("appState" in value) ||
      value.appState === undefined ||
      value.appState === null ||
      (typeof value.appState === "object" && !Array.isArray(value.appState))) &&
    (!("files" in value) ||
      value.files === undefined ||
      (typeof value.files === "object" &&
        value.files !== null &&
        !Array.isArray(value.files)))
  );
}
