import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";

import {
  cleanupIsolatedDesktopPaths,
  createIsolatedDesktopPaths,
  isolatedDesktopEnvironment,
  resolveDesktopBinary,
} from "../helpers/app";

const RELIABILITY_SCENARIO_FLAG = "--e2e-reliability-scenario";
const SCENARIO_TIMEOUT_MS = 30_000;

interface HistoryLifecycleEvidence {
  scenario: "history-lifecycle";
  workspace: string;
  originalPath: string;
  renamedPath: string;
  ancestorMovedPath: string;
  saveAsPath: string;
  trashPath: string;
  documentIdBefore: string;
  documentIdAfterRename: string;
  saveAsDocumentId: string;
  renameOperationId: string;
  ancestorMoveOperationId: string;
  deleteOperationId: string;
  renameCommitted: boolean;
  ancestorMoveCommitted: boolean;
  saveAsHasDistinctIdentity: boolean;
  saveAsHistoryCount: number;
  samePathReplacementRejected: boolean;
  deleteCommitted: boolean;
  historyVersionsAfterDelete: number;
  activeIdentityAfterDelete: boolean;
  originalExistsAfterDelete: boolean;
  trashExistsAfterDelete: boolean;
  samePathRecreatedDistinct: boolean;
  samePathRecreatedHistoryCount: number;
  samePathRecreatedExists: boolean;
}

interface HistoryLifecycleJournalEvidence {
  scenario: "history-lifecycle-journal";
  phase: "seed" | "probe";
  operationId: string;
  oldPath: string;
  newPath: string;
  documentId: string;
  journalPendingBefore: boolean;
  journalPendingAfter: boolean;
  oldExistsAfter: boolean;
  newExistsAfter: boolean;
  identityAtNewPath?: string;
  identityAtOldPath?: string;
  historyReplayApplied: boolean;
}

interface HistoryDocumentSaveAsEvidence {
  scenario: "history-document-save-as";
  conflictSourcePath: string;
  conflictTargetPath: string;
  conflictSourceDocumentId: string;
  conflictTargetDocumentId: string;
  previousTargetState: string;
  conflictSaveAsDistinct: boolean;
  conflictSourceRemainsActive: boolean;
  orphanSourcePath: string;
  orphanTargetPath: string;
  orphanTargetDocumentId: string;
  orphanTargetHistoryCount: number;
  orphanSourceDraftExistsAfterClose: boolean;
  orphanSaveAsDistinct: boolean;
  orphanSourceFileExistsAfterClose: boolean;
}

