import { expect, test, type Locator, type Page } from "@playwright/test";
import { en } from "../../src/i18n/messages/en.ts";
import { zhCN } from "../../src/i18n/messages/zh-CN.ts";
import {
  emitBrowserTauriEvent,
  installBrowserTauriHarness,
  readBrowserTauriCommands,
  setBrowserTauriExtraEntries,
} from "./browserTauriHarness";

type Catalog = typeof en | typeof zhCN;

const VIEWPORT = { width: 1280, height: 760 } as const;
const CANVAS_BACKGROUND = {
  light: "rgb(255, 255, 255)",
  dark: "rgb(27, 27, 31)",
} as const;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await installBrowserTauriHarness(page);
  await page.goto("/");
  // Welcome New Drawing claims the harness folder; closing its only tab
  // leaves the Workspace open with no drawing.
  await page
    .getByTestId("welcome-screen")
    .getByRole("button", { name: "New Drawing", exact: true })
    .click();
  await expect(page.locator(".excalidraw-editor")).toBeVisible();
  await page.getByRole("button", { name: /^Close Untitled/u }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(emptyState(page, en)).toBeVisible();
});

function emptyState(page: Page, catalog: Catalog): Locator {
  return page.getByRole("region", {
    name: catalog["shell.emptyState.label"],
  });
}

async function command(page: Page, name: string): Promise<void> {
  await emitBrowserTauriEvent(page, "native-menu-command", { command: name });
}

async function expectNoHorizontalOverflow(page: Page, region: Locator) {
  const overflow = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(overflow[0]).toBeLessThanOrEqual(overflow[1]);
  const inner = await region.evaluate((element) => [
    element.scrollWidth,
    element.clientWidth,
  ]);
  expect(inner[0]).toBeLessThanOrEqual(inner[1]);
}

for (const scheme of ["light", "dark"] as const) {
  for (const [language, catalog] of [
    ["en", en],
    ["zh-CN", zhCN],
  ] as const) {
    test(`reads as the canvas in ${scheme} / ${language}`, async ({ page }) => {
      await command(
        page,
        scheme === "light" ? "appearanceLight" : "appearanceDark",
      );
      await command(page, language === "en" ? "languageEn" : "languageZhCn");
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-scheme",
        scheme,
      );

      const region = emptyState(page, catalog);
      await expect(region).toBeVisible();
      await expect(region).toHaveCSS(
        "background-color",
        CANVAS_BACKGROUND[scheme],
      );
      await expect(
        region.getByText(catalog["shell.emptyState.title"]),
      ).toBeVisible();
      await expect(
        region.getByText(catalog["shell.emptyState.subtitle"]),
      ).toBeVisible();
      await expect(
        region.getByRole("button", {
          name: catalog["shell.emptyState.newDrawing"],
        }),
      ).toBeVisible();
      await expect(
        region.getByRole("button", {
          name: catalog["shell.emptyState.showSidebar"],
        }),
      ).toBeVisible();
      const other = catalog === en ? zhCN : en;
      await expect(
        region.getByText(other["shell.emptyState.title"]),
      ).toHaveCount(0);
      await expectNoHorizontalOverflow(page, region);
    });
  }
}

test("both actions are reached with Tab and run from the keyboard", async ({
  page,
}) => {
  const region = emptyState(page, en);
  const reached: string[] = [];
  for (let step = 0; step < 30 && reached.length < 2; step += 1) {
    await page.keyboard.press("Tab");
    const name = await page.evaluate(() => {
      const element = document.activeElement;
      return element?.closest(".canvas-empty-state") !== null
        ? (element?.textContent ?? "")
        : null;
    });
    if (name !== null && !reached.includes(name)) reached.push(name);
  }
  expect(reached).toEqual(["New Drawing", "Show Sidebar"]);

  await region.getByRole("button", { name: "Show Sidebar" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".app-shell-body")).toHaveAttribute(
    "data-sidebar-mode",
    "overlay",
  );
  await page.keyboard.press("Escape");

  await region.getByRole("button", { name: "New Drawing" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".excalidraw-editor")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(emptyState(page, en)).toHaveCount(0);
});

test("drawing on the empty canvas does nothing", async ({ page }) => {
  const region = emptyState(page, en);
  const before = (await readBrowserTauriCommands(page)).length;
  const box = await region.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.85, {
    steps: 8,
  });
  await page.mouse.up();
  await page.keyboard.press("r");

  await expect(region).toBeVisible();
  await expect(page.locator(".excalidraw-editor")).toHaveCount(0);
  await expect(region.locator("canvas")).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(0);
  const after = await readBrowserTauriCommands(page);
  expect(
    after
      .slice(before)
      .filter((name) => name.startsWith("doc_") || name.includes("create")),
  ).toEqual([]);
});

test("with the sidebar pinned only New Drawing remains, without the pointer", async ({
  page,
}) => {
  const toggle = page.getByRole("button", {
    name: "Toggle workspace sidebar",
    exact: true,
  });
  await toggle.click();
  await toggle.click();
  await expect(page.locator(".app-shell-body")).toHaveAttribute(
    "data-sidebar-mode",
    "pinned",
  );
  const region = emptyState(page, en);
  await expect(region.getByRole("button")).toHaveCount(1);
  await expect(
    region.getByRole("button", { name: "New Drawing" }),
  ).toBeVisible();
  await expect(page.getByText("Your drawings live here")).toHaveCount(0);
  await expectNoHorizontalOverflow(page, region);
});

test("New Drawing creates in the folder selected in the sidebar", async ({
  page,
}) => {
  await setBrowserTauriExtraEntries(page, [
    {
      workspaceId: "workspace-1",
      kind: "directory",
      canonicalPath: "/virtual/sketches",
      relativePath: "sketches",
      parentRelativePath: "",
      name: "sketches",
      displayName: "sketches",
      mtime: 1,
      fileSize: 0,
    },
  ]);
  const toggle = page.getByRole("button", {
    name: "Toggle workspace sidebar",
    exact: true,
  });
  await toggle.click();
  await toggle.click();
  const sidebar = page.getByRole("complementary", { name: "Files" });
  await sidebar.getByRole("button", { name: "Refresh" }).click();
  await sidebar.getByRole("treeitem", { name: "sketches" }).click();

  await emptyState(page, en)
    .getByRole("button", { name: "New Drawing" })
    .click();

  await expect(page.getByRole("tab")).toHaveCount(1);
  const created = await page.evaluate(() => {
    const stored = localStorage.getItem(
      "excalidraw-e2e:workspace-entries:workspace-1",
    );
    const entries = JSON.parse(stored ?? "[]") as { relativePath: string }[];
    return entries.map((entry) => entry.relativePath);
  });
  expect(created).toContain("sketches/Untitled.excalidraw");

  // The new drawing shows in its folder without a Refresh.
  if (!(await sidebar.isVisible())) await toggle.click();
  const tree = sidebar.getByRole("tree");
  await expect(
    tree.getByRole("treeitem", { name: "sketches", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  const createdRow = tree.getByRole("treeitem", {
    name: "Untitled",
    description: "/virtual/sketches/Untitled.excalidraw",
  });
  await expect(createdRow).toBeVisible();
  // Inside `sketches`: the workspace root is level 1, the folder level 2.
  await expect(createdRow).toHaveAttribute("aria-level", "3");
});
