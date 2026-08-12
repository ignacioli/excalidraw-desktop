import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PERFORMANCE_REPORT_SCHEMA_VERSION = "2.0.0";
const REFERENCE_HOST_HARDWARE = "Apple M5 Pro / 48GB";
const REFERENCE_VIRTUALIZATION_NAME = "Parallels Desktop Pro";
const REFERENCE_VIRTUALIZATION_VERSION = "26.4.1";

export interface ExecutionEnvironmentMetadata {
  type: "physical" | "virtual" | "unspecified";
  hostHardware: string;
  virtualization: { name: string; version: string } | null;
}

export interface EnvironmentMetadata {
  hardware: string;
  memory: { bytes: number; gibibytes: number };
  architecture: string;
  logicalCores: number;
  osVersion: string;
  webviewVersion: string;
  executionEnvironment: ExecutionEnvironmentMetadata;
}

export interface ProcessClassCounts {
  tauri: number;
  webview: number;
  gpu: number;
  network: number;
  other: number;
}

export interface ProcessTreeSample {
  monotonicMs: number;
  rssBytes: number;
  cpuPercentOfOneLogicalCore: number;
  processCount: number;
  processClasses: ProcessClassCounts;
}

export interface ProcessTreeAccounting {
  rootProcessName: string;
  associationMethod: string;
  includedClasses: readonly string[];
  exclusions: readonly string[];
  platformLimitations: readonly string[];
}

export interface WriteObservation {
  method: "fs-watch-plus-metadata-snapshot";
  eventCount: number;
  changedPathCount: number;
  watchedRootCount: number;
  limitations: readonly string[];
}

