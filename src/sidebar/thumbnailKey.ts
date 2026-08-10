import type { ColorScheme } from "../ipc/contracts";

/**
 * Renderer version that participates in the content-addressed cache key.
 * Bump when the thumbnail pipeline changes so stale thumbnails regenerate.
 */
export const THUMBNAIL_RENDERER_VERSION = "excalidraw-0.18.1";

export const THUMBNAIL_WIDTH = 320;
export const THUMBNAIL_HEIGHT = 200;
export const THUMBNAIL_QUALITY = 0.8;

/**
 * Cache key for a thumbnail: SHA-256 of the serialized scene JSON, the
 * renderer version, and the theme. Shared by the worker and the main thread
 * so both sides always agree on what is cached under which key.
 */
export async function computeThumbnailKey(
  sceneJson: string,
  theme: ColorScheme,
): Promise<string> {
  const input = `${sceneJson}|${THUMBNAIL_RENDERER_VERSION}|${theme}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return bytesToHex(new Uint8Array(digest));
}

export function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, "0");
  }
  return result;
}
