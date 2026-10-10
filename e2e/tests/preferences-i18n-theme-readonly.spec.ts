import { expect, test, type Page } from "@playwright/test";
import {
  emitBrowserTauriEvent,
  installBrowserTauriHarness,
  readHarnessDraft,
} from "./browserTauriHarness";
import {
  activeEditor,
  canvasMenuItem,
  closeCanvasMenu,
  emitNativeCommand,
  focusCanvas,
  nativeMenuState,
  openCanvasMenu,
  openWelcomeDrawing,
} from "./preferencesI18nMenu";
import {
  openWorkspaceSidebar,
  persistPinnedWorkspaceSidebar,
} from "./workspaceSidebar";

const APPEARANCE_KEY = "excalidraw-desktop.appearance";
const DRAWING = "/virtual/first.excalidraw";

async function expectAppearance(
  page: Page,
  preference: "system" | "light" | "dark",
  scheme: "light" | "dark",
) {
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    scheme,
  );
  await expect
    .poll(async () => (await nativeMenuState(page))?.appearance)
    .toBe(preference);
  await expect
    .poll(() =>
      page.evaluate((key) => localStorage.getItem(key), APPEARANCE_KEY),
    )
    .toBe(
      JSON.stringify({
        version: 1,
        themeId: "excalidraw",
        modePreference: preference,
      }),
    );
  const radio = {
    system: "System mode",
    light: "Light mode - Shift+Option+D",
    dark: "Dark mode - Shift+Option+D",
  }[preference];
  await openCanvasMenu(page);
  await expect(
    activeEditor(page).getByRole("radio", { name: radio, exact: true }),
  ).toBeChecked();
  await closeCanvasMenu(page);
}

test.describe("theme", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await installBrowserTauriHarness(page);
    await page.goto("/");
    await page.evaluate(
      (key) => globalThis.localStorage.removeItem(key),
      APPEARANCE_KEY,
    );
    await page.reload();
    await openWelcomeDrawing(page);
  });

  test("Shift+Option+D and the canvas Theme item drive the shell and native menu", async ({
    page,
  }) => {
    await expectAppearance(page, "system", "light");

    await focusCanvas(page);
    await page.keyboard.press("Shift+Alt+KeyD");
    await expectAppearance(page, "dark", "dark");

    await openCanvasMenu(page);
    await activeEditor(page)
      .getByRole("radio", { name: "Light mode - Shift+Option+D", exact: true })
      .click();
    await expectAppearance(page, "light", "light");

    await openCanvasMenu(page);
    await activeEditor(page)
      .getByRole("radio", { name: "System mode", exact: true })
      .click();
    await expectAppearance(page, "system", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expectAppearance(page, "system", "dark");
  });
});

test.describe("forced read-only", () => {
  test.beforeEach(async ({ page }) => {
    await installBrowserTauriHarness(
      page,
      DRAWING,
      undefined,
      [DRAWING],
      undefined,
      true,
    );
    await persistPinnedWorkspaceSidebar(page, ["workspace-1"], "workspace-1");
    await page.goto("/");
    await openWorkspaceSidebar(page);
    await page.getByRole("treeitem", { name: "first" }).click();
    await expect(activeEditor(page)).toBeVisible();
  });

  test("locks Tool lock, Snap and View mode during a conflict and restores the user's View mode", async ({
    page,
  }) => {
    await drawRectangle(page);
    await openCanvasMenu(page);

    await emitBrowserTauriEvent(page, "file-changed", {
      path: DRAWING,
      change: "modified",
      mtime: 200,
      contentHash: "external-1",
    });
    await expect(
      page.getByRole("dialog", { name: "File changed on disk" }),
    ).toBeVisible();

    await expect
      .poll(async () => {
        const state = await nativeMenuState(page);
        return [state?.forcedReadOnly, state?.viewMode];
      })
      .toEqual([true, true]);
    for (const label of ["Tool lock", "Snap to objects", "View mode"]) {
      const item = canvasMenuItem(page, label);
      await expect(item).toBeDisabled();
      await expect(item).toHaveAttribute("aria-disabled", "true");
    }
    await expect(canvasMenuItem(page, "View mode")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(canvasMenuItem(page, "Toggle grid")).toBeEnabled();
    await expect(canvasMenuItem(page, "Zen mode")).toBeEnabled();

    // The conflict dialog covers the canvas, so act through the native menu.
    await emitNativeCommand(page, "toggleGrid");
    await emitNativeCommand(page, "toggleZen");
    await emitNativeCommand(page, "appearanceDark");
    await expect
      .poll(async () => {
        const state = await nativeMenuState(page);
        return [state?.grid, state?.zen, state?.appearance];
      })
      .toEqual([true, true, "dark"]);
    await expect(canvasMenuItem(page, "Toggle grid")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await emitNativeCommand(page, "toggleViewMode");
    await emitNativeCommand(page, "toggleToolLock");
    await emitNativeCommand(page, "toggleSnap");
    await page.evaluate(() =>
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "KeyR",
          key: "®",
          altKey: true,
          bubbles: true,
        }),
      ),
    );
    await page.waitForTimeout(200);
    expect(await nativeMenuState(page)).toMatchObject({
      forcedReadOnly: true,
      viewMode: true,
      toolLock: false,
      snap: false,
    });

    await page.getByRole("button", { name: "Keep local changes" }).click();
    await expect(
      page.getByRole("dialog", { name: "File changed on disk" }),
    ).toHaveCount(0);
    await expect
      .poll(async () => {
        const state = await nativeMenuState(page);
        return [state?.forcedReadOnly, state?.viewMode];
      })
      .toEqual([false, false]);
    await openCanvasMenu(page);
    for (const label of ["Tool lock", "Snap to objects", "View mode"]) {
      await expect(canvasMenuItem(page, label)).toBeEnabled();
    }
    await expect(canvasMenuItem(page, "View mode")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});

async function drawRectangle(page: Page): Promise<void> {
  // The host-owned editor container; the canvas fills it.
  const box = await activeEditor(page).boundingBox();
  if (box === null) throw new Error("The canvas was not measurable.");
  await focusCanvas(page);
  await page.keyboard.press("r");
  await page.mouse.move(box.x + 300, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 280, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await readHarnessDraft(page, DRAWING)) ?? "")
    .toContain('"rectangle"');
}
