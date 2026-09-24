import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";

import {
  HistoryRestartJourneyError,
  runTauriHistoryRestartJourney,
  type HistoryFrontendCanvasEvidence,
  type HistoryCanvasReadback,
  type HistoryRestartVerifyEvidence,
} from "../helpers/reliability";

test("native history survives restart and restores A→B→A with pinned target resources", async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  void browserName;
  test.skip(
    !nativeHistoryRestartBuildConfigured(),
    "Native history restart tests require APP_E2E=1, EXCALIDRAW_E2E_BINARY, and EXCALIDRAW_E2E_HISTORY_RESTART=1.",
  );
  if (!nativeHistoryRestartBuildConfigured()) {
    return;
  }

  const run = await runTauriHistoryRestartJourney().catch(
    async (error: unknown) => {
      if (error instanceof HistoryRestartJourneyError) {
        await testInfo.attach("native-history-restart-failure", {
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
      "native-history-restart-evidence.json",
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
    await testInfo.attach("native-history-restart-evidence", {
      path: evidencePath,
      contentType: "application/json",
    });

    const { seed, frontendB, verifyB, frontendA, verifyA, evict } =
      run.evidence;
    expect(seed.versionCount).toBe(20);
    expect(seed.initialSceneSha256).toBe(seed.sceneASha256);
    expect(seed.targetPath.startsWith(`${run.paths.workspace}/`)).toBe(true);
    expect(seed.historyDatabasePath.startsWith(`${run.paths.data}/`)).toBe(
      true,
    );

    assertFrontendCanvas(
      frontendB,
      seed.versionBId,
      ["text-B", "rect-B", "image-B"],
      seed.assetSha256,
    );
    assertVerify(verifyB, seed.sceneBSha256, seed.assetSha256, seed.versionBId);
    assertSharedOperationIdentity(frontendB, verifyB);
    assertProtectedPriorState(frontendB, verifyB, "A", seed.assetSha256);
    assertFrontendCanvas(
      frontendA,
      seed.versionAId,
      ["text-A", "rect-A", "image-A"],
      seed.assetSha256,
    );
    assertVerify(verifyA, seed.sceneASha256, seed.assetSha256, seed.versionAId);
    assertSharedOperationIdentity(frontendA, verifyA);
    assertProtectedPriorState(frontendA, verifyA, "B", seed.assetSha256);

    expect(evict.requestId).toBe("history-restart-a");
    expect(evict.retainedVersionCount).toBe(20);
    expect(evict.evictedVersionId).toBe(seed.versionAId);
    expect(evict.operationStatusState).toBe("Completed");
    expect(evict.targetSceneSha256).toBe(seed.sceneASha256);
    expect(evict.targetAssetSha256).toBe(seed.assetSha256);
    expect(evict.targetObjectExistsAfterGc).toBe(true);
    expect(evict.targetAssetExistsAfterGc).toBe(true);
    expect(evict.gcDeletedTarget).toBe(false);
    expect(evict.targetRetainedSceneReferences).toBe(0);
    expect(evict.targetRetainedAssetReferences).toBe(0);
    passed = true;
  } finally {
    if (passed) await run.cleanup();
  }
});

function assertFrontendCanvas(
  evidence: HistoryFrontendCanvasEvidence,
  expectedVersionId: string,
  expectedElementIds: string[],
  expectedAssetSha256: string,
): void {
  expect(evidence.requestId).toBe(
    `history-restart-${expectedVersionId.at(-1)?.toLowerCase()}`,
  );
  expect(evidence.targetVersionId).toBe(expectedVersionId);
  expect(evidence.adopted).toBe(true);
  expect(evidence.processExit).toEqual({ code: 0, signal: null });
  expect(evidence.listedVersionIds).toContain(expectedVersionId);
  expect(evidence.previewVersionId).toBe(expectedVersionId);
  const label = expectedVersionId.at(-1)!.toUpperCase();
  assertSceneContents(evidence.canvasReadback, label, expectedAssetSha256);
  assertSceneContents(evidence.previewReadback, label, expectedAssetSha256);
  expect(evidence.canvasReadback.elementIds).toEqual(
    expect.arrayContaining(expectedElementIds),
  );
  expect(Object.values(evidence.canvasReadback.assetHashes)).toContain(
    expectedAssetSha256,
  );
}

function assertSharedOperationIdentity(
  frontend: {
    historyDatabasePath: string;
    activeDocumentId?: string;
    operationDocumentId?: string;
    operationState?: string;
  },
  verify: {
    historyDatabasePath: string;
    activeDocumentId?: string;
    operationDocumentId?: string;
    operationState?: string;
  },
): void {
  expect(frontend.historyDatabasePath).toBe(verify.historyDatabasePath);
  expect(frontend.activeDocumentId).toBeDefined();
  expect(frontend.operationDocumentId).toBe(frontend.activeDocumentId);
  expect(frontend.operationState).toBe("completed");
  expect(verify.activeDocumentId).toBe(frontend.activeDocumentId);
  expect(verify.operationDocumentId).toBe(frontend.operationDocumentId);
  expect(verify.operationState).toBe("completed");
}

function assertVerify(
  evidence: HistoryRestartVerifyEvidence,
  expectedSceneSha256: string,
  expectedAssetSha256: string,
  expectedVersionId: string,
): void {
  expect(evidence.requestId).toBe(
    `history-restart-${expectedVersionId.at(-1)?.toLowerCase()}`,
  );
  expect(evidence.targetVersionId).toBe(expectedVersionId);
  expect(evidence.persistedSceneSha256).toBe(expectedSceneSha256);
  expect(evidence.statusSceneSha256).toBe(expectedSceneSha256);
  expect(evidence.statusState).toBe("Completed");
  expect(evidence.listedVersionIds).not.toContain(expectedVersionId);
  expect(evidence.targetVersionEvicted).toBe(true);
  expect(evidence.retainedVersionCount).toBe(20);
  expect(evidence.targetAssetSha256).toBe(expectedAssetSha256);
  expect(evidence.targetObjectExists).toBe(true);
  expect(evidence.targetAssetExists).toBe(true);
}

function nativeHistoryRestartBuildConfigured(): boolean {
  return (
    process.env.APP_E2E === "1" &&
    Boolean(process.env.EXCALIDRAW_E2E_BINARY) &&
    process.env.EXCALIDRAW_E2E_HISTORY_RESTART === "1"
  );
}

function assertSceneContents(
  scene: HistoryCanvasReadback,
  label: string,
  hash: string,
): void {
  expect(scene.elementIds).toEqual([
    `text-${label}`,
    `rect-${label}`,
    `image-${label}`,
  ]);
  expect(scene.elements[0]).toMatchObject({
    type: "text",
    text: `历史 ${label}`,
    x: 40,
    y: 40,
    width: 180,
    height: 30,
  });
  expect(scene.elements[1]).toMatchObject({
    type: "rectangle",
    x: 40,
    y: 100,
    width: 180,
    height: 90,
  });
  expect(scene.elements[2]).toMatchObject({
    type: "image",
    x: 260,
    y: 100,
    width: 80,
    height: 80,
  });
  expect(Object.values(scene.assetHashes)).toEqual([hash]);
  expect(Object.values(scene.decodedImages)).toEqual([{ width: 1, height: 1 }]);
}

function assertProtectedPriorState(
  frontend: HistoryFrontendCanvasEvidence,
  verify: HistoryRestartVerifyEvidence,
  label: string,
  hash: string,
): void {
  assertSceneContents(frontend.beforeReplacement, label, hash);
  expect(verify.protectionVersionId).toBeTruthy();
  expect(verify.listedVersionIds).toContain(verify.protectionVersionId);
  expect(verify.protectionAssetSha256).toBe(hash);
  const expected = frontend.beforeReplacement.elements.map((element) => ({
    id: element.id,
    type: element.type,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    ...(element.type === "text" ? { text: element.text } : {}),
    ...(element.type === "image" ? { imageAssetSha256: hash } : {}),
  }));
  expect(verify.protectionElements).toEqual(expected);
}
