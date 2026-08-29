import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import {
  REQUIRED_NATIVE_WINDOW_TITLE,
  runNativeWindowContractScenario,
} from "../helpers/uiInteractions";

const TAURI_CONF_PATH = fileURLToPath(
  new URL("../../src-tauri/tauri.conf.json", import.meta.url),
);
const DEFAULT_CAPABILITY_PATH = fileURLToPath(
  new URL("../../src-tauri/capabilities/default.json", import.meta.url),
);
const LIB_RS_PATH = fileURLToPath(
  new URL("../../src-tauri/src/lib.rs", import.meta.url),
);

test.describe("US4 native window contract (titlebar choice A)", () => {
  test("production window title is Excalidraw Whiteboard", async () => {
    const windowConfig = await readPrimaryWindowConfig();
    expect(windowConfig.title).toBe(REQUIRED_NATIVE_WINDOW_TITLE);
  });

  test("window is ordinary decorated without transparency or overlay title bar", async () => {
    const windowConfig = await readPrimaryWindowConfig();
    expect(windowConfig.decorations).not.toBe(false);
    expect(windowConfig.transparent).not.toBe(true);
    expect(windowConfig.hiddenTitle).not.toBe(true);
    expect(windowConfig.titleBarStyle ?? "Visible").toBe("Visible");
    expect(windowConfig.titleBarStyle).not.toBe("Overlay");
    expect(windowConfig.titleBarStyle).not.toBe("Transparent");
  });

  test("production tauri.conf.json does not set alwaysOnTop", async () => {
    const windowConfig = await readPrimaryWindowConfig();
    expect(windowConfig.alwaysOnTop).not.toBe(true);
  });

  test("native close checkpoint may destroy the main window", async () => {
    const permissions = await readDefaultCapabilityPermissions();
    expect(permissions).toContain("core:window:allow-destroy");
  });

  test("lib.rs set_always_on_top stays behind e2e-harness and EXCALIDRAW_PERF_CONTROL_DIR", async () => {
    const source = await readFile(LIB_RS_PATH, "utf8");
    const ungated = ungatedAlwaysOnTopSites(source);
    expect(
      ungated,
      "production lib.rs must not call set_always_on_top except behind feature e2e-harness and EXCALIDRAW_PERF_CONTROL_DIR",
    ).toEqual([]);
  });

  test("production native chrome is system-colored without app-wide Dark", async () => {
    const windowConfig = await readPrimaryWindowConfig();
    expect(windowConfig.theme).toBeUndefined();
    expect(String(windowConfig.theme ?? "")).not.toMatch(/^dark$/iu);

    const source = await readFile(LIB_RS_PATH, "utf8");
    expect(source).not.toMatch(/\bset_theme\s*\(/u);
    expect(source).not.toMatch(/\bTheme\s*::\s*Dark\b/u);
    expect(source).not.toMatch(/\bNSAppearance\b/u);
    expect(source).not.toMatch(/\bsetAppearance\s*\(/u);
    expect(source).not.toMatch(/\bDarkAqua\b/u);
  });

  test("live native process reports OS title, ordinary stacking, and non-overlay chrome", async ({
    browserName,
  }, testInfo) => {
    void browserName;
    test.skip(
      !nativeWindowBuildConfigured(),
      "Native US4 window contract tests require APP_E2E=1 and EXCALIDRAW_E2E_BINARY pointing at the e2e-harness Tauri build.",
    );
    if (!nativeWindowBuildConfigured()) return;

    const run = await runNativeWindowContractScenario();
    try {
      await attachEvidence(testInfo, run);
      if (run.evidence.scenario !== "window-contract") {
        throw new Error(`Unexpected scenario: ${run.evidence.scenario}`);
      }
      const evidence = run.evidence;
      expect(evidence.title).toBe(REQUIRED_NATIVE_WINDOW_TITLE);
      expect(evidence.alwaysOnTop).toBe(false);
      expect(evidence.fullscreen).toBe(false);
      expect(evidence.overlayTitleBar).toBe(false);
      expect(evidence.decorations).toBe(true);
      expect(evidence.transparent).toBe(false);
      expect(evidence.titleBarStyle).toBe("Visible");
      expect(evidence.systemControlledChrome).toBe(true);
      expect(evidence.appWideDark).toBe(false);
    } finally {
      await run.cleanup();
    }
  });
});

async function attachEvidence(
  testInfo: Parameters<Parameters<typeof test>[1]>[1],
  run: {
    environment: unknown;
    evidence: unknown;
  },
): Promise<void> {
  await testInfo.attach("native-window-contract-evidence", {
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

function nativeWindowBuildConfigured(): boolean {
  return (
    process.env.APP_E2E === "1" && Boolean(process.env.EXCALIDRAW_E2E_BINARY)
  );
}

async function readPrimaryWindowConfig(): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(TAURI_CONF_PATH, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.app)) {
    throw new Error("src-tauri/tauri.conf.json is missing app.");
  }
  const windows = parsed.app.windows;
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new Error("src-tauri/tauri.conf.json is missing app.windows[0].");
  }
  const windowConfig = windows[0];
  if (!isRecord(windowConfig)) {
    throw new Error(
      "src-tauri/tauri.conf.json app.windows[0] is not an object.",
    );
  }
  return windowConfig;
}

async function readDefaultCapabilityPermissions(): Promise<string[]> {
  const parsed: unknown = JSON.parse(
    await readFile(DEFAULT_CAPABILITY_PATH, "utf8"),
  );
  if (!isRecord(parsed) || !Array.isArray(parsed.permissions)) {
    throw new Error(
      "src-tauri/capabilities/default.json is missing permissions.",
    );
  }
  if (
    !parsed.permissions.every((permission) => typeof permission === "string")
  ) {
    throw new Error(
      "src-tauri/capabilities/default.json permissions must be strings.",
    );
  }
  return parsed.permissions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ungatedAlwaysOnTopSites(source: string): number[] {
  const sites: number[] = [];
  for (const match of source.matchAll(
    /set_always_on_top\s*\(|set_always_on_top\s*\(/gu,
  )) {
    const index = match.index ?? 0;
    const preceding = source.slice(Math.max(0, index - 600), index);
    const gatedByFeature =
      /#\[cfg\(\s*(?:all\()?(?:[^)]*feature\s*=\s*"e2e-harness")/u.test(
        preceding,
      );
    const gatedByPerfDir = /EXCALIDRAW_PERF_CONTROL_DIR/u.test(preceding);
    if (!gatedByFeature || !gatedByPerfDir) {
      sites.push(index);
    }
  }
  return sites;
}
