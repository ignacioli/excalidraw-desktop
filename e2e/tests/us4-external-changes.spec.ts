import { expect, test, type Page } from "@playwright/test";
import {
  emitFileChanged,
  getHarnessDraft,
  getHarnessFile,
  getHarnessState,
  installUs4Harness,
  setExternalFile,
  setSaveAsPath,
} from "./us4BrowserHarness";
import { openWorkspaceSidebar } from "./workspaceSidebar";

const DRAWING = "/workspace/drawing.excalidraw";

test("reloads an unchanged open drawing within three seconds of an external change", async ({
  page,
}) => {
  await installUs4Harness(page);
  await page.goto("/");
  await mountAndOpen(page);
  await saveDocumentClean(page);

  const before = await getHarnessState(page);
  await setExternalFile(page, DRAWING, externalSceneWithText());
  await emitFileChanged(page, {
    path: DRAWING,
    change: "modified",
    mtime: 100,
    contentHash: "external-1",
  });

  await expect(page.getByText("Reloaded from disk")).toBeVisible({
    timeout: 3_000,
  });
  await expect(
    page.getByRole("dialog", { name: "File changed on disk" }),
  ).toHaveCount(0);
  const after = await getHarnessState(page);
  expect(after.openCount).toBe(before.openCount + 1);
  expect(after.checkpointCount).toBe(before.checkpointCount);
});

test("shows a conflict dialog for a dirty drawing and writes nothing before a decision", async ({
  page,
}) => {
  await installUs4Harness(page);
  await page.goto("/");
  await mountAndOpen(page);
  await drawRectangle(page);
  await page.waitForTimeout(400);

  const before = await getHarnessState(page);
  await emitFileChanged(page, {
    path: DRAWING,
    change: "modified",
    mtime: 200,
    contentHash: "external-2",
  });

  const dialog = page.getByRole("dialog", {
    name: "File changed on disk",
  });
  await expect(dialog).toBeVisible({ timeout: 3_000 });
  await expect(
    page.getByRole("button", { name: "Use external version" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Keep local changes" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save local changes as new…" }),
  ).toBeVisible();

  const during = await getHarnessState(page);
  expect(during.checkpointCount).toBe(before.checkpointCount);

  await page.getByRole("button", { name: "Keep local changes" }).click();
  await expect(
    page.getByRole("dialog", { name: "File changed on disk" }),
  ).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText(/unsaved changes/i);

  await page.keyboard.press("Meta+s");
  await expect
    .poll(async () => (await getHarnessState(page)).checkpointCount)
    .toBe(before.checkpointCount + 1);
  await expect(page.getByRole("status")).toHaveText("All changes saved");
  const after = await getHarnessState(page);
  expect(after.checkpointCount).toBe(before.checkpointCount + 1);
});

test("marks a removed external file as orphaned and guides the user to save as", async ({
  page,
}) => {
  await installUs4Harness(page);
  await page.goto("/");
  await mountAndOpen(page);
  await drawRectangle(page);

  await expect
    .poll(async () => {
      const draft = await getHarnessDraft(page, DRAWING);
      if (draft === null) return false;
      const scene = JSON.parse(draft) as {
        elements?: Array<{ type?: string }>;
      };
      return (
        scene.elements?.some((element) => element.type === "rectangle") ?? false
      );
    })
    .toBe(true);

  await emitFileChanged(page, {
    path: DRAWING,
    change: "removed",
  });
  await expect(
    page.getByRole("tab", { name: /file unavailable/i }),
  ).toBeVisible();
  const before = await getHarnessState(page);
  await page.getByRole("button", { name: "Close drawing.excalidraw" }).click();
  const dialog = page.getByRole("dialog", { name: "File is unavailable" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save As" })).toBeVisible();
  await setSaveAsPath(page, "/workspace/recovered.excalidraw");
  await dialog.getByRole("button", { name: "Save As" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: /file unavailable/i }),
  ).toHaveCount(0);
  await expect
    .poll(async () => (await getHarnessState(page)).checkpointCount)
    .toBe(before.checkpointCount + 1);
  const recovered = JSON.parse(
    (await getHarnessFile(page, "/workspace/recovered.excalidraw")) ?? "null",
  ) as { elements?: Array<{ type?: string }> } | null;
  expect(recovered?.elements).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "rectangle" })]),
  );
});

async function mountAndOpen(page: Page): Promise<void> {
  await openWorkspaceSidebar(page);
  await page.getByRole("button", { name: /Mount folder/i }).click();
  await expect(page.getByRole("tree")).toBeVisible();
  await page.getByRole("treeitem", { name: "drawing" }).click();
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
  await page.mouse.move(canvasBox.x + 500, canvasBox.y + 150);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 620, canvasBox.y + 230, { steps: 6 });
  await page.mouse.up();
}

async function saveDocumentClean(page: Page): Promise<void> {
  await page.keyboard.press("Meta+s");
  await expect(page.getByRole("status")).toHaveText("All changes saved");
}

function externalSceneWithText(): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    elements: [
      {
        id: "external-text",
        type: "text",
        x: 0,
        y: 0,
        width: 100,
        height: 20,
        text: "changed outside",
      },
    ],
    appState: {},
    files: {},
  });
}
