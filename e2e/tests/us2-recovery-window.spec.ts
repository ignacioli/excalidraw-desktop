import { expect, test } from "@playwright/test";

import { runTauriRecoveryScenario } from "../helpers/reliability";

test("normal exit is dialog-free and abnormal recovery restores the last edit within 5s", async ({
  browserName,
}, testInfo) => {
  void browserName;
  test.skip(
    !nativeRecoveryBuildConfigured(),
    "Native recovery tests require APP_E2E=1, EXCALIDRAW_E2E_BINARY, and EXCALIDRAW_E2E_RECOVERY=1 after lifecycle/recovery integration.",
  );
  if (!nativeRecoveryBuildConfigured()) {
    return;
  }

  const run = await runTauriRecoveryScenario("recovery-window");
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

    if (run.evidence.scenario !== "recovery-window") {
      throw new Error(
        `Expected recovery-window evidence, received ${run.evidence.scenario}.`,
      );
    }
    const { evidence } = run;
    expect(evidence.normalExitDialogVisible).toBe(false);
    expect(evidence.forcedExitDialogVisible).toBe(true);
    expect(evidence.recoveryElapsedMs).toBeLessThanOrEqual(5_000);
    const expectedScene = JSON.parse(evidence.expectedSceneJson) as unknown;
    const restoredScene = JSON.parse(evidence.restoredSceneJson) as unknown;
    expect(restoredScene).toEqual(expectedScene);
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
