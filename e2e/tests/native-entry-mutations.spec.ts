import { expect, test } from "@playwright/test";

import {
  runNativeEntryRenameKill,
  runNativeEntryScenario,
  type NativeEntryTrashMode,
} from "../helpers/uiInteractions";

test.describe("US1 native Workspace Entry mutation barriers", () => {
  test.describe.configure({ mode: "serial" });

  for (const mode of [
    "success",
    "failure",
    "source-disappeared",
  ] as const satisfies readonly NativeEntryTrashMode[]) {
    test(`Trash ${mode} records invocation and source state without Finder claims`, async ({
      browserName,
    }, testInfo) => {
      void browserName;
      test.skip(
        !nativeEntryBuildConfigured(),
        "Native US1 entry tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
      );
      if (!nativeEntryBuildConfigured()) return;

      const run = await runNativeEntryScenario("entry-trash", {
        EXCALIDRAW_E2E_TRASH_MODE: mode,
      });
      try {
        await attachEvidence(testInfo, run);
        if (run.evidence.scenario !== "entry-trash") {
          throw new Error(`Unexpected scenario: ${run.evidence.scenario}`);
        }
        const evidence = run.evidence;
        expect(evidence.mode).toBe(mode);
        expect(evidence.trashInvoked).toBe(true);
        expect(evidence.targetPath.startsWith(`${run.paths.workspace}/`)).toBe(
          true,
        );
        expect(evidence.trashPath.startsWith(`${run.paths.root}/`)).toBe(true);
        expect(evidence.targetFileIndexBefore).toBe(true);
        expect(evidence.targetMetadataBefore).toBe(true);

        if (mode === "success") {
          expect(evidence.errorCode).toBeNull();
          expect(evidence.sourceExistsAfter).toBe(false);
          expect(evidence.trashExistsAfter).toBe(true);
          expect(evidence.targetFileIndexAfter).toBe(false);
          expect(evidence.targetDraftAfter).toBe(false);
          expect(evidence.targetMetadataAfter).toBe(false);
        } else if (mode === "failure") {
          expect(evidence.errorCode).toBe("IO_ERROR");
          expect(evidence.sourceExistsAfter).toBe(true);
          expect(evidence.trashExistsAfter).toBe(false);
          expect(evidence.targetFileIndexAfter).toBe(true);
          expect(evidence.targetDraftAfter).toBe(true);
          expect(evidence.targetMetadataAfter).toBe(true);
        } else {
          expect(evidence.errorCode).toBe("IO_ERROR");
          expect(evidence.sourceExistsAfter).toBe(false);
          expect(evidence.trashExistsAfter).toBe(false);
          // A provider failure after source disappearance is not a committed
          // Trash operation; exact metadata must remain recoverable.
          expect(evidence.targetFileIndexAfter).toBe(true);
          expect(evidence.targetDraftAfter).toBe(true);
          expect(evidence.targetMetadataAfter).toBe(true);
        }
      } finally {
        await run.cleanup();
      }
    });
  }

  for (const faultPoint of ["source-changed", "target-collision"] as const) {
    test(`rename ${faultPoint} keeps all old paths before commit`, async ({
      browserName,
    }, testInfo) => {
      void browserName;
      test.skip(
        !nativeEntryBuildConfigured(),
        "Native US1 entry tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
      );
      if (!nativeEntryBuildConfigured()) return;

      const run = await runNativeEntryScenario("entry-rename-fault", {
        EXCALIDRAW_E2E_ENTRY_RENAME_FAULT: faultPoint,
      });
      try {
        await attachEvidence(testInfo, run);
        if (run.evidence.scenario !== "entry-rename-fault") {
          throw new Error(`Unexpected scenario: ${run.evidence.scenario}`);
        }
        expect(run.evidence.faultPoint).toBe(faultPoint);
        expect(run.evidence.errorCode).toBe(
          faultPoint === "source-changed" ? "ENTRY_CHANGED" : "NAME_CONFLICT",
        );
        expect(run.evidence.sourceExistsAfter).toBe(true);
        expect(run.evidence.targetExistsAfter).toBe(
          faultPoint === "target-collision",
        );
        expect(
          run.evidence.sourcePath.startsWith(`${run.paths.workspace}/`),
        ).toBe(true);
        expect(
          run.evidence.targetPath.startsWith(`${run.paths.workspace}/`),
        ).toBe(true);
      } finally {
        await run.cleanup();
      }
    });
  }

  test("Directory becoming non-empty after preflight blocks Trash without invocation", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeEntryBuildConfigured(),
      "Native US1 entry tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
    );
    if (!nativeEntryBuildConfigured()) return;

    const run = await runNativeEntryScenario("entry-directory-race");
    try {
      await attachEvidence(testInfo, run);
      if (run.evidence.scenario !== "entry-directory-race") {
        throw new Error(`Unexpected scenario: ${run.evidence.scenario}`);
      }
      expect(run.evidence.preflightStatus).toBe("confirmable");
      expect(run.evidence.errorCode).toBe("DIRECTORY_NOT_EMPTY");
      expect(run.evidence.trashInvoked).toBe(false);
      expect(run.evidence.directoryExistsAfter).toBe(true);
      expect(run.evidence.childExistsAfter).toBe(true);
      expect(
        run.evidence.directoryPath.startsWith(`${run.paths.workspace}/`),
      ).toBe(true);
      expect(run.evidence.childPath.startsWith(`${run.paths.workspace}/`)).toBe(
        true,
      );
    } finally {
      await run.cleanup();
    }
  });

  test("successful Trash removes exact clean metadata and preserves sibling metadata", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeEntryBuildConfigured(),
      "Native US1 entry tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
    );
    if (!nativeEntryBuildConfigured()) return;

    const run = await runNativeEntryScenario("entry-metadata-cleanup");
    try {
      await attachEvidence(testInfo, run);
      if (run.evidence.scenario !== "entry-metadata-cleanup") {
        throw new Error(`Unexpected scenario: ${run.evidence.scenario}`);
      }
      expect(run.evidence.trashInvoked).toBe(true);
      expect(run.evidence.sourceExistsAfter).toBe(false);
      expect(run.evidence.targetFileIndexAfter).toBe(false);
      expect(run.evidence.targetDraftAfter).toBe(false);
      expect(run.evidence.targetMetadataAfter).toBe(false);
      expect(run.evidence.siblingFileIndexAfter).toBe(true);
      expect(run.evidence.siblingDraftAfter).toBe(true);
      expect(run.evidence.siblingMetadataAfter).toBe(true);
    } finally {
      await run.cleanup();
    }
  });

  test("renamed Directory descendants continue saving at migrated paths", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeEntryBuildConfigured(),
      "Native US1 entry tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
    );
    if (!nativeEntryBuildConfigured()) return;

    const run = await runNativeEntryScenario("entry-descendant-save");
    try {
      await attachEvidence(testInfo, run);
      if (run.evidence.scenario !== "entry-descendant-save") {
        throw new Error(`Unexpected scenario: ${run.evidence.scenario}`);
      }
      expect(run.evidence.pathMigrationCount).toBe(
        run.evidence.descendants.length,
      );
      expect(run.evidence.descendants.length).toBeGreaterThanOrEqual(3);
      expect(run.evidence.continuedSaveSucceeded).toBe(true);
      for (const descendant of run.evidence.descendants) {
        expect(descendant.oldExistsAfter).toBe(false);
        expect(descendant.newExistsAfter).toBe(true);
        expect(descendant.newSha256).toMatch(/^[0-9a-f]{64}$/u);
      }
    } finally {
      await run.cleanup();
    }
  });

  test("SIGKILL before Directory rename leaves old tree intact", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeEntryBuildConfigured(),
      "Native US1 entry tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
    );
    if (!nativeEntryBuildConfigured()) return;

    const run = await runNativeEntryRenameKill("before_rename");
    try {
      await attachEvidence(testInfo, run);
      expect(run.evidence.scenario).toBe("entry-rename-kill");
      expect(run.evidence.faultPoint).toBe("before_rename");
      expect(run.evidence.processSignal).toBe("SIGKILL");
      expect(run.evidence.sourceExistsAfter).toBe(true);
      expect(run.evidence.targetExistsAfter).toBe(false);
      expect(run.evidence.descendantOldExistsAfter).toBe(true);
      expect(run.evidence.descendantNewExistsAfter).toBe(false);
    } finally {
      await run.cleanup();
    }
  });
});

async function attachEvidence(
  testInfo: Parameters<Parameters<typeof test>[1]>[1],
  run: {
    environment: unknown;
    evidence: unknown;
  },
): Promise<void> {
  await testInfo.attach("native-entry-evidence", {
    body: Buffer.from(
      JSON.stringify(
        { environment: run.environment, evidence: run.evidence },
        null,
        2,
      ),
    ),
    contentType: "application/json",
  });
}

function nativeEntryBuildConfigured(): boolean {
  return (
    process.env.APP_E2E === "1" && Boolean(process.env.EXCALIDRAW_E2E_BINARY)
  );
}
