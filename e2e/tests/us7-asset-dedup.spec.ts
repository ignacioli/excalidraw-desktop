import { expect, test } from "@playwright/test";
import { getUs7State, installUs7Harness } from "./us7BrowserHarness";
import {
  openWorkspaceSidebar,
  persistCurrentWorkspace,
} from "./workspaceSidebar";

test("mounted workspaces never stack and removing the current one leaves the other mounted", async ({
  page,
}) => {
  await installUs7Harness(page, {
    files: ["drawing.excalidraw"],
    workspaces: [
      { id: "workspace-1", name: "Work", rootPath: "/work" },
      { id: "workspace-2", name: "Personal", rootPath: "/personal" },
    ],
  });
  await persistCurrentWorkspace(page, "workspace-1");
  await page.goto("/");
  await openWorkspaceSidebar(page);

  const tree = page.getByRole("tree");
  await expect(tree.getByRole("treeitem", { name: "Work" })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "Personal" })).toHaveCount(0);

  await tree.getByRole("treeitem", { name: "Work" }).hover();
  await page.getByRole("button", { name: "Actions for Work" }).click();
  await page.getByRole("menuitem", { name: "Remove Workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "Remove Work?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Files on disk will not be deleted");
  await dialog.getByRole("button", { name: "Remove Workspace" }).click();
  await expect(tree.getByRole("treeitem", { name: "Work" })).toHaveCount(0);
  await expect(tree.getByRole("treeitem", { name: "Personal" })).toBeVisible();

  const state = await getUs7State(page);
  expect(state.mountedWorkspaces.map((workspace) => workspace.id)).toEqual([
    "workspace-2",
  ]);
});
