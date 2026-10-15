import { expect, test, type Locator, type Page } from "@playwright/test";
import { en } from "../../src/i18n/messages/en.ts";
import { zhCN } from "../../src/i18n/messages/zh-CN.ts";
import {
  emitUiInteractionEvent,
  getUiInteractionHarnessState,
  installUiInteractionFileEvents,
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

  await page
    .getByRole("toolbar", { name: "Workspace actions" })
    .getByRole("button", { name: "New Drawing" })
    .click();
  const input = page.getByRole("textbox", { name: "Name" });
  await expect(input).toHaveValue("Untitled");
  await expect(input).toHaveAccessibleDescription(
    "Fixed extension .excalidraw",
  );
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(
    (await getUiInteractionHarnessState(page)).invocations.filter(
      (call) => call.command === "workspace_entry_create",
    ),
  ).toHaveLength(0);

  await page
    .getByRole("toolbar", { name: "Workspace actions" })
    .getByRole("button", { name: "New Drawing" })
    .click();
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
  await expect(input).toHaveAccessibleDescription(
    "Fixed extension .excalidraw",
  );
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

type Catalog = typeof en | typeof zhCN;

function format(
  catalog: Catalog,
  key: keyof Catalog,
  values: Record<string, string> = {},
): string {
  return String(catalog[key]).replace(/\{(\w+)\}/gu, (_, name: string) =>
    String(values[name]),
  );
}

interface SidebarDialogCase {
  name: string;
  open(page: Page, catalog: Catalog): Promise<Locator>;
  title(catalog: Catalog): string;
  actions(catalog: Catalog): string[];
  /** Naming dialogs focus the field; confirmations focus Cancel. */
  naming: boolean;
}

function toolbarButton(page: Page, catalog: Catalog, key: keyof Catalog) {
  return page
    .getByRole("toolbar", { name: format(catalog, "workspace.actionsLabel") })
    .getByRole("button", { name: format(catalog, key), exact: true });
}

async function openFromToolbar(
  page: Page,
  catalog: Catalog,
  key: keyof Catalog,
): Promise<Locator> {
  const trigger = toolbarButton(page, catalog, key);
  await trigger.click();
  return trigger;
}

async function openFromRowMenu(
  page: Page,
  catalog: Catalog,
  row: string,
  item: keyof Catalog,
): Promise<Locator> {
  await page.getByRole("treeitem", { name: row }).hover();
  const actions = page.getByRole("button", {
    name: format(catalog, "workspace.menu.actionsFor", { name: row }),
  });
  await actions.click();
  await page.getByRole("menuitem", { name: format(catalog, item) }).click();
  return page.getByRole("treeitem", { name: row });
}

const SIDEBAR_DIALOGS: SidebarDialogCase[] = [
  {
    name: "new drawing",
    naming: true,
    open: (page, catalog) =>
      openFromToolbar(page, catalog, "workspace.newDrawing"),
    title: (catalog) => format(catalog, "entry.naming.newDrawing"),
    actions: (catalog) => [
      format(catalog, "dialog.cancel"),
      format(catalog, "entry.naming.create"),
    ],
  },
  {
    name: "new folder",
    naming: true,
    open: (page, catalog) =>
      openFromToolbar(page, catalog, "workspace.newFolder"),
    title: (catalog) => format(catalog, "entry.naming.newFolder"),
    actions: (catalog) => [
      format(catalog, "dialog.cancel"),
      format(catalog, "entry.naming.create"),
    ],
  },
  {
    name: "rename drawing",
    naming: true,
    open: (page, catalog) =>
      openFromRowMenu(page, catalog, "drawing", "workspace.menu.rename"),
    title: (catalog) => format(catalog, "entry.naming.renameDrawing"),
    actions: (catalog) => [
      format(catalog, "dialog.cancel"),
      format(catalog, "entry.naming.rename"),
    ],
  },
  {
    name: "rename folder",
    naming: true,
    open: (page, catalog) =>
      openFromRowMenu(page, catalog, "folder", "workspace.menu.rename"),
    title: (catalog) => format(catalog, "entry.naming.renameFolder"),
    actions: (catalog) => [
      format(catalog, "dialog.cancel"),
      format(catalog, "entry.naming.rename"),
    ],
  },
  {
    name: "delete",
    naming: false,
    open: (page, catalog) =>
      openFromRowMenu(page, catalog, "drawing", "workspace.menu.delete"),
    title: (catalog) =>
      format(catalog, "entry.delete.title", { name: "drawing.excalidraw" }),
    actions: (catalog) => [
      format(catalog, "dialog.cancel"),
      format(catalog, "entry.delete.confirm"),
    ],
  },
  {
    name: "folder not empty",
    naming: false,
    open: (page, catalog) =>
      openFromRowMenu(page, catalog, "folder", "workspace.menu.delete"),
    title: (catalog) => format(catalog, "entry.notEmpty.title"),
    actions: (catalog) => [
      format(catalog, "dialog.cancel"),
      format(catalog, "entry.notEmpty.reveal"),
    ],
  },
  {
    name: "remove workspace",
    naming: false,
    open: (page, catalog) =>
      openFromRowMenu(
        page,
        catalog,
        workspace.name,
        "workspace.menu.removeWorkspace",
      ),
    title: (catalog) =>
      format(catalog, "workspace.remove.title", { name: workspace.name }),
    actions: (catalog) => [
      format(catalog, "workspace.remove.cancel"),
      format(catalog, "workspace.remove.confirm"),
    ],
  },
];

async function expectDialogFits(page: Page, dialog: Locator): Promise<void> {
  const fit = await dialog.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const escaping = [...element.querySelectorAll("*")].filter((child) => {
      const rect = child.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      if (child.closest(".visually-hidden") !== null) return false;
      return (
        rect.left < box.left - 0.5 ||
        rect.right > box.right + 0.5 ||
        rect.top < box.top - 0.5 ||
        rect.bottom > box.bottom + 0.5
      );
    });
    const clipped = [...element.querySelectorAll("h2, p, button, label")]
      .filter((child) => child.scrollWidth > child.clientWidth + 1)
      .map((child) => child.textContent);
    return {
      inside:
        box.left >= 0 &&
        box.top >= 0 &&
        box.right <= window.innerWidth &&
        box.bottom <= window.innerHeight,
      escaping: escaping.map((child) => child.outerHTML.slice(0, 80)),
      clipped,
      overflow: element.scrollWidth > element.clientWidth,
      page:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    };
  });
  expect(fit).toEqual({
    inside: true,
    escaping: [],
    clipped: [],
    overflow: false,
    page: false,
  });
}