interface PsRecord {
  pid: number;
  parentPid: number;
  rssKilobytes: number;
  cpuPercent: number;
  name: string;
  command: string;
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function runOptional(
  command: string,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, [...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    const value = stdout.trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function collectMacWebViewVersion(): Promise<string> {
  const version = await runOptional("/usr/bin/plutil", [
    "-extract",
    "CFBundleVersion",
    "raw",
    "/System/Library/Frameworks/WebKit.framework/Resources/Info.plist",
  ]);
  if (!version) {
    throw new Error("Unable to read the exact macOS WebKit framework version.");
  }
  return `WebKit ${version}`;
}

function parseMacHardwareProfile(
  profileJson: string | undefined,
): { model: string; cpuBrand: string } | undefined {
  if (!profileJson) {
    return undefined;
  }
  try {
    const profile = JSON.parse(profileJson) as {
      SPHardwareDataType?: Array<{
        machine_model?: unknown;
        chip_type?: unknown;
      }>;
    };
    const hardware = profile.SPHardwareDataType?.[0];
    if (
      typeof hardware?.machine_model !== "string" ||
      typeof hardware.chip_type !== "string"
    ) {
      return undefined;
    }
    return {
      model: hardware.machine_model,
      cpuBrand: hardware.chip_type,
    };
  } catch {
    return undefined;
  }
}

async function collectLinuxWebViewVersion(): Promise<string> {
  const version =
    (await runOptional("pkg-config", ["--modversion", "webkit2gtk-4.1"])) ??
    (await runOptional("pkg-config", ["--modversion", "webkit2gtk-4.0"]));
  if (!version) {
    throw new Error(
      "Unable to read the installed WebKitGTK version with pkg-config.",
    );
  }
  return `WebKitGTK ${version}`;
}

export async function collectEnvironmentMetadata(): Promise<EnvironmentMetadata> {
  const memoryBytes = os.totalmem();
  let hardware = `${os.type()} ${os.arch()}`;
  let osVersion = `${os.type()} ${os.release()}`;
  let webviewVersion = "unsupported-platform";

  if (process.platform === "darwin") {
    const [sysctlModel, sysctlCpuBrand, productVersion, buildVersion] =
      await Promise.all([
        runOptional("/usr/sbin/sysctl", ["-n", "hw.model"]),
        runOptional("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]),
        runOptional("/usr/bin/sw_vers", ["-productVersion"]),
        runOptional("/usr/bin/sw_vers", ["-buildVersion"]),
      ]);
    const hardwareProfile =
      sysctlModel && sysctlCpuBrand
        ? undefined
        : parseMacHardwareProfile(
            await runOptional("/usr/sbin/system_profiler", [
              "SPHardwareDataType",
              "-json",
            ]),
          );
    const model = sysctlModel ?? hardwareProfile?.model;
    const cpuBrand = sysctlCpuBrand ?? hardwareProfile?.cpuBrand;
    if (!model || !cpuBrand || !productVersion || !buildVersion) {
      throw new Error(
        "Unable to collect the reference-environment hardware or exact macOS metadata.",
      );
    }
    hardware = `${model} (${cpuBrand})`;
    osVersion = `macOS ${productVersion} (${buildVersion})`;
    webviewVersion = await collectMacWebViewVersion();
  } else if (process.platform === "linux") {
    let productName: string | undefined;
    try {
      productName = (
        await readFile("/sys/devices/virtual/dmi/id/product_name", "utf8")
      ).trim();
    } catch {
      productName = undefined;
    }
    const cpuModel = os.cpus()[0]?.model ?? "unknown CPU";
    hardware = `${productName ?? "Linux host"} (${cpuModel})`;
    osVersion = `${os.type()} ${os.release()} (${os.version()})`;
    webviewVersion = await collectLinuxWebViewVersion();
  }

  return {
    hardware,
    memory: {
      bytes: memoryBytes,
      gibibytes: round(memoryBytes / 1024 ** 3),
    },
    architecture: os.arch(),
    logicalCores: os.cpus().length,
    osVersion,
    webviewVersion,
    executionEnvironment: collectExecutionEnvironmentMetadata(hardware),
  };
}

function collectExecutionEnvironmentMetadata(
  guestHardware: string,
): ExecutionEnvironmentMetadata {
  const declaredType = process.env.PERF_EXECUTION_ENVIRONMENT;
  const type =
    declaredType === "virtual" || declaredType === "physical"
      ? declaredType
      : "unspecified";
  const hostHardware =
    process.env.PERF_HOST_HARDWARE?.trim() ||
    (type === "physical" ? guestHardware : "not-recorded");
  return {
    type,
    hostHardware,
    virtualization:
      type === "virtual"
        ? {
            name:
              process.env.PERF_VIRTUALIZATION_NAME?.trim() || "not-recorded",
            version:
              process.env.PERF_VIRTUALIZATION_VERSION?.trim() || "not-recorded",
          }
        : null,
  };
}

export async function collectCommit(): Promise<string> {
  const commit = await runOptional("git", ["rev-parse", "HEAD"]);
  if (!commit) {
    throw new Error("Unable to resolve the commit for the performance report.");
  }
  return commit;
}

function parsePs(output: string): PsRecord[] {
  const records: PsRecord[] = [];
  for (const line of output.split("\n")) {
    const match = line
      .trim()
      .match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s*(.*)$/);
    if (!match) {
      continue;
    }
    records.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      rssKilobytes: Number(match[3]),
      cpuPercent: Number(match[4]),
      name: match[5],
      command: match[6],
    });
  }
  return records;
}

async function processSnapshot(): Promise<PsRecord[]> {
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-axo", "pid=,ppid=,rss=,%cpu=,ucomm=,command="],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return parsePs(stdout);
}

function descendantPids(
  records: readonly PsRecord[],
  rootPid: number,
): Set<number> {
  const included = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (included.has(record.parentPid) && !included.has(record.pid)) {
        included.add(record.pid);
        changed = true;
      }
    }
  }
  return included;
}

function isWebViewAuxiliary(record: PsRecord): boolean {
  return /(webkit|webview|gpu|networkprocess|webprocess)/i.test(
    `${record.name} ${record.command}`,
  );
}

