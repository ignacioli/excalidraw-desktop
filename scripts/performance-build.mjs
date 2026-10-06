#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256File } from "./publish-evidence.mjs";

export const BUILD_ARGS = [
  "exec",
  "tauri",
  "build",
  "--no-bundle",
  "--features",
  "e2e-harness",
  "--",
  "--offline",
  "--locked",
];
const BUILD_TIMEOUT_MS = 25 * 60 * 1000;
const INPUT_PATHS = [
  "index.html",
  "src",
  "src-tauri",
  "public",
  "e2e",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "vitest.config.ts",
  ":(exclude)e2e/**/*.md",
];

class UsageError extends Error {}

export function parseArguments(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const options = {};
  const names = new Map([
    ["--mode", "mode"],
    ["--repo", "repo"],
    ["--target-dir", "targetDir"],
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const name = names.get(args[index]);
    const value = args[index + 1];
    if (
      !name ||
      options[name] !== undefined ||
      !value ||
      value.startsWith("--")
    ) {
      throw new UsageError(`Invalid or duplicate argument: ${args[index]}`);
    }
    options[name] = value;
  }
  if (!["common", "history"].includes(options.mode) || !options.targetDir) {
    throw new UsageError(
      "Required: --mode common|history --target-dir <new absolute directory>",
    );
  }
  return options;
}

export function buildEnvironment(mode, targetDir, inherited = process.env) {
  const environment = {
    ...inherited,
    VITE_E2E_HARNESS: "1",
    CARGO_TARGET_DIR: targetDir,
  };
  delete environment.VITE_E2E_HISTORY_FRONTEND;
  if (mode === "history") environment.VITE_E2E_HISTORY_FRONTEND = "1";
  return environment;
}

function repositoryIdentity(repo, sinceCommit) {
  const git = (...args) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  return {
    commit: git("rev-parse", "HEAD").trim(),
    worktreeRoots: git("worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice(9)),
    dirtyInputs: git(
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ...INPUT_PATHS,
    ).trim(),
    committedInputChanges: sinceCommit
      ? git(
          "diff",
          "--name-only",
          sinceCommit,
          "HEAD",
          "--",
          ...INPUT_PATHS,
        ).trim()
      : "",
  };
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

async function canonicalDirectory(directory) {
  try {
    return await fs.realpath(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return path.resolve(directory);
  }
}

async function reserveTarget(targetDir, roots) {
  if (!path.isAbsolute(targetDir))
    throw new UsageError("--target-dir must be absolute");
  const normalized = path.resolve(targetDir);
  const target = path.join(
    await fs.realpath(path.dirname(normalized)),
    path.basename(normalized),
  );
  for (const root of roots) {
    if (inside(await canonicalDirectory(root), target)) {
      throw new UsageError(
        "Performance target must be outside every registered worktree",
      );
    }
  }
  try {
    await fs.mkdir(target);
  } catch (error) {
    if (error.code === "EEXIST")
      throw new UsageError(
        "Performance target must not already exist; use a fresh directory",
      );
    throw error;
  }
  return target;
}

export async function defaultRunBuild(
  { cwd, environment, logPath },
  spawnChild = spawn,
) {
  const log = createWriteStream(logPath, { flags: "wx" });
  return await new Promise((resolve, reject) => {
    const child = spawnChild("pnpm", BUILD_ARGS, {
      cwd,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    let logError;
    let childClosed = false;
    let forceTimer;
    const signalOwnedGroup = (signal) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") reject(error);
      }
    };
    const stop = (signal) => {
      signalOwnedGroup(signal);
      forceTimer ??= setTimeout(() => signalOwnedGroup("SIGKILL"), 5_000);
    };
    const interrupt = () => stop("SIGINT");
    const terminate = () => stop("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
    }, BUILD_TIMEOUT_MS);
    log.on("error", (error) => {
      logError = error;
      if (childClosed) reject(error);
      else stop("SIGTERM");
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        if (!logError) log.write(chunk);
        process.stderr.write(chunk);
      });
    }
    child.on("error", (error) => {
      cleanup();
      log.end();
      reject(error);
    });
    child.on("close", (code, signal) => {
      childClosed = true;
      cleanup();
      if (logError) {
        reject(logError);
        return;
      }
      log.end(() => resolve({ code, signal, timedOut }));
    });
  });
}

async function featuresAt(directory, filename) {
  const value = JSON.parse(
    await fs.readFile(path.join(directory, filename), "utf8"),
  );
  return typeof value.features === "string"
    ? JSON.parse(value.features)
    : value.features;
}

export async function inspectBuildOutput({ targetDir, distDir, mode }) {
  const fingerprints = path.join(targetDir, "release/.fingerprint");
  const featureProofs = [];
  let harnessProof;
  for (const directory of await fs.readdir(fingerprints)) {
    if (/^excalidraw-desktop-[a-f0-9]+$/.test(directory)) {
      const location = path.join(fingerprints, directory);
      if (
        (await fs.readdir(location)).includes(
          "lib-excalidraw_desktop_lib.json",
        ) &&
        (
          await featuresAt(location, "lib-excalidraw_desktop_lib.json")
        )?.includes("e2e-harness")
      ) {
        harnessProof = path.join(location, "lib-excalidraw_desktop_lib.json");
      }
    }
    const filename = /^tauri-[a-f0-9]+$/.test(directory)
      ? "lib-tauri.json"
      : /^tauri-macros-[a-f0-9]+$/.test(directory)
        ? "lib-tauri_macros.json"
        : null;
    if (!filename) continue;
    const location = path.join(fingerprints, directory);
    if (!(await fs.readdir(location)).includes(filename)) continue;
    if ((await featuresAt(location, filename))?.includes("custom-protocol")) {
      featureProofs.push(path.join(location, filename));
    }
  }
  if (
    !featureProofs.some((file) => file.endsWith("/lib-tauri.json")) ||
    !featureProofs.some((file) => file.endsWith("/lib-tauri_macros.json"))
  ) {
    throw new Error("Built Tauri and macros must enable custom-protocol");
  }
  if (!harnessProof)
    throw new Error("Built application must enable e2e-harness");
  const modeProofs = [];
  const buildRoot = path.join(targetDir, "release/build");
  for (const directory of await fs.readdir(buildRoot)) {
    if (!/^tauri-[a-f0-9]+$/.test(directory)) continue;
    const filename = path.join(buildRoot, directory, "output");
    let content;
    try {
      content = await fs.readFile(filename, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const lines = content.split(/\r?\n/u);
    if (
      lines.includes("cargo:dev=false") &&
      lines.includes("cargo:rustc-cfg=custom_protocol") &&
      !lines.includes("cargo:dev=true") &&
      !lines.includes("cargo:rustc-cfg=dev")
    )
      modeProofs.push(filename);
  }
  if (modeProofs.length === 0)
    throw new Error(
      "Built Tauri must prove cargo:dev=false and custom_protocol",
    );
  const binaryPath = path.join(targetDir, "release/excalidraw-desktop");
  const binaryStat = await fs.lstat(binaryPath);
  if (!binaryStat.isFile() || (binaryStat.mode & 0o111) === 0)
    throw new Error(
      "Expected a regular executable binary in the independent target",
    );
  const resolvedBinary = await fs.realpath(binaryPath);
  if (!inside(await fs.realpath(targetDir), resolvedBinary))
    throw new Error("Built binary resolves outside the independent target");
  const bytes = await fs.readFile(binaryPath);
  const assetNames = await fs.readdir(path.join(distDir, "assets"));
  const required = [
    "performanceDriver",
    ...(mode === "history" ? ["historyFrontendDriver"] : []),
  ];
  const assetProofs = [];
  for (const prefix of required) {
    const filename = assetNames.find(
      (name) => name.startsWith(`${prefix}-`) && name.endsWith(".js"),
    );
    if (!filename || !bytes.includes(Buffer.from(filename)))
      throw new Error(`Built binary lacks embedded ${prefix} frontend asset`);
    assetProofs.push(filename);
  }
  if (!bytes.includes(Buffer.from("index.html")))
    throw new Error("Built binary lacks embedded index.html");
  return {
    binary: {
      path: resolvedBinary,
      sha256: await sha256File(binaryPath),
      sizeBytes: binaryStat.size,
    },
    e2eHarness: harnessProof,
    customProtocol: featureProofs,
    productionMode: modeProofs,
    embeddedFrontendAssetKeys: assetProofs,
  };
}

export async function buildPerformanceBinary(options, dependencies = {}) {
  if (!["common", "history"].includes(options.mode))
    throw new UsageError("--mode must be common or history");
  if (!options.targetDir) throw new UsageError("--target-dir is required");
  const repo = await fs.realpath(options.repo ?? process.cwd());
  await fs.access(path.join(repo, "package.json"));
  const config = JSON.parse(
    await fs.readFile(path.join(repo, "src-tauri/tauri.conf.json"), "utf8"),
  );
  if (
    config.build?.frontendDist !== "../dist" ||
    config.mainBinaryName !== "excalidraw-desktop"
  ) {
    throw new Error(
      "Expected the project local dist and excalidraw-desktop binary configuration",
    );
  }
  const readIdentity = dependencies.repositoryIdentity ?? repositoryIdentity;
  const identity = await readIdentity(repo);
  if (identity.dirtyInputs)
    throw new Error(
      `Commit runtime/runner inputs before building (docs/evidence edits are allowed): ${identity.dirtyInputs}`,
    );
  const targetDir = await reserveTarget(options.targetDir, [
    repo,
    ...identity.worktreeRoots,
  ]);
  const environment = buildEnvironment(
    options.mode,
    targetDir,
    dependencies.environment ?? process.env,
  );
  const reportPath = path.join(targetDir, "build-report.json");
  const report = {
    status: "BUILD_FAILED",
    mode: options.mode,
    repo,
    gitCommit: identity.commit,
    targetDir,
    command: ["pnpm", ...BUILD_ARGS],
    environment: {
      VITE_E2E_HARNESS: "1",
      VITE_E2E_HISTORY_FRONTEND: options.mode === "history" ? "1" : null,
      CARGO_TARGET_DIR: targetDir,
    },
    startedAt: new Date().toISOString(),
    performanceVerdict: "not_evaluated",
  };
  try {
    report.build = await (dependencies.runBuild ?? defaultRunBuild)({
      cwd: repo,
      environment,
      logPath: path.join(targetDir, "build.log"),
      args: BUILD_ARGS,
    });
    if (
      report.build.code !== 0 ||
      report.build.signal ||
      report.build.timedOut
    ) {
      throw new Error(
        `Tauri build failed: exit=${report.build.code}, signal=${report.build.signal ?? "none"}, timedOut=${Boolean(report.build.timedOut)}; see build.log`,
      );
    }
    const finalIdentity = await readIdentity(repo, identity.commit);
    if (finalIdentity.dirtyInputs || finalIdentity.committedInputChanges)
      throw new Error("Runtime/runner inputs changed during the build");
    report.checkoutCommitAtFinish = finalIdentity.commit;
    report.output = await inspectBuildOutput({
      targetDir,
      distDir: path.join(repo, "dist"),
      mode: options.mode,
    });
    report.status = "BUILD_READY";
  } catch (error) {
    report.reason = error.message ?? String(error);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
      flag: "wx",
    });
  }
  return { ...report, reportPath };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(
        "Usage: node scripts/performance-build.mjs --mode common|history [--repo <checkout>] --target-dir <new absolute directory outside all worktrees>",
      );
      return;
    }
    console.log(JSON.stringify(await buildPerformanceBinary(options), null, 2));
  } catch (error) {
    console.error(error.message ?? String(error));
    process.exitCode = error instanceof UsageError ? 64 : 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
