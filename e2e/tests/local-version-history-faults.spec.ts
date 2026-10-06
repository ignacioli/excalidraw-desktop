import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, readFile, readdir, rm } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { HISTORY_FAULT_MATRIX } from "../helpers/fault";
import {
  cleanupIsolatedDesktopPaths,
  createIsolatedDesktopPaths,
  isolatedDesktopEnvironment,
  resolveDesktopBinary,
  type IsolatedDesktopPaths,
} from "../helpers/app";
import {
  runTauriHistoryFaultKill,
  runTauriHistoryEvictionFaultKill,
  runTauriHistoryOperationConcurrency,
  runTauriHistoryOperationExternalWrite,
  runTauriHistoryOperationFailure,
  runTauriHistoryOperationFaultKill,
} from "../helpers/reliability";

const RELIABILITY_SCENARIO_FLAG = "--e2e-reliability-scenario";

/**
 * This suite owns the native barrier protocol for the shared History
 * transaction.  It intentionally does not turn a standalone barrier fixture
 * into a claim about a replacement that it did not execute.  Once a real
 * replacement journey is available, the same matrix is the place to add the
 * operation-specific old/new/pending and asset assertions.
 */
test.describe("US1 local version history process fault barriers", () => {
  test.describe.configure({ mode: "serial" });

  for (const { stage, boundary } of HISTORY_FAULT_MATRIX) {
    test(`restarts safely after ${boundary} (${stage})`, async ({
      browserName,
    }, testInfo) => {
      void browserName;
      test.skip(
        !nativeReliabilityBuildConfigured(),
        "Native History fault tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
      );
      if (!nativeReliabilityBuildConfigured()) {
        return;
      }

      const oldSceneJson = JSON.stringify({
        version: 2,
        source: "history-fault-old",
        elements: [
          {
            id: "old-element",
            type: "rectangle",
            x: 10,
            y: 10,
            width: 80,
            height: 40,
          },
        ],
        files: {},
      });
      const newSceneJson = JSON.stringify({
        version: 2,
        source: "history-fault-new",
        elements: [
          {
            id: "new-element",
            type: "ellipse",
            x: 30,
            y: 20,
            width: 100,
            height: 60,
          },
        ],
        files: {},
      });
      const seed = `t025-${stage}`;
      const run = await runTauriHistoryFaultKill(stage, {
        seed,
        oldSceneJson,
        newSceneJson,
      });

      try {
        const { evidence } = run;
        await testInfo.attach("native-history-fault-evidence", {
          body: Buffer.from(
            JSON.stringify(
              {
                matrixBoundary: boundary,
                environment: run.environment,
                evidence,
              },
              null,
              2,
            ),
          ),
          contentType: "application/json",
        });

        expect(evidence.scenario).toBe("history-fault-kill");
        expect(evidence.stage).toBe(stage);
        expect(evidence.seed).toBe(seed);
        expect(evidence.processSignal).toBe("SIGKILL");
        expect(evidence.readyMarker.pid).toBeGreaterThan(0);
        expect(evidence.readyMarker.context.targetPath).toBe(
          evidence.targetPath,
        );
        expect(evidence.targetPath.startsWith(`${run.paths.workspace}/`)).toBe(
          true,
        );
        expect(evidence.afterRestart.faultMarkerExists).toBe(true);

        // The direct process fixture has not executed a replacement.  Its
        // pre-existing target therefore must remain the complete old state;
        // accepting arbitrary bytes here would make SIGKILL appear safe.
        expect(evidence.afterRestart.expectedState).toBe("old");
        expect(evidence.afterRestart.parseableJson).toBe(true);
        const persisted = await readFile(evidence.targetPath, "utf8");
        expect(JSON.parse(persisted) as unknown).toEqual(
          JSON.parse(oldSceneJson) as unknown,
        );
        expect(sha256(persisted)).toBe(evidence.oldSha256);
        expect(evidence.afterRestart.sha256).toBe(evidence.oldSha256);

        const temporaryFiles = await readdir(run.paths.workspace);
        expect(
          temporaryFiles.filter((name) =>
            name.startsWith("history-fault.excalidraw."),
          ),
        ).toEqual([]);

        // A readiness marker is not sufficient if the fixture is still alive:
        // a live PID would mean the restart proof never crossed the kill edge.
        expect(isProcessAlive(evidence.readyMarker.pid)).toBe(false);
      } finally {
        await run.cleanup();
      }
    });
  }

  for (const { stage, boundary } of HISTORY_FAULT_MATRIX.filter(
    ({ stage }) =>
      stage !== "rename_delete_repair" && stage !== "eviction_delete_gc",
  )) {
    test(`executes the protected replacement at ${boundary} (${stage})`, async ({
      browserName,
    }, testInfo) => {
      void browserName;
      test.skip(
        !nativeReliabilityBuildConfigured(),
        "Native History operation tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
      );
      if (!nativeReliabilityBuildConfigured()) return;

      const run = await runTauriHistoryOperationFaultKill(stage, {
        seed: `t025-real-${stage}`,
      });
      try {
        await testInfo.attach("native-history-operation-fault-evidence", {
          body: Buffer.from(
            JSON.stringify(
              {
                matrixBoundary: boundary,
                environment: run.environment,
                evidence: run.evidence,
              },
              null,
              2,
            ),
          ),
          contentType: "application/json",
        });
        const { evidence } = run;
        expect(evidence.scenario).toBe("history-operation-fault-probe");
        expect(evidence.stage).toBe(stage);
        expect(evidence.requestId).toBe(
          `history-fault-operation-t025-real-${stage}`,
        );
        expect(evidence.targetPath.startsWith(`${run.paths.workspace}/`)).toBe(
          true,
        );
        expect(evidence.parseableJson).toBe(true);
        expect(evidence.expectedState).toBe(
          stage === "after_rename_before_parent_sync" ||
            stage === "metadata_complete_before_frontend_ack"
            ? "new"
            : "old",
        );
        expect(evidence.targetObjectExists).toBe(true);
        expect(evidence.targetAssetExists).toBe(true);
        expect(evidence.operationRowCount).toBe(
          stage === "object_publish" || stage === "protection_commit" ? 0 : 1,
        );
        expect(evidence.protectionVersionCount).toBe(
          stage === "object_publish" ? 0 : 1,
        );
        expect(evidence.temporaryFiles).toEqual([]);
        if (stage === "after_rename_before_parent_sync") {
          // The target rename is observable, while metadata repair may still
          // be pending when the same-root restart lacks a frontend ack.
          expect([true, null, undefined]).toContain(
            evidence.replacementCommitted,
          );
        } else if (stage === "metadata_complete_before_frontend_ack") {
          expect(evidence.replacementCommitted).toBe(true);
          expect(evidence.operationState).toContain("Completed");
        } else {
          expect(evidence.replacementCommitted).not.toBe(true);
        }
      } finally {
        await run.cleanup();
      }
    });
  }

  for (const failureMode of [
    "missing-version",
    "missing-scene",
    "corrupt-scene",
    "missing-asset",
    "corrupt-asset",
    "object-permission",
    "object-enospc",
    "sqlite-permission",
    "sqlite-enospc",
    "partial-protection",
  ]) {
    test(`keeps the target unchanged for ${failureMode}`, async ({
      browserName,
    }, testInfo) => {
      void browserName;
      test.skip(
        !nativeReliabilityBuildConfigured(),
        "Native History failure tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
      );
      if (!nativeReliabilityBuildConfigured()) return;

      const run = await runTauriHistoryOperationFailure(failureMode);
      try {
        await testInfo.attach("native-history-failure-evidence", {
          body: Buffer.from(
            JSON.stringify(
              { environment: run.environment, evidence: run.evidence },
              null,
              2,
            ),
          ),
          contentType: "application/json",
        });
        expect(run.evidence.scenario).toBe("history-operation-failure");
        expect(run.evidence.failureMode).toBe(failureMode);
        expect(
          run.evidence.targetPath.startsWith(`${run.paths.workspace}/`),
        ).toBe(true);
        expect(run.evidence.targetUnchanged).toBe(true);
        expect(run.evidence.targetSha256).toBe(run.evidence.originalSha256);
        expect(run.evidence.error).not.toBe("unexpected success");
        expect(run.evidence.temporaryFiles).toEqual([]);
        expect(run.evidence.validSiblingAvailable).toBe(true);
        expect(run.evidence.protectedVersionCount).toBe(0);
        expect(run.evidence.operationRowCount).toBe(0);
        if (failureMode === "partial-protection") {
          expect(run.evidence.faultSceneRegistered).toBe(false);
          expect(run.evidence.unregisteredObjectHashes.length).toBeGreaterThan(
            0,
          );
        }
        if (
          failureMode === "object-permission" ||
          failureMode === "object-enospc"
        ) {
          expect(run.evidence.faultSceneObjectExists).toBe(false);
          expect(run.evidence.faultSceneRegistered).toBe(false);
        }
        if (
          failureMode === "sqlite-permission" ||
          failureMode === "sqlite-enospc"
        ) {
          expect(run.evidence.error).toContain("HistoryUnavailable");
          expect(run.evidence.faultSceneObjectExists).toBe(false);
          expect(run.evidence.faultSceneRegistered).toBe(false);
        }
      } finally {
        await run.cleanup();
      }
    });
  }

  test("serializes concurrent same-request replacements without duplicate publication", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeReliabilityBuildConfigured(),
      "Native History concurrency tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
    );
    if (!nativeReliabilityBuildConfigured()) return;

    const run = await runTauriHistoryOperationConcurrency();
    try {
      await testInfo.attach("native-history-concurrency-evidence", {
        body: Buffer.from(
          JSON.stringify(
            { environment: run.environment, evidence: run.evidence },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      });
      expect(run.evidence.scenario).toBe("history-operation-concurrency");
      expect(run.evidence.responseStates).toHaveLength(2);
      expect(
        run.evidence.responseStates.every((value) =>
          value.includes("Completed"),
        ),
      ).toBe(true);
      expect(run.evidence.replacementCommitted).toEqual([true, true]);
      expect(run.evidence.differentResponseStates).toHaveLength(2);
      expect(
        run.evidence.differentResponseStates.filter((value) =>
          value.includes("Completed"),
        ),
      ).toHaveLength(1);
      expect(
        run.evidence.differentResponseStates.filter((value) =>
          value.startsWith("error:"),
        ),
      ).toHaveLength(1);
      expect(run.evidence.targetObjectExists).toBe(true);
      expect(run.evidence.targetAssetExists).toBe(true);
    } finally {
      await run.cleanup();
    }
  });

  test("preserves an external write between precheck and target publication", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeReliabilityBuildConfigured(),
      "Native History external-write tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
    );
    if (!nativeReliabilityBuildConfigured()) return;

    const run = await runTauriHistoryOperationExternalWrite();
    try {
      await testInfo.attach("native-history-external-write-evidence", {
        body: Buffer.from(
          JSON.stringify(
            { environment: run.environment, evidence: run.evidence },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      });
      expect(run.evidence.scenario).toBe("history-operation-external-write");
      expect(run.evidence.externalWritePreserved).toBe(true);
      expect(run.evidence.observedSha256).toBe(run.evidence.externalSha256);
      expect(run.evidence.observedSha256).not.toBe(
        run.evidence.publishedSha256,
      );
      expect(run.evidence.responseState).toContain("HistoryStaleDocument");
    } finally {
      await run.cleanup();
    }
  });

  test("restarts safely after real retention eviction before GC", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeReliabilityBuildConfigured(),
      "Native History eviction fault tests require the e2e-harness Tauri build.",
    );
    if (!nativeReliabilityBuildConfigured()) return;

    const run = await runTauriHistoryEvictionFaultKill();
    try {
      await testInfo.attach("native-history-eviction-fault-evidence", {
        body: Buffer.from(
          JSON.stringify(
            { environment: run.environment, evidence: run.evidence },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      });
      const { evidence } = run;
      expect(evidence.processSignal).toBe("SIGKILL");
      expect(evidence.persistedSceneSha256).toBe(
        evidence.expectedOldSceneSha256,
      );
      expect(evidence.targetVersionExists).toBe(false);
      expect(evidence.retainedVersionCount).toBe(20);
      expect(evidence.protectionVersionCount).toBe(1);
      expect(evidence.operationRowCount).toBe(0);
      expect(evidence.targetObjectExistedBeforeGc).toBe(true);
      expect(evidence.targetAssetExistedBeforeGc).toBe(true);
      expect(evidence.gcDeletedTargetScene).toBe(true);
      expect(evidence.targetObjectExistsAfterGc).toBe(false);
      expect(evidence.gcDeletedTargetAsset).toBe(false);
      expect(evidence.targetAssetExistsAfterGc).toBe(true);
    } finally {
      await run.cleanup();
    }
  });

  test("keeps the third journal phase pending across a fresh process fault and repairs it", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeReliabilityBuildConfigured(),
      "Native History journal replay tests require the e2e-harness Tauri build.",
    );
    if (!nativeReliabilityBuildConfigured()) return;

    const run = await createIsolatedDesktopPaths();
    try {
      const seed = await runScenarioProcess(
        run,
        "history-lifecycle-journal-seed",
      );
      const failed = await runScenarioProcess(
        run,
        "history-lifecycle-journal-fault-probe",
        {
          EXCALIDRAW_E2E_HISTORY_REPLAY_FAULT: "disk-full",
        },
      );
      const repaired = await runScenarioProcess(
        run,
        "history-lifecycle-journal-fault-probe",
      );
      await testInfo.attach("native-history-journal-replay-fault-evidence", {
        body: Buffer.from(JSON.stringify({ seed, failed, repaired }, null, 2)),
        contentType: "application/json",
      });
      expect(seed.journalPendingAfter).toBe(true);
      expect(failed.scenario).toBe("history-lifecycle-journal-fault");
      expect(failed.firstError).toContain("transaction fault injected");
      expect(failed.journalPendingAfter).toBe(true);
      expect(failed.historyReplayApplied).toBe(false);
      expect(repaired.firstError).toBeNull();
      expect(repaired.journalPendingAfter).toBe(false);
      expect(repaired.historyReplayApplied).toBe(true);
      expect(repaired.identityAtNewPath).toBe(seed.documentId);
      expect(repaired.identityAtOldPath).toBeNull();
    } finally {
      await cleanupIsolatedDesktopPaths(run);
    }
  });

  test("keeps a filesystem rename journal pending when parent sync is denied, then repairs it", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeReliabilityBuildConfigured(),
      "Native History parent-sync tests require the e2e-harness Tauri build.",
    );
    if (!nativeReliabilityBuildConfigured()) return;

    const paths = await createIsolatedDesktopPaths();
    const journalParent = `${paths.workspace}/journal`;
    try {
      const seed = await runScenarioProcess(
        paths,
        "history-lifecycle-journal-seed",
      );
      const denied = await runScenarioProcess(
        paths,
        "history-lifecycle-journal-parent-sync-probe",
        { EXCALIDRAW_E2E_HISTORY_PARENT_SYNC_DENIED: "1" },
      );
      await chmod(journalParent, 0o755);
      const repaired = await runScenarioProcess(
        paths,
        "history-lifecycle-journal-parent-sync-probe",
      );
      await testInfo.attach("native-history-parent-sync-evidence", {
        body: Buffer.from(JSON.stringify({ seed, denied, repaired }, null, 2)),
        contentType: "application/json",
      });
      expect(seed.journalPendingAfter).toBe(true);
      expect(denied.scenario).toBe("history-lifecycle-journal-parent-sync");
      expect(denied.faultInjected).toBe(true);
      expect(denied.firstError).toContain("Permission denied");
      expect(denied.journalPendingAfter).toBe(true);
      expect(denied.historyReplayApplied).toBe(false);
      expect(repaired.firstError).toBeNull();
      expect(repaired.journalPendingAfter).toBe(false);
      expect(repaired.historyReplayApplied).toBe(true);
    } finally {
      await chmod(journalParent, 0o755).catch(() => undefined);
      await cleanupIsolatedDesktopPaths(paths);
    }
  });

  test("repairs an actual WorkspaceEntryService rename killed after filesystem commit", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeReliabilityBuildConfigured(),
      "Native post-filesystem rename tests require the e2e-harness Tauri build.",
    );
    if (!nativeReliabilityBuildConfigured()) return;

    const paths = await createIsolatedDesktopPaths();
    try {
      const run = await runEntryRenamePostFsKill(paths);
      await testInfo.attach("native-entry-rename-post-fs-evidence", {
        body: Buffer.from(JSON.stringify(run, null, 2)),
        contentType: "application/json",
      });
      expect(run.marker.stage).toBe("after_rename_before_parent_sync");
      expect(run.marker.pid).toBeGreaterThan(0);
      expect(run.marker.context.targetPath).toBe(
        `${paths.workspace}/post-fs-new`,
      );
      expect(run.probe.scenario).toBe("entry-rename-post-fs-probe");
      expect(run.probe.processSignal).toBe("SIGKILL");
      expect(run.probe.markerStage).toBe("after_rename_before_parent_sync");
      expect(run.probe.oldChildExists).toBe(false);
      expect(run.probe.newChildExists).toBe(true);
      expect(run.probe.journalPendingBefore).toBe(true);
      expect(run.probe.journalPendingAfter).toBe(false);
      expect(run.probe.journalFilesAfter).toBe(0);
      expect(run.probe.parentSyncApplied).toBe(true);
      expect(run.probe.sqliteApplied).toBe(true);
      expect(run.probe.recoveryApplied).toBe(true);
      expect(run.probe.historyApplied).toBe(true);
      expect(run.probe.identityAtNewPath).toBeTruthy();
      expect(run.probe.identityAtOldPath).toBeNull();
      expect(run.probe.historyVersionCount).toBe(1);
      expect(run.probe.duplicateHistoryVersions).toBe(false);
    } finally {
      await cleanupIsolatedDesktopPaths(paths);
    }
  });

  for (const resource of ["scene", "asset"] as const) {
    test(`reports missing history ${resource} after a fresh process restart`, async ({
      browserName,
    }, testInfo) => {
      void browserName;
      test.skip(
        !nativeReliabilityBuildConfigured(),
        "Native History missing-resource tests require the e2e-harness Tauri build.",
      );
      if (!nativeReliabilityBuildConfigured()) return;

      const paths = await createIsolatedDesktopPaths();
      const targetPath = `${paths.workspace}/history-fault-operation.excalidraw`;
      try {
        const seed = await runScenarioProcess(
          paths,
          "history-missing-resource-seed",
          {
            EXCALIDRAW_E2E_HISTORY_TARGET_PATH: targetPath,
            EXCALIDRAW_E2E_HISTORY_MISSING_RESOURCE: resource,
          },
        );
        const probe = await runScenarioProcess(
          paths,
          "history-missing-resource-probe",
          {
            EXCALIDRAW_E2E_HISTORY_MISSING_RESOURCE: resource,
          },
        );
        await testInfo.attach(`native-history-missing-${resource}-evidence`, {
          body: Buffer.from(JSON.stringify({ seed, probe }, null, 2)),
          contentType: "application/json",
        });
        expect(seed.resource).toBe(resource);
        expect(seed.resourceExists).toBe(false);
        expect(seed.targetParseable).toBe(true);
        expect(probe.scenario).toBe("history-missing-resource-probe");
        expect(probe.resource).toBe(resource);
        expect(probe.targetParseable).toBe(true);
        expect(probe.resourceExists).toBe(false);
        expect(probe.previewSucceeded).toBe(false);
        expect(probe.error).toBeTruthy();
        expect(probe.siblingVersionId).toBe("history-fault-version-b");
        expect(probe.siblingPreviewSucceeded).toBe(true);
        expect(probe.unavailableRecordStable).toBe(true);
      } finally {
        await cleanupIsolatedDesktopPaths(paths);
      }
    });
  }

  test("cleans an unregistered partial-protection object after a fresh process restart", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeReliabilityBuildConfigured(),
      "Native partial-protection tests require the e2e-harness Tauri build.",
    );
    if (!nativeReliabilityBuildConfigured()) return;

    const paths = await createIsolatedDesktopPaths();
    const targetPath = `${paths.workspace}/history-fault-operation.excalidraw`;
    try {
      const seed = await runScenarioProcess(
        paths,
        "history-partial-protection-seed",
        {
          EXCALIDRAW_E2E_HISTORY_FAILURE_MODE: "partial-protection",
          EXCALIDRAW_E2E_HISTORY_OPERATION_ID:
            "history-fault-partial-protection-fresh",
          EXCALIDRAW_E2E_HISTORY_TARGET_PATH: targetPath,
        },
      );
      const probe = await runScenarioProcess(
        paths,
        "history-partial-protection-probe",
      );
      await testInfo.attach(
        "native-history-partial-protection-fresh-evidence",
        {
          body: Buffer.from(JSON.stringify({ seed, probe }, null, 2)),
          contentType: "application/json",
        },
      );
      expect(seed.scenario).toBe("history-partial-protection");
      expect(seed.phase).toBe("seed");
      expect(seed.targetUnchanged).toBe(true);
      expect(seed.protectedVersionCount).toBe(0);
      expect(seed.operationRowCount).toBe(0);
      expect(seed.unregisteredBeforeGc.length).toBeGreaterThan(0);
      expect(probe.phase).toBe("probe");
      expect(probe.targetUnchanged).toBe(true);
      expect(probe.targetParseable).toBe(true);
      expect(probe.protectedVersionCount).toBe(0);
      expect(probe.operationRowCount).toBe(0);
      expect(probe.unregisteredBeforeGc.length).toBeGreaterThan(0);
      expect(probe.unregisteredAfterGc).toEqual([]);
      expect(probe.gcDeletedOrphan).toBe(true);
      expect(probe.retainedSceneObjects).toBe(true);
      expect(probe.retainedAssetObjects).toBe(true);
    } finally {
      await cleanupIsolatedDesktopPaths(paths);
    }
  });

  test("holds scene and asset objects during a real hydration pin and collects them after release", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeReliabilityBuildConfigured(),
      "Native History GC pin tests require the e2e-harness Tauri build.",
    );
    if (!nativeReliabilityBuildConfigured()) return;
    const paths = await createIsolatedDesktopPaths();
    try {
      const evidence = await runScenarioProcess(
        paths,
        "history-gc-hydration-pin",
      );
      await testInfo.attach("native-history-gc-hydration-pin-evidence", {
        body: Buffer.from(JSON.stringify(evidence, null, 2)),
        contentType: "application/json",
      });
      expect(evidence.scenario).toBe("history-gc-hydration-pin");
      expect(evidence.retainedWhileHydrating).toBe(true);
      expect(evidence.previewCompleted).toBe(true);
      expect(evidence.previewSceneComplete).toBe(true);
      expect(evidence.previewAssetComplete).toBe(true);
      expect(evidence.currentFileUnchanged).toBe(true);
      expect(evidence.deletedAfterRelease).toBe(true);
      expect(evidence.deletedOnlyOrphanedObjects).toBe(true);
    } finally {
      await cleanupIsolatedDesktopPaths(paths);
    }
  });
});

