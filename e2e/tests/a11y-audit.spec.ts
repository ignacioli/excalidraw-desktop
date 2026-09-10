import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { installBrowserTauriHarness } from "./browserTauriHarness";
import {
  emitUiInteractionFileChanged,
  installUiInteractionFileEvents,
  installUiInteractionHarness,
} from "./uiInteractionHarness";
import { emitFileChanged, installUs4Harness } from "./us4BrowserHarness";
import { openWorkspaceSidebar } from "./workspaceSidebar";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];

type AxeResults = Awaited<ReturnType<AxeBuilder["analyze"]>>;
type Violation = AxeResults["violations"][number];

const SHELL_CHROME: readonly (string | Locator)[] = [
  ".app-shell-tabs",
  ".canvas-region",
];
const SHELL_CHROME_WITH_SIDEBAR: readonly (string | Locator)[] = [
  ".app-shell-tabs",
  ".file-sidebar",
  ".canvas-region",
];
const EDITOR_EXCLUDE = [".excalidraw-editor"];
const SHELL_PREFERENCES_STORAGE_KEY = "excalidraw-desktop.shell";
const ACCESS_DENIED = {
  code: "PATH_ACCESS_DENIED",
  message: "Path is outside the mounted workspaces.",
  retriable: false,
} as const;
const A11Y_WORKSPACE = {
  id: "workspace-1",
  name: "Workspace",
  rootPath: "/workspace",
  createdAt: 1,
} as const;

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
          .map((violation) => `${violation.id} x${violation.nodes.length}`)
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
    invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  };
};

/** Default browser harness plus the workspace stubs the shell needs. */
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
      const names = [...fileNames];
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
        if (command === "workspace_entry_list") {
          const parentRelativePath = String(args.parentRelativePath ?? "");
          if (parentRelativePath !== "") {
            return [];
          }
          return names.map((name) => ({
            workspaceId: "workspace-1",
            kind: "drawing",
            canonicalPath: `/workspace/${name}`,
            relativePath: name,
            parentRelativePath: "",
            name,
            displayName: name.replace(/\.excalidraw(\.json)?$/i, ""),
            mtime: 1,
            fileSize: 100,
          }));
        }
        return original(command, args);
      };
    },
    { fileNames: [...files] },
  );
}

