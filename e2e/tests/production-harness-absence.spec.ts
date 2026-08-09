import { test } from "@playwright/test";

import { assertProductionBinaryOmitsFaultHarness } from "../helpers/fault";

test("production executable omits the fault-injection interface", async () => {
  const binaryPath = process.env.TAURI_PRODUCTION_BINARY;
  test.skip(
    !binaryPath,
    "Set TAURI_PRODUCTION_BINARY to a production build without the e2e-harness feature.",
  );
  if (!binaryPath) {
    return;
  }

  await assertProductionBinaryOmitsFaultHarness(binaryPath);
});
