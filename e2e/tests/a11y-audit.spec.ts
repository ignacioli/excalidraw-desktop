import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { installBrowserTauriHarness } from "./browserTauriHarness";
import {
  emitFileChanged,
  installUs4Harness,
} from "./us4BrowserHarness";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;
type Violation = AxeResults["violations"][number];

const SHELL_CHROME: readonly (string | Locator)[] = [
  ".app-shell-tabs",
  ".file-sidebar",
  ".canvas-region",
  ".reload-notice",
];
const EDITOR_EXCLUDE = [".excalidraw-editor"];

const EMPTY_SCENE = {
  type: "excalidraw",
  version: 2,
  source: "excalidraw-desktop-e2e",
  elements: [],
  appState: {},
  files: {},
};

const RECOVERY_CANDIDATES = [
  {
    documentId: "recovery-1",
    originalPath: "/workspace/drawing.excalidraw",
    displayName: "drawing.excalidraw",
    snapshotSavedAt: 1_710_000_000,
    coldFileMtime: 100,
    snapshotNewer: true,
  },
  {
    documentId: "recovery-2",
    originalPath: null,
    displayName: "untitled.excalidraw",
    snapshotSavedAt: 1_700_000_000,
    coldFileMtime: null,
    snapshotNewer: false,
  },
];

async function scan(
  page: Page,
  include: readonly (string | Locator)[],
  exclude: readonly string[] = [],
): Promise<AxeResults> {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  for (const selector of include) {
    builder = builder.include(selector);
  }
  for (const selector of exclude) {
    builder = builder.exclude(selector);
  }
  return builder.analyze();
}

function seriousCritical(violations: readonly Violation[]): Violation[] {
  return violations.filter(
    (violation) =>
      violation.impact === "serious" || violation.impact === "critical",
  );
}

function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map((violation) => {
      const targets = violation.nodes
        .map((node) => node.target.join(" "))
        .join(" | ");
      return `${violation.id} [${violation.impact ?? "unknown"}] ${
        violation.description
      } -> ${targets}`;
    })
    .join("\n");
}

async function expectAxeClean(
  page: Page,
  label: string,
  include: readonly (string | Locator)[],
  exclude: readonly string[] = [],
): Promise<void> {
  const results = await scan(page, include, exclude);
  const found = seriousCritical(results.violations);
  const summary =
    found.length === 0
      ? "none"
      : found
          .map(
            (violation) =>
              `${violation.id} x${violation.nodes.length}`,
          )
          .join(", ");
  console.log(
    `[a11y-audit] ${label}: violations=${results.violations.length} seriousCritical=${found.length} (${summary})`,
  );
  expect(
    found,
    `serious/critical violations on ${label}:\n${formatViolations(found)}`,
  ).toEqual([]);
}