function processClass(
  record: PsRecord,
  rootPid: number,
): keyof ProcessClassCounts {
  const descriptor = `${record.name} ${record.command}`;
  if (record.pid === rootPid) {
    return "tauri";
  }
  if (/gpu/i.test(descriptor)) {
    return "gpu";
  }
  if (/network/i.test(descriptor)) {
    return "network";
  }
  if (/(webkit|webview|webprocess)/i.test(descriptor)) {
    return "webview";
  }
  return "other";
}

export function processTreeAccounting(
  rootProcessName: string,
): ProcessTreeAccounting {
  return {
    rootProcessName,
    associationMethod:
      "recursive parent PID closure plus WebView/GPU/Network auxiliary processes carrying an explicit app association token",
    includedClasses: [
      "Tauri main",
      "descendants",
      "associated WebView",
      "GPU",
      "Network",
    ],
    exclusions: [
      "unrelated system WebView/GPU processes",
      "processes that expose neither parentage nor an app association token",
    ],
    platformLimitations: [
      "macOS may re-parent WKWebView auxiliary processes; token attribution is used only when the process also has a WebKit/GPU/Network role",
      "ps RSS can include shared pages charged independently to more than one process",
      "ps CPU is an OS interval estimate normalized so 100 percent equals one logical core",
    ],
  };
}

export async function collectProcessTreeSample(
  rootPid: number,
  startedAtNs: bigint,
  associationTokens: readonly string[],
): Promise<ProcessTreeSample> {
  const records = await processSnapshot();
  const root = records.find((record) => record.pid === rootPid);
  if (!root) {
    throw new Error(`Tauri root process ${rootPid} is not running.`);
  }

  const includedPids = descendantPids(records, rootPid);
  const normalizedTokens = associationTokens
    .filter((token) => token.length >= 4)
    .map((token) => token.toLowerCase());

  for (const record of records) {
    if (includedPids.has(record.pid) || !isWebViewAuxiliary(record)) {
      continue;
    }
    const command = record.command.toLowerCase();
    if (normalizedTokens.some((token) => command.includes(token))) {
      includedPids.add(record.pid);
    }
  }

  const included = records.filter((record) => includedPids.has(record.pid));
  const classes: ProcessClassCounts = {
    tauri: 0,
    webview: 0,
    gpu: 0,
    network: 0,
    other: 0,
  };
  for (const record of included) {
    classes[processClass(record, rootPid)] += 1;
  }

  return {
    monotonicMs: round(
      Number(process.hrtime.bigint() - startedAtNs) / 1_000_000,
    ),
    rssBytes: included.reduce(
      (total, record) => total + record.rssKilobytes * 1024,
      0,
    ),
    cpuPercentOfOneLogicalCore: round(
      included.reduce((total, record) => total + record.cpuPercent, 0),
    ),
    processCount: included.length,
    processClasses: classes,
  };
}

export function percentile(
  values: readonly number[],
  percentileValue: number,
): number {
  if (values.length === 0) {
    throw new Error("Cannot calculate a percentile without samples.");
  }
  if (percentileValue <= 0 || percentileValue > 1) {
    throw new Error("Percentile must be greater than zero and at most one.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index];
}

type DirectoryState = Map<string, string>;

async function capturePath(path: string, state: DirectoryState): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    return;
  }

  state.set(path, `${metadata.size}:${metadata.mtimeMs}:${metadata.mode}`);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    return;
  }

  let entries;
  try {
    entries = await readdir(path);
  } catch {
    return;
  }
  await Promise.all(
    entries.map((entry) => capturePath(join(path, entry), state)),
  );
}

async function captureDirectoryState(
  paths: readonly string[],
): Promise<DirectoryState> {
  const state: DirectoryState = new Map();
  await Promise.all(paths.map((path) => capturePath(path, state)));
  return state;
}