test("native lifecycle preserves identity across rename/move, isolates Save As, rejects same-path replacement, and deletes history after Trash", async ({
  browserName,
}, testInfo) => {
  void browserName;
  test.setTimeout(120_000);
  test.skip(
    !nativeLifecycleBuildConfigured(),
    "Native lifecycle tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
  );
  if (!nativeLifecycleBuildConfigured()) return;

  const run = await runNativeLifecycleScenario();
  try {
    await testInfo.attach("native-history-lifecycle-evidence", {
      body: Buffer.from(JSON.stringify(run, null, 2)),
      contentType: "application/json",
    });
    const { evidence, paths } = run;
    expect(evidence.scenario).toBe("history-lifecycle");
    expect(evidence.workspace).toBe(paths.workspace);
    expect(evidence.renameOperationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(evidence.ancestorMoveOperationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(evidence.deleteOperationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(evidence.renameCommitted).toBe(true);
    expect(evidence.ancestorMoveCommitted).toBe(true);
    expect(evidence.documentIdAfterRename).toBe(evidence.documentIdBefore);
    expect(evidence.saveAsHasDistinctIdentity).toBe(true);
    expect(evidence.saveAsHistoryCount).toBe(0);
    expect(evidence.samePathReplacementRejected).toBe(true);
    expect(evidence.deleteCommitted).toBe(true);
    expect(evidence.historyVersionsAfterDelete).toBe(0);
    expect(evidence.activeIdentityAfterDelete).toBe(false);
    expect(evidence.originalExistsAfterDelete).toBe(false);
    expect(evidence.trashExistsAfterDelete).toBe(true);
    expect(evidence.samePathRecreatedDistinct).toBe(true);
    expect(evidence.samePathRecreatedHistoryCount).toBe(0);
    expect(evidence.samePathRecreatedExists).toBe(true);
  } finally {
    await cleanupIsolatedDesktopPaths(run.paths);
  }
});

test("fresh process replay completes the history-required third journal phase", async ({
  browserName,
}, testInfo) => {
  void browserName;
  test.setTimeout(120_000);
  test.skip(
    !nativeLifecycleBuildConfigured(),
    "Native lifecycle tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
  );
  if (!nativeLifecycleBuildConfigured()) return;

  const run = await runNativeLifecycleJournalScenario();
  try {
    await testInfo.attach("native-history-lifecycle-journal-evidence", {
      body: Buffer.from(JSON.stringify(run, null, 2)),
      contentType: "application/json",
    });
    expect(run.seed.scenario).toBe("history-lifecycle-journal");
    expect(run.seed.phase).toBe("seed");
    expect(run.seed.journalPendingBefore).toBe(true);
    expect(run.seed.journalPendingAfter).toBe(true);
    expect(run.seed.oldExistsAfter).toBe(false);
    expect(run.seed.newExistsAfter).toBe(true);
    expect(run.probe.phase).toBe("probe");
    expect(run.probe.journalPendingBefore).toBe(true);
    expect(run.probe.journalPendingAfter).toBe(false);
    expect(run.probe.oldExistsAfter).toBe(false);
    expect(run.probe.newExistsAfter).toBe(true);
    expect(run.probe.identityAtNewPath).toBe(run.probe.documentId);
    expect(run.probe.identityAtOldPath).toBeNull();
    expect(run.probe.historyReplayApplied).toBe(true);
  } finally {
    await cleanupIsolatedDesktopPaths(run.paths);
  }
});

test("native DocumentService conflict and orphan Save As create fresh identities", async ({
  browserName,
}, testInfo) => {
  void browserName;
  test.setTimeout(120_000);
  test.skip(
    !nativeLifecycleBuildConfigured(),
    "Native lifecycle tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
  );
  if (!nativeLifecycleBuildConfigured()) return;

  const run = await runNativeProductSaveAsScenario();
  try {
    await testInfo.attach("native-history-document-save-as-evidence", {
      body: Buffer.from(JSON.stringify(run, null, 2)),
      contentType: "application/json",
    });
    expect(run.evidence.scenario).toBe("history-document-save-as");
    expect(run.evidence.conflictSaveAsDistinct).toBe(true);
    expect(run.evidence.conflictSourceRemainsActive).toBe(true);
    expect(run.evidence.previousTargetState).toBe("detached");
    expect(run.evidence.orphanSaveAsDistinct).toBe(true);
    expect(run.evidence.orphanTargetHistoryCount).toBe(0);
    expect(run.evidence.orphanSourceDraftExistsAfterClose).toBe(false);
    expect(run.evidence.orphanSourceFileExistsAfterClose).toBe(false);
  } finally {
    await cleanupIsolatedDesktopPaths(run.paths);
  }
});

async function runNativeLifecycleScenario(): Promise<{
  environment: {
    platform: NodeJS.Platform;
    architecture: string;
    filesystemType: string;
    binaryPath: string;
    binarySha256: string;
    seed: string;
  };
  paths: Awaited<ReturnType<typeof createIsolatedDesktopPaths>>;
  evidence: HistoryLifecycleEvidence;
}> {
  const binary = await resolveDesktopBinary();
  const paths = await createIsolatedDesktopPaths();
  const child = spawn(
    binary,
    [RELIABILITY_SCENARIO_FLAG, "history-lifecycle"],
    {
      detached: process.platform !== "win32",
      env: isolatedDesktopEnvironment(paths, {}),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  try {
    const exitCode = await waitForChild(child, SCENARIO_TIMEOUT_MS);
    if (exitCode !== 0) {
      throw new Error(
        `history-lifecycle scenario exited with ${exitCode}: ${stderr.trim()}`,
      );
    }
    const line = stdout
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean)
      .at(-1);
    if (line === undefined) {
      throw new Error("history-lifecycle scenario produced no evidence.");
    }
    const evidence = JSON.parse(line) as HistoryLifecycleEvidence;
    if (evidence.scenario !== "history-lifecycle") {
      throw new Error(`Unexpected lifecycle scenario: ${evidence.scenario}`);
    }
    const filesystem = await statfs(paths.workspace);
    return {
      environment: {
        platform: process.platform,
        architecture: process.arch,
        filesystemType: String(filesystem.type),
        binaryPath: binary,
        binarySha256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
        seed: "deterministic",
      },
      paths,
      evidence,
    };
  } catch (error) {
    await terminateChild(child);
    await cleanupIsolatedDesktopPaths(paths);
    throw error;
  }
}

async function runNativeLifecycleJournalScenario(): Promise<{
  paths: Awaited<ReturnType<typeof createIsolatedDesktopPaths>>;
  seed: HistoryLifecycleJournalEvidence;
  probe: HistoryLifecycleJournalEvidence;
}> {
  const binary = await resolveDesktopBinary();
  const paths = await createIsolatedDesktopPaths();
  try {
    const seed = await runScenarioChild<HistoryLifecycleJournalEvidence>(
      binary,
      paths,
      "history-lifecycle-journal-seed",
    );
    const probe = await runScenarioChild<HistoryLifecycleJournalEvidence>(
      binary,
      paths,
      "history-lifecycle-journal-probe",
    );
    return { paths, seed, probe };
  } catch (error) {
    await cleanupIsolatedDesktopPaths(paths);
    throw error;
  }
}

async function runNativeProductSaveAsScenario(): Promise<{
  paths: Awaited<ReturnType<typeof createIsolatedDesktopPaths>>;
  evidence: HistoryDocumentSaveAsEvidence;
}> {
  const binary = await resolveDesktopBinary();
  const paths = await createIsolatedDesktopPaths();
  try {
    const evidence = await runScenarioChild<HistoryDocumentSaveAsEvidence>(
      binary,
      paths,
      "history-document-save-as",
    );
    return { paths, evidence };
  } catch (error) {
    await cleanupIsolatedDesktopPaths(paths);
    throw error;
  }
}

async function runScenarioChild<T>(
  binary: string,
  paths: Awaited<ReturnType<typeof createIsolatedDesktopPaths>>,
  scenario: string,
): Promise<T> {
  const child = spawn(binary, [RELIABILITY_SCENARIO_FLAG, scenario], {
    detached: process.platform !== "win32",
    env: isolatedDesktopEnvironment(paths, {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const exitCode = await waitForChild(child, SCENARIO_TIMEOUT_MS);
  if (exitCode !== 0) {
    throw new Error(`${scenario} exited with ${exitCode}: ${stderr.trim()}`);
  }
  const line = stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (line === undefined) throw new Error(`${scenario} produced no evidence.`);
  return JSON.parse(line) as T;
}

function waitForChild(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      void terminateChild(child).finally(() =>
        reject(new Error(`history-lifecycle exceeded ${timeoutMs} ms.`)),
      );
    }, timeoutMs);
    timeout.unref();
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code ?? -1);
    });
  });
}

async function terminateChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

function nativeLifecycleBuildConfigured(): boolean {
  return (
    process.env.APP_E2E === "1" && Boolean(process.env.EXCALIDRAW_E2E_BINARY)
  );
}
