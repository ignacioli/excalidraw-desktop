import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";

import {
  HistoryMarkReuseJourneyError,
  runTauriHistoryMarkReuseJourney,
  type HistoryMarkResponseEvidence,
} from "../helpers/reliability";

test("same-document Mark reuses one durable version across serial, concurrent, and fresh-process calls", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  void browserName;
  test.skip(
    !nativeMarkReuseBuildConfigured(),
    "Native Mark restart proof requires APP_E2E=1, EXCALIDRAW_E2E_BINARY, and EXCALIDRAW_E2E_HISTORY_MARK_REUSE=1 for a matching test-only build.",
  );
  if (!nativeMarkReuseBuildConfigured()) return;

  const run = await runTauriHistoryMarkReuseJourney().catch(
    async (error: unknown) => {
      if (error instanceof HistoryMarkReuseJourneyError) {
        await testInfo.attach("native-history-mark-restart-failure", {
          body: Buffer.from(
            JSON.stringify(
              {
                stage: error.stage,
                paths: error.paths,
                evidence: error.evidence,
                error: error.message,
              },
              null,
              2,
            ),
          ),
          contentType: "application/json",
        });
      }
      throw error;
    },
  );
  let passed = false;
  try {
    const evidencePath = testInfo.outputPath(
      "native-history-mark-restart.json",
    );
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          environment: run.environment,
          paths: run.paths,
          evidence: run.evidence,
        },
        null,
        2,
      ),
    );
    await testInfo.attach("native-history-mark-restart-evidence", {
      path: evidencePath,
      contentType: "application/json",
    });

    const { seed, verify } = run.evidence;
    expect(seed.processId).toBeGreaterThan(0);
    expect(verify.processId).toBeGreaterThan(0);
    expect(verify.processId).not.toBe(seed.processId);
    expect(seed.targetPath.startsWith(`${run.paths.workspace}/`)).toBe(true);
    expect(seed.historyDatabasePath.startsWith(`${run.paths.data}/`)).toBe(
      true,
    );
    expect(seed.assetSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(seed.original.source).toBe("manual");
    expect(seed.original.reused).toBe(false);
    expect(seed.original.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(seed.original.recordedAt).toBeGreaterThan(0);
    expect(seed.afterOriginalCount).toBe(seed.beforeCount + 1);
    expect(seed.serialResponses).toHaveLength(10);
    expect(seed.concurrentResponses).toHaveLength(2);
    expect(seed.afterSerialCount).toBe(seed.afterOriginalCount);
    expect(seed.afterConcurrentCount).toBe(seed.afterSerialCount);
    for (const response of [
      ...seed.serialResponses,
      ...seed.concurrentResponses,
    ]) {
      assertReusedMark(response, seed.original);
    }

    expect(verify.targetPath).toBe(seed.targetPath);
    expect(verify.documentId).toBe(seed.documentId);
    expect(verify.historyDatabasePath).toBe(seed.historyDatabasePath);
    expect(verify.originalVersionId).toBe(seed.original.versionId);
    expect(verify.originalContentHash).toBe(seed.original.contentHash);
    expect(verify.originalRecordedAt).toBe(seed.original.recordedAt);
    expect(verify.originalPreviewAssetSha256).toBe(seed.assetSha256);
    expect(verify.beforeCount).toBe(seed.afterConcurrentCount);
    assertReusedMark(verify.restartResponse, seed.original);
    expect(verify.afterRestartCount).toBe(verify.beforeCount);

    expect(verify.changedResponse.reused).toBe(false);
    expect(verify.changedResponse.source).toBe("manual");
    expect(verify.changedResponse.versionId).not.toBe(seed.original.versionId);
    expect(verify.changedResponse.contentHash).not.toBe(
      seed.original.contentHash,
    );
    expect(verify.afterChangedCount).toBe(verify.afterRestartCount + 1);
    expect(verify.otherDocumentId).not.toBe(seed.documentId);
    expect(verify.otherTargetPath).not.toBe(seed.targetPath);
    expect(verify.otherTargetPath.startsWith(`${run.paths.workspace}/`)).toBe(
      true,
    );
    expect(verify.crossDocumentResponse.reused).toBe(false);
    expect(verify.crossDocumentResponse.source).toBe("manual");
    expect(verify.crossDocumentResponse.versionId).not.toBe(
      seed.original.versionId,
    );
    expect(verify.crossDocumentResponse.contentHash).toBe(
      seed.original.contentHash,
    );
    expect(verify.otherAfterCount).toBe(verify.otherBeforeCount + 1);

    expect(verify.unmarkResponse).toEqual({
      versionId: seed.original.versionId,
      marked: false,
      retained: true,
    });
    expect(verify.remarkResponse).toEqual({
      versionId: seed.original.versionId,
      marked: true,
      retained: true,
    });
    passed = true;
  } finally {
    if (passed) await run.cleanup();
  }
});

function assertReusedMark(
  response: HistoryMarkResponseEvidence,
  original: HistoryMarkResponseEvidence,
): void {
  expect(response).toEqual({ ...original, reused: true });
}

function nativeMarkReuseBuildConfigured(): boolean {
  return (
    process.env.APP_E2E === "1" &&
    Boolean(process.env.EXCALIDRAW_E2E_BINARY) &&
    process.env.EXCALIDRAW_E2E_HISTORY_MARK_REUSE === "1"
  );
}
