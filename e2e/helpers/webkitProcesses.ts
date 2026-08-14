import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * On macOS, WKWebView auxiliary processes (WebContent/GPU/Networking) are
 * spawned by launchd on the app's behalf: their parent PID is 1 and their
 * command line is a pure system framework path with no app token. Parent-PID
 * closure and command-line token matching therefore both miss them.
 *
 * This module attributes those processes to a launched test app through a
 * launch-time window: a WebKit-role process that did not exist before the app
 * was launched and that started after the launch instant belongs to the app.
 * The same tracked set is used for RSS/CPU accounting and for terminating the
 * processes that outlive the app's process group on close.
 *
 * Known limitation: another same-user WebKit app launched during the
 * measurement window would be misattributed. The declared reference VM runs no
 * other WebKit apps; host-machine diagnostic runs must avoid launching
 * WebKit-based browsers mid-measurement.
 */

export interface ProcessRecord {
  pid: number;
  parentPid: number;
  rssKilobytes: number;
  cpuPercent: number;
  startedAtEpochMs: number;
  name: string;
  command: string;
}

// The `etime` column has one-second granularity; allow the computed start
// instant to precede the recorded launch instant by this much before ruling
// a process out of the launch window.
const START_TIME_SLACK_MS = 2_000;
const ORPHAN_EXIT_POLL_INTERVAL_MS = 100;

const WEBKIT_ROLE_PATTERN =
  /com\.apple\.WebKit|WebKit\.framework|WebKitWebProcess|WebKitNetworkProcess/i;

export function isWebKitAuxiliaryProcess(record: ProcessRecord): boolean {
  return WEBKIT_ROLE_PATTERN.test(`${record.name} ${record.command}`);
}

/** Parses a ps `etime` value ([[dd-]hh:]mm:ss) into milliseconds. */
export function parseElapsedTimeMs(etime: string): number | null {
  const match = etime.trim().match(/^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const [, days, hours, minutes, seconds] = match;
  return (
    (Number(days ?? 0) * 24 * 3600 +
      Number(hours ?? 0) * 3600 +
      Number(minutes) * 60 +
      Number(seconds)) *
    1_000
  );
}

export function parseProcessSnapshot(
  output: string,
  snapshotAtEpochMs: number,
): ProcessRecord[] {
  const records: ProcessRecord[] = [];
  for (const line of output.split("\n")) {
    const match = line
      .trim()
      .match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!match) {
      continue;
    }
    const elapsedMs = parseElapsedTimeMs(match[5]);
    if (elapsedMs === null) {
      continue;
    }
    records.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      rssKilobytes: Number(match[3]),
      cpuPercent: Number(match[4]),
      startedAtEpochMs: snapshotAtEpochMs - elapsedMs,
      name: match[6],
      command: match[7],
    });
  }
  return records;
}

export async function snapshotProcesses(): Promise<ProcessRecord[]> {
  const snapshotAtEpochMs = Date.now();
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-axo", "pid=,ppid=,rss=,%cpu=,etime=,ucomm=,command="],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return parseProcessSnapshot(stdout, snapshotAtEpochMs);
}

/**
 * Tracks the WebKit auxiliary processes belonging to one launched app.
 * Create the tracker immediately before spawning the app process.
 */
export class WebKitProcessTracker {
  readonly launchedAtEpochMs: number;
  readonly #preexistingPids: ReadonlySet<number>;
  readonly #enabled: boolean;

  private constructor(
    launchedAtEpochMs: number,
    preexistingPids: ReadonlySet<number>,
    enabled: boolean,
  ) {
    this.launchedAtEpochMs = launchedAtEpochMs;
    this.#preexistingPids = preexistingPids;
    this.#enabled = enabled;
  }

  static async create(): Promise<WebKitProcessTracker> {
    if (process.platform === "win32") {
      return new WebKitProcessTracker(Date.now(), new Set(), false);
    }
    const records = await snapshotProcesses();
    const preexisting = new Set(
      records.filter(isWebKitAuxiliaryProcess).map((record) => record.pid),
    );
    return new WebKitProcessTracker(Date.now(), preexisting, true);
  }

  static inert(): WebKitProcessTracker {
    return new WebKitProcessTracker(Date.now(), new Set(), false);
  }

  /**
   * WebKit-role processes re-parented to launchd (PID 1) that appeared after
   * this tracker was created and were absent from the pre-launch snapshot.
   */
  orphanedAppProcesses(records: readonly ProcessRecord[]): ProcessRecord[] {
    if (!this.#enabled) {
      return [];
    }
    return selectOrphanedWebKitProcesses(records, {
      launchedAtEpochMs: this.launchedAtEpochMs,
      preexistingPids: this.#preexistingPids,
    });
  }

  /**
   * Terminates the app's re-parented WebKit auxiliary processes that survive
   * the app's process-group shutdown. SIGTERM first, then SIGKILL survivors.
   */
  async terminateOrphanedProcesses(timeoutMs = 2_000): Promise<number[]> {
    if (!this.#enabled) {
      return [];
    }
    const orphaned = this.orphanedAppProcesses(await snapshotProcesses());
    if (orphaned.length === 0) {
      return [];
    }
    const pids = orphaned.map((record) => record.pid);
    signalAll(pids, "SIGTERM");

    const deadline = Date.now() + timeoutMs;
    let survivors = pids.filter(isProcessAlive);
    while (survivors.length > 0 && Date.now() < deadline) {
      await delay(ORPHAN_EXIT_POLL_INTERVAL_MS);
      survivors = survivors.filter(isProcessAlive);
    }
    signalAll(survivors, "SIGKILL");
    return pids;
  }
}

export function selectOrphanedWebKitProcesses(
  records: readonly ProcessRecord[],
  window: {
    launchedAtEpochMs: number;
    preexistingPids: ReadonlySet<number>;
  },
): ProcessRecord[] {
  return records.filter(
    (record) =>
      record.parentPid === 1 &&
      isWebKitAuxiliaryProcess(record) &&
      !window.preexistingPids.has(record.pid) &&
      record.startedAtEpochMs >= window.launchedAtEpochMs - START_TIME_SLACK_MS,
  );
}

function signalAll(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
