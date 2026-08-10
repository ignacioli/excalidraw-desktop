import { expect, test } from "@playwright/test";
import { getUs7State, installUs7Harness } from "./us7BrowserHarness";

test("multiple workspaces mount side by side and remove independently", async ({
  page,
}) => {
  await installUs7Harness(page, {
    files: ["drawing.excalidraw"],
    workspaces: [
      { id: "workspace-1", name: "Work", rootPath: "/work" },
      { id: "workspace-2", name: "Personal", rootPath: "/personal" },
    ],
  });
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Work" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Personal" })).toBeVisible();

  // Remove one workspace independently; the other stays mounted.
  const workSection = page
    .locator(".workspace-section")
    .filter({ hasText: "Work" });
  page.once("dialog", (dialog) => void dialog.accept());
  await workSection.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("button", { name: "Work" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Personal" })).toBeVisible();

  const state = await getUs7State(page);
  expect(
    state.mountedWorkspaces.map((workspace) => workspace.id),
  ).toEqual(["workspace-2"]);
});
