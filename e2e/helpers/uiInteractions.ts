import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  statfs,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  cleanupIsolatedDesktopPaths,
  createIsolatedDesktopPaths,
  isolatedDesktopEnvironment,
  resolveDesktopBinary,
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
const RELIABILITY_SCENARIO_FLAG = "--e2e-reliability-scenario";
const ENTRY_RELIABILITY_TIMEOUT_MS = 30_000;

export type NativeEntryTrashMode = "success" | "failure" | "source-disappeared";

export type NativeEntryRenameFaultPoint = "source-changed" | "target-collision";

export interface NativeEntryEnvironment {
  platform: NodeJS.Platform;
  architecture: string;
  filesystemType: string;
  binaryPath: string;
  binarySha256: string;
  seed: string;
}

export interface NativeEntryScenarioRun<T> {
  evidence: T;
  environment: NativeEntryEnvironment;
  paths: IsolatedDesktopPaths;
  cleanup(): Promise<void>;
}

export interface NativeEntryTrashEvidence {
  scenario: "entry-trash";
  mode: NativeEntryTrashMode;
  targetPath: string;
  trashPath: string;
  trashInvoked: boolean;
  sourceExistsAfter: boolean;
  trashExistsAfter: boolean;
  errorCode: string | null;
  targetFileIndexBefore: boolean;
  targetFileIndexAfter: boolean;
  targetDraftBefore: boolean;
  targetDraftAfter: boolean;
  targetMetadataBefore: boolean;
  targetMetadataAfter: boolean;
}

export interface NativeEntryRenameFaultEvidence {
  scenario: "entry-rename-fault";
  faultPoint: NativeEntryRenameFaultPoint;
  sourcePath: string;
  targetPath: string;
  errorCode: string | null;
  sourceExistsAfter: boolean;
  targetExistsAfter: boolean;
}

export interface NativeEntryDirectoryRaceEvidence {
  scenario: "entry-directory-race";
  directoryPath: string;
  childPath: string;
  preflightStatus: "confirmable" | "directoryNotEmpty";
  errorCode: string | null;
  trashInvoked: boolean;
  directoryExistsAfter: boolean;
  childExistsAfter: boolean;
}

export interface NativeEntryMetadataCleanupEvidence {
  scenario: "entry-metadata-cleanup";
  targetPath: string;
  siblingPath: string;
  trashInvoked: boolean;
  sourceExistsAfter: boolean;
  targetFileIndexAfter: boolean;
  targetDraftAfter: boolean;
  targetMetadataAfter: boolean;
  siblingFileIndexAfter: boolean;
  siblingDraftAfter: boolean;
  siblingMetadataAfter: boolean;
}

export interface NativeEntryDescendantSaveEvidence {
  scenario: "entry-descendant-save";
  oldDirectoryPath: string;
  newDirectoryPath: string;
  descendants: Array<{
    oldPath: string;
    newPath: string;
    oldExistsAfter: boolean;
    newExistsAfter: boolean;
    newSha256: string | null;
  }>;
  pathMigrationCount: number;
  continuedSaveSucceeded: boolean;
}

export interface NativeEntryRenameKillEvidence {
  scenario: "entry-rename-kill";
  faultPoint: "before_rename";
  processSignal: NodeJS.Signals | null;
  sourcePath: string;
  targetPath: string;
  sourceExistsAfter: boolean;
  targetExistsAfter: boolean;
  descendantOldPath: string;
  descendantNewPath: string;
  descendantOldExistsAfter: boolean;
  descendantNewExistsAfter: boolean;
}

export type NativeTabCloseScenarioKind =
  | "cmd-w-active"
  | "middle-click-inactive"
  | "duplicate-close"
  | "checkpoint-failure"
  | "wheel-vertical-notch";

export type NativeTabCloseScenarioRun<T> = NativeEntryScenarioRun<T>;

export interface NativeTabCloseCmdWEvidence {
  scenario: "cmd-w-active";
  shortcut: "Cmd+W" | "Ctrl+W";
  activeTabIdBefore: string;
  inactiveTabIdsBefore: string[];
  closedTabIds: string[];
  remainingTabIds: string[];
  activeTabIdAfter: string | null;
  checkpointInvoked: boolean;
  checkpointReason: "tabClose" | null;
  closeInvokedCount: number;
  windowRemainedOpen: boolean;
  workspaceSidebarRemainedOpen: boolean;
}

