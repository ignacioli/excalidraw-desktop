import { expect, test } from "@playwright/test";

import { runTauriHistoryRestartJourney } from "../helpers/reliability";

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

  const run = await runTauriHistoryRestartJourney();
  try {
    await testInfo.attach("native-history-restart-evidence", {
      body: Buffer.from(
        JSON.stringify(
          {
            environment: run.environment,
            paths: run.paths,
            evidence: run.evidence,
          },
          null,
          2,
        ),
      ),
      contentType: "application/json",
    });

    const { seed, frontendB, verifyB, frontendA, verifyA, evict } =
      run.evidence;
    expect(seed.versionCount).toBe(2);
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
    assertFrontendCanvas(
      frontendA,
      seed.versionAId,
      ["text-A", "rect-A", "image-A"],
      seed.assetSha256,
    );
    assertVerify(verifyA, seed.sceneASha256, seed.assetSha256, seed.versionAId);
    assertSharedOperationIdentity(frontendA, verifyA);

    expect(evict.requestId).toBe("history-restart-a");
    expect(evict.retainedVersionCount).toBe(20);
    expect(evict.evictedVersionId).toBe(seed.versionAId);
    expect(evict.operationStatusState).toBe("Completed");
    expect(evict.targetSceneSha256).toBe(seed.sceneASha256);
    expect(evict.targetAssetSha256).toBe(seed.assetSha256);
    expect(evict.targetObjectExistsAfterGc).toBe(true);
    expect(evict.targetAssetExistsAfterGc).toBe(true);
    expect(evict.gcDeletedTarget).toBe(false);
  } finally {
    await run.cleanup();
  }
});

function assertFrontendCanvas(
  evidence: {
    requestId: string;
    targetVersionId: string;
    adopted: true;
    canvasReadback: {
      elementIds: string[];
      elementTypes: string[];
      assetHashes: Record<string, string>;
    };
  },
  expectedVersionId: string,
  expectedElementIds: string[],
  expectedAssetSha256: string,
): void {
  expect(evidence.requestId).toBe(
    `history-restart-${expectedVersionId.at(-1)?.toLowerCase()}`,
  );
  expect(evidence.targetVersionId).toBe(expectedVersionId);
  expect(evidence.adopted).toBe(true);
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
  evidence: {
    requestId: string;
    targetVersionId: string;
    persistedSceneSha256: string;
    statusSceneSha256?: string;
    statusState: string;
    listedVersionIds: string[];
    targetAssetSha256: string;
    targetObjectExists: boolean;
    targetAssetExists: boolean;
  },
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
  expect(evidence.listedVersionIds).toContain(expectedVersionId);
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
