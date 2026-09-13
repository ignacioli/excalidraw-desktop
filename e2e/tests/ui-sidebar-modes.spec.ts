import { expect, test, type Page } from "@playwright/test";
import {
  getUiInteractionHarnessState,
  installUiInteractionHarness,
} from "./uiInteractionHarness";

/**
 * Accessible name and state the sidebar implementation should expose:
 * - `Toggle workspace sidebar` — Hidden → Overlay → Pinned → Hidden
 * - `aria-expanded=false` in Hidden; `true` in Overlay and Pinned
 * - no independent `Pin workspace sidebar` / `Unpin workspace sidebar`
 *
 * The shell header retains Toggle, Back, and Drawing tabs. Save, Export, and
 * Appearance stay with their native/application owners and have no duplicate
 * top-level shell controls.
 *
 * Panel under test is the existing `.file-sidebar` complementary. Preference
 * JSON matches `src/app/shellPreferences.ts`.
 */
const SHELL_PREFERENCES_STORAGE_KEY = "excalidraw-desktop.shell";
const SHELL_PREFERENCES_VERSION = 1;
const THEME_PREFERENCE_STORAGE_KEY = "excalidraw-desktop.appearance";
const THEME_PREFERENCE_VERSION = 1;
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

test("a selected Workspace starts hidden; the Toggle control opens overlay", async ({
  page,
}) => {
  await prepareShell(page);
  const canvasBefore = await canvasBox(page);
  await expect(workspaceSidebar(page)).not.toBeVisible({ timeout: 1_000 });
  await expectRetainedChrome(page);

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

test("one toggle cycles hidden, overlay, pinned, and hidden while persisting pin state", async ({
  page,
}) => {
  await prepareShell(page);
  const hiddenCanvas = await canvasBox(page);
  const toggle = sidebarToggle(page);

  await expectSidebarMode(page, "hidden");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  await openOverlay(page);
  const overlay = await readLayout(page);
  expect(
    horizontalOverlap(overlay.sidebar, overlay.canvas),
  ).toBeGreaterThanOrEqual(OVERLAY_OVERLAP_PX);
  expect(
    Math.abs(overlay.canvas.width - hiddenCanvas.width),
  ).toBeLessThanOrEqual(LAYOUT_PX);

  await toggle.click({ timeout: 5_000 });
  await expectSidebarMode(page, "pinned");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expectIndependentPinControlsAbsent(page);
  await expectPersistedSidebarPinned(page, true);
  const pinned = await readLayout(page);
  expectPinnedLayout(pinned, hiddenCanvas);
  expect(pinned.canvas.width / pinned.body.width).toBeGreaterThanOrEqual(0.7);

  await page.reload();
  await expectSidebarMode(page, "pinned");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expectPinnedLayout(await readLayout(page), hiddenCanvas);

  await toggle.click();
  await expectSidebarMode(page, "hidden");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(workspaceSidebar(page)).not.toBeVisible();
  await expectPersistedSidebarPinned(page, false);
  expect(
    Math.abs((await canvasBox(page)).width - hiddenCanvas.width),
  ).toBeLessThanOrEqual(LAYOUT_PX);

  await page.reload();
  await expectSidebarMode(page, "hidden");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(workspaceSidebar(page)).not.toBeVisible();
});

test("overlay closes 500ms after pointer leave and cancels the pending close on re-enter", async ({
  page,
}) => {
  await prepareShell(page);
  await openOverlay(page);
  await releaseSidebarFocus(page);
  await hoverSidebar(page);

  await leaveSidebar(page);
  await page.waitForTimeout(STILL_OPEN_MS);
  expect(
    await workspaceSidebar(page).isVisible(),
    `sidebar must stay open ${STILL_OPEN_MS}ms after pointer leave`,
  ).toBe(true);
  await page.waitForTimeout(POINTER_LEAVE_MS - STILL_OPEN_MS);
  expect(
    await workspaceSidebar(page).isVisible(),
    `sidebar must close within ${POINTER_LEAVE_MS}ms of pointer leave`,
  ).toBe(false);

  await openOverlay(page);
  await releaseSidebarFocus(page);
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

test("focus inside the sidebar pauses overlay auto-close", async ({ page }) => {
  await prepareShell(page);
  await openOverlay(page);
  await workspaceSidebar(page)
    .getByRole("button", { name: "Refresh", exact: true })
    .focus();
  await leaveSidebar(page);
  await page.waitForTimeout(HOLD_PAUSE_MS);
  expect(
    await workspaceSidebar(page).isVisible(),
    "keyboard/pointer focus inside the sidebar must pause auto-close",
  ).toBe(true);
  await releaseSidebarFocus(page);
  await page.waitForTimeout(CLOSED_AFTER_LEAVE_MS);
  expect(await workspaceSidebar(page).isVisible()).toBe(false);
});

test("an open sidebar menu holds the overlay open while active", async ({
  page,
}) => {
  await prepareShell(page);
  await openOverlay(page);
  await releaseSidebarFocus(page);
  await hoverSidebar(page);
  await page.getByRole("treeitem", { name: "Workspace" }).hover();
  await page
    .getByRole("button", { name: "Actions for Workspace", exact: true })
    .click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await releaseSidebarFocus(page);
  await expect(menu).toBeVisible();
  await leaveSidebar(page);
  await page.waitForTimeout(HOLD_PAUSE_MS);
  expect(
    await workspaceSidebar(page).isVisible(),
    "an open sidebar menu must pause auto-close",
  ).toBe(true);
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem").first().press("Tab");
  await expect(menu).toHaveCount(0);
});

test("an open sidebar dialog holds the overlay open while active", async ({
  page,
}) => {
  await prepareShell(page);
  await openOverlay(page);
  await releaseSidebarFocus(page);
  await hoverSidebar(page);
  await page.getByRole("treeitem", { name: "Workspace" }).hover();
  await page
    .getByRole("button", { name: "Actions for Workspace", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "New Drawing" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await releaseSidebarFocus(page);
  await expect(dialog).toBeVisible();
  await leaveSidebar(page);
  await page.waitForTimeout(HOLD_PAUSE_MS);
  expect(
    await workspaceSidebar(page).isVisible(),
    "a sidebar dialog must pause auto-close",
  ).toBe(true);
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await workspaceSidebar(page).isVisible()).toBe(true);
});

test("an in-progress sidebar drag pauses overlay auto-close", async ({
  page,
}) => {
  await prepareShell(page);
  await openOverlay(page);
  await releaseSidebarFocus(page);
  await hoverSidebar(page);
  const row = page.getByRole("treeitem", { name: "drawing" });
  await row.hover();
  await page.mouse.down();
  await releaseSidebarFocus(page);
  await leaveSidebar(page);
  await page.waitForTimeout(HOLD_PAUSE_MS);
  expect(
    await workspaceSidebar(page).isVisible(),
    "an in-progress sidebar drag must pause auto-close",
  ).toBe(true);
  await page.mouse.up();
  await page.waitForTimeout(CLOSED_AFTER_LEAVE_MS);
  expect(await workspaceSidebar(page).isVisible()).toBe(false);
});

test("Escape dismisses an overlay even while sidebar focus is held", async ({
  page,
}) => {
  await prepareShell(page);
  await openOverlay(page);
  await workspaceSidebar(page)
    .getByRole("button", { name: "Refresh", exact: true })
    .focus();
  await page.keyboard.press("Escape");
  await expect(workspaceSidebar(page)).not.toBeVisible();
  await expectSidebarMode(page, "hidden");
  await expect(sidebarToggle(page)).toHaveAttribute("aria-expanded", "false");
});

test("a pinned sidebar keeps the canvas at least 70% of available content width", async ({
  page,
}) => {
  await prepareShell(page, { sidebarPinned: true });
  await expect(workspaceSidebar(page)).toBeVisible();
  await expectSidebarMode(page, "pinned");
  await expect(sidebarToggle(page)).toHaveAttribute("aria-expanded", "true");
  await expectIndependentPinControlsAbsent(page);

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
  await releaseSidebarFocus(page);
  await hoverSidebar(page);
  await leaveSidebar(page);
  await page.waitForTimeout(POINTER_LEAVE_MS);
  expect(await workspaceSidebar(page).isVisible()).toBe(false);
});

test("persisted Light, Dark, and System preferences remain independent of sidebar modes", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await prepareShell(page);
  await setPersistedThemePreference(page, "dark");
  await page.reload();
  await expectRetainedChrome(page);
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "dark",
  );
  await expectPersistedThemePreference(page, "dark");

  await openOverlay(page);
  await sidebarToggle(page).click({ timeout: 5_000 });
  await expectSidebarMode(page, "pinned");
  await expectPersistedSidebarPinned(page, true);
  await expectPersistedThemePreference(page, "dark");

  await setPersistedThemePreference(page, "light");
  await page.reload();
  await expectSidebarMode(page, "pinned");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "light",
  );
  await expectPersistedThemePreference(page, "light");

  await page.emulateMedia({ colorScheme: "dark" });
  await setPersistedThemePreference(page, "system");
  await page.reload();
  await expectSidebarMode(page, "pinned");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "dark",
  );
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "light",
  );
  await expectPersistedThemePreference(page, "system");

  await sidebarToggle(page).click();
  await expectSidebarMode(page, "hidden");
  await expectPersistedSidebarPinned(page, false);
  await expectPersistedThemePreference(page, "system");
  await expectRetainedChrome(page);
});

