import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildEnvironment,
  buildPerformanceBinary,
  defaultRunBuild,
  parseArguments,
} from "./performance-build.mjs";

test("log write failure waits for the owned build process to exit", async (t) => {
  const f = await fixture(t);
  let child;
  let closed = false;
  await assert.rejects(
    defaultRunBuild(
      { cwd: f.repo, environment: process.env, logPath: f.repo },
      (_command, _args, options) => {
        child = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          options,
        );
        child.on("close", () => {
          closed = true;
        });
        t.after(() => {
          if (!closed) child.kill("SIGKILL");
        });
        return child;
      },
    ),
    /EEXIST|EISDIR/,
  );
  assert.equal(closed, true);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

async function fixture(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "performance-build-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await fs.mkdir(path.join(repo, "src-tauri"), { recursive: true });
  await fs.mkdir(path.join(repo, "dist/assets"), { recursive: true });
  await fs.writeFile(path.join(repo, "package.json"), "{}\n");
  await fs.writeFile(
    path.join(repo, "src-tauri/tauri.conf.json"),
    JSON.stringify({
      mainBinaryName: "excalidraw-desktop",
      build: { frontendDist: "../dist" },
    }),
  );
  return { root, repo, targetDir: path.join(root, "target") };
}

function identity(repo, changes = {}) {
  return {
    commit: "a".repeat(40),
    worktreeRoots: [repo],
    dirtyInputs: "",
    committedInputChanges: "",
    ...changes,
  };
}

test("real Git identity rejects dirty or build-time committed index.html", async (t) => {
  const f = await fixture(t);
  const git = (...args) =>
    execFileSync("git", ["-C", f.repo, ...args], { stdio: "pipe" });
  const commit = () => {
    git(
      "add",
      "--",
      "index.html",
      "package.json",
      "src-tauri/tauri.conf.json",
      ".gitignore",
    );
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "Record fixture",
    );
  };
  git("init");
  await fs.writeFile(path.join(f.repo, ".gitignore"), "dist/\n");
  await fs.writeFile(path.join(f.repo, "index.html"), "initial\n");
  commit();
  await fs.writeFile(path.join(f.repo, "index.html"), "changed\n");
  await assert.rejects(
    buildPerformanceBinary(
      { mode: "common", repo: f.repo, targetDir: f.targetDir },
      { runBuild: () => assert.fail("dirty input must not start build") },
    ),
    /Commit runtime\/runner inputs/,
  );
  commit();
  await assert.rejects(
    buildPerformanceBinary(
      { mode: "common", repo: f.repo, targetDir: f.targetDir },
      {
        runBuild: async (args) => {
          const result = await fakeArtifacts(args);
          await fs.writeFile(
            path.join(f.repo, "index.html"),
            "changed during build\n",
          );
          commit();
          return result;
        },
      },
    ),
    /inputs changed during the build/,
  );
});