interface ScenarioEvidence {
  scenario: string;
  [key: string]: unknown;
}

async function runScenarioProcess(
  paths: IsolatedDesktopPaths,
  scenario: string,
  extraEnvironment: Record<string, string> = {},
): Promise<ScenarioEvidence> {
  const binary = await resolveDesktopBinary();
  const child = spawn(binary, [RELIABILITY_SCENARIO_FLAG, scenario], {
    detached: process.platform !== "win32",
    env: isolatedDesktopEnvironment(paths, extraEnvironment),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The close event below reports the terminal state.
        }
      }
      reject(new Error(`${scenario} exceeded 30 seconds.`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code ?? -1);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`${scenario} exited with ${exitCode}: ${stderr.trim()}`);
  }
  const line = stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (line === undefined) {
    throw new Error(`${scenario} produced no evidence.`);
  }
  return JSON.parse(line) as ScenarioEvidence;
}

interface EntryRenameReadyMarker {
  stage: string;
  pid: number;
  context: { targetPath: string };
}

async function runEntryRenamePostFsKill(paths: IsolatedDesktopPaths): Promise<{
  marker: EntryRenameReadyMarker;
  probe: ScenarioEvidence;
}> {
  const binary = await resolveDesktopBinary();
  const markerPath = `${paths.runtime}/reliability/history-fault.ready.json`;
  const targetPath = `${paths.workspace}/post-fs-new`;
  await rm(markerPath, { force: true });
  const child = spawn(
    binary,
    [RELIABILITY_SCENARIO_FLAG, "entry-rename-post-fs-kill"],
    {
      detached: process.platform !== "win32",
      env: isolatedDesktopEnvironment(paths, {
        EXCALIDRAW_E2E_HISTORY_FAULT_STAGE: "after_rename_before_parent_sync",
        EXCALIDRAW_E2E_HISTORY_FAULT_ARMED: "1",
        EXCALIDRAW_E2E_HISTORY_FAULT_MODE: "kill",
        EXCALIDRAW_E2E_HISTORY_OPERATION_ID: "t043-entry-rename-post-fs",
        EXCALIDRAW_E2E_HISTORY_DOCUMENT_ID: "t043-entry-rename-document",
        EXCALIDRAW_E2E_HISTORY_TARGET_PATH: targetPath,
        EXCALIDRAW_E2E_HISTORY_FAULT_SEED: "t043-entry-rename-post-fs",
      }),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr?.setEncoding("utf8");
  let stderr = "";
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-16_384);
  });
  try {
    const marker = await waitForEntryRenameMarker(child, markerPath, 15_000);
    if (child.pid === undefined) {
      throw new Error("post-FS rename child has no PID");
    }
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
    await waitForChildClose(child, 5_000);
    if (child.signalCode !== "SIGKILL") {
      throw new Error(
        `post-FS rename child was not SIGKILLed: ${child.signalCode}`,
      );
    }
    const probe = await runScenarioProcess(paths, "entry-rename-post-fs-probe");
    return { marker, probe };
  } catch (error) {
    if (
      child.exitCode === null &&
      child.signalCode === null &&
      child.pid !== undefined
    ) {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The child may have already exited while reporting the failure.
      }
    }
    await waitForChildClose(child, 2_000).catch(() => undefined);
    throw new Error(
      `post-FS rename process evidence failed: ${error instanceof Error ? error.message : String(error)}${stderr ? `\napp stderr tail:\n${stderr}` : ""}`,
      { cause: error },
    );
  }
}

async function waitForEntryRenameMarker(
  child: ReturnType<typeof spawn>,
  markerPath: string,
  timeoutMs: number,
): Promise<EntryRenameReadyMarker> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `post-FS rename exited before barrier (code=${child.exitCode}, signal=${child.signalCode})`,
      );
    }
    try {
      const marker = JSON.parse(
        await readFile(markerPath, "utf8"),
      ) as EntryRenameReadyMarker;
      if (
        marker.stage === "after_rename_before_parent_sync" &&
        marker.pid > 0 &&
        marker.context?.targetPath
      ) {
        return marker;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `post-FS rename barrier did not arrive within ${timeoutMs} ms`,
  );
}

async function waitForChildClose(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`child did not close within ${timeoutMs} ms`)),
      timeoutMs,
    );
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function nativeReliabilityBuildConfigured(): boolean {
  return (
    process.env.APP_E2E === "1" && Boolean(process.env.EXCALIDRAW_E2E_BINARY)
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    throw error;
  }
}
