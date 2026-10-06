import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import {
  documentAppState,
  type SceneSnapshot,
} from "../editor/sceneSerializer";
import { adoptSceneAssets, type AssetAdoptionResult } from "./assetAdoption";

/** A scene prepared for an isolated, non-editable Excalidraw instance. */
export type ReadonlyPreviewScene = AssetAdoptionResult;

/**
 * Prepare `initialData` for a separate preview instance. This function has no
 * access to the current document adapter, document store or draft scheduler;
 * creating a preview therefore cannot write the current document as a side
 * effect.
 */
export async function createReadonlyPreviewInitialData(
  scene: SceneSnapshot,
): Promise<ReadonlyPreviewScene> {
  const adopted = await adoptSceneAssets(scene);
  return {
    ...adopted,
    appState: {
      ...adopted.appState,
      viewModeEnabled: true,
    },
  };
}

/**
 * Apply one preview scene through Excalidraw's public imperative API. Files are
 * registered before elements reference them, which avoids the SDK's stale
 * same-ID image cache. The caller is expected to pass an API belonging only to
 * the preview instance; this function never touches the current editor.
 */
export async function applyReadonlyPreview(
  api: ExcalidrawImperativeAPI,
  scene: SceneSnapshot,
): Promise<ReadonlyPreviewScene> {
  const prepared = await createReadonlyPreviewInitialData(scene);
  api.addFiles(Object.values(prepared.files));
  api.updateScene({ elements: prepared.elements });
  api.updateScene({ appState: { viewModeEnabled: true } });
  const documentState = documentAppState(prepared.appState);
  if (documentState.gridModeEnabled !== undefined) {
    api.updateScene({
      appState: { gridModeEnabled: documentState.gridModeEnabled },
    });
  }
  if (documentState.gridSize !== undefined) {
    api.updateScene({ appState: { gridSize: documentState.gridSize } });
  }
  if (documentState.gridStep !== undefined) {
    api.updateScene({ appState: { gridStep: documentState.gridStep } });
  }
  if (documentState.viewBackgroundColor !== undefined) {
    api.updateScene({
      appState: { viewBackgroundColor: documentState.viewBackgroundColor },
    });
  }
  return prepared;
}

/**
 * Small adapter used by a future HistoryPreview component. It intentionally
 * exposes only scene loading; there is no `onChange` subscription, save method
 * or route to the current document's draft queue.
 */
export class ReadonlyPreviewAdapter {
  private readonly api: ExcalidrawImperativeAPI;

  constructor(api: ExcalidrawImperativeAPI) {
    this.api = api;
  }

  load(scene: SceneSnapshot): Promise<ReadonlyPreviewScene> {
    return applyReadonlyPreview(this.api, scene);
  }
}

// Keep the shorter name available for consumers that treat preview adapters as
// a distinct surface from the current-document ExcalidrawAdapter.
export { ReadonlyPreviewAdapter as PreviewAdapter };