type HarnessWindow = {
  __TAURI_INTERNALS__?: {
    invoke(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<unknown>;
  };
};

/** Default browser harness plus the workspace/thumbnail stubs the shell needs. */
async function installShellHarness(page: Page): Promise<void> {
  await installBrowserTauriHarness(page);
  await page.addInitScript(() => {
    const browser = globalThis as HarnessWindow;
    const original = browser.__TAURI_INTERNALS__?.invoke;
    if (original === undefined) {
      return;
    }
    browser.__TAURI_INTERNALS__!.invoke = async (command, args) => {
      if (command === "workspace_list") {
        return [];
      }
      if (command === "thumb_lookup") {
        return { hit: false };
      }
      return original(command, args);
    };
  });
}

/** Workspace mounting plus a two-file tree so tabs and the file tree render. */
async function installWorkspaceHarness(
  page: Page,
  files: readonly string[],
): Promise<void> {
  await installBrowserTauriHarness(page);
  await page.addInitScript(
    ({ fileNames }) => {
      const browser = globalThis as HarnessWindow;
      const original = browser.__TAURI_INTERNALS__?.invoke;
      if (original === undefined) {
        return;
      }
      let mounted = false;
      let names = [...fileNames];
      browser.__TAURI_INTERNALS__!.invoke = async (command, args = {}) => {
        if (command === "workspace_list") {
          return mounted
            ? [
                {
                  id: "workspace-1",
                  name: "Workspace",
                  rootPath: "/workspace",
                  createdAt: 1,
                },
              ]
            : [];
        }
        if (command === "workspace_add") {
          mounted = true;
          return {
            id: "workspace-1",
            name: "Workspace",
            rootPath: "/workspace",
            createdAt: 1,
          };
        }
        if (command === "dir_list") {
          return names.map((name) => ({
            name,
            relativePath: name,
            kind: "file",
            mtime: 1,
            fileSize: 100,
          }));
        }
        if (command === "file_create") {
          const requested = String(args.relativePath ?? "drawing.excalidraw");
          const name = requested.split("/").pop() ?? "drawing.excalidraw";
          names = [...names, name];
          return {
            canonicalPath: `/workspace/${name}`,
            workspaceId: "workspace-1",
            displayName: name,
            relativePath: name,
            mtime: 1,
            fileSize: 100,
          };
        }
        if (command === "thumb_lookup") {
          return { hit: false };
        }
        return original(command, args);
      };
    },
    { fileNames: [...files] },
  );
}

/** US4 event-channel harness (native window runtime) plus a thumbnail stub. */
async function installConflictHarness(page: Page): Promise<void> {
  await installUs4Harness(page);
  await page.addInitScript(() => {
    const browser = globalThis as HarnessWindow;
    const original = browser.__TAURI_INTERNALS__?.invoke;
    if (original === undefined) {
      return;
    }
    browser.__TAURI_INTERNALS__!.invoke = async (command, args) => {
      if (command === "thumb_lookup") {
        return { hit: false };
      }
      return original(command, args);
    };
  });
}

/** US4 harness with an abnormal-exit handshake and two recovery candidates. */
async function installRecoveryHarness(page: Page): Promise<void> {
  await installUs4Harness(page);
  await page.addInitScript(
    ({ candidates, emptyScene }) => {
      const browser = globalThis as HarnessWindow;
      const original = browser.__TAURI_INTERNALS__?.invoke;
      if (original === undefined) {
        return;
      }
      browser.__TAURI_INTERNALS__!.invoke = async (command, args) => {
        if (command === "thumb_lookup") {
          return { hit: false };
        }
        if (command === "app_handshake") {
          return {
            contractVersion: 1,
            appVersion: "0.1.0",
            abnormalExit: true,
          };
        }
        if (command === "recovery_list") {
          return candidates;
        }
        if (command === "recovery_apply") {
          return { scene: emptyScene, newPath: null };
        }
        return original(command, args);
      };
    },
    { candidates: RECOVERY_CANDIDATES, emptyScene: EMPTY_SCENE },
  );
}

async function installExportHarness(
  page: Page,
  mode: "ok" | "fail",
): Promise<void> {
  await installBrowserTauriHarness(page);
  await page.addInitScript(
    ({ exportMode }) => {
      const browser = globalThis as HarnessWindow;
      const original = browser.__TAURI_INTERNALS__?.invoke;
      if (original === undefined) {
        return;
      }
      browser.__TAURI_INTERNALS__!.invoke = async (command, args) => {
        if (command === "workspace_list") {
          return [];
        }
        if (command === "thumb_lookup") {
          return { hit: false };
        }
        if (command === "doc_export") {
          if (exportMode === "fail") {
            throw {
              code: "IO_ERROR",
              message: "The destination could not be written.",
              retriable: false,
            };
          }
          return { writtenPath: "/workspace/saved.png" };
        }
        return original(command, args);
      };
    },
    { exportMode: mode },
  );
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.getByRole("radio", { name: theme === "dark" ? "Dark" : "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", theme);
}

/** Applies a persisted appearance preference before any app module runs. */
async function installDarkPreference(page: Page): Promise<void> {
  await page.addInitScript(() => {
    globalThis.localStorage.setItem(
      "excalidraw-desktop.appearance",
      JSON.stringify({
        version: 1,
        themeId: "excalidraw",
        modePreference: "dark",
      }),
    );
  });
}

async function openDrawing(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New drawing" }).click();
  await expect(page.locator(".excalidraw-editor")).toBeVisible();
  await expect(page.getByRole("button", { name: "Export…" })).toBeEnabled({
    timeout: 15_000,
  });
}

async function drawRectangle(page: Page): Promise<void> {
  const canvas = page.locator(".excalidraw__canvas.interactive");
  await expect(canvas).toBeVisible();
  const canvasBox = await canvas.boundingBox();
  if (canvasBox === null) {
    throw new Error("The Excalidraw canvas did not expose a bounding box.");
  }
  await page.getByTitle(/^Rectangle/).click();
  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 100);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 220, canvasBox.y + 180, { steps: 6 });
  await page.mouse.up();
}

async function openDirtyDrawing(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Mount folder/i }).click();
  await expect(page.getByRole("tree")).toBeVisible();
  await page
    .getByRole("button", { name: /Open drawing\.excalidraw/i })
    .click();
  await expect(page.getByRole("tab", { name: "drawing.excalidraw" })).toBeVisible();
  await drawRectangle(page);
  await page.waitForTimeout(400);
}