async function prepareShell(
  page: Page,
  options: { sidebarPinned?: boolean } = {},
): Promise<void> {
  await page.setViewportSize(SUPPORTED_VIEWPORT);
  await installUiInteractionHarness(page, {
    workspaces: [workspace],
    entries: [drawing("drawing.excalidraw", "drawing")],
    startup: { nativeWindowRuntime: true },
  });
  await page.addInitScript(
    ({ key, snapshot }) => {
      if (localStorage.getItem(key) === null) {
        localStorage.setItem(key, snapshot);
      }
    },
    {
      key: SHELL_PREFERENCES_STORAGE_KEY,
      snapshot: JSON.stringify({
        version: SHELL_PREFERENCES_VERSION,
        sidebarPinned: options.sidebarPinned === true,
        expandedWorkspaceIds: [workspace.id],
        currentWorkspaceId: workspace.id,
      }),
    },
  );
  await page.goto("/");
  await expect
    .poll(async () => {
      const state = await getUiInteractionHarnessState(page);
      return {
        errors: state.errors,
        commands: state.invocations.map((invocation) => invocation.command),
      };
    })
    .toEqual(
      expect.objectContaining({
        errors: [],
        commands: expect.arrayContaining(["app_handshake", "workspace_list"]),
      }),
    );
}

