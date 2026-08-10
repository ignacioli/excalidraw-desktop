import type { BinaryFiles, DataURL } from "@excalidraw/excalidraw/types";
import type { Workspace } from "../ipc/contracts";
import {
  createTauriCommandInvoker,
  hasTauriCommandRuntime,
  type CommandInvoker,
} from "../ipc/client";

export const ASSET_REFERENCE_PREFIX = "asset://";
export const ASSET_DIRECTORY_NAME = ".excalidraw_assets";

const HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

export function isAssetReference(dataUrl: string): boolean {
  return dataUrl.startsWith(ASSET_REFERENCE_PREFIX);
}

export function hashFromReference(reference: string): string | null {
  const hash = reference.slice(ASSET_REFERENCE_PREFIX.length);
  return HASH_PATTERN.test(hash) ? hash : null;
}

export function assetPathFor(assetRoot: string, hash: string): string {
  return `${assetRoot}/${ASSET_DIRECTORY_NAME}/${hash}`;
}

/**
 * Converts `asset://<sha256>` references in `files` into renderable base64
 * data URLs by reading the workspace asset store through Tauri's asset
 * protocol. The persisted scene is not touched here: the document keeps its
 * internal references and the backend re-externalizes the resolved payloads
 * back to the same references on the next save.
 *
 * Browser-only test environments (no Tauri runtime) receive the files
 * unchanged so existing unit tests keep passing.
 */
export async function resolveAssetFiles(
  files: BinaryFiles,
  documentPath: string | undefined,
  invoker: CommandInvoker = createTauriCommandInvoker(),
): Promise<BinaryFiles> {
  if (!hasTauriCommandRuntime() || !hasAssetReferences(files)) {
    return files;
  }
  const assetRoot = await resolveAssetRoot(documentPath, invoker);
  if (assetRoot === null) {
    return files;
  }

  const resolved: BinaryFiles = {};
  await Promise.all(
    Object.entries(files).map(async ([id, file]) => {
      if (!isAssetReference(file.dataURL)) {
        resolved[id] = file;
        return;
      }
      const hash = hashFromReference(file.dataURL);
      if (hash === null) {
        resolved[id] = file;
        return;
      }
      try {
        const dataUrl = await readAssetAsDataUrl(assetRoot, hash);
        resolved[id] = { ...file, dataURL: dataUrl as DataURL };
      } catch {
        // A missing or unreadable asset must not block the canvas; the
        // reference stays and the image renders as unavailable.
        resolved[id] = file;
      }
    }),
  );
  return resolved;
}

function hasAssetReferences(files: BinaryFiles): boolean {
  return Object.values(files).some((file) => isAssetReference(file.dataURL));
}

async function resolveAssetRoot(
  documentPath: string | undefined,
  invoker: CommandInvoker,
): Promise<string | null> {
  if (documentPath === undefined || documentPath.length === 0) {
    return null;
  }
  let workspaces: Workspace[];
  try {
    workspaces = await invoker.invoke("workspace_list", {});
  } catch {
    return null;
  }
  const workspace = workspaces.find((entry) =>
    isPathWithin(documentPath, entry.rootPath),
  );
  if (workspace !== undefined) {
    return workspace.rootPath;
  }
  // Mirrors the backend fallback for documents opened outside a mounted
  // workspace: the asset store sits next to the document.
  const separator = documentPath.lastIndexOf("/");
  return separator > 0 ? documentPath.slice(0, separator) : null;
}

function isPathWithin(path: string, root: string): boolean {
  if (path === root) {
    return true;
  }
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(prefix);
}

async function readAssetAsDataUrl(
  assetRoot: string,
  hash: string,
): Promise<string> {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  const absolutePath = assetPathFor(assetRoot, hash);
  const response = await fetch(convertFileSrc(absolutePath));
  if (!response.ok) {
    throw new Error(`asset request failed with status ${response.status}`);
  }
  return blobToDataUrl(await response.blob());
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read the asset blob."));
    reader.readAsDataURL(blob);
  });
}