async function fakeArtifacts({ cwd, environment, logPath }, overrides = {}) {
  const targetDir = environment.CARGO_TARGET_DIR;
  await fs.mkdir(path.join(targetDir, "release/.fingerprint/tauri-eeee"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(
      targetDir,
      "release/.fingerprint/tauri-eeee/run-build-script.json",
    ),
    "{}\n",
  );
  const write = async (relative, value) => {
    const filename = path.join(targetDir, relative);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(
      filename,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  const protocol =
    overrides.customProtocol === false ? [] : ["custom-protocol"];
  await write("release/.fingerprint/tauri-aaaa/lib-tauri.json", {
    features: JSON.stringify(protocol),
  });
  await write("release/.fingerprint/tauri-macros-bbbb/lib-tauri_macros.json", {
    features: JSON.stringify(overrides.macroProtocol === false ? [] : protocol),
  });
  await write(
    "release/.fingerprint/excalidraw-desktop-cccc/lib-excalidraw_desktop_lib.json",
    {
      features: JSON.stringify(
        overrides.harness === false ? [] : ["e2e-harness"],
      ),
    },
  );
  await write(
    "release/build/tauri-dddd/output",
    overrides.devMode
      ? "cargo:rustc-cfg=dev\ncargo:dev=true\n"
      : "cargo:rustc-cfg=custom_protocol\ncargo:dev=false\n",
  );
  const assets = ["performanceDriver-fixture.js"];
  if (
    environment.VITE_E2E_HISTORY_FRONTEND === "1" &&
    !overrides.missingHistory
  )
    assets.push("historyFrontendDriver-fixture.js");
  for (const name of assets)
    await fs.writeFile(path.join(cwd, "dist/assets", name), "fixture\n");
  await write(
    "release/excalidraw-desktop",
    overrides.missingEmbeddedAssets
      ? "fake executable without embedded assets"
      : `fixture executable\0index.html\0${assets.join("\0")}`,
  );
  await fs.chmod(
    path.join(targetDir, "release/excalidraw-desktop"),
    overrides.notExecutable ? 0o644 : 0o755,
  );
  await fs.writeFile(logPath, "original fake build output\n");
  return { code: 0, signal: null, timedOut: false };
}

test("requires explicit mode and fresh target arguments, rejects unknown/duplicate flags", () => {
  assert.deepEqual(
    parseArguments([
      "--mode",
      "history",
      "--repo",
      "/target-repo",
      "--target-dir",
      "/tmp/new-target",
    ]),
    {
      mode: "history",
      repo: "/target-repo",
      targetDir: "/tmp/new-target",
    },
  );
  for (const args of [
    [],
    ["--mode", "production", "--target-dir", "/tmp/t"],
    ["--mode", "common"],
    ["--check"],
    ["--mode", "common", "--mode", "history"],
    ["--mode", "common", "--target-dir", "--repo"],
  ])
    assert.throws(() => parseArguments(args));
  assert.deepEqual(parseArguments(["--help"]), { help: true });
});

test("common removes inherited history flag; history sets both flags; target cannot be inherited", () => {
  const inherited = {
    VITE_E2E_HARNESS: "0",
    VITE_E2E_HISTORY_FRONTEND: "1",
    CARGO_TARGET_DIR: "/production",
  };
  assert.deepEqual(buildEnvironment("common", "/isolated", inherited), {
    VITE_E2E_HARNESS: "1",
    CARGO_TARGET_DIR: "/isolated",
  });
  assert.equal(
    buildEnvironment("history", "/isolated", inherited)
      .VITE_E2E_HISTORY_FRONTEND,
    "1",
  );
  assert.equal(inherited.CARGO_TARGET_DIR, "/production");
});

for (const mode of ["common", "history"]) {
  test(`${mode} calls no-bundle/offline CLI against target checkout and reports actual binary identity`, async (t) => {
    const f = await fixture(t);
    let call;
    const report = await buildPerformanceBinary(
      { mode, repo: f.repo, targetDir: f.targetDir },
      {
        repositoryIdentity: async (repo) => {
          assert.equal(repo, await fs.realpath(f.repo));
          return identity(repo);
        },
        environment: {
          VITE_E2E_HISTORY_FRONTEND: "1",
          CARGO_TARGET_DIR: "/do-not-use",
        },
        runBuild: async (options) => {
          call = options;
          return fakeArtifacts(options);
        },
      },
    );
    assert.deepEqual(call.args, [
      "exec",
      "tauri",
      "build",
      "--no-bundle",
      "--features",
      "e2e-harness",
      "--",
      "--offline",
      "--locked",
    ]);
    assert.equal(call.cwd, await fs.realpath(f.repo));
    assert.equal(report.gitCommit, "a".repeat(40));
    assert.equal(report.status, "BUILD_READY");
    assert.equal(report.performanceVerdict, "not_evaluated");
    assert.equal(
      report.output.binary.path,
      await fs.realpath(path.join(f.targetDir, "release/excalidraw-desktop")),
    );
    assert.equal(
      report.output.binary.sha256,
      createHash("sha256")
        .update(await fs.readFile(report.output.binary.path))
        .digest("hex"),
    );
    assert.equal(
      report.output.embeddedFrontendAssetKeys.length,
      mode === "history" ? 2 : 1,
    );
    assert.equal(
      JSON.parse(await fs.readFile(report.reportPath, "utf8")).status,
      "BUILD_READY",
    );
    assert.equal(
      call.environment.VITE_E2E_HISTORY_FRONTEND,
      mode === "history" ? "1" : undefined,
    );
  });
}

test("refuses existing targets including prior binaries and symlink targets without running a build", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.targetDir);
  await fs.writeFile(path.join(f.targetDir, "existing-binary"), "preserve");
  const dependencies = {
    repositoryIdentity: async () => identity(f.repo),
    runBuild: async () => assert.fail("must not build"),
  };
  await assert.rejects(
    buildPerformanceBinary(
      { mode: "common", repo: f.repo, targetDir: f.targetDir },
      dependencies,
    ),
    /must not already exist/u,
  );
  const alias = path.join(f.root, "alias");
  await fs.symlink(f.targetDir, alias);
  await assert.rejects(
    buildPerformanceBinary(
      { mode: "common", repo: f.repo, targetDir: alias },
      dependencies,
    ),
    /must not already exist/u,
  );
  assert.equal(
    await fs.readFile(path.join(f.targetDir, "existing-binary"), "utf8"),
    "preserve",
  );
});

test("refuses production targets, another registered checkout, and symlinked parents", async (t) => {
  const f = await fixture(t);
  const other = path.join(f.root, "baseline-repo");
  await fs.mkdir(other);
  const alias = path.join(f.root, "parent-alias");
  await fs.symlink(path.join(f.repo, "src-tauri"), alias);
  const dependencies = {
    repositoryIdentity: async () =>
      identity(f.repo, { worktreeRoots: [f.repo, other] }),
    runBuild: async () => assert.fail("must not build"),
  };
  for (const targetDir of [
    path.join(f.repo, "src-tauri/target"),
    path.join(other, "target"),
    path.join(alias, "target"),
  ]) {
    await assert.rejects(
      buildPerformanceBinary(
        { mode: "common", repo: f.repo, targetDir },
        dependencies,
      ),
      /outside every registered worktree/u,
    );
  }
  await assert.rejects(
    buildPerformanceBinary(
      { mode: "common", repo: f.repo, targetDir: "relative" },
      dependencies,
    ),
    /must be absolute/u,
  );
});

test("dirty runtime or untracked runner input cannot be recorded as HEAD", async (t) => {
  const f = await fixture(t);
  for (const dirtyInputs of [
    " M src/app/AppShell.tsx",
    "?? e2e/perf/new-runner.ts",
  ]) {
    await assert.rejects(
      buildPerformanceBinary(
        { mode: "common", repo: f.repo, targetDir: f.targetDir },
        {
          repositoryIdentity: async () => identity(f.repo, { dirtyInputs }),
          runBuild: async () => assert.fail("must not build"),
        },
      ),
      /Commit runtime\/runner inputs/u,
    );
  }
});

for (const [name, overrides, reason, mode] of [
  [
    "missing custom protocol",
    { customProtocol: false },
    /custom-protocol/u,
    "common",
  ],
  [
    "missing macro custom protocol",
    { macroProtocol: false },
    /custom-protocol/u,
    "common",
  ],
  [
    "production backend without harness",
    { harness: false },
    /e2e-harness/u,
    "common",
  ],
  ["dev mode", { devMode: true }, /cargo:dev=false/u, "common"],
  [
    "missing embedded frontend",
    { missingEmbeddedAssets: true },
    /embedded performanceDriver/u,
    "common",
  ],
  [
    "missing history frontend",
    { missingHistory: true },
    /embedded historyFrontendDriver/u,
    "history",
  ],
  [
    "non-executable output",
    { notExecutable: true },
    /regular executable/u,
    "common",
  ],
]) {
  test(`${name} cannot produce BUILD_READY even after a successful command`, async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      buildPerformanceBinary(
        { mode, repo: f.repo, targetDir: f.targetDir },
        {
          repositoryIdentity: async () => identity(f.repo),
          runBuild: (options) => fakeArtifacts(options, overrides),
        },
      ),
      reason,
    );
    const report = JSON.parse(
      await fs.readFile(path.join(f.targetDir, "build-report.json"), "utf8"),
    );
    assert.equal(report.status, "BUILD_FAILED");
    assert.match(report.reason, reason);
  });
}

