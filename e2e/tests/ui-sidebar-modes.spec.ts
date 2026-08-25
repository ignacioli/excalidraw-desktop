import { expect, test, type Page } from "@playwright/test";
import { installUiInteractionHarness } from "./uiInteractionHarness";

/**
 * Accessible names the US4 implementation should match (exact role names):
 * - `Workspace sidebar` — explicit overlay open control (not screen-edge hover)
 * - `Pin workspace sidebar` / `Unpin workspace sidebar` — overlay ↔ pinned
 *
 * Existing chrome strings stay as they are: Save, Export…, Appearance
 * (Light / Dark / System). Native titlebar color/stacking is T057, not this
 * browser spec.
 *
 * Panel under test is the existing `.file-sidebar` complementary. Preference
 * JSON matches `src/app/shellPreferences.ts`.
 */
const SHELL_PREFERENCES_STORAGE_KEY = "excalidraw-desktop.shell";
const SHELL_PREFERENCES_VERSION = 1;
const POINTER_LEAVE_MS = 500;
const STILL_OPEN_MS = 350;
const CLOSED_AFTER_LEAVE_MS = 700;
const HOLD_PAUSE_MS = 800;
const SUPPORTED_VIEWPORT = { width: 1280, height: 800 } as const;
const LAYOUT_PX = 2;
const OVERLAY_OVERLAP_PX = 8;

const workspace = {
  id: "workspace-1",
  name: "Workspace",
  rootPath: "/ui-interactions/workspace-1",
  createdAt: 1,
};

test("first launch hides the sidebar; an explicit control opens overlay without edge hover", async ({
  page,
}) => {
  await prepareShell(page);
  const canvasBefore = await canvasBox(page);
  await expect(workspaceSidebar(page)).not.toBeVisible({ timeout: 1_000 });
  await expectRetainedChrome(page);

  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("The viewport was not measurable.");
  await page.mouse.move(1, Math.round(viewport.height / 2));
  await page.waitForTimeout(CLOSED_AFTER_LEAVE_MS);
  await expect(workspaceSidebar(page)).not.toBeVisible();

  await openOverlay(page);
  const overlay = await readLayout(page);
  expect(
    overlay.sidebar,
    "overlay should expose the Workspace Sidebar panel",
  ).not.toBeNull();
  expect(
    horizontalOverlap(overlay.sidebar, overlay.canvas),
  ).toBeGreaterThanOrEqual(OVERLAY_OVERLAP_PX);
  expect(
    Math.abs(overlay.canvas.width - canvasBefore.width),
  ).toBeLessThanOrEqual(LAYOUT_PX);
  expectFlushToContentRight(overlay);

  await page.keyboard.press("Escape");
  await expect(workspaceSidebar(page)).not.toBeVisible();
  expect(
    Math.abs((await canvasBox(page)).width - canvasBefore.width),
  ).toBeLessThanOrEqual(LAYOUT_PX);
});

