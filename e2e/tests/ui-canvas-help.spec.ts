import { expect, test, type Page } from "@playwright/test";
import { installBrowserTauriHarness } from "./browserTauriHarness";
import {
  activeEditor,
  emitNativeCommand,
  focusCanvas,
  openWelcomeDrawing,
} from "./preferencesI18nMenu";
import {
  openWorkspaceSidebar,
  persistPinnedWorkspaceSidebar,
} from "./workspaceSidebar";

function helpDialog(page: Page) {
  return page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: "Help", level: 2 }),
  });
}

async function blurToBody(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      active.blur();
    }
  });
  await expect
    .poll(() => page.evaluate(() => document.activeElement === document.body))
    .toBe(true);
}

test.describe("canvas help shortcut", () => {
  test.beforeEach(async ({ page }) => {
    await installBrowserTauriHarness(page);
    await page.goto("/");
    await openWelcomeDrawing(page);
  });

  test("help opens from the canvas and the page but not from an application dialog", async ({
    page,
  }) => {
    await focusCanvas(page);
    await page.keyboard.press("?");
    await expect(helpDialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(helpDialog(page)).toHaveCount(0);

    // The application dialog owns its keys: "?" must not stack the canvas help
    // underneath it, even though its first option is a plain focused input.
    await emitNativeCommand(page, "exportImage");
    const exportDialog = page.getByRole("dialog", { name: "Export drawing" });
    await expect(exportDialog).toBeVisible();
    await page.keyboard.press("?");
    await expect(helpDialog(page)).toHaveCount(0);
    await expect(exportDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(exportDialog).toHaveCount(0);

    // Focus resting on the page still reaches the canvas help, and a second "?"
    // reopens it rather than toggling it closed, matching the SDK's own key.
    await blurToBody(page);
    await page.keyboard.press("?");
    await expect(helpDialog(page)).toHaveCount(1);
    await page.keyboard.press("?");
    await expect(helpDialog(page)).toHaveCount(1);
  });

  test("a second tab keeps only the visible editor answering", async ({
    page,
  }) => {
    await installBrowserTauriHarness(page);
    await persistPinnedWorkspaceSidebar(page, ["workspace-1"], "workspace-1");
    await page.goto("/");
    await openWorkspaceSidebar(page);
    for (const name of ["one", "two"]) {
      await page
        .getByRole("toolbar", { name: "Workspace actions" })
        .getByRole("button", { name: "New Drawing" })
        .click();
      const dialog = page.getByRole("dialog", { name: "New drawing" });
      await dialog.getByRole("textbox", { name: "Name" }).fill(name);
      await dialog.getByRole("button", { name: "Create" }).click();
      await expect(
        page.getByRole("tab", { name: `${name}.excalidraw` }),
      ).toBeVisible();
    }
    expect(
      await page.locator(".canvas-document[hidden]").count(),
    ).toBeGreaterThan(0);

    await blurToBody(page);
    await page.keyboard.press("?");
    // Only the visible editor answers; a hidden one would portal its own help
    // dialog next to this one.
    await expect(helpDialog(page)).toHaveCount(1);
    await expect(activeEditor(page)).toBeVisible();
  });
});