async function triggerConflict(page: Page): Promise<Locator> {
  await emitFileChanged(page, {
    path: "/workspace/drawing.excalidraw",
    change: "modified",
    mtime: 200,
    contentHash: "external-2",
  });
  const dialog = page.getByRole("dialog", { name: "File changed on disk" });
  await expect(dialog).toBeVisible({ timeout: 3_000 });
  return dialog;
}

for (const theme of ["light", "dark"] as const) {
  test(`shell chrome is axe-clean in ${theme} theme`, async ({ page }) => {
    await installShellHarness(page);
    await page.goto("/");
    await setTheme(page, theme);
    await expect(page.locator(".app-shell")).toBeVisible();
    await expectAxeClean(
      page,
      `shell empty state ${theme}`,
      SHELL_CHROME,
      EDITOR_EXCLUDE,
    );

    await page.getByRole("button", { name: "New drawing" }).click();
    await expect(page.locator(".excalidraw-editor")).toBeVisible();
    await expectAxeClean(
      page,
      `shell with drawing ${theme}`,
      SHELL_CHROME,
      EDITOR_EXCLUDE,
    );
  });
}

test("workspace file tree, context menu, and tab bar are axe-clean and keyboard navigable", async ({
  page,
}) => {
  await installWorkspaceHarness(page, [
    "drawing.excalidraw",
    "second.excalidraw",
  ]);
  await page.goto("/");
  await page.getByRole("button", { name: /Mount folder/i }).click();
  await expect(page.getByRole("tree")).toBeVisible();
  await page
    .getByRole("button", { name: /Open drawing\.excalidraw/i })
    .click();
  await page
    .getByRole("button", { name: /Open second\.excalidraw/i })
    .click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expectAxeClean(page, "workspace tree", SHELL_CHROME, EDITOR_EXCLUDE);

  await page
    .getByRole("button", { name: /Actions for drawing\.excalidraw/i })
    .first()
    .click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expectAxeClean(page, "file tree context menu", [".file-tree-menu"], []);

  const activeTab = page.getByRole("tab", { name: "second.excalidraw" });
  await activeTab.focus();
  await expect(activeTab).toBeFocused();
  await page.keyboard.press("ArrowRight");
  const nextTab = page.getByRole("tab", { name: "drawing.excalidraw" });
  await expect(nextTab).toBeFocused();
  await expect(nextTab).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(nextTab).toBeFocused();
  await page.keyboard.press("End");
  await expect(activeTab).toBeFocused();
});

test("appearance radios are keyboard operable with a visible focus indicator", async ({
  page,
}) => {
  await installShellHarness(page);
  await page.goto("/");
  await expect(page.locator(".app-shell")).toBeVisible();

  await page.keyboard.press("Tab");
  const system = page.getByRole("radio", { name: "System" });
  await expect(system).toBeFocused();
  await expect(
    page.locator(".appearance-option input:focus-visible + span"),
  ).toHaveCSS("outline-style", "solid");

  const dark = page.getByRole("radio", { name: "Dark" });
  await page.keyboard.press("ArrowLeft");
  await expect(dark).toBeChecked();
  await expect(dark).toBeFocused();
  const indicator = page.locator(".appearance-option input:focus-visible + span");
  await expect(indicator).toHaveCSS("outline-style", "solid");
  await expect(indicator).toHaveCSS("outline-width", "2px");
  await expect(indicator).toHaveCSS("outline-color", "rgb(116, 192, 252)");

  await page.keyboard.press("ArrowLeft");
  const light = page.getByRole("radio", { name: "Light" });
  await expect(light).toBeChecked();
  await expect(light).toBeFocused();
  await expect(
    page.locator(".appearance-option input:focus-visible + span"),
  ).toHaveCSS("outline-color", "rgb(28, 126, 214)");
  await page.keyboard.press("ArrowRight");
  await expect(dark).toBeChecked();
  await expect(dark).toBeFocused();

  await page.locator("body").click({ position: { x: 8, y: 8 } });
  await page.keyboard.press("Tab");
  await expect(dark).toBeChecked();
  await expect(dark).toBeFocused();
  await expect(
    page.locator(".appearance-option input:focus-visible + span"),
  ).toHaveCSS("outline-color", "rgb(116, 192, 252)");
});

test("conflict dialog is axe-clean and traps focus", async ({ page }) => {
  await installConflictHarness(page);
  await page.goto("/");
  await openDirtyDrawing(page);
  await triggerConflict(page);

  await expect(
    page.getByRole("button", { name: "Use external version" }),
  ).toBeFocused();
  await expectAxeClean(page, "conflict dialog", [".conflict-dialog-backdrop"], []);

  const first = page.getByRole("button", { name: "Use external version" });
  const last = page.getByRole("button", { name: "Save local changes as new…" });
  await last.focus();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();
});

