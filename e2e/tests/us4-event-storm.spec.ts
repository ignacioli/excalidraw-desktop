import { expect, test, type Page } from "@playwright/test";
import {
  emitFileChanged,
  getHarnessState,
  installUs4Harness,
} from "./us4BrowserHarness";

const DRAWING = "/workspace/drawing.excalidraw";

test("coalesces a 20-write external storm into a single conflict dialog", async ({
  page,
}) => {
  await installUs4Harness(page);
  await page.goto("/");
  await mountAndOpen(page);
  await drawRectangle(page);
  await page.waitForTimeout(400);

  for (let index = 0; index < 20; index += 1) {
    await emitFileChanged(page, {
      path: DRAWING,
      change: "modified",
      mtime: 100 + index,
      contentHash: "storm-1",
    });
  }

  await expect(
    page.getByRole("dialog", { name: "File changed on disk" }),
  ).toHaveCount(1);
  await page.waitForTimeout(300);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByRole("status")).toHaveText(
    "Save paused because the file changed elsewhere",
  );
});

test("does not reload repeatedly for duplicate external events on a clean document", async ({
  page,
}) => {
  await installUs4Harness(page);
  await page.goto("/");
  await mountAndOpen(page);
  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(page.getByRole("status")).toHaveText("All changes saved");
  const before = await getHarnessState(page);

  for (let index = 0; index < 20; index += 1) {
    await emitFileChanged(page, {
      path: DRAWING,
      change: "modified",
      mtime: 100 + index,
      contentHash: "storm-clean",
    });
  }

  await expect(page.getByText("Reloaded from disk")).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "File changed on disk" }),
  ).toHaveCount(0);
  const after = await getHarnessState(page);
  expect(after.openCount).toBe(before.openCount + 1);
  expect(after.checkpointCount).toBe(before.checkpointCount);
});

async function mountAndOpen(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Mount folder/i }).click();
  await expect(page.getByRole("tree")).toBeVisible();
  await page
    .getByRole("button", { name: /Open drawing\.excalidraw/i })
    .click();
  await expect(
    page.getByRole("tab", { name: "drawing.excalidraw" }),
  ).toBeVisible();
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
