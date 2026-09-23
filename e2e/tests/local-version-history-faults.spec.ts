import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { HISTORY_FAULT_MATRIX } from "../helpers/fault";
import {
  runTauriHistoryFaultKill,
  runTauriHistoryOperationConcurrency,
  runTauriHistoryOperationFailure,
  runTauriHistoryOperationFaultKill,
} from "../helpers/reliability";

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
        expect(evidence.temporaryFiles).toEqual([]);
        if (stage === "after_rename_before_parent_sync") {
          // The target rename is observable, while metadata repair may still
          // be pending when the same-root restart lacks a frontend ack.
          expect([true, null, undefined]).toContain(
            evidence.replacementCommitted,
          );
        } else if (stage === "metadata_complete_before_frontend_ack") {
          expect(evidence.replacementCommitted).toBe(true);
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
});

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
