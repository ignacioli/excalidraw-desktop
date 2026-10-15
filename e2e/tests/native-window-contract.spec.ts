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
const WINDOW_RS_PATH = fileURLToPath(
  new URL("../../src-tauri/src/window/mod.rs", import.meta.url),
);

test.describe("US4 native window contract (titlebar choice A)", () => {
  test("windows are created at runtime, not declared in tauri.conf.json", async () => {
    const parsed: unknown = JSON.parse(await readFile(TAURI_CONF_PATH, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.app)) {
      throw new Error("src-tauri/tauri.conf.json is missing app.");
    }
    expect(parsed.app.windows ?? []).toEqual([]);
  });

  test("the window chrome contract titles a new window Excalidraw", async () => {
    const chrome = await readWindowChrome();
    expect(chrome.title).toBe(REQUIRED_NATIVE_WINDOW_TITLE);
  });

  test("window is ordinary decorated without transparency or overlay title bar", async () => {
    const chrome = await readWindowChrome();
    expect(chrome.decorations).toBe("true");
    expect(chrome.transparent).toBe("false");
    expect(chrome.titleBarStyle).toBe("Visible");

    const source = await readFile(WINDOW_RS_PATH, "utf8");
    expect(source).not.toMatch(/\.transparent\s*\(/u);
    expect(source).not.toMatch(/\.hidden_title\s*\(/u);
    expect(source).not.toMatch(/\.title_bar_style\s*\(/u);
    expect(source).toMatch(/\.decorations\(WINDOW_CHROME\.decorations\)/u);
  });

  test("production windows are not always on top", async () => {
    const chrome = await readWindowChrome();
    expect(chrome.alwaysOnTop).toBe("false");
    const source = await readFile(WINDOW_RS_PATH, "utf8");
    expect(source).toMatch(/\.always_on_top\(WINDOW_CHROME\.always_on_top\)/u);
  });

  test("every application window may set its title and destroy itself after the close checkpoint", async () => {
    const capability = await readDefaultCapability();
    expect(capability.windows).toEqual(["window-*"]);
    expect(capability.permissions).toContain("core:window:allow-destroy");
    expect(capability.permissions).toContain("core:window:allow-set-title");
  });

  test("set_always_on_top stays behind e2e-harness and EXCALIDRAW_PERF_CONTROL_DIR", async () => {
    for (const path of [LIB_RS_PATH, WINDOW_RS_PATH]) {
      const source = await readFile(path, "utf8");
      const ungated = ungatedAlwaysOnTopSites(source);
      expect(
        ungated,
        `${path} must not call set_always_on_top except behind feature e2e-harness and EXCALIDRAW_PERF_CONTROL_DIR`,
      ).toEqual([]);
    }
  });

  test("production native chrome is system-colored without app-wide Dark", async () => {
    const chrome = await readWindowChrome();
    expect(chrome.theme).toBe("None");

    for (const path of [LIB_RS_PATH, WINDOW_RS_PATH]) {
      const source = await readFile(path, "utf8");
      expect(source).not.toMatch(/\bset_theme\s*\(/u);
      expect(source).not.toMatch(/\.theme\s*\(/u);
      expect(source).not.toMatch(/\bTheme\s*::\s*Dark\b/u);
      expect(source).not.toMatch(/\bNSAppearance\b/u);
      expect(source).not.toMatch(/\bsetAppearance\s*\(/u);
      expect(source).not.toMatch(/\bDarkAqua\b/u);
    }
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

interface WindowChromeSource {
  title: string;
  decorations: string;
  transparent: string;
  titleBarStyle: string;
  alwaysOnTop: string;
  theme: string;
}

/** Read the `WINDOW_CHROME` constant every runtime window is built from. */
async function readWindowChrome(): Promise<WindowChromeSource> {
  const source = await readFile(WINDOW_RS_PATH, "utf8");
  const block =
    /pub const WINDOW_CHROME: WindowChrome = WindowChrome \{([^}]*)\};/u.exec(
      source,
    )?.[1];
  const welcomeTitle = /pub const WELCOME_TITLE: &str = "([^"]*)";/u.exec(
    source,
  )?.[1];
  if (block === undefined || welcomeTitle === undefined) {
    throw new Error("src-tauri/src/window/mod.rs is missing WINDOW_CHROME.");
  }
  const field = (name: string): string => {
    const value = new RegExp(`\\b${name}:\\s*([^,]+),`, "u").exec(block)?.[1];
    if (value === undefined) {
      throw new Error(`WINDOW_CHROME is missing ${name}.`);
    }
    return value.trim();
  };
  const title = field("title");
  return {
    title: title === "WELCOME_TITLE" ? welcomeTitle : title.replace(/"/gu, ""),
    decorations: field("decorations"),
    transparent: field("transparent"),
    titleBarStyle: field("title_bar_style").replace(/"/gu, ""),
    alwaysOnTop: field("always_on_top"),
    theme: field("theme"),
  };
}

async function readDefaultCapability(): Promise<{
  windows: string[];
  permissions: string[];
}> {
  const parsed: unknown = JSON.parse(
    await readFile(DEFAULT_CAPABILITY_PATH, "utf8"),
  );
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.permissions) ||
    !Array.isArray(parsed.windows)
  ) {
    throw new Error(
      "src-tauri/capabilities/default.json is missing windows or permissions.",
    );
  }
  const strings = (values: unknown[]): string[] =>
    values.filter((value): value is string => typeof value === "string");
  return {
    windows: strings(parsed.windows),
    permissions: strings(parsed.permissions),
  };
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
