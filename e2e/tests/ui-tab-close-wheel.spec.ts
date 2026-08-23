import { expect, test, type Page } from "@playwright/test";
import {
  emitUiInteractionFileChanged,
  getUiInteractionHarnessState,
  installUiInteractionFileEvents,
  installUiInteractionHarness,
  setUiInteractionHarnessFailure,
} from "./uiInteractionHarness";

const workspace = {
  id: "workspace-1",
  name: "Workspace",
  rootPath: "/ui-interactions/workspace-1",
  createdAt: 1,
};

const CLOSE_FAILURE = {
  code: "IO_ERROR",
  message: "The drawing could not be closed",
  retriable: true,
};

test("tab close button, context menu, middle-click, and Cmd/Ctrl+W close Open Documents", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [workspace],
    entries: [
      drawing("one.excalidraw", "one"),
      drawing("two.excalidraw", "two"),
      drawing("three.excalidraw", "three"),
      drawing("four.excalidraw", "four"),
      drawing("five.excalidraw", "five"),
    ],
  });
  await page.goto("/");
  await openDrawings(page, ["one", "two", "three", "four", "five"]);

  await expect(tabNamed(page, "five")).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", { name: "Close five.excalidraw" }),
  ).toBeVisible();

  const two = tabNamed(page, "two");
  const menu = await openTabContextMenu(page, "two");
  await expect(
    menu.getByRole("menuitem", { name: "Close", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Close Others", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Close Tabs to the Right", exact: true }),
  ).toBeVisible();
  await menu.getByRole("menuitem", { name: "Close", exact: true }).click();
  await expect(two).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(4);

  await tabNamed(page, "four").hover();
  await page.getByRole("button", { name: "Close four.excalidraw" }).click();
  await expect(tabNamed(page, "four")).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(3);

  await tabNamed(page, "three").click({ button: "middle" });
  await expect(tabNamed(page, "three")).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(2);

  await tabNamed(page, "five").click();
  await pressCloseShortcut(page);
  await expect(tabNamed(page, "five")).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(tabNamed(page, "one")).toBeVisible();
});

test("Close Others and Close Tabs to the Right stop at the first failure", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [workspace],
    entries: [
      drawing("keep.excalidraw", "keep"),
      drawing("fail.excalidraw", "fail"),
      drawing("later.excalidraw", "later"),
    ],
  });
  await page.goto("/");
  await openDrawings(page, ["keep", "fail", "later"]);
  await setUiInteractionHarnessFailure(page, "doc_close", CLOSE_FAILURE);

  const toTheRight = (await openTabContextMenu(page, "keep")).getByRole(
    "menuitem",
    { name: "Close Tabs to the Right", exact: true },
  );
  await expect(toTheRight).toBeVisible();
  await toTheRight.click();
  await expect(tabNamed(page, "keep")).toBeVisible();
  await expect(tabNamed(page, "fail")).toBeVisible();
  await expect(tabNamed(page, "later")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(3);
  await expect(page.getByRole("status")).toContainText(CLOSE_FAILURE.message);
  expect(await closeInvocations(page)).toHaveLength(1);

  const closeOthers = (await openTabContextMenu(page, "keep")).getByRole(
    "menuitem",
    { name: "Close Others", exact: true },
  );
  await expect(closeOthers).toBeVisible();
  await closeOthers.click();
  await expect(tabNamed(page, "keep")).toBeVisible();
  await expect(tabNamed(page, "fail")).toBeVisible();
  await expect(tabNamed(page, "later")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(3);
  expect(await closeInvocations(page)).toHaveLength(2);
});

test("orphan close dialog offers Save As, Close Without Saving, and Cancel, and Cancel stops a batch", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [workspace],
    entries: [
      drawing("alive.excalidraw", "alive"),
      drawing("gone.excalidraw", "gone"),
      drawing("after.excalidraw", "after"),
    ],
  });
  await installUiInteractionFileEvents(page);
  await page.goto("/");
  await openDrawings(page, ["alive", "gone", "after"]);
  await emitUiInteractionFileChanged(page, {
    path: `${workspace.rootPath}/gone.excalidraw`,
    change: "removed",
  });
  await expect(
    page.getByRole("tab", { name: /file unavailable/i }),
  ).toBeVisible();

  const closeOthers = (await openTabContextMenu(page, "alive")).getByRole(
    "menuitem",
    { name: "Close Others", exact: true },
  );
  await expect(closeOthers).toBeVisible();
  await closeOthers.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Save As", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Close Without Saving", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(tabNamed(page, "alive")).toBeVisible();
  await expect(
    page.getByRole("tab", { name: /file unavailable/i }),
  ).toBeVisible();
  await expect(tabNamed(page, "after")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(3);
  expect(await closeInvocations(page)).toHaveLength(0);
});

test("Close Without Saving continues a batch to the next orphaned drawing", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [workspace],
    entries: [
      drawing("alive.excalidraw", "alive"),
      drawing("gone.excalidraw", "gone"),
      drawing("after.excalidraw", "after"),
    ],
  });
  await installUiInteractionFileEvents(page);
  await page.goto("/");
  await openDrawings(page, ["alive", "gone", "after"]);
  await emitUiInteractionFileChanged(page, {
    path: `${workspace.rootPath}/gone.excalidraw`,
    change: "removed",
  });
  await emitUiInteractionFileChanged(page, {
    path: `${workspace.rootPath}/after.excalidraw`,
    change: "removed",
  });
  await expect(
    page.getByRole("tab", { name: /file unavailable/i }),
  ).toHaveCount(2);

  const closeOthers = (await openTabContextMenu(page, "alive")).getByRole(
    "menuitem",
    { name: "Close Others", exact: true },
  );
  await expect(closeOthers).toBeVisible();
  await closeOthers.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("gone.excalidraw");
  await dialog
    .getByRole("button", { name: "Close Without Saving", exact: true })
    .click();

  await expect(tabNamed(page, "gone")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("after.excalidraw");
  await dialog
    .getByRole("button", { name: "Close Without Saving", exact: true })
    .click();

  await expect(dialog).toHaveCount(0);
  await expect(tabNamed(page, "alive")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(1);
});

