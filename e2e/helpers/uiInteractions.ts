import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import {
  cleanupIsolatedDesktopPaths,
  createIsolatedDesktopPaths,
  type IsolatedDesktopPaths,
} from "./app";

const ISOLATED_ROOT_PREFIX = "excalidraw-desktop-e2e-";
const DEFAULT_SENTINEL_NAME = "delete-sentinel.excalidraw";
const EMPTY_DRAWING = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "excalidraw-desktop-ui-interaction-e2e",
  elements: [],
  appState: {},
  files: {},
});

export type NativeUiInteractionEntrySeed =
  | { kind: "drawing"; relativePath: string; sceneJson?: string }
  | { kind: "directory"; relativePath: string }
  | { kind: "file"; relativePath: string; contents?: string };

export interface NativeUiInteractionFixture {
  paths: IsolatedDesktopPaths;
  workspaceRoot: string;
  sentinelPath: string;
  pathFor(relativePath: string): string;
  writeDrawing(relativePath: string, sceneJson?: string): Promise<string>;
  writeFile(relativePath: string, contents?: string): Promise<string>;
  createDirectory(relativePath: string): Promise<string>;
  cleanup(): Promise<void>;
}

/** Lexically rejects absolute paths, traversal, and the Workspace Root itself. */
export function resolveNativeUiInteractionEntryPath(
  workspaceRoot: string,
  relativePath: string,
): string {
  if (isAbsolute(relativePath) || relativePath.length === 0) {
    throw new Error(`Unsafe native UI fixture entry path: ${relativePath}`);
  }
  const candidate = resolve(workspaceRoot, relativePath);
  const fromWorkspace = relative(workspaceRoot, candidate);
  if (
    fromWorkspace.length === 0 ||
    fromWorkspace === ".." ||
    fromWorkspace.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    ) ||
    isAbsolute(fromWorkspace)
  ) {
    throw new Error(
      `Native UI fixture entry escaped its Workspace: ${relativePath}`,
    );
  }
  return candidate;
}

async function assertIsolatedRoot(paths: IsolatedDesktopPaths): Promise<void> {
  const temporaryRoot = await realpath(tmpdir());
  const expectedParent = resolve(temporaryRoot);
  const actualParent = resolve(dirname(paths.root));
  if (
    actualParent !== expectedParent ||
    !basename(paths.root).startsWith(ISOLATED_ROOT_PREFIX)
  ) {
    throw new Error(`Refusing unsafe native UI fixture root: ${paths.root}`);
  }
  const workspaceFromRoot = relative(paths.root, paths.workspace);
  if (
    workspaceFromRoot.length === 0 ||
    workspaceFromRoot === ".." ||
    workspaceFromRoot.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    ) ||
    isAbsolute(workspaceFromRoot)
  ) {
    throw new Error(
      `Native UI fixture Workspace escaped its root: ${paths.workspace}`,
    );
  }
}

export async function createNativeUiInteractionFixture(
  entries: readonly NativeUiInteractionEntrySeed[] = [],
): Promise<NativeUiInteractionFixture> {
  const paths = await createIsolatedDesktopPaths();
  await assertIsolatedRoot(paths);
  let cleaned = false;

  const pathFor = (relativePath: string): string =>
    resolveNativeUiInteractionEntryPath(paths.workspace, relativePath);
  const createDirectory = async (relativePath: string): Promise<string> => {
    const target = pathFor(relativePath);
    await mkdir(target, { recursive: true });
    return target;
  };
  const writeFixtureFile = async (
    relativePath: string,
    contents = "fixture",
  ): Promise<string> => {
    const target = pathFor(relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, { encoding: "utf8", flag: "wx" });
    return target;
  };
  const writeDrawing = (relativePath: string, sceneJson = EMPTY_DRAWING) =>
    writeFixtureFile(relativePath, sceneJson);

  try {
    for (const entry of entries) {
      if (entry.kind === "directory") {
        await createDirectory(entry.relativePath);
      } else if (entry.kind === "drawing") {
        await writeDrawing(entry.relativePath, entry.sceneJson);
      } else {
        await writeFixtureFile(entry.relativePath, entry.contents);
      }
    }
    const sentinelPath = await writeDrawing(DEFAULT_SENTINEL_NAME);
    const sentinelMetadata = await lstat(sentinelPath);
    if (!sentinelMetadata.isFile() || sentinelMetadata.isSymbolicLink()) {
      throw new Error("Native UI fixture sentinel is not an ordinary file.");
    }

    return {
      paths,
      workspaceRoot: paths.workspace,
      sentinelPath,
      pathFor,
      writeDrawing,
      writeFile: writeFixtureFile,
      createDirectory,
      async cleanup(): Promise<void> {
        if (cleaned) return;
        cleaned = true;
        await assertIsolatedRoot(paths);
        await cleanupIsolatedDesktopPaths(paths);
      },
    };
  } catch (error) {
    await assertIsolatedRoot(paths);
    await cleanupIsolatedDesktopPaths(paths);
    cleaned = true;
    throw error;
  }
}