test("conflict dialog closes via Escape and resolves via Enter", async ({
  page,
}) => {
  await installConflictHarness(page);
  await page.goto("/");
  await openDirtyDrawing(page);
  let dialog = await triggerConflict(page);

  await page
    .getByRole("button", { name: "Keep local changes" })
    .press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.reload();
  await openDirtyDrawing(page);
  dialog = await triggerConflict(page);
  await dialog.dispatchEvent("keydown", { key: "Enter" });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("All changes saved");
});

test("recovery dialog is axe-clean with Esc/Enter/tab-loop handling", async ({
  page,
}) => {
  await installDarkPreference(page);
  await installRecoveryHarness(page);
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "Recover unsaved drawings" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "dark",
  );

  const first = page.getByRole("button", {
    name: /Restore drawing\.excalidraw/,
  });
  const last = page.getByRole("button", {
    name: /Discard recovery for untitled\.excalidraw/,
  });
  await expect(first).toBeFocused();
  await expectAxeClean(page, "recovery dialog dark", [".recovery-dialog-backdrop"], []);

  await last.focus();
  await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();

  await first.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.reload();
  const reopened = page.getByRole("dialog", {
    name: "Recover unsaved drawings",
  });
  await expect(reopened).toBeVisible();
  await reopened.dispatchEvent("keydown", { key: "Enter" });
  await expect(
    page.getByRole("button", { name: /Restore drawing\.excalidraw/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "drawing.excalidraw" })).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`export dialog is axe-clean in ${theme} theme with keyboard handling`, async ({
    page,
  }) => {
    await installExportHarness(page, "ok");
    await page.goto("/");
    await openDrawing(page);
    await setTheme(page, theme);

    await page.getByRole("button", { name: "Export…" }).click();
    const dialog = page.getByRole("dialog", { name: "Export drawing" });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("radio", { name: "PNG image" })).toBeFocused();
    await expectAxeClean(page, `export dialog ${theme}`, [".export-dialog-backdrop"], []);

    const png = page.getByRole("radio", { name: "PNG image" });
    const cancel = page.getByRole("button", { name: "Cancel" });
    await cancel.focus();
    await page.keyboard.press("Tab");
    await expect(png).toBeFocused();
    await png.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
}

for (const theme of ["light", "dark"] as const) {
  for (const mode of ["ok", "fail"] as const) {
    test(`export ${mode} state is axe-clean in ${theme} theme`, async ({
      page,
    }) => {
      await installExportHarness(page, mode);
      await page.goto("/");
      await openDrawing(page);
      await setTheme(page, theme);

      await page.getByRole("button", { name: "Export…" }).click();
      const dialog = page.getByRole("dialog", { name: "Export drawing" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Export…" }).click();

      if (mode === "ok") {
        await expect(page.locator(".export-dialog-success")).toHaveText(
          /Exported to/,
        );
      } else {
        await expect(page.locator(".export-dialog-error")).toHaveText(
          /could not be written/,
        );
      }
      await expectAxeClean(
        page,
        `export ${mode} ${theme}`,
        [".export-dialog-backdrop"],
        [],
      );
    });
  }
}

test("reduced motion preference disables animations globally", async ({
  page,
}) => {
  await installShellHarness(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator(".app-shell")).toBeVisible();
  const reducedDuration = await page
    .locator(".app-shell")
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(Number.parseFloat(reducedDuration)).toBeLessThanOrEqual(0.001);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  const normalDuration = await page
    .locator(".app-shell")
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(normalDuration).toBe("0s");

  const hasMediaQuery = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (
            rule instanceof CSSMediaRule &&
            rule.conditionText.includes("prefers-reduced-motion")
          ) {
            return true;
          }
        }
      } catch {
        // Cross-origin style sheets are not readable.
      }
    }
    return false;
  });
  expect(hasMediaQuery).toBe(true);
});

test("dirty and orphaned tab states are announced beyond color", async ({
  page,
}) => {
  await installConflictHarness(page);
  await page.goto("/");
  await openDirtyDrawing(page);

  await expect(
    page.getByRole("tab", { name: /unsaved changes/i }),
  ).toBeVisible();
  await expect(
    page.locator(".visually-hidden", { hasText: "Unsaved changes" }),
  ).toHaveCount(1);

  await emitFileChanged(page, {
    path: "/workspace/drawing.excalidraw",
    change: "removed",
  });
  await expect(
    page.getByRole("tab", { name: /file unavailable/i }),
  ).toBeVisible();
});
