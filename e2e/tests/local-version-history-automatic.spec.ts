import { expect, test } from "@playwright/test";

import { runTauriHistoryAutomaticJourney } from "../helpers/reliability";

test.describe("US2 automatic history cadence", () => {
  test.describe.configure({ mode: "serial" });

  for (const mixedCount of [19, 20] as const) {
    test(`keeps the mixed automatic/protected pool at ${mixedCount} records`, async ({
      browserName,
    }) => {
      void browserName;
      test.skip(
        !nativeAutomaticBuildConfigured(),
        "Native automatic-history tests require APP_E2E=1, EXCALIDRAW_E2E_BINARY, and EXCALIDRAW_E2E_HISTORY_AUTOMATIC=1.",
      );
      if (!nativeAutomaticBuildConfigured()) return;

      const run = await runTauriHistoryAutomaticJourney(mixedCount);
      try {
        const { seed, verify } = run.evidence;
        expect(seed.baselineOutcome).toBe("baselineEstablished");
        expect(seed.beforeBoundaryOutcome).toBe("waiting");
        expect(seed.noChangeOutcome).toBe("noChange");
        expect(seed.boundaryOutcome).toBe("published");
        expect(seed.clockBoundaryAt - seed.clockBaselineAt).toBe(30 * 60);
        expect(seed.clockBeforeBoundaryAt).toBe(seed.clockBoundaryAt - 1);
        expect(seed.coldCheckpointCalls).toBe(4);
        expect(seed.timerWakeups).toBe(0);
        expect(verify.timerWakeups).toBe(0);
        expect(verify.retainedPoolCount).toBe(mixedCount);
        expect(verify.manualVersionCount).toBe(1);
        expect(verify.retainedVersionCount).toBe(mixedCount + 1);
        expect(verify.listedVersionIds).toContain(seed.automaticVersionId);
        const actualSources = new Map(
          verify.listedSources.map(({ versionId, source }) => [
            versionId,
            source,
          ]),
        );
        for (const expected of seed.mixedSources) {
          expect(actualSources.get(expected.versionId)).toBe(expected.source);
        }
      } finally {
        await run.cleanup();
      }
    });
  }
});

function nativeAutomaticBuildConfigured(): boolean {
  return (
    process.env.APP_E2E === "1" &&
    Boolean(process.env.EXCALIDRAW_E2E_BINARY) &&
    process.env.EXCALIDRAW_E2E_HISTORY_AUTOMATIC === "1"
  );
}