for (const scheme of ["light", "dark"] as const) {
  for (const [language, catalog] of [
    ["en", en],
    ["zh-CN", zhCN],
  ] as const) {
    test(`sidebar dialogs fit, order their actions and return focus in ${scheme} / ${language}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 760 });
      await installUiInteractionHarness(page, {
        workspaces: [workspace],
        entries: [
          drawing("drawing.excalidraw", "drawing"),
          directory("folder", ""),
          drawing("folder/child.excalidraw", "child", "folder"),
        ],
      });
      await installUiInteractionFileEvents(page);
      await persistPinnedWorkspaceSidebar(page, [workspace.id], workspace.id);
      await page.goto("/");
      await openWorkspaceSidebar(page);
      for (const command of [
        scheme === "light" ? "appearanceLight" : "appearanceDark",
        language === "en" ? "languageEn" : "languageZhCn",
      ]) {
        await emitUiInteractionEvent(page, "native-menu-command", { command });
      }
      await expect(page.locator("html")).toHaveAttribute(
        "data-color-scheme",
        scheme,
      );
      await expect(
        toolbarButton(page, catalog, "workspace.newDrawing"),
      ).toBeVisible();

      for (const dialogCase of SIDEBAR_DIALOGS) {
        await test.step(dialogCase.name, async () => {
          const trigger = await dialogCase.open(page, catalog);
          const dialog = page.getByRole("dialog", {
            name: dialogCase.title(catalog),
          });
          await expect(dialog).toBeVisible();
          await expect(dialog).toHaveAttribute("data-variant", "sidebar");
          await expectDialogFits(page, dialog);
          await expect(dialog.getByRole("button")).toHaveText(
            dialogCase.actions(catalog),
          );
          if (dialogCase.naming) {
            await expect(
              dialog.getByRole("textbox", {
                name: format(catalog, "entry.naming.name"),
              }),
            ).toBeFocused();
          } else {
            await expect(dialog.getByRole("button").first()).toBeFocused();
          }
          await page.keyboard.press("Escape");
          await expect(dialog).toHaveCount(0);
          await expect(trigger).toBeFocused();
        });
      }
      const calls = (await getUiInteractionHarnessState(page)).invocations;
      expect(
        calls.filter((call) =>
          [
            "workspace_entry_create",
            "workspace_entry_rename",
            "workspace_entry_delete",
            "workspace_entry_reveal",
            "window_release_workspace",
          ].includes(call.command),
        ),
      ).toEqual([]);
    });
  }
}

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
