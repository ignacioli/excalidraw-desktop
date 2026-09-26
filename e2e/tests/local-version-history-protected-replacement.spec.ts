import { expect, test, type TestInfo } from "@playwright/test";

import {
  runTauriHistoryProtectedReplacement,
  runTauriHistoryProtectedReplacementResponseLost,
  type HistoryProtectedReplacementEvidence,
} from "../helpers/reliability";

const TARGET_KINDS = ["clear", "import"] as const;
type TargetKind = (typeof TARGET_KINDS)[number];

test.describe("US3 target-specific protected replacement", () => {
  test.describe.configure({ mode: "serial" });

  for (const targetKind of TARGET_KINDS) {
    test(`${targetKind} uses the shared replacement transaction and publishes the target`, async ({
      browserName,
    }, testInfo) => {
      void browserName;
      test.setTimeout(120_000);
      test.skip(
        !nativeProtectedReplacementBuildConfigured(),
        "Native protected-replacement tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
      );
      if (!nativeProtectedReplacementBuildConfigured()) return;

      const run = await runTauriHistoryProtectedReplacement(targetKind);
      try {
        await attachEvidence(testInfo, run.evidence, run.environment);
        assertTargetIdentity(run.evidence, targetKind);
        expect(run.evidence.failureMode).toBe("none");
        expect(run.evidence.replacementInvocationCount).toBe(1);
        expect(run.evidence.replacementCommitted).toBe(true);
        expect(run.evidence.responseState).toBe("completed");
        expect(run.evidence.operationStatusState).toBe("Completed");
        expect(run.evidence.protectionAction).toBe(targetKind);
        expect(run.evidence.protectionVersionId).toMatch(/^protected-/u);
        expect(run.evidence.protectedVersionCount).toBe(1);
        expect(run.evidence.persistedSha256).toBe(
          run.evidence.expectedTargetSha256,
        );
        expect(run.evidence.targetUnchanged).toBe(false);
        expect(run.evidence.parseableJson).toBe(true);
        expect(run.evidence.temporaryFiles).toEqual([]);
        expect(run.evidence.error).toBeUndefined();
      } finally {
        await run.cleanup();
      }
    });
  }

  for (const failureMode of ["disk-full", "permission-denied"] as const) {
    for (const targetKind of TARGET_KINDS) {
      test(`${targetKind} protection ${failureMode} keeps the target unchanged`, async ({
        browserName,
      }, testInfo) => {
        void browserName;
        test.setTimeout(120_000);
        test.skip(
          !nativeProtectedReplacementBuildConfigured(),
          "Native protected-replacement tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
        );
        if (!nativeProtectedReplacementBuildConfigured()) return;

        const run = await runTauriHistoryProtectedReplacement(
          targetKind,
          failureMode,
        );
        try {
          await attachEvidence(testInfo, run.evidence, run.environment);
          assertTargetIdentity(run.evidence, targetKind);
          expect(run.evidence.failureMode).toBe(failureMode);
          expect(run.evidence.replacementInvocationCount).toBe(1);
          expect(run.evidence.replacementCommitted).not.toBe(true);
          expect(run.evidence.responseState).toBe("error");
          expect(run.evidence.targetUnchanged).toBe(true);
          expect(run.evidence.persistedSha256).toBe(run.evidence.oldSha256);
          expect(run.evidence.parseableJson).toBe(true);
          expect(run.evidence.protectedVersionCount).toBe(0);
          expect(run.evidence.temporaryFiles).toEqual([]);
          expect(run.evidence.error).toBeTruthy();
        } finally {
          await run.cleanup();
        }
      });
    }
  }

  for (const targetKind of TARGET_KINDS) {
    test(`${targetKind} survives a lost response after target publication`, async ({
      browserName,
    }, testInfo) => {
      void browserName;
      test.setTimeout(120_000);
      test.skip(
        !nativeProtectedReplacementBuildConfigured(),
        "Native protected-replacement tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
      );
      if (!nativeProtectedReplacementBuildConfigured()) return;

      const run =
        await runTauriHistoryProtectedReplacementResponseLost(targetKind);
      try {
        await attachEvidence(testInfo, run.evidence, run.environment);
        assertTargetIdentity(run.evidence, targetKind);
        expect(run.evidence.failureMode).toBe("response-lost");
        expect(run.evidence.replacementInvocationCount).toBe(1);
        expect(run.evidence.replacementCommitted).toBe(true);
        expect(run.evidence.responseState).toBe("lost");
        expect(run.evidence.operationStatusState).toBe("Completed");
        expect(run.evidence.protectionAction).toBe(targetKind);
        expect(run.evidence.protectionVersionId).toMatch(/^protected-/u);
        expect(run.evidence.protectedVersionCount).toBe(1);
        expect(run.evidence.persistedSha256).toBe(
          run.evidence.expectedTargetSha256,
        );
        expect(run.evidence.targetUnchanged).toBe(false);
        expect(run.evidence.parseableJson).toBe(true);
        expect(run.evidence.temporaryFiles).toEqual([]);
      } finally {
        await run.cleanup();
      }
    });
  }

  test("import missing asset fails before replacement and preserves the old file", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.setTimeout(120_000);
    test.skip(
      !nativeProtectedReplacementBuildConfigured(),
      "Native protected-replacement tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
    );
    if (!nativeProtectedReplacementBuildConfigured()) return;

    const run = await runTauriHistoryProtectedReplacement(
      "import",
      "missing-asset",
    );
    try {
      await attachEvidence(testInfo, run.evidence, run.environment);
      assertTargetIdentity(run.evidence, "import");
      expect(run.evidence.failureMode).toBe("missing-asset");
      expect(run.evidence.replacementInvocationCount).toBe(1);
      expect(run.evidence.replacementCommitted).not.toBe(true);
      expect(run.evidence.responseState).toBe("error");
      expect(run.evidence.targetUnchanged).toBe(true);
      expect(run.evidence.persistedSha256).toBe(run.evidence.oldSha256);
      expect(run.evidence.parseableJson).toBe(true);
      expect(run.evidence.protectedVersionCount).toBe(0);
      expect(run.evidence.temporaryFiles).toEqual([]);
      expect(run.evidence.error).toBeTruthy();
    } finally {
      await run.cleanup();
    }
  });
});

function nativeProtectedReplacementBuildConfigured(): boolean {
  return (
    process.env.APP_E2E === "1" && Boolean(process.env.EXCALIDRAW_E2E_BINARY)
  );
}

function assertTargetIdentity(
  evidence: HistoryProtectedReplacementEvidence,
  targetKind: TargetKind,
): void {
  expect(evidence.scenario).toBe("history-protected-replacement");
  expect(evidence.targetKind).toBe(targetKind);
  expect(evidence.targetPath).toContain("excalidraw-desktop-e2e-");
}

async function attachEvidence(
  testInfo: TestInfo,
  evidence: HistoryProtectedReplacementEvidence,
  environment: unknown,
): Promise<void> {
  await testInfo.attach("native-history-protected-replacement-evidence", {
    body: Buffer.from(JSON.stringify({ environment, evidence }, null, 2)),
    contentType: "application/json",
  });
}
