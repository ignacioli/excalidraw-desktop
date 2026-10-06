import type {
  BinaryFileData,
  BinaryFiles,
  DataURL,
} from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/excalidraw/element/types";
import {
  documentAppState,
  type SceneSnapshot,
} from "../editor/sceneSerializer";

const DATA_URL_PATTERN = /^data:([^;,]+)?((?:;[^,]*)*),(.*)$/su;
const BASE64_FLAG = /(?:^|;)base64(?:;|$)/u;
const SHA_256_PREFIX = "sha256-";

/**
 * A display-bound scene has file IDs derived from bytes rather than from the
 * SDK's source file IDs. Excalidraw's public `addFiles` API intentionally does
 * not replace an existing file with the same ID, so a history scene must not
 * reuse an ID whose bytes may already be cached by the preview/editor.
 */
export interface AssetAdoptionResult extends SceneSnapshot {
  readonly fileIdBySourceId: ReadonlyMap<string, string>;
  readonly contentHashByFileId: ReadonlyMap<string, string>;
}

export class AssetAdoptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AssetAdoptionError";
  }
}

/**
 * Adopt every displayable binary file into a stable, content-derived ID and
 * rewrite image elements to point at the adopted file. The input scene and
 * every input object are left untouched; this is important because the same
 * immutable snapshot may still be referenced by history metadata or by the
 * current document session.
 */
export async function adoptSceneAssets(
  scene: SceneSnapshot,
): Promise<AssetAdoptionResult> {
  const sourceIds = Object.keys(scene.files);
  const fileIdBySourceId = new Map<string, string>();
  const contentHashByFileId = new Map<string, string>();
  const adoptedFiles: BinaryFiles = {};

  for (const sourceId of sourceIds) {
    const file = scene.files[sourceId];
    if (file === undefined) {
      continue;
    }

    // Unresolved workspace references are not bytes. Keep their identity so a
    // caller can surface the unavailable-resource state instead of silently
    // treating the reference string as an image payload.
    if (!file.dataURL.startsWith("data:")) {
      fileIdBySourceId.set(sourceId, sourceId);
      adoptedFiles[sourceId] = {
        ...file,
        id: sourceId as BinaryFileData["id"],
      };
      continue;
    }

    let bytes: Uint8Array;
    try {
      bytes = decodeDataUrl(file.dataURL);
    } catch (error) {
      throw new AssetAdoptionError(
        `The image file ${sourceId} could not be decoded for adoption.`,
        { cause: error },
      );
    }

    const contentHash = await sha256Hex(bytes);
    const adoptedId = `${SHA_256_PREFIX}${contentHash}`;
    fileIdBySourceId.set(sourceId, adoptedId);
    contentHashByFileId.set(adoptedId, contentHash);

    // Content-addressing also deduplicates repeated files in one scene. Keep
    // the first metadata record; all records with the same hash have identical
    // bytes, while MIME metadata is only used by the renderer.
    if (adoptedFiles[adoptedId] === undefined) {
      adoptedFiles[adoptedId] = {
        ...file,
        id: adoptedId as BinaryFileData["id"],
      };
    }
  }

  const adoptedElements = scene.elements.map((element) => {
    if (element.type !== "image" || element.fileId === null) {
      return element;
    }
    const adoptedId = fileIdBySourceId.get(element.fileId);
    return adoptedId === undefined || adoptedId === element.fileId
      ? element
      : { ...element, fileId: adoptedId as FileId };
  });

  return {
    elements: adoptedElements,
    appState: documentAppState(scene.appState),
    files: adoptedFiles,
    fileIdBySourceId,
    contentHashByFileId,
  };
}

/** Return the canonical display ID for a SHA-256 content digest. */
export function fileIdForContentHash(contentHash: string): string {
  if (!/^[0-9a-f]{64}$/u.test(contentHash)) {
    throw new AssetAdoptionError("Asset content hash must be SHA-256 hex.");
  }
  return `${SHA_256_PREFIX}${contentHash}`;
}

function decodeDataUrl(dataUrl: DataURL): Uint8Array {
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (match === null) {
    throw new Error("invalid data URL");
  }

  const metadata = match[2] ?? "";
  const payload = match[3] ?? "";
  if (BASE64_FLAG.test(metadata)) {
    return decodeBase64(payload);
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(payload);
  } catch {
    decoded = payload;
  }
  return new TextEncoder().encode(decoded);
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s+/gu, "");
  if (
    normalized.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized)
  ) {
    throw new Error("invalid base64 data URL payload");
  }

  // `atob` is available in browsers, WebKit and the supported test runtime.
  // Keep the conversion local so the adapter remains browser-compatible and
  // does not pull a Node-only Buffer dependency into the renderer bundle.
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle !== undefined) {
    const ownedBytes = new Uint8Array(bytes.byteLength);
    ownedBytes.set(bytes);
    const digest = await subtle.digest("SHA-256", ownedBytes.buffer);
    return bytesToHex(new Uint8Array(digest));
  }
  // The supported browser targets expose Web Crypto. This fallback makes the
  // pure adapter usable in older test shims without weakening the ID contract.
  return sha256Fallback(bytes);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

// Minimal SHA-256 fallback for non-Web-Crypto test shims. It is intentionally
// private; callers should rely on the content-derived ID, not the algorithm's
// implementation details.
function sha256Fallback(input: Uint8Array): string {
  const words = new Uint32Array(64);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const bitLength = input.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const value = words[index - 15];
      const sigma0 =
        ((value >>> 7) | (value << 25)) ^
        ((value >>> 18) | (value << 14)) ^
        (value >>> 3);
      const previous = words[index - 2];
      const sigma1 =
        ((previous >>> 17) | (previous << 15)) ^
        ((previous >>> 19) | (previous << 13)) ^
        (previous >>> 10);
      words[index] =
        (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const temp1 =
        (h + bigSigma1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const bigSigma0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join(
    "",
  );
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