test("a failing command preserves its output and cannot produce readiness from artifacts", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    buildPerformanceBinary(
      { mode: "common", repo: f.repo, targetDir: f.targetDir },
      {
        repositoryIdentity: async () => identity(f.repo),
        runBuild: async (options) => {
          await fakeArtifacts(options);
          return { code: 7, signal: null };
        },
      },
    ),
    /exit=7/u,
  );
  assert.equal(
    await fs.readFile(path.join(f.targetDir, "build.log"), "utf8"),
    "original fake build output\n",
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(f.targetDir, "build-report.json"), "utf8"),
    ).status,
    "BUILD_FAILED",
  );
});

test("newly committed runtime changes reject readiness; evidence-only commits remain allowed", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const repositoryIdentity = async () =>
    identity(
      f.repo,
      ++calls === 1
        ? {}
        : {
            commit: "b".repeat(40),
            committedInputChanges: "src/documents/documentStore.ts",
          },
    );
  await assert.rejects(
    buildPerformanceBinary(
      { mode: "common", repo: f.repo, targetDir: f.targetDir },
      {
        repositoryIdentity,
        runBuild: fakeArtifacts,
      },
    ),
    /changed during the build/u,
  );
  calls = 0;
  const report = await buildPerformanceBinary(
    {
      mode: "common",
      repo: f.repo,
      targetDir: path.join(f.root, "evidence-target"),
    },
    {
      repositoryIdentity: async () =>
        identity(f.repo, {
          commit: ++calls === 1 ? "a".repeat(40) : "b".repeat(40),
        }),
      runBuild: fakeArtifacts,
    },
  );
  assert.equal(report.status, "BUILD_READY");
  assert.equal(report.gitCommit, "a".repeat(40));
  assert.equal(report.checkoutCommitAtFinish, "b".repeat(40));
});

test("timeout cannot be reported as ready even if output artifacts exist", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    buildPerformanceBinary(
      { mode: "common", repo: f.repo, targetDir: f.targetDir },
      {
        repositoryIdentity: async () => identity(f.repo),
        runBuild: async (options) => {
          await fakeArtifacts(options);
          return { code: 0, signal: null, timedOut: true };
        },
      },
    ),
    /timedOut=true/u,
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(path.join(f.targetDir, "build-report.json"), "utf8"),
    ).status,
    "BUILD_FAILED",
  );
});