function changedPaths(
  before: DirectoryState,
  after: DirectoryState,
): Set<string> {
  const changed = new Set<string>();
  for (const [path, fingerprint] of before) {
    if (after.get(path) !== fingerprint) {
      changed.add(path);
    }
  }
  for (const path of after.keys()) {
    if (!before.has(path)) {
      changed.add(path);
    }
  }
  return changed;
}

export class DirectoryWriteObserver {
  readonly #paths: readonly string[];
  readonly #watchers: FSWatcher[] = [];
  readonly #changedPaths = new Set<string>();
  #eventCount = 0;
  #initialState: DirectoryState | undefined;

  constructor(paths: readonly string[]) {
    this.#paths = [...new Set(paths)];
  }

  async start(): Promise<void> {
    this.#initialState = await captureDirectoryState(this.#paths);
    for (const path of this.#paths) {
      try {
        await stat(path);
        const watcher = watch(path, { recursive: true }, (_event, fileName) => {
          this.#eventCount += 1;
          if (fileName) {
            this.#changedPaths.add(join(path, fileName.toString()));
          }
        });
        this.#watchers.push(watcher);
      } catch {
        // The final metadata snapshot still observes persistent changes.
      }
    }
  }

  async stop(): Promise<WriteObservation> {
    for (const watcher of this.#watchers) {
      watcher.close();
    }
    const finalState = await captureDirectoryState(this.#paths);
    for (const path of changedPaths(
      this.#initialState ?? new Map(),
      finalState,
    )) {
      this.#changedPaths.add(path);
    }

    return {
      method: "fs-watch-plus-metadata-snapshot",
      eventCount: this.#eventCount,
      changedPathCount: this.#changedPaths.size,
      watchedRootCount: this.#paths.length,
      limitations: [
        "fs.watch may coalesce events; the before/after metadata snapshot detects persistent changes but not an ephemeral file created and removed between snapshots",
        "write observation covers only the explicitly supplied application-managed data roots and mounted test workspaces",
      ],
    };
  }
}

export async function writePerformanceReport(
  reportPath: string,
  report: unknown,
): Promise<void> {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export function assertReferenceEnvironment(
  metadata: EnvironmentMetadata,
): void {
  if (process.platform !== "darwin" || metadata.architecture !== "arm64") {
    throw new Error(
      "The declared performance reference run requires a macOS ARM64 guest.",
    );
  }
  if (!metadata.osVersion.startsWith("macOS 26.5.2 (")) {
    throw new Error(
      `The declared reference guest must run macOS 26.5.2; found ${metadata.osVersion}.`,
    );
  }
  if (metadata.logicalCores !== 4) {
    throw new Error(
      `The declared reference guest must expose 4 logical CPUs; found ${metadata.logicalCores}.`,
    );
  }
  const minimumMemoryBytes = 7.5 * 1024 ** 3;
  const maximumMemoryBytes = 8.5 * 1024 ** 3;
  if (
    metadata.memory.bytes < minimumMemoryBytes ||
    metadata.memory.bytes > maximumMemoryBytes
  ) {
    throw new Error(
      `The declared reference guest must be configured with approximately 8 GiB of memory; the guest reports ${metadata.memory.bytes} bytes.`,
    );
  }
  const execution = metadata.executionEnvironment;
  if (
    execution.type !== "virtual" ||
    execution.hostHardware !== REFERENCE_HOST_HARDWARE ||
    execution.virtualization?.name !== REFERENCE_VIRTUALIZATION_NAME ||
    execution.virtualization.version !== REFERENCE_VIRTUALIZATION_VERSION
  ) {
    throw new Error(
      `The first reference series requires ${REFERENCE_HOST_HARDWARE} with ${REFERENCE_VIRTUALIZATION_NAME} ${REFERENCE_VIRTUALIZATION_VERSION}. Record a changed environment as a new series through an ADR before updating the reference pins.`,
    );
  }
}

export function executableAssociationTokens(
  executablePath: string,
  isolatedRoot: string,
): string[] {
  return [basename(executablePath), "excalidraw-desktop", isolatedRoot];
}