test("overlay leaves canvas size unchanged; pin enters layout and unpin restores overlay", async ({
  page,
}) => {
  await prepareShell(page);
  const hiddenCanvas = await canvasBox(page);

  await openOverlay(page);
  const overlay = await readLayout(page);
  expect(
    horizontalOverlap(overlay.sidebar, overlay.canvas),
  ).toBeGreaterThanOrEqual(OVERLAY_OVERLAP_PX);
  expect(
    Math.abs(overlay.canvas.width - hiddenCanvas.width),
  ).toBeLessThanOrEqual(LAYOUT_PX);

  await page
    .getByRole("button", { name: "Pin workspace sidebar", exact: true })
    .click({ timeout: 5_000 });
  await expect(
    page.getByRole("button", { name: "Unpin workspace sidebar", exact: true }),
  ).toBeVisible();
  const pinned = await readLayout(page);
  expectPinnedLayout(pinned, hiddenCanvas);
  expect(pinned.canvas.width / pinned.body.width).toBeGreaterThanOrEqual(0.7);

  await page
    .getByRole("button", { name: "Unpin workspace sidebar", exact: true })
    .click();
  const restored = await readLayout(page);
  expect(
    horizontalOverlap(restored.sidebar, restored.canvas),
  ).toBeGreaterThanOrEqual(OVERLAY_OVERLAP_PX);
  expect(
    Math.abs(restored.canvas.width - hiddenCanvas.width),
  ).toBeLessThanOrEqual(LAYOUT_PX);

  await page
    .getByRole("button", { name: "Pin workspace sidebar", exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Unpin workspace sidebar", exact: true }),
  ).toBeVisible();
  expectPinnedLayout(await readLayout(page), hiddenCanvas);
});

test("overlay closes 500ms after pointer leave and cancels the pending close on re-enter", async ({
  page,
}) => {
  await prepareShell(page);
  await openOverlay(page);
  await hoverSidebar(page);

  await leaveSidebar(page);
  await page.waitForTimeout(STILL_OPEN_MS);
  expect(
    await workspaceSidebar(page).isVisible(),
    `sidebar must stay open ${STILL_OPEN_MS}ms after pointer leave`,
  ).toBe(true);
  await page.waitForTimeout(CLOSED_AFTER_LEAVE_MS - STILL_OPEN_MS);
  expect(
    await workspaceSidebar(page).isVisible(),
    `sidebar must close within ${POINTER_LEAVE_MS}ms of pointer leave`,
  ).toBe(false);

  await openOverlay(page);
  await hoverSidebar(page);
  await leaveSidebar(page);
  await page.waitForTimeout(STILL_OPEN_MS);
  await hoverSidebar(page);
  await page.waitForTimeout(CLOSED_AFTER_LEAVE_MS);
  expect(
    await workspaceSidebar(page).isVisible(),
    "re-entering the sidebar must cancel the pending close",
  ).toBe(true);
});

test("focus, menu, dialog, and drag holds pause overlay auto-close; Escape still dismisses", async ({
  page,
}) => {
  await prepareShell(page);

  await openOverlay(page);
  await page.getByRole("button", { name: "Pin workspace sidebar" }).focus();
  await leaveSidebar(page);
  await page.waitForTimeout(HOLD_PAUSE_MS);
  expect(
    await workspaceSidebar(page).isVisible(),
    "keyboard/pointer focus inside the sidebar must pause auto-close",
  ).toBe(true);
  await page.getByRole("toolbar", { name: "Drawing commands" }).click();
  await page.waitForTimeout(CLOSED_AFTER_LEAVE_MS);
  expect(await workspaceSidebar(page).isVisible()).toBe(false);

  await openOverlay(page);
  await hoverSidebar(page);
  await page.getByRole("button", { name: "Actions for Workspace" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await leaveSidebar(page);
  await page.waitForTimeout(HOLD_PAUSE_MS);
  expect(
    await workspaceSidebar(page).isVisible(),
    "an open sidebar menu must pause auto-close",
  ).toBe(true);
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("toolbar", { name: "Drawing commands" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.waitForTimeout(CLOSED_AFTER_LEAVE_MS);
  expect(await workspaceSidebar(page).isVisible()).toBe(false);

  await openOverlay(page);
  await hoverSidebar(page);
  await page.getByRole("button", { name: "Actions for Workspace" }).click();
  await page.getByRole("menuitem", { name: "New Drawing" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await leaveSidebar(page);
  await page.waitForTimeout(HOLD_PAUSE_MS);
  expect(
    await workspaceSidebar(page).isVisible(),
    "a sidebar dialog must pause auto-close",
  ).toBe(true);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await workspaceSidebar(page).isVisible()).toBe(true);

  await hoverSidebar(page);
  const row = page.getByRole("treeitem", { name: "drawing" });
  await row.hover();
  await page.mouse.down();
  await leaveSidebar(page);
  await page.waitForTimeout(HOLD_PAUSE_MS);
  expect(
    await workspaceSidebar(page).isVisible(),
    "an in-progress sidebar drag must pause auto-close",
  ).toBe(true);
  await page.mouse.up();
  await page.waitForTimeout(CLOSED_AFTER_LEAVE_MS);
  expect(await workspaceSidebar(page).isVisible()).toBe(false);

  await openOverlay(page);
  await page.keyboard.press("Escape");
  expect(await workspaceSidebar(page).isVisible()).toBe(false);
});

test("a pinned sidebar keeps the canvas at least 70% of available content width", async ({
  page,
}) => {
  await prepareShell(page, { sidebarPinned: true });
  await expect(workspaceSidebar(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Unpin workspace sidebar", exact: true }),
  ).toBeVisible();

  const layout = await readLayout(page);
  expectPinnedLayout(layout);
  expect(layout.canvas.width / layout.body.width).toBeGreaterThanOrEqual(0.7);
  expectFlushToContentRight(layout);
});

test("prefers-reduced-motion still opens and closes overlay without relying on animation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await prepareShell(page);

  await openOverlay(page);
  await expect(workspaceSidebar(page)).toBeVisible({ timeout: 1_000 });
  await page.keyboard.press("Escape");
  await expect(workspaceSidebar(page)).not.toBeVisible({ timeout: 1_000 });

  await openOverlay(page);
  await hoverSidebar(page);
  await leaveSidebar(page);
  await page.waitForTimeout(CLOSED_AFTER_LEAVE_MS);
  expect(await workspaceSidebar(page).isVisible()).toBe(false);
});

test("Appearance light, dark, and system still resolve while sidebar modes change", async ({
  page,
}) => {
  await prepareShell(page);
  await expectRetainedChrome(page);
  await openOverlay(page);

  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "dark",
  );
  await page.getByRole("radio", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "light",
  );

  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("radio", { name: "System" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "dark",
  );
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "light",
  );

  await page
    .getByRole("button", { name: "Pin workspace sidebar", exact: true })
    .click({ timeout: 5_000 });
  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "dark",
  );
  await expectRetainedChrome(page);
  // Content theme is independent of the ordinary native titlebar (T057).
});

async function prepareShell(
  page: Page,
  options: { sidebarPinned?: boolean } = {},
): Promise<void> {
  await page.setViewportSize(SUPPORTED_VIEWPORT);
  await installUiInteractionHarness(page, {
    workspaces: [workspace],
    entries: [drawing("drawing.excalidraw", "drawing")],
  });
  if (options.sidebarPinned === true) {
    await page.addInitScript(
      ({ key, snapshot }) => {
        localStorage.setItem(key, snapshot);
      },
      {
        key: SHELL_PREFERENCES_STORAGE_KEY,
        snapshot: JSON.stringify({
          version: SHELL_PREFERENCES_VERSION,
          sidebarPinned: true,
          expandedWorkspaceIds: [workspace.id],
        }),
      },
    );
  }
  await page.goto("/");
}

async function openOverlay(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Workspace sidebar", exact: true })
    .click({ timeout: 5_000 });
  await expect(workspaceSidebar(page)).toBeVisible();
}

function workspaceSidebar(page: Page) {
  return page.locator(".file-sidebar");
}

async function expectRetainedChrome(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export…" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Appearance" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Light" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Dark" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "System" })).toBeVisible();
}

async function hoverSidebar(page: Page): Promise<void> {
  const box = await workspaceSidebar(page).boundingBox();
  if (box === null)
    throw new Error("The Workspace Sidebar was not measurable.");
  await page.mouse.move(
    box.x + Math.min(24, box.width / 2),
    box.y + box.height / 2,
  );
}

async function leaveSidebar(page: Page): Promise<void> {
  const canvas = page.getByRole("main", { name: "Drawing canvas" });
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("The drawing canvas was not measurable.");
  }
  await page.mouse.move(
    box.x + Math.max(box.width - 24, box.width / 2),
    box.y + box.height / 2,
  );
}

interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ShellLayout {
  sidebar: LayoutBox | null;
  canvas: LayoutBox;
  body: LayoutBox;
}

async function readLayout(page: Page): Promise<ShellLayout> {
  const layout = await page.evaluate(() => {
    const boxOf = (element: Element | null) => {
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    return {
      sidebar: boxOf(document.querySelector(".file-sidebar")),
      canvas: boxOf(document.querySelector(".canvas-region")),
      body: boxOf(document.querySelector(".app-shell-body")),
    };
  });
  if (layout.canvas === null || layout.body === null) {
    throw new Error("The canvas-first shell layout was not measurable.");
  }
  return { sidebar: layout.sidebar, canvas: layout.canvas, body: layout.body };
}

async function canvasBox(page: Page): Promise<LayoutBox> {
  return (await readLayout(page)).canvas;
}

function horizontalOverlap(a: LayoutBox | null, b: LayoutBox): number {
  if (a === null) return 0;
  return Math.max(
    0,
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  );
}

function expectPinnedLayout(
  layout: ShellLayout,
  hiddenCanvas?: LayoutBox,
): void {
  expect(
    layout.sidebar,
    "pinned mode should keep the Workspace Sidebar in the layout",
  ).not.toBeNull();
  expect(horizontalOverlap(layout.sidebar, layout.canvas)).toBeLessThanOrEqual(
    LAYOUT_PX,
  );
  if (layout.sidebar !== null) {
    expect(layout.sidebar.x + layout.sidebar.width).toBeLessThanOrEqual(
      layout.canvas.x + LAYOUT_PX,
    );
  }
  if (hiddenCanvas !== undefined) {
    expect(layout.canvas.width).toBeLessThan(hiddenCanvas.width - LAYOUT_PX);
  }
  expectFlushToContentRight(layout);
}

function expectFlushToContentRight(layout: ShellLayout): void {
  expect(
    layout.body.x + layout.body.width - (layout.canvas.x + layout.canvas.width),
  ).toBeLessThanOrEqual(LAYOUT_PX);
}

function drawing(relativePath: string, displayName: string) {
  const name = relativePath.split("/").at(-1) ?? relativePath;
  return {
    workspaceId: workspace.id,
    kind: "drawing" as const,
    name,
    displayName,
    canonicalPath: `${workspace.rootPath}/${relativePath}`,
    relativePath,
    parentRelativePath: "",
    mtime: 1,
    fileSize: 100,
  };
}