test("closing the last drawing tab keeps the window shell and Files sidebar", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [workspace],
    entries: [drawing("solo.excalidraw", "solo")],
  });
  await page.goto("/");
  await openDrawings(page, ["solo"]);
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Files" }),
  ).toBeAttached();

  await pressCloseShortcut(page);

  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Open drawings" }),
  ).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Drawing tabs" })).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Files" }),
  ).toBeAttached();
  await expect(page.getByText("Select a drawing to begin.")).toBeVisible();
});

test("vertical wheel on the tab bar cycles one tab per notch and ignores horizontal input", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [workspace],
    entries: [
      drawing("one.excalidraw", "one"),
      drawing("two.excalidraw", "two"),
      drawing("three.excalidraw", "three"),
      drawing("four.excalidraw", "four"),
    ],
  });
  await page.goto("/");
  await openDrawings(page, ["one", "two", "three", "four"]);

  const tabBar = page.getByRole("navigation", { name: "Open drawings" });
  await tabNamed(page, "two").click();
  await expect(tabNamed(page, "two")).toHaveAttribute("aria-selected", "true");
  await tabBar.hover();

  await dispatchTabBarWheel(page, { deltaX: 120, deltaY: 0 });
  await expect(tabNamed(page, "two")).toHaveAttribute("aria-selected", "true");

  await dispatchTabBarWheel(page, { deltaX: 0, deltaY: 120, ctrlKey: true });
  await expect(tabNamed(page, "two")).toHaveAttribute("aria-selected", "true");

  await dispatchTabBarWheel(page, { deltaX: 0, deltaY: 120 });
  await expect(tabNamed(page, "three")).toHaveAttribute("aria-selected", "true");
  await waitForWheelCooldown(page);

  await dispatchTabBarWheel(page, { deltaX: 0, deltaY: 120 });
  await expect(tabNamed(page, "four")).toHaveAttribute("aria-selected", "true");
  await waitForWheelCooldown(page);

  await dispatchTabBarWheel(page, { deltaX: 0, deltaY: 120 });
  await expect(tabNamed(page, "one")).toHaveAttribute("aria-selected", "true");
  await waitForWheelCooldown(page);

  await dispatchTabBarWheel(page, { deltaX: 0, deltaY: -120 });
  await expect(tabNamed(page, "four")).toHaveAttribute("aria-selected", "true");

  await tabNamed(page, "one").click();
  await tabBar.hover();
  await dispatchTabBarWheel(page, { deltaX: 0, deltaY: 120 });
  await waitForWheelCooldown(page);
  await dispatchTabBarWheel(page, { deltaX: 0, deltaY: 120 });
  await waitForWheelCooldown(page);
  await dispatchTabBarWheel(page, { deltaX: 0, deltaY: 120 });
  await expect(tabNamed(page, "four")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { selected: true })).toHaveCount(1);
});

function drawing(relativePath: string, displayName: string) {
  const name = relativePath.split("/").at(-1) ?? relativePath;
  return {
    workspaceId: workspace.id,
    kind: "drawing" as const,
    canonicalPath: `${workspace.rootPath}/${relativePath}`,
    relativePath,
    parentRelativePath: "",
    name,
    displayName,
    mtime: 1,
    fileSize: 100,
  };
}

async function openTabContextMenu(page: Page, displayName: string) {
  await tabNamed(page, displayName).click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

async function openDrawings(page: Page, displayNames: readonly string[]) {
  const sidebar = page.getByRole("complementary", { name: "Files" });
  if (!(await sidebar.isVisible())) {
    await page
      .getByRole("button", { name: "Workspace sidebar", exact: true })
      .click();
    await expect(sidebar).toBeVisible();
  }
  const workspaceRow = page.getByRole("treeitem", {
    name: workspace.name,
    exact: true,
  });
  if ((await workspaceRow.getAttribute("aria-expanded")) === "false") {
    await workspaceRow.click();
  }
  for (const displayName of displayNames) {
    await page.getByRole("treeitem", { name: displayName, exact: true }).click();
    await expect(tabNamed(page, displayName)).toBeVisible();
  }
}

function tabNamed(page: Page, displayName: string) {
  return page.getByRole("tab", { name: `${displayName}.excalidraw` });
}

async function pressCloseShortcut(page: Page) {
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "w",
        code: "KeyW",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

async function dispatchTabBarWheel(
  page: Page,
  init: {
    deltaX: number;
    deltaY: number;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
  },
) {
  await page.getByRole("navigation", { name: "Open drawings" }).evaluate(
    (element, eventInit) => {
      element.dispatchEvent(
        new WheelEvent("wheel", {
          deltaX: eventInit.deltaX,
          deltaY: eventInit.deltaY,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          ctrlKey: eventInit.ctrlKey === true,
          metaKey: eventInit.metaKey === true,
          shiftKey: eventInit.shiftKey === true,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    init,
  );
}

async function waitForWheelCooldown(page: Page) {
  await page.waitForTimeout(400);
}

async function closeInvocations(page: Page) {
  return (await getUiInteractionHarnessState(page)).invocations.filter(
    (call) => call.command === "doc_close",
  );
}