async function openOverlay(page: Page): Promise<void> {
  const toggle = sidebarToggle(page);
  await expectSidebarMode(page, "hidden");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click({ timeout: 5_000 });
  await expect(workspaceSidebar(page)).toBeVisible();
  await expectSidebarMode(page, "overlay");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expectIndependentPinControlsAbsent(page);
  await hoverSidebar(page);
}

function workspaceSidebar(page: Page) {
  return page.locator(".file-sidebar");
}

function sidebarToggle(page: Page) {
  return page.getByRole("button", {
    name: "Toggle workspace sidebar",
    exact: true,
  });
}

async function releaseSidebarFocus(page: Page): Promise<void> {
  const toggle = sidebarToggle(page);
  await toggle.focus();
  await expect(toggle).toBeFocused();
}

async function expectSidebarMode(
  page: Page,
  mode: "hidden" | "overlay" | "pinned",
): Promise<void> {
  await expect(page.locator(".app-shell-body")).toHaveAttribute(
    "data-sidebar-mode",
    mode,
  );
}

async function expectIndependentPinControlsAbsent(page: Page): Promise<void> {
  await expect(
    page.getByRole("button", { name: /^(?:Pin|Unpin) workspace sidebar$/ }),
  ).toHaveCount(0);
}

async function expectPersistedSidebarPinned(
  page: Page,
  expected: boolean,
): Promise<void> {
  const stored = await page.evaluate(
    (key) => localStorage.getItem(key),
    SHELL_PREFERENCES_STORAGE_KEY,
  );
  expect(stored).not.toBeNull();
  expect(JSON.parse(stored ?? "null")).toMatchObject({
    version: SHELL_PREFERENCES_VERSION,
    sidebarPinned: expected,
  });
}

async function setPersistedThemePreference(
  page: Page,
  modePreference: "light" | "dark" | "system",
): Promise<void> {
  await page.evaluate(
    ({ key, snapshot }) => localStorage.setItem(key, snapshot),
    {
      key: THEME_PREFERENCE_STORAGE_KEY,
      snapshot: serializeThemePreference(modePreference),
    },
  );
}

async function expectPersistedThemePreference(
  page: Page,
  expected: "light" | "dark" | "system",
): Promise<void> {
  const stored = await page.evaluate(
    (key) => localStorage.getItem(key),
    THEME_PREFERENCE_STORAGE_KEY,
  );
  expect(stored).toBe(serializeThemePreference(expected));
}

function serializeThemePreference(
  modePreference: "light" | "dark" | "system",
): string {
  return JSON.stringify({
    version: THEME_PREFERENCE_VERSION,
    themeId: "excalidraw",
    modePreference,
  });
}

async function expectRetainedChrome(page: Page): Promise<void> {
  const shellNavigation = page.getByRole("group", {
    name: "Shell navigation",
    exact: true,
  });
  await expect(shellNavigation.getByRole("button")).toHaveCount(2);
  await expect(sidebarToggle(page)).toBeVisible();
  await expect(
    shellNavigation.getByRole("button", { name: "Back", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Open drawings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tablist", { name: "Drawing tabs", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.locator(".app-commands button, .app-commands fieldset"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Export…", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("group", { name: "Appearance", exact: true }),
  ).toHaveCount(0);
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
