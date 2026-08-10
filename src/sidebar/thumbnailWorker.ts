import { exportToBlob, getCommonBounds } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ColorScheme } from "../ipc/contracts";
import { deserializeSceneData } from "../editor/sceneSerializer";
import {
  THUMBNAIL_HEIGHT,
  THUMBNAIL_QUALITY,
  THUMBNAIL_WIDTH,
} from "./thumbnailKey";

export interface ThumbnailWorkerRequest {
  type: "render";
  id: string;
  sceneJson: string;
  theme: ColorScheme;
}

export interface ThumbnailWorkerResponse {
  type: "result" | "unsupported";
  id: string;
  webpBytes?: number[];
}

const LIGHT_BACKGROUND = "#ffffff";
const DARK_BACKGROUND = "#1e1e1e";
const MAX_UPSCALE = 8;

/**
 * Module worker entry for thumbnail rendering. The upstream export pipeline
 * creates DOM canvases internally, so this path is only usable where the
 * bundle and the worker environment cooperate; otherwise it reports
 * `unsupported` and the renderer adapter falls back to the main thread.
 */
self.onmessage = async (event: MessageEvent<ThumbnailWorkerRequest>) => {
  const request = event.data;
  if (request.type !== "render") {
    return;
  }
  try {
    const webpBytes = await renderWebp(request.sceneJson, request.theme);
    const response: ThumbnailWorkerResponse = {
      type: "result",
      id: request.id,
      webpBytes: Array.from(webpBytes),
    };
    postMessage(response);
  } catch {
    const response: ThumbnailWorkerResponse = {
      type: "unsupported",
      id: request.id,
    };
    postMessage(response);
  }
};

async function renderWebp(
  sceneJson: string,
  theme: ColorScheme,
): Promise<Uint8Array> {
  const scene = deserializeSceneData(sceneJson);
  const elements: readonly ExcalidrawElement[] = scene.elements.filter(
    (element) => element.isDeleted !== true,
  );
  const [minX, minY, maxX, maxY] = getCommonBounds(elements);
  const boundsWidth = maxX - minX;
  const boundsHeight = maxY - minY;
  if (boundsWidth <= 0 || boundsHeight <= 0) {
    return blankThumbnail(theme);
  }

  const scale = Math.min(
    THUMBNAIL_WIDTH / boundsWidth,
    THUMBNAIL_HEIGHT / boundsHeight,
    MAX_UPSCALE,
  );
  const blob = await exportToBlob({
    elements,
    appState: { ...scene.appState, theme },
    files: scene.files,
    mimeType: "image/webp",
    quality: THUMBNAIL_QUALITY,
    exportPadding: 0,
    getDimensions: (width: number, height: number) => ({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      scale,
    }),
  });
  return new Uint8Array(await blob.arrayBuffer());
}

async function blankThumbnail(theme: ColorScheme): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("OffscreenCanvas 2D context is unavailable.");
  }
  context.fillStyle = theme === "dark" ? DARK_BACKGROUND : LIGHT_BACKGROUND;
  context.fillRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  const blob = await canvas.convertToBlob({
    type: "image/webp",
    quality: THUMBNAIL_QUALITY,
  });
  return new Uint8Array(await blob.arrayBuffer());
}
