import { expect, test } from "@playwright/test";
import {
  getUiInteractionHarnessState,
  installUiInteractionHarness,
} from "./uiInteractionHarness";

const WORKSPACE = {
  id: "workspace-1",
  name: "Workspace",
  rootPath: "/ui-interactions/workspace-1",
  createdAt: 1,
};

const DRAWING = {
  workspaceId: WORKSPACE.id,
  kind: "drawing" as const,
  canonicalPath: `${WORKSPACE.rootPath}/drawing.excalidraw`,
  relativePath: "drawing.excalidraw",
  parentRelativePath: "",
  name: "drawing.excalidraw",
  displayName: "drawing",
  mtime: 1,
  fileSize: 100,
};

test("drawing rows stay icon-only and opening one performs exactly one document open", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [WORKSPACE],
    entries: [DRAWING],
  });
  await page.goto("/");

  await expect(page.getByRole("tree")).toBeVisible();
  const drawing = page.getByRole("button", {
    name: /Open drawing\.excalidraw/i,
  });
  await expect(drawing).toBeVisible();
  await expect(page.locator("img.file-tree-thumbnail")).toHaveCount(0);
  expect(
    (await getUiInteractionHarnessState(page)).invocations.filter(
      ({ command }) =>
        command === "thumb_lookup" ||
        command === "thumb_store" ||
        command === "thumbnail_render",
    ),
  ).toEqual([]);

  await drawing.click();
  await expect(
    page.getByRole("tab", { name: "drawing.excalidraw" }),
  ).toBeVisible();
  const state = await getUiInteractionHarnessState(page);
  expect(
    state.invocations.filter(({ command }) => command === "doc_open"),
  ).toHaveLength(1);
  expect(
    state.invocations.filter(
      ({ command }) =>
        command === "thumb_lookup" ||
        command === "thumb_store" ||
        command === "thumbnail_render",
    ),
  ).toEqual([]);
  await expect(page.locator("img.file-tree-thumbnail")).toHaveCount(0);
});
test("mounting, expanding, and revisiting a Workspace never starts thumbnail work", async ({
  page,
}) => {
  const entries = [
    DRAWING,
    {
      ...DRAWING,
      canonicalPath: `${WORKSPACE.rootPath}/second.excalidraw.json`,
      relativePath: "second.excalidraw.json",
      name: "second.excalidraw.json",
      displayName: "second",
    },
  ];
  await installUiInteractionHarness(page, {
    workspaces: [WORKSPACE],
    entries,
  });
  await page.goto("/");

  const tree = page.getByRole("tree");
  await expect(tree).toBeVisible();
  await expect(tree.getByRole("button", { name: /^Open /i })).toHaveCount(2);
  await tree.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.reload();
  await expect(page.getByRole("tree")).toBeVisible();
  await expect(page.locator("img.file-tree-thumbnail")).toHaveCount(0);

  const state = await getUiInteractionHarnessState(page);
  expect(
    state.invocations.filter(
      ({ command }) =>
        command === "thumb_lookup" ||
        command === "thumb_store" ||
        command === "thumbnail_render",
    ),
  ).toEqual([]);
});
