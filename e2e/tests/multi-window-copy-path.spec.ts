import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  emitUiInteractionEvent,
  getUiInteractionHarnessState,
  installUiInteractionFileEvents,
  installUiInteractionHarness,
  setUiInteractionHarnessFailure,
} from "./uiInteractionHarness";
import {
  openWorkspaceSidebar,
  persistPinnedWorkspaceSidebar,
} from "./workspaceSidebar";

const ROOT = "/Users/tester/My Drawings";
const workspace = {
  id: "workspace-1",
  name: "My Drawings",
  rootPath: ROOT,
  createdAt: 1,
};
const FOLDER = "我的 文件夹";
const NESTED = `${FOLDER}/计划 草图.excalidraw`;
const PREVIOUS_CLIPBOARD = "kept from before";

test.beforeEach(async ({ page }) => {
  await installUiInteractionHarness(page, {
    workspaces: [workspace],
    entries: [
      directory(FOLDER, ""),
      drawing(NESTED, "计划 草图", FOLDER),
      drawing("plan.excalidraw", "plan", ""),
    ],
    clipboardText: PREVIOUS_CLIPBOARD,
  });
  await installUiInteractionFileEvents(page);
  await persistPinnedWorkspaceSidebar(page, [workspace.id], workspace.id);
  await page.goto("/");
  await openWorkspaceSidebar(page);
  await page.getByRole("treeitem", { name: FOLDER }).click();
  await expect(page.getByRole("treeitem", { name: "计划 草图" })).toBeVisible();
});

async function rowMenu(page: Page, row: string): Promise<Locator> {
  await page.getByRole("treeitem", { name: row }).hover();
  await page.getByRole("button", { name: `Actions for ${row}` }).click();
  return page.getByRole("menu");
}

async function tabMenu(page: Page, tab: string): Promise<Locator> {
  await page.getByRole("tab", { name: tab }).click({ button: "right" });
  return page.getByRole("menu");
}

async function menuLabels(menu: Locator): Promise<string[]> {
  return menu.getByRole("menuitem").allTextContents();
}

async function clipboard(page: Page): Promise<string> {
  return (await getUiInteractionHarnessState(page)).clipboardText;
}

async function expectCopied(page: Page, message: string, text: string) {
  await expect(
    page.getByRole("status").filter({ hasText: message }),
  ).toBeVisible();
  expect(await clipboard(page)).toBe(text);
}

test("a drawing or folder row copies its full path", async ({ page }) => {
  const drawingMenu = await rowMenu(page, "计划 草图");
  await drawingMenu.getByRole("menuitem", { name: "Copy Path" }).click();
  await expectCopied(page, "Path copied", `${ROOT}/${NESTED}`);

  const folderMenu = await rowMenu(page, FOLDER);
  await folderMenu.getByRole("menuitem", { name: "Copy Path" }).click();
  await expectCopied(page, "Path copied", `${ROOT}/${FOLDER}`);
  expect(await clipboard(page)).not.toContain("~");
});

test("a drawing or folder row copies its path relative to the Workspace", async ({
  page,
}) => {
  const drawingMenu = await rowMenu(page, "计划 草图");
  await drawingMenu
    .getByRole("menuitem", { name: "Copy Relative Path" })
    .click();
  await expectCopied(page, "Relative path copied", NESTED);

  const folderMenu = await rowMenu(page, FOLDER);
  await folderMenu
    .getByRole("menuitem", { name: "Copy Relative Path" })
    .click();
  await expectCopied(page, "Relative path copied", FOLDER);
});

test("the Workspace row offers only Copy Path", async ({ page }) => {
  const menu = await rowMenu(page, workspace.name);
  expect(await menuLabels(menu)).toEqual([
    "New Drawing",
    "New Folder",
    "Copy Path",
    "Remove Workspace",
  ]);
  await menu.getByRole("menuitem", { name: "Copy Path" }).click();
  await expectCopied(page, "Path copied", ROOT);
});

test("a tab of a drawing in the Workspace copies what its row copies", async ({
  page,
}) => {
  await page.getByRole("treeitem", { name: "计划 草图" }).click();
  await expect(page.getByRole("tab", { name: /计划 草图/u })).toBeVisible();

  let menu = await tabMenu(page, "计划 草图");
  expect(await menuLabels(menu)).toEqual([
    "Close",
    "Close Others",
    "Close Tabs to the Right",
    "Close All",
    "Copy Path",
    "Copy Relative Path",
  ]);
  await menu.getByRole("menuitem", { name: "Copy Path" }).click();
  await expectCopied(page, "Path copied", `${ROOT}/${NESTED}`);

  menu = await tabMenu(page, "计划 草图");
  await menu.getByRole("menuitem", { name: "Copy Relative Path" }).click();
  await expectCopied(page, "Relative path copied", NESTED);
});

test("a tab of a drawing outside the Workspace offers only Copy Path", async ({
  page,
}) => {
  const outside = "/Users/tester/Desktop/loose sketch.excalidraw";
  await emitUiInteractionEvent(page, "window-activate-document", {
    path: outside,
  });
  await expect(page.getByRole("tab", { name: /loose sketch/u })).toBeVisible();

  const menu = await tabMenu(page, "loose sketch");
  expect(await menuLabels(menu)).toEqual([
    "Close",
    "Close Others",
    "Close Tabs to the Right",
    "Close All",
    "Copy Path",
  ]);
  await menu.getByRole("menuitem", { name: "Copy Path" }).click();
  await expectCopied(page, "Path copied", outside);
});

test("a failed clipboard write shows a failure and keeps the clipboard", async ({
  page,
}) => {
  await setUiInteractionHarnessFailure(
    page,
    "plugin:clipboard-manager|write_text",
    { code: "CLIPBOARD", message: "clipboard unavailable", retriable: true },
  );
  const menu = await rowMenu(page, "计划 草图");
  await menu.getByRole("menuitem", { name: "Copy Path" }).click();
  await expect(page.getByRole("alert")).toContainText("Couldn't copy path");
  expect(await clipboard(page)).toBe(PREVIOUS_CLIPBOARD);
  await expect(
    page.getByRole("status").filter({ hasText: "Path copied" }),
  ).toHaveCount(0);
});

function drawing(
  relativePath: string,
  displayName: string,
  parentRelativePath: string,
) {
  return {
    workspaceId: workspace.id,
    kind: "drawing" as const,
    canonicalPath: `${ROOT}/${relativePath}`,
    relativePath,
    parentRelativePath,
    name: relativePath.split("/").at(-1) ?? relativePath,
    displayName,
    mtime: 1,
    fileSize: 100,
  };
}

function directory(relativePath: string, parentRelativePath: string) {
  return {
    workspaceId: workspace.id,
    kind: "directory" as const,
    canonicalPath: `${ROOT}/${relativePath}`,
    relativePath,
    parentRelativePath,
    name: relativePath,
    displayName: relativePath,
    mtime: 1,
    fileSize: 0,
  };
}
