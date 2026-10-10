import { expect, test, type Page } from "@playwright/test";
import { emitBrowserTauriEvent } from "./browserTauriHarness";
import { EXPORT_WORKSPACE, installExportHarness } from "./us5-exportHarness";
import { persistPinnedWorkspaceSidebar } from "./workspaceSidebar";

const READONLY_TARGET = "/readonly/export.png";
const WRITABLE_TARGET = "/writable/export.png";

test("shows a clear error after a failed export and leaves no partial file", async ({
  page,
}) => {
  await installExportHarness(page, {
    exportPaths: [READONLY_TARGET, WRITABLE_TARGET],
    failReadonlyTarget: READONLY_TARGET,
  });
  await persistPinnedWorkspaceSidebar(
    page,
    [EXPORT_WORKSPACE.id],
    EXPORT_WORKSPACE.id,
  );
  await page.goto("/");
  await page.getByRole("treeitem", { name: "drawing", exact: true }).click();
  await expect(page.locator(".excalidraw-editor")).toBeVisible();
  await drawRectangle(page);

  const dialog = page.getByRole("dialog", { name: "Export drawing" });
  await emitBrowserTauriEvent(page, "native-menu-command", {
    command: "exportImage",
  });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole("button", { name: "Export…" }).click();

  await expect(dialog.getByRole("alert")).toHaveText(
    "The destination could not be written. No partial file was left behind.",
  );
  await expect(dialog).toHaveAttribute("aria-describedby", "export-dialog-error");

  let store = await exportStore(page);
  expect(store.tmp).toEqual([]);
  expect(Object.keys(store.files)).toEqual([]);

  await dialog.getByRole("button", { name: "Export…" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    `Exported to ${WRITABLE_TARGET}`,
  );

  store = await exportStore(page);
  expect(store.tmp).toEqual([]);
  expect(Object.keys(store.files)).toEqual([WRITABLE_TARGET]);
  expect(READONLY_TARGET in store.files).toBe(false);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // Export is reached from the native menu; the shell has no top-level Export
  // control to return focus to.
  await expect(page.getByRole("button", { name: "Export…" })).toHaveCount(0);
});

async function drawRectangle(page: Page): Promise<void> {
  const canvas = page.locator(".excalidraw__canvas.interactive");
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  if (canvasBox === null) {
    throw new Error("The Excalidraw canvas did not expose a bounding box.");
  }
  await page.getByTitle(/^Rectangle/).click();
  await page.mouse.move(canvasBox.x + 400, canvasBox.y + 140);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 560, canvasBox.y + 250, { steps: 10 });
  await page.mouse.up();
}

async function exportStore(page: Page): Promise<{
  files: Record<string, number[]>;
  tmp: string[];
}> {
  return page.evaluate(() => {
    const windowWithStore = globalThis as unknown as {
      __exportStore: { files: Record<string, number[]>; tmp: string[] };
    };
    return {
      files: { ...windowWithStore.__exportStore.files },
      tmp: [...windowWithStore.__exportStore.tmp],
    };
  });
}
