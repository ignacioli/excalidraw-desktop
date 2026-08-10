import { expect, test } from "@playwright/test";
import {
  getUs7State,
  installUs7Harness,
} from "./us7BrowserHarness";

test("visible file rows lazily generate thumbnails and hit the cache on revisit", async ({
  page,
}) => {
  await installUs7Harness(page);
  await page.goto("/");

  await page.getByRole("button", { name: /Mount folder/i }).click();
  const workspaceTree = page
    .getByRole("region", { name: "Workspace files for Workspace" })
    .getByRole("tree");
  await expect(workspaceTree).toBeVisible();
  await expect(
    workspaceTree.getByRole("button", { name: /Open drawing\.excalidraw/i }),
  ).toBeVisible();

  // The visible rows request a thumbnail; the miss path renders and stores.
  await expect
    .poll(async () => (await getUs7State(page)).storeCalls.length)
    .toBeGreaterThan(0);
  await expect(page.locator("img.file-tree-thumbnail").first()).toBeVisible();

  const stateAfterFirst = await getUs7State(page);
  expect(stateAfterFirst.lookupCalls.length).toBeGreaterThan(0);
  expect(stateAfterFirst.convertCalls.length).toBeGreaterThan(0);
  const storeCount = stateAfterFirst.storeCalls.length;

  // Revisit (simulate a restart) must hit the cache and not regenerate.
  await page.reload();
  await page.getByRole("button", { name: /Mount folder/i }).click();
  await expect(workspaceTree).toBeVisible();
  await expect(page.locator("img.file-tree-thumbnail").first()).toBeVisible();

  const stateAfterReload = await getUs7State(page);
  expect(stateAfterReload.lookupCalls.length).toBeGreaterThan(0);
  expect(stateAfterReload.storeCalls.length).toBeLessThanOrEqual(storeCount);
});

test("thumbnails are decorative and never take keyboard focus", async ({
  page,
}) => {
  await installUs7Harness(page);
  await page.goto("/");

  await page.getByRole("button", { name: /Mount folder/i }).click();
  const workspaceTree = page
    .getByRole("region", { name: "Workspace files for Workspace" })
    .getByRole("tree");
  await expect(workspaceTree).toBeVisible();
  const thumbnail = page.locator("img.file-tree-thumbnail").first();
  await expect(thumbnail).toBeVisible();

  await expect(thumbnail).toHaveAttribute("alt", "");
  await expect(thumbnail).toHaveAttribute("aria-hidden", "true");
  await expect(thumbnail).not.toBeFocused();
  await page.keyboard.press("Tab");
  await expect(thumbnail).not.toBeFocused();
});
