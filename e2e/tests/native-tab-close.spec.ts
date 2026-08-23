import { expect, test, type TestInfo } from "@playwright/test";

import { runNativeTabCloseScenario } from "../helpers/uiInteractions";

test.describe("US3 native tab close and wheel process barriers", () => {
  test.describe.configure({ mode: "serial" });

  test("Cmd+W closes only the active dirty tab after a tabClose checkpoint", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeEntryBuildConfigured(),
      "Native US3 tab close tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
    );
    if (!nativeEntryBuildConfigured()) return;

    const run = await runNativeTabCloseScenario("cmd-w-active");
    try {
      await attachEvidence(testInfo, run);
      if (run.evidence.scenario !== "cmd-w-active") {
        throw new Error(`Unexpected scenario: ${run.evidence.scenario}`);
      }
      const evidence = run.evidence;
      expect(evidence.shortcut).toBe(
        process.platform === "darwin" ? "Cmd+W" : "Ctrl+W",
      );
      expect(evidence.inactiveTabIdsBefore.length).toBeGreaterThanOrEqual(1);
      expect(evidence.closedTabIds).toEqual([evidence.activeTabIdBefore]);
      expect(evidence.remainingTabIds).toEqual(evidence.inactiveTabIdsBefore);
      expect(evidence.remainingTabIds).not.toContain(evidence.activeTabIdBefore);
      expect(evidence.checkpointInvoked).toBe(true);
      expect(evidence.checkpointReason).toBe("tabClose");
      expect(evidence.closeInvokedCount).toBe(1);
      expect(evidence.windowRemainedOpen).toBe(true);
      expect(evidence.workspaceSidebarRemainedOpen).toBe(true);
    } finally {
      await run.cleanup();
    }
  });

  test("middle-click closes an inactive tab without activating it first", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeEntryBuildConfigured(),
      "Native US3 tab close tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
    );
    if (!nativeEntryBuildConfigured()) return;

    const run = await runNativeTabCloseScenario("middle-click-inactive");
    try {
      await attachEvidence(testInfo, run);
      if (run.evidence.scenario !== "middle-click-inactive") {
        throw new Error(`Unexpected scenario: ${run.evidence.scenario}`);
      }
      const evidence = run.evidence;
      expect(evidence.targetWasActiveBefore).toBe(false);
      expect(evidence.activatedBeforeClose).toBe(false);
      expect(evidence.closedTabIds).toEqual([evidence.targetTabId]);
      expect(evidence.remainingTabIds).not.toContain(evidence.targetTabId);
      expect(evidence.checkpointInvoked).toBe(true);
      expect(evidence.checkpointReason).toBe("tabClose");
      expect(evidence.closeInvokedCount).toBe(1);
    } finally {
      await run.cleanup();
    }
  });

  test("duplicate close requests join one in-flight close and invoke doc_close once", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeEntryBuildConfigured(),
      "Native US3 tab close tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
    );
    if (!nativeEntryBuildConfigured()) return;

    const run = await runNativeTabCloseScenario("duplicate-close");
    try {
      await attachEvidence(testInfo, run);
      if (run.evidence.scenario !== "duplicate-close") {
        throw new Error(`Unexpected scenario: ${run.evidence.scenario}`);
      }
      const evidence = run.evidence;
      expect(evidence.closeRequestCount).toBeGreaterThanOrEqual(2);
      expect(evidence.closeInvokedCount).toBe(1);
      expect(evidence.overlappingCloseDetected).toBe(false);
      expect(evidence.checkpointInvoked).toBe(true);
      expect(evidence.checkpointReason).toBe("tabClose");
    } finally {
      await run.cleanup();
    }
  });

  test("failed close checkpoint leaves the file and session intact", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeEntryBuildConfigured(),
      "Native US3 tab close tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
    );
    if (!nativeEntryBuildConfigured()) return;

    const run = await runNativeTabCloseScenario("checkpoint-failure");
    try {
      await attachEvidence(testInfo, run);
      if (run.evidence.scenario !== "checkpoint-failure") {
        throw new Error(`Unexpected scenario: ${run.evidence.scenario}`);
      }
      const evidence = run.evidence;
      expect(evidence.targetPath.startsWith(`${run.paths.workspace}/`)).toBe(
        true,
      );
      expect(evidence.checkpointInvoked).toBe(true);
      expect(evidence.closeInvokedCount).toBe(0);
      expect(evidence.tabRemainedOpen).toBe(true);
      expect(evidence.sessionIntact).toBe(true);
      expect(evidence.sourceExistsAfter).toBe(true);
      expect(evidence.errorCode).not.toBeNull();
      expect(evidence.persistedSha256).toBe(evidence.originalSha256);
      expect(evidence.originalSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(evidence.draftDirty).toBe(true);
    } finally {
      await run.cleanup();
    }
  });

  test("one vertical mouse-wheel notch activates the next tab once", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeEntryBuildConfigured(),
      "Native US3 tab close tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
    );
    if (!nativeEntryBuildConfigured()) return;

    const run = await runNativeTabCloseScenario("wheel-vertical-notch");
    try {
      await attachEvidence(testInfo, run);
      if (run.evidence.scenario !== "wheel-vertical-notch") {
        throw new Error(`Unexpected scenario: ${run.evidence.scenario}`);
      }
      const evidence = run.evidence;
      expect(evidence.inputKind).toBe("mouse-wheel");
      expect(evidence.axis).toBe("vertical");
      expect(evidence.modifierKeys).toEqual([]);
      expect(evidence.notchCount).toBe(1);
      expect(evidence.activationCount).toBe(1);
      expect(evidence.overlappingActivationDetected).toBe(false);
      expect(evidence.checkpointInvoked).toBe(true);
      expect(evidence.checkpointReason).toBe("tabSwitch");
      expect(evidence.finalActiveTabId).toBe(evidence.intendedActiveTabId);
      expect(evidence.finalActiveTabId).not.toBe(evidence.previousActiveTabId);
    } finally {
      await run.cleanup();
    }
  });
});

async function attachEvidence(
  testInfo: TestInfo,
  run: {
    environment: unknown;
    evidence: unknown;
  },
): Promise<void> {
  await testInfo.attach("native-tab-close-evidence", {
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
