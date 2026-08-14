import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { WebKitProcessTracker } from "./webkitProcesses";

const TEST_ROOT_PREFIX = "excalidraw-desktop-e2e-";
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const STDERR_CAPTURE_LIMIT_BYTES = 64 * 1024;

export interface IsolatedDesktopPaths {
  root: string;
  data: string;
  config: string;
  cache: string;
  runtime: string;
  workspace: string;
  temporary: string;
}

export interface LaunchDesktopAppOptions {
  binaryPath?: string;
  args?: readonly string[];
  environment?: Readonly<NodeJS.ProcessEnv>;
  shutdownTimeoutMs?: number;
}

export interface DesktopAppHandle {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly paths: IsolatedDesktopPaths;
  readonly startedAtNs: bigint;
  /** Attributes the app's re-parented WebKit auxiliary processes (macOS). */
  readonly webkitTracker: WebKitProcessTracker;
  /** Returns the captured stderr tail (native crashes and Rust panics). */
  stderrOutput(): string;
  close(): Promise<void>;
}

function executableName(): string {
  return process.platform === "win32"
    ? "excalidraw-desktop.exe"
    : "excalidraw-desktop";
}

export function desktopBinaryCandidates(): string[] {
  const explicit = process.env.EXCALIDRAW_E2E_BINARY;
  const target = resolve("src-tauri", "target", "release");
  const candidates = [
    explicit,
    process.platform === "darwin"
      ? join(
          target,
          "bundle",
          "macos",
          "excalidraw-desktop.app",
          "Contents",
          "MacOS",
          executableName(),
        )
      : undefined,
    join(target, executableName()),
  ];

  return candidates.filter((candidate): candidate is string =>
    Boolean(candidate),
  );
}

export async function resolveDesktopBinary(
  explicitPath?: string,
): Promise<string> {
  const candidates = explicitPath
    ? [resolve(explicitPath)]
    : desktopBinaryCandidates();

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next documented Tauri release output location.
    }
  }

  throw new Error(
    "No Tauri E2E binary found. Build the e2e-harness feature and set EXCALIDRAW_E2E_BINARY to the resulting executable.",
  );
}

export async function createIsolatedDesktopPaths(): Promise<IsolatedDesktopPaths> {
  const root = await realpath(await mkdtemp(join(tmpdir(), TEST_ROOT_PREFIX)));
  const paths: IsolatedDesktopPaths = {
    root,
    data: join(root, "data"),
    config: join(root, "config"),
    cache: join(root, "cache"),
    runtime: join(root, "runtime"),
    workspace: join(root, "workspace"),
    temporary: join(root, "tmp"),
  };

  await Promise.all(
    Object.values(paths)
      .filter((path) => path !== root)
      .map((path) => mkdir(path, { recursive: true })),
  );
  return paths;
}

export function isolatedDesktopEnvironment(
  paths: IsolatedDesktopPaths,
  overrides: Readonly<NodeJS.ProcessEnv> | undefined,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
    XDG_DATA_HOME: paths.data,
    XDG_CONFIG_HOME: paths.config,
    XDG_CACHE_HOME: paths.cache,
    XDG_RUNTIME_DIR: paths.runtime,
    TMPDIR: paths.temporary,
    // Preserve tool lookup when a minimal environment is supplied by CI.
    PATH: (overrides?.PATH ?? process.env.PATH)
      ?.split(delimiter)
      .join(delimiter),
    APP_E2E: "1",
    EXCALIDRAW_E2E_ROOT: paths.root,
  };
}

async function waitForSpawn(child: ChildProcess): Promise<number> {
  if (child.pid !== undefined) {
    return child.pid;
  }

  return await new Promise<number>((resolvePid, reject) => {
    child.once("spawn", () => {
      if (child.pid === undefined) {
        reject(
          new Error("Tauri process spawned without a process identifier."),
        );
        return;
      }
      resolvePid(child.pid);
    });
    child.once("error", reject);
  });
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  return await Promise.race([
    new Promise<boolean>((resolveExit) =>
      child.once("exit", () => resolveExit(true)),
    ),
    delay(timeoutMs, false, { ref: false }),
  ]);
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) {
    return;
  }

  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") {
      throw error;
    }
  }
}

/**
 * Formats a contract failure together with the app's captured stderr tail so
 * native crashes and Rust panics are visible in test output instead of being
 * discarded with the child process's stdio.
 */
export function describeAppError(
  error: unknown,
  app: Pick<DesktopAppHandle, "stderrOutput">,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = app.stderrOutput().trim();
  return stderr.length > 0
    ? `${message}\napp stderr tail:\n${stderr}`
    : message;
}

export async function cleanupIsolatedDesktopPaths(
  paths: IsolatedDesktopPaths,
): Promise<void> {
  const expectedPrefix = join(await realpath(tmpdir()), TEST_ROOT_PREFIX);
  if (!paths.root.startsWith(expectedPrefix)) {
    throw new Error(`Refusing to remove unexpected E2E root: ${paths.root}`);
  }
  await rm(paths.root, { recursive: true, force: true });
}

/**
 * Starts the test-only Tauri build as its own process group.
 *
 * This fixture is deliberately independent of Playwright's browser `page` fixture:
 * browser UI evidence does not prove native-shell, process, or filesystem behavior.
 * The Rust `e2e-harness` feature must consume EXCALIDRAW_E2E_ROOT for app-managed
 * storage; XDG/TMPDIR isolation alone is insufficient proof on macOS.
 */
export async function launchTauriTestApp(
  options: LaunchDesktopAppOptions = {},
): Promise<DesktopAppHandle> {
  const binaryPath = await resolveDesktopBinary(options.binaryPath);
  const paths = await createIsolatedDesktopPaths();
  const webkitTracker = await WebKitProcessTracker.create();
  const startedAtNs = process.hrtime.bigint();
  const child = spawn(binaryPath, [...(options.args ?? [])], {
    detached: process.platform !== "win32",
    env: isolatedDesktopEnvironment(paths, options.environment),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_CAPTURE_LIMIT_BYTES);
  });

  try {
    const pid = await waitForSpawn(child);
    let closed = false;

    return {
      child,
      pid,
      paths,
      startedAtNs,
      webkitTracker,
      stderrOutput(): string {
        return stderrTail;
      },
      async close(): Promise<void> {
        if (closed) {
          return;
        }
        closed = true;

        try {
          signalProcessTree(child, "SIGTERM");
          const exited = await waitForExit(
            child,
            options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
          );
          if (!exited) {
            signalProcessTree(child, "SIGKILL");
            await waitForExit(child, 2_000);
          }
          // The group signal does not reach WKWebView auxiliary processes that
          // macOS re-parented to launchd; terminate them explicitly so they do
          // not leak across multi-launch cycles.
          await webkitTracker.terminateOrphanedProcesses();
        } finally {
          await cleanupIsolatedDesktopPaths(paths);
        }
      },
    };
  } catch (error) {
    child.kill("SIGKILL");
    await webkitTracker.terminateOrphanedProcesses();
    await cleanupIsolatedDesktopPaths(paths);
    throw error;
  }
}
