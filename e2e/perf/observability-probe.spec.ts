import { expect, test } from "@playwright/test";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  describeAppError,
  launchTauriTestApp,
  resolveDesktopBinary,
} from "../helpers/app";
import {
  NativePerformanceControl,
  RESULT_PUBLISH_SLACK_MS,
} from "./helpers/nativePerformanceContract";

const READY_TIMEOUT_MS = 15_000;
const PROBE_PAN_ZOOM_MS = 3_000;
const PRODUCTION_IGNORE_WAIT_MS = 8_000;

test.describe("native performance command/result observability", () => {
  test.skip(
    process.env.PERF_OBSERVABILITY !== "1",
    "Set PERF_OBSERVABILITY=1 to probe command.json → result.json before T090/T108.",
  );

  test("harness publishes result.json for a short visible pan-zoom", async () => {
    test.setTimeout(120_000);
    const control = await NativePerformanceControl.create({
      scenario: "startup-editable",
      seed: 72_000,
    });
    const app = await launchTauriTestApp({
      binaryPath: await resolveDesktopBinary(),
      environment: control.environment,
    });
    try {
      const ready = await control.waitForReady(READY_TIMEOUT_MS);
      expect(ready.elementCount).toBe(0);
      expect(ready.visibilityState).toBe("visible");

      const command = await control.sendCommand({
        operation: "pan-zoom",
        durationMs: PROBE_PAN_ZOOM_MS,
        seed: 72_001,
      });
      const result = await control.waitForResult(
        command,
        PROBE_PAN_ZOOM_MS + RESULT_PUBLISH_SLACK_MS,
      );
      expect(result.commandId).toBe(command.commandId);
      expect(result.completed).toBe(true);
      expect(result.frameIntervalsMs.length).toBeGreaterThan(0);
    } catch (error) {
      throw new Error(describeAppError(error, app), { cause: error });
    } finally {
      await app.close();
      await control.dispose();
    }
  });

  test("production ignores EXCALIDRAW_PERF_CONTROL_DIR", async () => {
    test.setTimeout(60_000);
    const productionBinary = process.env.TAURI_PRODUCTION_BINARY;
    test.skip(
      !productionBinary,
      "Set TAURI_PRODUCTION_BINARY to prove production ignores the control directory.",
    );

    const control = await NativePerformanceControl.create({
      scenario: "startup-editable",
      seed: 72_100,
    });
    const app = await launchTauriTestApp({
      binaryPath: productionBinary,
      environment: control.environment,
    });
    try {
      await delay(PRODUCTION_IGNORE_WAIT_MS);
      await expect(
        access(join(control.root, "ready.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(join(control.root, "result.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(join(control.root, "error.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await app.close();
      await control.dispose();
    }
  });
});
