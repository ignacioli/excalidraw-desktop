import { expect, test } from "@playwright/test";

import { ATOMIC_WRITE_FAULT_POINTS } from "../helpers/fault";
import { runTauriAtomicWriteKill } from "../helpers/reliability";

test.describe("US2 atomic-write SIGKILL boundaries", () => {
  test.describe.configure({ mode: "serial" });

  for (const faultPoint of ATOMIC_WRITE_FAULT_POINTS) {
    test(`preserves an old or new complete document at ${faultPoint}`, async ({
      browserName,
    }, testInfo) => {
      void browserName;
      test.skip(
        !nativeReliabilityBuildConfigured(),
        "Native US2 tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
      );
      if (!nativeReliabilityBuildConfigured()) {
        return;
      }

      const run = await runTauriAtomicWriteKill(faultPoint);
      try {
        await testInfo.attach("native-reliability-evidence", {
          body: Buffer.from(
            JSON.stringify(
              {
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
        expect(evidence.scenario).toBe("atomic-write-kill");
        expect(evidence.faultPoint).toBe(faultPoint);
        expect(evidence.processSignal).toBe("SIGKILL");
        expect(evidence.targetPath.startsWith(`${run.paths.workspace}/`)).toBe(
          true,
        );

        // The fixture marker and the post-kill file must each be valid JSON.
        // The target may be the complete old version (rename not reached) or
        // the complete new version (rename reached), but never a third state.
        expect(
          () => JSON.parse(evidence.oldSceneJson) as unknown,
        ).not.toThrow();
        expect(
          () => JSON.parse(evidence.newSceneJson) as unknown,
        ).not.toThrow();
        expect(
          () => JSON.parse(evidence.persistedSceneJson) as unknown,
        ).not.toThrow();
        expect(evidence.oldSha256).not.toBe(evidence.newSha256);
        expect([evidence.oldSha256, evidence.newSha256]).toContain(
          evidence.persistedSha256,
        );

        const expectedSceneJson =
          evidence.persistedSha256 === evidence.oldSha256
            ? evidence.oldSceneJson
            : evidence.newSceneJson;
        expect(evidence.persistedSceneJson).toBe(expectedSceneJson);

        // A SIGKILL can leave the in-flight .tmp behind; it must be a scoped
        // target temporary, never an alternate document or an overwrite.
        for (const temporaryFile of evidence.temporaryFiles) {
          expect(temporaryFile.startsWith(`${run.paths.workspace}/`)).toBe(
            true,
          );
          expect(temporaryFile).toMatch(/\.tmp$/u);
        }
      } finally {
        await run.cleanup();
      }
    });
  }

  test("nightly run records 100 random seeds across the fault matrix", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      process.env.RELIABILITY_NIGHTLY !== "1",
      "Set RELIABILITY_NIGHTLY=1 and RELIABILITY_NIGHTLY_SEEDS to run the fixed-machine 100-seed campaign.",
    );
    test.skip(
      !nativeReliabilityBuildConfigured(),
      "Nightly native reliability tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
    );
    if (
      process.env.RELIABILITY_NIGHTLY !== "1" ||
      !nativeReliabilityBuildConfigured()
    ) {
      return;
    }

    const seeds = parseNightlySeeds(process.env.RELIABILITY_NIGHTLY_SEEDS);
    expect(seeds).toHaveLength(100);
    const reports: Array<unknown> = [];
    for (const [index, seed] of seeds.entries()) {
      const faultPoint =
        ATOMIC_WRITE_FAULT_POINTS[index % ATOMIC_WRITE_FAULT_POINTS.length];
      const run = await runTauriAtomicWriteKill(faultPoint, seed);
      try {
        const { evidence } = run;
        expect(evidence.processSignal).toBe("SIGKILL");
        expect([evidence.oldSha256, evidence.newSha256]).toContain(
          evidence.persistedSha256,
        );
        expect(
          () => JSON.parse(evidence.persistedSceneJson) as unknown,
        ).not.toThrow();
        reports.push({ environment: run.environment, evidence });
      } finally {
        await run.cleanup();
      }
    }
    await testInfo.attach("native-reliability-nightly-evidence", {
      body: Buffer.from(JSON.stringify(reports, null, 2)),
      contentType: "application/json",
    });
  });
});

function nativeReliabilityBuildConfigured(): boolean {
  return (
    process.env.APP_E2E === "1" && Boolean(process.env.EXCALIDRAW_E2E_BINARY)
  );
}

function parseNightlySeeds(value: string | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(",")
    .map((seed) => seed.trim())
    .filter((seed) => seed.length > 0);
}
