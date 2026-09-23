import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  NormalizedZoomValue,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { documentAppState, type SceneSnapshot } from "./sceneSerializer";
import { adoptSceneAssets } from "../history/assetAdoption";

export type SceneChangeListener = (scene: SceneSnapshot) => void;
export type AssetFileResolver = (files: BinaryFiles) => Promise<BinaryFiles>;

export class ExcalidrawAdapter {
  private readonly api: ExcalidrawImperativeAPI;
  private readonly subscriptions = new Set<() => void>();
  private readonly resolveFiles: AssetFileResolver | undefined;

  constructor(api: ExcalidrawImperativeAPI, resolveFiles?: AssetFileResolver) {
    this.api = api;
    this.resolveFiles = resolveFiles;
  }

  readScene(): SceneSnapshot {
    return {
      elements: this.api.getSceneElementsIncludingDeleted(),
      appState: this.api.getAppState(),
      files: this.api.getFiles(),
    };
  }

  async replaceScene(scene: SceneSnapshot): Promise<void> {
    const files = this.resolveFiles
      ? await this.resolveFiles(scene.files)
      : scene.files;
    const adopted = await adoptSceneAssets({ ...scene, files });

    // Excalidraw keeps the first file registered for an SDK file ID. Register
    // content-derived files before applying elements so a restored image can
    // never render stale bytes from a previous scene.
    this.api.addFiles(Object.values(adopted.files));
    this.api.updateScene({ elements: adopted.elements });
    const documentState = documentAppState(adopted.appState);
    if (documentState.gridModeEnabled !== undefined) {
      this.api.updateScene({
        appState: { gridModeEnabled: documentState.gridModeEnabled },
      });
    }
    if (documentState.gridSize !== undefined) {
      this.api.updateScene({ appState: { gridSize: documentState.gridSize } });
    }
    if (documentState.gridStep !== undefined) {
      this.api.updateScene({ appState: { gridStep: documentState.gridStep } });
    }
    if (documentState.viewBackgroundColor !== undefined) {
      this.api.updateScene({
        appState: {
          viewBackgroundColor: documentState.viewBackgroundColor,
        },
      });
    }
  }

  setReadOnly(readOnly: boolean): void {
    this.api.updateScene({ appState: { viewModeEnabled: readOnly } });
  }

  isEditable(): boolean {
    return !this.api.getAppState().viewModeEnabled;
  }

  getLiveElementCount(): number {
    return this.api.getSceneElements().length;
  }

  applyPerformanceViewport(seed: number, frameIndex: number): void {
    const phase = ((seed + frameIndex) % 240) / 240;
    const radians = phase * Math.PI * 2;
    this.api.updateScene({
      appState: {
        scrollX: Math.cos(radians) * 180,
        scrollY: Math.sin(radians) * 120,
        zoom: { value: normalizeZoom(1) },
      },
    });
  }

  applyPerformanceEdit(seed: number, editIndex: number): boolean {
    const elements = this.api.getSceneElements();
    if (elements.length === 0) {
      return false;
    }

    const targetIndex = positiveModulo(seed + editIndex, elements.length);
    const target = elements[targetIndex];
    const direction = editIndex % 2 === 0 ? 1 : -1;
    const updated = {
      ...target,
      x: target.x + direction,
      y: target.y - direction,
      version: target.version + 1,
      versionNonce: deterministicNonce(seed, editIndex),
      updated: target.updated + 1,
    };
    const nextElements = elements.slice();
    nextElements[targetIndex] = updated;
    this.api.updateScene({ elements: nextElements });
    return true;
  }

  subscribe(listener: SceneChangeListener): () => void {
    const unsubscribe = this.api.onChange(
      (
        elements: readonly ExcalidrawElement[],
        appState: AppState,
        files: BinaryFiles,
      ) => listener({ elements, appState, files }),
    );
    this.subscriptions.add(unsubscribe);

    return () => {
      unsubscribe();
      this.subscriptions.delete(unsubscribe);
    };
  }

  dispose(): void {
    this.subscriptions.forEach((unsubscribe) => unsubscribe());
    this.subscriptions.clear();
  }

  refresh(): void {
    this.api.refresh();
  }
}

function normalizeZoom(value: number): NormalizedZoomValue {
  const normalized = Math.min(2, Math.max(0.25, value));
  return normalized as NormalizedZoomValue;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function deterministicNonce(seed: number, index: number): number {
  return (
    (Math.imul(seed ^ (index + 1), 1_664_525) + 1_013_904_223) & 0x7fff_ffff
  );
}