export interface NativeTabCloseMiddleClickEvidence {
  scenario: "middle-click-inactive";
  targetTabId: string;
  targetWasActiveBefore: boolean;
  activatedBeforeClose: boolean;
  closedTabIds: string[];
  remainingTabIds: string[];
  checkpointInvoked: boolean;
  checkpointReason: "tabClose" | null;
  closeInvokedCount: number;
}

export interface NativeTabCloseDuplicateEvidence {
  scenario: "duplicate-close";
  targetTabId: string;
  closeRequestCount: number;
  closeInvokedCount: number;
  overlappingCloseDetected: boolean;
  checkpointInvoked: boolean;
  checkpointReason: "tabClose" | null;
}

export interface NativeTabCloseCheckpointFailureEvidence {
  scenario: "checkpoint-failure";
  targetPath: string;
  errorCode: string | null;
  checkpointInvoked: boolean;
  closeInvokedCount: number;
  tabRemainedOpen: boolean;
  sessionIntact: boolean;
  sourceExistsAfter: boolean;
  originalSha256: string;
  persistedSha256: string;
  draftDirty: boolean;
}

export interface NativeTabCloseWheelNotchEvidence {
  scenario: "wheel-vertical-notch";
  inputKind: "mouse-wheel" | "trackpad";
  axis: "vertical";
  modifierKeys: string[];
  notchCount: number;
  activationCount: number;
  overlappingActivationDetected: boolean;
  checkpointInvoked: boolean;
  checkpointReason: "tabSwitch" | null;
  previousActiveTabId: string;
  intendedActiveTabId: string;
  finalActiveTabId: string;
}

export type NativeTabCloseEvidence =
  | NativeTabCloseCmdWEvidence
  | NativeTabCloseMiddleClickEvidence
  | NativeTabCloseDuplicateEvidence
  | NativeTabCloseCheckpointFailureEvidence
  | NativeTabCloseWheelNotchEvidence;

/** FR-045 / SC-011 titlebar choice A: exact native window title. */
export const REQUIRED_NATIVE_WINDOW_TITLE = "Excalidraw Whiteboard";

export type NativeWindowTitleBarStyle = "Visible" | "Transparent" | "Overlay";

export interface NativeWindowContractEvidence {
  scenario: "window-contract";
  title: string;
  decorations: boolean;
  transparent: boolean;
  titleBarStyle: NativeWindowTitleBarStyle;
  alwaysOnTop: boolean;
  fullscreen: boolean;
  overlayTitleBar: boolean;
  /** Native chrome follows the OS appearance instead of an app-wide Dark theme. */
  systemControlledChrome: boolean;
  appWideDark: boolean;
}

export type NativeWindowContractScenarioRun =
  NativeEntryScenarioRun<NativeWindowContractEvidence>;

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

/**
 * Runs a test-only native entry scenario in a fresh process and returns only
 * JSON evidence published by the Rust harness. Browser fixtures deliberately
 * cannot prove these filesystem/process invariants.
 */
export async function runNativeEntryScenario(
  scenario:
    | "entry-trash"
    | "entry-rename-fault"
    | "entry-directory-race"
    | "entry-metadata-cleanup"
    | "entry-descendant-save",
  environmentOverrides: Readonly<NodeJS.ProcessEnv> = {},
): Promise<
  NativeEntryScenarioRun<
    | NativeEntryTrashEvidence
    | NativeEntryRenameFaultEvidence
    | NativeEntryDirectoryRaceEvidence
    | NativeEntryMetadataCleanupEvidence
    | NativeEntryDescendantSaveEvidence
  >
