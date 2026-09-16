import { expect, test } from "@playwright/test";
import {
  getUiInteractionHarnessState,
  installUiInteractionHarness,
} from "./uiInteractionHarness";
import {
  openWorkspaceSidebar,
  persistPinnedWorkspaceSidebar,
} from "./workspaceSidebar";

const workspace = {
  id: "workspace-1",
  name: "Workspace",
  rootPath: "/ui-interactions/workspace-1",
  createdAt: 1,
};

test("entry dialogs cancel without mutation and keep naming conflicts inline", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [workspace],
    entries: [drawing("drawing.excalidraw", "drawing")],
  });
  await persistPinnedWorkspaceSidebar(page, [workspace.id], workspace.id);
  await page.goto("/");
  await openWorkspaceSidebar(page);

  await page.getByRole("button", { name: "New Drawing" }).click();
  const input = page.getByRole("textbox", { name: "Name" });
  await expect(input).toHaveValue("Untitled");
  await expect(page.getByLabel("Fixed extension .excalidraw")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(
    (await getUiInteractionHarnessState(page)).invocations.filter(
      (call) => call.command === "workspace_entry_create",
    ),
  ).toHaveLength(0);

  await page.getByRole("button", { name: "New Drawing" }).click();
  await input.fill("drawing");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("alert")).toContainText("already exists");
  await expect(input).toHaveValue("drawing");
});

test("non-empty Directory blocker reveals only after explicit action", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [workspace],
    entries: [
      directory("folder", ""),
      drawing("folder/child.excalidraw", "child", "folder"),
    ],
  });
  await persistPinnedWorkspaceSidebar(page, [workspace.id], workspace.id);
  await page.goto("/");
  await openWorkspaceSidebar(page);
  await openEntryActions(page, "folder");
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(
    page.getByRole("dialog", { name: "Folder isn’t empty" }),
  ).toBeVisible();
  let calls = (await getUiInteractionHarnessState(page)).invocations;
  expect(
    calls.filter((call) => call.command === "workspace_entry_reveal"),
  ).toHaveLength(0);
  expect(
    calls.filter((call) => call.command === "workspace_entry_delete"),
  ).toHaveLength(0);

  await page.getByRole("button", { name: "Open in Finder" }).click();
  await expect
    .poll(
      async () =>
        (await getUiInteractionHarnessState(page)).invocations.filter(
          (call) => call.command === "workspace_entry_reveal",
        ).length,
    )
    .toBe(1);
  calls = (await getUiInteractionHarnessState(page)).invocations;
  expect(
    calls.filter((call) => call.command === "workspace_entry_delete"),
  ).toHaveLength(0);
});

test("rename preserves the fixed suffix and delete cancellation performs no mutation", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [workspace],
    entries: [drawing("drawing.excalidraw", "drawing")],
  });
  await persistPinnedWorkspaceSidebar(page, [workspace.id], workspace.id);
  await page.goto("/");
  await openWorkspaceSidebar(page);
  await openEntryActions(page, "drawing");
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const input = page.getByRole("textbox", { name: "Name" });
  await expect(input).toHaveValue("drawing");
  await expect(page.getByLabel("Fixed extension .excalidraw")).toBeVisible();
  await input.fill("renamed");
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("treeitem", { name: "renamed" })).toBeVisible();

  await openEntryActions(page, "renamed");
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(
    page.getByRole("dialog", { name: "Delete renamed.excalidraw?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  const calls = (await getUiInteractionHarnessState(page)).invocations;
  expect(
    calls.filter((call) => call.command === "workspace_entry_rename"),
  ).toHaveLength(1);
  expect(
    calls.filter((call) => call.command === "workspace_entry_delete"),
  ).toHaveLength(0);
});

test("dirty Drawing deletion focuses its Open Document and performs no hidden mutation", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [workspace],
    entries: [drawing("drawing.excalidraw", "drawing")],
  });
  await persistPinnedWorkspaceSidebar(page, [workspace.id], workspace.id);
  await page.goto("/");
  await openWorkspaceSidebar(page);
  await page.getByRole("treeitem", { name: "drawing" }).click();
  const canvas = page.locator(".excalidraw__canvas.interactive").last();
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("The Drawing canvas was not measurable.");
  await page.getByTitle(/^Rectangle/).click();
  await page.mouse.move(box.x + 120, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 160, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole("status")).not.toHaveText("All changes saved");

  await openEntryActions(page, "drawing");
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(
    page.getByRole("tab", { name: /drawing\.excalidraw/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("alert")).toContainText("Save the open drawing");
  const calls = (await getUiInteractionHarnessState(page)).invocations;
  expect(
    calls.filter(
      (call) =>
        call.command === "workspace_entry_delete_preflight" ||
        call.command === "workspace_entry_delete",
    ),
  ).toHaveLength(0);
});

function drawing(
  relativePath: string,
  displayName: string,
  parentRelativePath = "",
) {
  const name = relativePath.split("/").at(-1) ?? relativePath;
  return {
    workspaceId: workspace.id,
    kind: "drawing" as const,
    canonicalPath: `${workspace.rootPath}/${relativePath}`,
    relativePath,
    parentRelativePath,
    name,
    displayName,
    mtime: 1,
    fileSize: 100,
  };
}

function directory(relativePath: string, parentRelativePath: string) {
  return {
    workspaceId: workspace.id,
    kind: "directory" as const,
    canonicalPath: `${workspace.rootPath}/${relativePath}`,
    relativePath,
    parentRelativePath,
    name: relativePath.split("/").at(-1) ?? relativePath,
    displayName: relativePath.split("/").at(-1) ?? relativePath,
    mtime: 1,
    fileSize: 0,
  };
}

async function openEntryActions(
  page: import("@playwright/test").Page,
  displayName: string,
): Promise<void> {
  await page.getByRole("treeitem", { name: displayName }).hover();
  await page
    .getByRole("button", { name: `Actions for ${displayName}` })
    .click();
}
