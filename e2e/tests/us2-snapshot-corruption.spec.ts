import { expect, test } from "@playwright/test";

import { runTauriRecoveryScenario } from "../helpers/reliability";

test("corrupting the latest recovery snapshot falls back to the next valid one", async ({
  browserName,
}, testInfo) => {
  void browserName;
  test.skip(
    !nativeRecoveryBuildConfigured(),
    "Native recovery tests require APP_E2E=1, EXCALIDRAW_E2E_BINARY, and EXCALIDRAW_E2E_RECOVERY=1 after the recovery service is integrated.",
  );
  if (!nativeRecoveryBuildConfigured()) {
    return;
  }

  const run = await runTauriRecoveryScenario("snapshot-corruption");
  try {
    await testInfo.attach("native-recovery-evidence", {
      body: Buffer.from(
        JSON.stringify(
          { environment: run.environment, evidence: run.evidence },
          null,
          2,
        ),
      ),
      contentType: "application/json",
    });

    if (run.evidence.scenario !== "snapshot-corruption") {
      throw new Error(
        `Expected snapshot-corruption evidence, received ${run.evidence.scenario}.`,
      );
    }
    const { evidence } = run;
    expect(evidence.targetPath.startsWith(`${run.paths.workspace}/`)).toBe(
      true,
    );
    expect(evidence.latestSnapshotPath.startsWith(`${run.paths.data}/`)).toBe(
      true,
    );
    expect(evidence.fallbackSnapshotPath.startsWith(`${run.paths.data}/`)).toBe(
      true,
    );
    expect(evidence.latestSnapshotPath).not.toBe(evidence.fallbackSnapshotPath);
    expect(evidence.latestSnapshotCorrupted).toBe(true);
    expect(evidence.recoveryDialogVisible).toBe(true);
    expect(evidence.recoveredSnapshotSavedAt).toBe(
      evidence.expectedFallbackSavedAt,
    );
    expect(evidence.snapshotsRemaining).toBe(0);
    expect(JSON.parse(evidence.recoveredSceneJson)).toMatchObject({
      elements: [{ id: "fallback" }],
    });
    expect(JSON.parse(evidence.targetSceneJson)).toMatchObject({
      elements: [{ id: "on-disk" }],
    });
  } finally {
    await run.cleanup();
  }
});

function nativeRecoveryBuildConfigured(): boolean {
  return (
    process.env.APP_E2E === "1" &&
    Boolean(process.env.EXCALIDRAW_E2E_BINARY) &&
    process.env.EXCALIDRAW_E2E_RECOVERY === "1"
  );
}