> {
  const binary = await resolveDesktopBinary();
  const paths = await createIsolatedDesktopPaths();
  await assertIsolatedRoot(paths);
  try {
    const evidence = await runReliabilityScenarioProcess<
      | NativeEntryTrashEvidence
      | NativeEntryRenameFaultEvidence
      | NativeEntryDirectoryRaceEvidence
      | NativeEntryMetadataCleanupEvidence
      | NativeEntryDescendantSaveEvidence
    >(binary, paths, scenario, environmentOverrides);
    const filesystem = await statfs(paths.workspace);
    const binarySha256 = createHash("sha256")
      .update(await readFile(binary))
      .digest("hex");
    let cleaned = false;
    return {
      evidence,
      environment: {
        platform: process.platform,
        architecture: process.arch,
        filesystemType: String(filesystem.type),
        binaryPath: binary,
        binarySha256,
        seed: environmentOverrides.EXCALIDRAW_E2E_SEED ?? "deterministic",
      },
      paths,
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
    throw error;
  }
}

/**
 * Stops the native rename fixture at its explicit pre-commit barrier. The
 * process kill is intentional: this is the process-level evidence that a
 * pre-rename interruption cannot expose a partially migrated Directory.
 */
export async function runNativeEntryRenameKill(
  faultPoint: "before_rename" = "before_rename",
  seed = "deterministic",
): Promise<NativeEntryScenarioRun<NativeEntryRenameKillEvidence>> {
  const binary = await resolveDesktopBinary();
  const paths = await createIsolatedDesktopPaths();
  await assertIsolatedRoot(paths);
  const markerPath = join(
    paths.runtime,
    "reliability",
    "entry-rename.ready.json",
  );
  const child = spawn(
    binary,
    [RELIABILITY_SCENARIO_FLAG, "entry-rename-kill"],
    {
      detached: process.platform !== "win32",
      env: isolatedDesktopEnvironment(paths, {
        ...environmentOverridesForSeed(seed),
        EXCALIDRAW_E2E_ENTRY_RENAME_FAULT: faultPoint,
      }),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-16_384);
  });

  let cleaned = false;
  let killed = false;
  const terminate = (): void => {
    if (child.pid === undefined || child.exitCode !== null) return;
    try {
      if (process.platform !== "win32") {
        process.kill(-child.pid, "SIGKILL");
      } else {
        child.kill("SIGKILL");
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") throw error;
    }
  };
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    if (!killed) {
      terminate();
      await waitForNativeChildExit(child, 2_000);
    }
    await assertIsolatedRoot(paths);
    await cleanupIsolatedDesktopPaths(paths);
  };

  try {
    const marker = await waitForEntryRenameReady(child, markerPath, 15_000);
    const sourcePath = assertPathWithin(paths.workspace, marker.sourcePath);
    const targetPath = assertPathWithin(paths.workspace, marker.targetPath);
    const descendantOldPath = assertPathWithin(
      paths.workspace,
      marker.descendantOldPath,
    );
    const descendantNewPath = assertPathWithin(
      paths.workspace,
      marker.descendantNewPath,
    );
    terminate();
    killed = true;
    await waitForNativeChildExit(child, 5_000);
    const binarySha256 = createHash("sha256")
      .update(await readFile(binary))
      .digest("hex");
    const filesystem = await statfs(paths.workspace);
    return {
      evidence: {
        scenario: "entry-rename-kill",
        faultPoint,
        processSignal: child.signalCode,
        sourcePath,
        targetPath,
        sourceExistsAfter: await ordinaryPathExists(sourcePath),
        targetExistsAfter: await ordinaryPathExists(targetPath),
        descendantOldPath,
        descendantNewPath,
        descendantOldExistsAfter: await ordinaryPathExists(descendantOldPath),
        descendantNewExistsAfter: await ordinaryPathExists(descendantNewPath),
      },
      environment: {
        platform: process.platform,
        architecture: process.arch,
        filesystemType: String(filesystem.type),
        binaryPath: binary,
        binarySha256,
        seed,
      },
      paths,
      cleanup,
    };
  } catch (error) {
    terminate();
    await waitForNativeChildExit(child, 2_000).catch(() => undefined);
    await assertIsolatedRoot(paths);
    await cleanupIsolatedDesktopPaths(paths);
    cleaned = true;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${detail}${stderr.trim().length > 0 ? `\nentry rename stderr:\n${stderr.trim()}` : ""}`,
      { cause: error },
    );
  }
}

/**
 * Runs isolated native close/activation scenarios through the e2e-harness.
 */
export async function runNativeTabCloseScenario(
  kind: NativeTabCloseScenarioKind,
): Promise<NativeTabCloseScenarioRun<NativeTabCloseEvidence>> {
  return runReliabilityScenario<NativeTabCloseEvidence>(kind);
}

/**
 * Collects live OS title / stacking / chrome evidence from a native process.
 */
export async function runNativeWindowContractScenario(): Promise<NativeWindowContractScenarioRun> {
  return runReliabilityScenario<NativeWindowContractEvidence>("window-contract");
}

async function runReliabilityScenario<T extends { scenario: string }>(
  scenario: string,
  environmentOverrides: Readonly<NodeJS.ProcessEnv> = {},
): Promise<NativeEntryScenarioRun<T>> {
  const binary = await resolveDesktopBinary();
  const paths = await createIsolatedDesktopPaths();
  await assertIsolatedRoot(paths);
  try {
    const evidence = await runReliabilityScenarioProcess<T>(
      binary,
      paths,
      scenario,
      environmentOverrides,
    );
    const filesystem = await statfs(paths.workspace);
    const binarySha256 = createHash("sha256")
      .update(await readFile(binary))
      .digest("hex");
    let cleaned = false;
    return {
      evidence,
      environment: {
        platform: process.platform,
        architecture: process.arch,
        filesystemType: String(filesystem.type),
        binaryPath: binary,
        binarySha256,
        seed: environmentOverrides.EXCALIDRAW_E2E_SEED ?? "deterministic",
      },
      paths,
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
    throw error;
  }
}

interface EntryRenameReadyMarker {
  scenario: "entry-rename-kill";
  faultPoint: "before_rename";
  sourcePath: string;
  targetPath: string;
  descendantOldPath: string;
  descendantNewPath: string;
}

async function runReliabilityScenarioProcess<T>(
  binary: string,
  paths: IsolatedDesktopPaths,
  scenario: string,
  environmentOverrides: Readonly<NodeJS.ProcessEnv>,
): Promise<T> {
  const child = spawn(binary, [RELIABILITY_SCENARIO_FLAG, scenario], {
    env: isolatedDesktopEnvironment(paths, environmentOverrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await waitForNativeChildResult(child, scenario);
  if (exitCode !== 0) {
    throw new Error(
      `Native reliability scenario ${scenario} exited with ${exitCode}: ${stderr.trim()}`,
    );
  }
  const evidenceLine = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (evidenceLine === undefined) {
    throw new Error(
      `Native reliability scenario ${scenario} produced no evidence.`,
    );
  }
  const parsed: unknown = JSON.parse(evidenceLine);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("scenario" in parsed) ||
    parsed.scenario !== scenario
  ) {
    throw new Error(
      `Native reliability scenario mismatch: requested ${scenario}, received ${String(
        (parsed as { scenario?: unknown } | null)?.scenario,
      )}.`,
    );
  }
  return parsed as T;
}

function environmentOverridesForSeed(seed: string): NodeJS.ProcessEnv {
  return { EXCALIDRAW_E2E_SEED: seed };
}

function assertPathWithin(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const suffix = relative(resolvedRoot, resolvedCandidate);
  if (
    suffix.length === 0 ||
    suffix === ".." ||
    suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(suffix)
  ) {
    throw new Error(
      `Native entry scenario path escaped its safe root: ${candidate}`,
    );
  }
  return resolvedCandidate;
}

async function ordinaryPathExists(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() || metadata.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitForNativeChildResult(
  child: ChildProcess,
  scenario: string,
): Promise<number> {
  return await new Promise<number>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The close event below carries the useful process result.
      }
      reject(
        new Error(
          `Native entry scenario ${scenario} exceeded ${ENTRY_RELIABILITY_TIMEOUT_MS} ms.`,
        ),
      );
    }, ENTRY_RELIABILITY_TIMEOUT_MS);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveExit(code ?? -1);
    });
  });
}

async function waitForNativeChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolveExit) =>
      child.once("close", () => resolveExit()),
    ),
    delay(timeoutMs).then(() => undefined),
  ]);
}

async function waitForEntryRenameReady(
  child: ChildProcess,
  markerPath: string,
  timeoutMs: number,
): Promise<EntryRenameReadyMarker> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Entry rename fixture exited before its barrier (code=${child.exitCode}, signal=${child.signalCode}).`,
      );
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(markerPath, "utf8"));
      if (!isEntryRenameReadyMarker(parsed)) {
        throw new Error("Entry rename fixture published an invalid marker.");
      }
      return parsed;
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        await delay(25);
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    `Entry rename fixture did not publish its barrier within ${timeoutMs} ms.`,
  );
}

function isEntryRenameReadyMarker(
  value: unknown,
): value is EntryRenameReadyMarker {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.scenario === "entry-rename-kill" &&
    record.faultPoint === "before_rename" &&
    typeof record.sourcePath === "string" &&
    typeof record.targetPath === "string" &&
    typeof record.descendantOldPath === "string" &&
    typeof record.descendantNewPath === "string"
  );
}
