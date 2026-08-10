import type { ColorScheme } from "../ipc/contracts";
import type { SceneSnapshot } from "../editor/sceneSerializer";
import {
  computeThumbnailKey,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_QUALITY,
  THUMBNAIL_WIDTH,
} from "./thumbnailKey";

export interface ThumbnailRenderResult {
  key: string;
  webpBytes: number[];
}

export interface ThumbnailRenderer {
  render(
    sceneJson: string,
    theme: ColorScheme,
  ): Promise<ThumbnailRenderResult | null>;
  dispose(): void;
}

const LIGHT_BACKGROUND = "#ffffff";
const DARK_BACKGROUND = "#1e1e1e";
const MAX_UPSCALE = 8;
const WORKER_TIMEOUT_MS = 15_000;

/**
 * Renders a 320x200 WebP thumbnail for a serialized scene. Tries a module
 * worker first; the upstream export helpers use `document.createElement`
 * internally, so when the worker cannot run them the pipeline permanently
 * falls back to the main thread.
 */
export function createThumbnailRenderer(): ThumbnailRenderer {
  return new FallbackThumbnailRenderer();
}

class FallbackThumbnailRenderer implements ThumbnailRenderer {
  private worker: Worker | null = null;
  private workerFailed = false;
  private nextRequestId = 0;

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.workerFailed = true;
  }

  async render(
    sceneJson: string,
    theme: ColorScheme,
  ): Promise<ThumbnailRenderResult | null> {
    const key = await computeThumbnailKey(sceneJson, theme);
    if (!this.workerFailed) {
      const workerBytes = await this.renderInWorker(sceneJson, theme);
      if (workerBytes !== null) {
        return { key, webpBytes: Array.from(workerBytes) };
      }
      this.workerFailed = true;
      this.worker?.terminate();
      this.worker = null;
    }
    const mainBytes = await renderThumbnailOnMainThread(sceneJson, theme);
    return mainBytes === null
      ? null
      : { key, webpBytes: Array.from(mainBytes) };
  }

  private renderInWorker(
    sceneJson: string,
    theme: ColorScheme,
  ): Promise<Uint8Array | null> {
    if (typeof Worker === "undefined") {
      return Promise.resolve(null);
    }
    try {
      const worker = this.ensureWorker();
      if (worker === null) {
        return Promise.resolve(null);
      }
      const requestId = String(this.nextRequestId++);
      return new Promise<Uint8Array | null>((resolve) => {
        const timer = window.setTimeout(() => {
          cleanup();
          resolve(null);
        }, WORKER_TIMEOUT_MS);
        const onMessage = (event: MessageEvent) => {
          const message = event.data as {
            type?: string;
            id?: string;
            webpBytes?: number[];
          };
          if (message.id !== requestId) {
            return;
          }
          cleanup();
          if (message.type === "result" && message.webpBytes !== undefined) {
            resolve(Uint8Array.from(message.webpBytes));
          } else {
            resolve(null);
          }
        };
        const cleanup = () => {
          window.clearTimeout(timer);
          worker.removeEventListener("message", onMessage);
        };
        worker.addEventListener("message", onMessage);
        worker.postMessage({
          type: "render",
          id: requestId,
          sceneJson,
          theme,
        });
      });
    } catch {
      return Promise.resolve(null);
    }
  }

  private ensureWorker(): Worker | null {
    if (this.worker !== null) {
      return this.worker;
    }
    try {
      this.worker = new Worker(
        new URL("./thumbnailWorker.ts", import.meta.url),
        { type: "module" },
      );
      return this.worker;
    } catch {
      return null;
    }
  }
}

async function renderThumbnailOnMainThread(
  sceneJson: string,
  theme: ColorScheme,
): Promise<Uint8Array | null> {
  // Lazy-load the Excalidraw export pipeline so tests and non-rendering
  // surfaces never pay for the heavy module graph.
  const [{ exportToCanvas, getCommonBounds }, { deserializeSceneData }] =
    await Promise.all([
      import("@excalidraw/excalidraw"),
      import("../editor/sceneSerializer"),
    ]);
  let scene: SceneSnapshot | undefined;
  try {
    scene = deserializeSceneData(sceneJson);
  } catch {
    return null;
  }
  if (scene === undefined) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = THUMBNAIL_WIDTH;
  canvas.height = THUMBNAIL_HEIGHT;
  const context = canvas.getContext("2d");
  if (context === null) {
    return null;
  }
  fillBackground(context, theme);

  const elements = scene.elements.filter(
    (element) => element.isDeleted !== true,
  );
  const [minX, minY, maxX, maxY] = getCommonBounds(elements);
  const boundsWidth = maxX - minX;
  const boundsHeight = maxY - minY;
  if (boundsWidth > 0 && boundsHeight > 0) {
    try {
      const scale = Math.min(
        THUMBNAIL_WIDTH / boundsWidth,
        THUMBNAIL_HEIGHT / boundsHeight,
        MAX_UPSCALE,
      );
      const exported = await exportToCanvas({
        elements,
        appState: { ...scene.appState, theme },
        files: scene.files,
        exportPadding: 0,
        getDimensions: (width: number, height: number) => ({
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
          scale,
        }),
      });
      const offsetX = Math.round((THUMBNAIL_WIDTH - exported.width) / 2);
      const offsetY = Math.round((THUMBNAIL_HEIGHT - exported.height) / 2);
      context.drawImage(exported, offsetX, offsetY);
    } catch {
      return null;
    }
  }

  return canvasToBytes(canvas);
}

function fillBackground(
  context: CanvasRenderingContext2D,
  theme: ColorScheme,
): void {
  context.fillStyle = theme === "dark" ? DARK_BACKGROUND : LIGHT_BACKGROUND;
  context.fillRect(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
}

function canvasToBytes(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  const encode = (mimeType: string) =>
    new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), mimeType, THUMBNAIL_QUALITY);
    });
  return encode("image/webp")
    .catch(() => null)
    .then(async (webp) => {
      const blob = webp ?? (await encode("image/png").catch(() => null));
      if (blob === null) {
        return null;
      }
      return new Uint8Array(await blob.arrayBuffer());
    });
}
