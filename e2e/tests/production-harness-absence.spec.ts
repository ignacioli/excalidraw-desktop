import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

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

test("production executable omits native history restart driver tokens", async () => {
  const binaryPath = process.env.TAURI_PRODUCTION_BINARY;
  test.skip(
    !binaryPath,
    "Set TAURI_PRODUCTION_BINARY to a production build without the e2e-harness feature.",
  );
  if (!binaryPath) {
    return;
  }

  const executable = await readFile(binaryPath);
  const testOnlyTokens = [
    "history-restart-seed",
    "history-restart-restore",
    "history-restart-verify",
    "history-restart-evict",
    "e2e_history_frontend_bootstrap",
    "e2e_history_frontend_publish",
    "history-frontend-adoption",
    "VITE_E2E_HISTORY_FRONTEND",
  ];
  const exposed = testOnlyTokens.filter((token) =>
    executable.includes(Buffer.from(token)),
  );
  expect(exposed).toEqual([]);
});

test("production executable omits the multi-window driver", async () => {
  const binaryPath = process.env.TAURI_PRODUCTION_BINARY;
  test.skip(
    !binaryPath,
    "Set TAURI_PRODUCTION_BINARY to a production build without the e2e-harness feature.",
  );
  if (!binaryPath) {
    return;
  }

  const executable = await readFile(binaryPath);
  const testOnlyTokens = [
    "e2e_multi_window_bootstrap",
    "e2e_multi_window_next",
    "e2e_multi_window_publish",
    "EXCALIDRAW_E2E_MULTI_WINDOW",
    "setCheckpointFault",
  ];
  const exposed = testOnlyTokens.filter((token) =>
    executable.includes(Buffer.from(token)),
  );
  expect(exposed).toEqual([]);
});
