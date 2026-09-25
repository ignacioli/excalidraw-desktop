import { expect, test } from "@playwright/test";

import { runTauriHistoryAutomaticJourney } from "../helpers/reliability";

test("automatic/manual history survives restart and the 21st pooled record evicts only the oldest pooled row", async ({
  browserName,
}) => {
  void browserName;
  test.skip(
    !nativeAutomaticBuildConfigured(),
    "Native automatic-history restart tests require APP_E2E=1, EXCALIDRAW_E2E_BINARY, and EXCALIDRAW_E2E_HISTORY_AUTOMATIC=1.",
  );
  if (!nativeAutomaticBuildConfigured()) return;

  const run = await runTauriHistoryAutomaticJourney(21);
  try {
    const { seed, verify } = run.evidence;
    expect(verify.historyDatabasePath).toBe(seed.historyDatabasePath);
    expect(verify.documentId).toBe(seed.documentId);
    expect(verify.targetPath).toBe(seed.targetPath);
    expect(verify.targetSha256).toBe(seed.postEditSceneSha256);

    expect(verify.manualVersionId).toBe(seed.manualVersionId);
    expect(verify.manualAvailableAfterRestart).toBe(true);
    expect(verify.manualSource).toBe("manual");
    expect(seed.manualContentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(verify.manualSceneSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(verify.manualElementIds).toEqual([
      "text-B",
      "rect-B",
      "image-B",
    ]);
    expect(verify.manualSceneSha256).not.toBe(seed.postEditSceneSha256);
    expect(verify.listedVersionIds).toContain(seed.manualVersionId);

    expect(verify.retainedPoolCount).toBe(20);
    expect(verify.manualVersionCount).toBe(1);
    expect(verify.retainedVersionCount).toBe(21);
    expect(verify.automaticVersionCount).toBeGreaterThan(0);
    expect(verify.protectedVersionCount).toBeGreaterThan(0);
    expect(verify.listedVersionIds).not.toContain(seed.automaticVersionId);
    expect(seed.mixedVersionIds).toHaveLength(21);
    expect(seed.mixedSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "automatic" }),
        expect.objectContaining({ source: "protected" }),
      ]),
    );
    const actualSources = new Map(
      verify.listedSources.map(({ versionId, source }) => [versionId, source]),
    );
    for (const expected of seed.mixedSources.slice(1)) {
      expect(actualSources.get(expected.versionId)).toBe(expected.source);
    }
    expect(seed.timerWakeups).toBe(0);
    expect(verify.timerWakeups).toBe(0);
  } finally {
    await run.cleanup();
  }
});

function nativeAutomaticBuildConfigured(): boolean {
  return (
    process.env.APP_E2E === "1" &&
    Boolean(process.env.EXCALIDRAW_E2E_BINARY) &&
    process.env.EXCALIDRAW_E2E_HISTORY_AUTOMATIC === "1"
  );
}