/** US4 event-channel harness (native window runtime). */
async function installConflictHarness(page: Page): Promise<void> {
  await installUs4Harness(page);
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
        if (command === "app_handshake") {
          return {
            contractVersion: 2,
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

async function ensureFilesSidebar(page: Page): Promise<void> {
  await openWorkspaceSidebar(page);
}

function a11yDrawing(
  relativePath: string,
  displayName: string,
  parentRelativePath = "",
) {
  const name = relativePath.split("/").at(-1) ?? relativePath;
  return {
    workspaceId: A11Y_WORKSPACE.id,
    kind: "drawing" as const,
    canonicalPath: `${A11Y_WORKSPACE.rootPath}/${relativePath}`,
    relativePath,
    parentRelativePath,
    name,
    displayName,
    mtime: 1,
    fileSize: 100,
  };
}

async function openDrawing(page: Page): Promise<void> {
  await ensureFilesSidebar(page);
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
  await ensureFilesSidebar(page);
  await page.getByRole("button", { name: /Mount folder/i }).click();
  await expect(page.getByRole("tree")).toBeVisible();
  await page.getByRole("treeitem", { name: "drawing" }).click();
  await expect(
    page.getByRole("tab", { name: "drawing.excalidraw" }),
  ).toBeVisible();
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
    if (theme === "dark") await installDarkPreference(page);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-scheme",
      theme,
    );
    await expect(page.locator(".app-shell")).toBeVisible();
    await expectAxeClean(
      page,
      `shell empty state ${theme}`,
      SHELL_CHROME,
      EDITOR_EXCLUDE,
    );

    await ensureFilesSidebar(page);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("complementary", { name: "Files" }),
    ).not.toBeVisible();
    await page
      .getByTestId("welcome-screen")
      .getByRole("button", { name: "New Drawing" })
      .click();
    await expect(page.locator(".excalidraw-editor")).toBeVisible();
    await ensureFilesSidebar(page);
    await expectAxeClean(
      page,
      `shell with drawing ${theme}`,
      SHELL_CHROME_WITH_SIDEBAR,
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
  await ensureFilesSidebar(page);
  await page.getByRole("button", { name: /Mount folder/i }).click();
  await expect(page.getByRole("tree")).toBeVisible();
  await page.getByRole("treeitem", { name: "drawing" }).click();
  await page.getByRole("treeitem", { name: "second" }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expectAxeClean(
    page,
    "workspace tree",
    SHELL_CHROME_WITH_SIDEBAR,
    EDITOR_EXCLUDE,
  );

  const drawingRow = page.getByRole("treeitem", { name: "drawing" });
  await drawingRow.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expectAxeClean(
    page,
    "file tree context menu",
    [".application-context-menu"],
    [],
  );

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

test("migrated Appearance controls add no stale shell focus stops", async ({
  page,
}) => {
  await installShellHarness(page);
  await page.goto("/");
  await expect(page.locator(".app-shell")).toBeVisible();

  await page.keyboard.press("Tab");
  const sidebarToggle = page.getByRole("button", {
    name: "Toggle workspace sidebar",
  });
  await expect(sidebarToggle).toBeFocused();
  await expect(sidebarToggle).toHaveCSS("outline-style", "solid");
  await expect(sidebarToggle).toHaveCSS("outline-width", "2px");
  await expect(page.getByRole("group", { name: "Appearance" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "System" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Light" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Dark" })).toHaveCount(0);
});

test("conflict dialog is axe-clean and traps focus", async ({ page }) => {
  await installConflictHarness(page);
  await page.goto("/");
  await openDirtyDrawing(page);
  await triggerConflict(page);

  await expect(
    page.getByRole("button", { name: "Use external version" }),
  ).toBeFocused();
  await expectAxeClean(
    page,
    "conflict dialog",
    [".conflict-dialog-backdrop"],
    [],
  );

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
  await expectAxeClean(
    page,
    "recovery dialog dark",
    [".recovery-dialog-backdrop"],
    [],
  );

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
  await expect(
    page.getByRole("tab", { name: "drawing.excalidraw" }),
  ).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`export dialog is axe-clean in ${theme} theme with keyboard handling`, async ({
    page,
  }) => {
    await installExportHarness(page, "ok");
    if (theme === "dark") await installDarkPreference(page);
    await page.goto("/");
    await openDrawing(page);
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-scheme",
      theme,
    );

    await page.getByRole("button", { name: "Export…" }).click();
    const dialog = page.getByRole("dialog", { name: "Export drawing" });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("radio", { name: "PNG image" })).toBeFocused();
    await expectAxeClean(
      page,
      `export dialog ${theme}`,
      [".export-dialog-backdrop"],
      [],
    );

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
      if (theme === "dark") await installDarkPreference(page);
      await page.goto("/");
      await openDrawing(page);
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-scheme",
        theme,
      );

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

test("entry dialogs are axe-clean, keyboard-trapped, and show inline errors", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [A11Y_WORKSPACE],
    entries: [a11yDrawing("drawing.excalidraw", "drawing")],
  });
  await page.goto("/");
  await ensureFilesSidebar(page);

  await page.getByRole("button", { name: "Actions for Workspace" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expectAxeClean(page, "workspace actions menu", [
    ".application-context-menu",
  ]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await page.getByRole("button", { name: "Actions for Workspace" }).click();
  await page.getByRole("menuitem", { name: "New Drawing" }).click();
  const dialog = page.getByRole("dialog", { name: "New drawing" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name" })).toBeFocused();
  await expectAxeClean(page, "new drawing dialog", [
    ".application-dialog-backdrop",
  ]);

  await page.getByRole("textbox", { name: "Name" }).fill("drawing");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("alert")).toContainText("already exists");
  await expectAxeClean(page, "new drawing name conflict", [
    ".application-dialog-backdrop",
  ]);

  const create = page.getByRole("button", { name: "Create" });
  await create.focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("textbox", { name: "Name" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("orphan close dialog is axe-clean and keyboard operable", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [A11Y_WORKSPACE],
    entries: [
      a11yDrawing("alive.excalidraw", "alive"),
      a11yDrawing("gone.excalidraw", "gone"),
    ],
  });
  await installUiInteractionFileEvents(page);
  await page.goto("/");
  await ensureFilesSidebar(page);
  await page.getByRole("treeitem", { name: "alive" }).click();
  await page.getByRole("treeitem", { name: "gone" }).click();
  await emitUiInteractionFileChanged(page, {
    path: `${A11Y_WORKSPACE.rootPath}/gone.excalidraw`,
    change: "removed",
  });
  await expect(
    page.getByRole("tab", { name: /file unavailable/i }),
  ).toBeVisible();
  await expect(
    page.locator(".visually-hidden", { hasText: "File unavailable" }),
  ).toHaveCount(1);

  await page.getByRole("tab", { name: /gone\.excalidraw/ }).click({
    button: "right",
  });
  await page.getByRole("menuitem", { name: "Close", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "File is unavailable" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Save As", exact: true }),
  ).toBeFocused();
  await expectAxeClean(page, "orphan close dialog", [
    ".application-dialog-backdrop",
  ]);

  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
  await cancel.focus();
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Save As", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: /file unavailable/i }),
  ).toBeVisible();
});

test("sidebar overlay is keyboard operable with a visible focus indicator", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [A11Y_WORKSPACE],
    entries: [a11yDrawing("drawing.excalidraw", "drawing")],
  });
  await page.goto("/");
  await expect(
    page.getByRole("complementary", { name: "Files" }),
  ).not.toBeVisible();

  await page.keyboard.press("Tab");
  const toggle = page.getByRole("button", {
    name: "Toggle workspace sidebar",
    exact: true,
  });
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveCSS("outline-style", "solid");
  await expect(toggle).toHaveCSS("outline-width", "2px");
  await page.keyboard.press("Enter");
  const sidebar = page.getByRole("complementary", { name: "Files" });
  await expect(sidebar).toBeVisible();
  await expectAxeClean(
    page,
    "overlay sidebar",
    SHELL_CHROME_WITH_SIDEBAR,
    EDITOR_EXCLUDE,
  );

  await expect(
    page.getByRole("button", { name: "Pin workspace sidebar" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sidebar).not.toBeVisible();
});

test("folder loading and permission-denied errors are announced without color alone", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [A11Y_WORKSPACE],
    entries: [a11yDrawing("drawing.excalidraw", "drawing")],
    failures: { workspace_entry_list: ACCESS_DENIED },
    latenciesMs: { workspace_entry_list: 800 },
  });
  await page.addInitScript(
    ({ key, snapshot }) => {
      localStorage.setItem(key, snapshot);
    },
    {
      key: SHELL_PREFERENCES_STORAGE_KEY,
      snapshot: JSON.stringify({
        version: 1,
        sidebarPinned: true,
        expandedWorkspaceIds: [A11Y_WORKSPACE.id],
      }),
    },
  );
  await page.goto("/");
  await expect(page.locator(".workspace-panel").getByRole("status")).toHaveText(
    "Loading folder…",
  );
  await expect(
    page.getByRole("region", { name: "Workspaces" }),
  ).toHaveAttribute("aria-busy", "true");
  await expectAxeClean(page, "workspace loading", [".workspace-panel"]);
  await expect(page.getByRole("alert")).toHaveText(
    "This location is outside the Workspace.",
  );
  await expect(
    page.locator(".workspace-panel").getByRole("status"),
  ).toHaveCount(0);
  await expectAxeClean(page, "workspace permission denied", [
    ".workspace-panel",
  ]);
});

test("create dialog announces permission-denied as an alert", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [A11Y_WORKSPACE],
    entries: [],
    failures: { workspace_entry_create: ACCESS_DENIED },
  });
  await page.goto("/");
  await ensureFilesSidebar(page);
  await page.getByRole("button", { name: "Actions for Workspace" }).click();
  await page.getByRole("menuitem", { name: "New Drawing" }).click();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "This location is outside the Workspace.",
  );
  await expect(page.getByRole("dialog")).not.toHaveAttribute("aria-busy");
  await expectAxeClean(page, "permission-denied create", [
    ".application-dialog-backdrop",
  ]);
});

test("reduced motion keeps overlay usable without depending on animation", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [A11Y_WORKSPACE],
    entries: [a11yDrawing("drawing.excalidraw", "drawing")],
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await ensureFilesSidebar(page);
  await expect(
    page.getByRole("complementary", { name: "Files" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("complementary", { name: "Files" }),
  ).not.toBeVisible();
});
