import { expect, test, type Locator, type Page } from "@playwright/test";
import { installBrowserTauriHarness } from "./browserTauriHarness";

/** The smallest window content size the native window allows. */
const MINIMUM_VIEWPORT = { width: 960, height: 640 } as const;
/** The canvas beside the narrowest (280-pixel) pinned sidebar at the minimum size. */
const MINIMUM_CANVAS_WIDTH = 680;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(MINIMUM_VIEWPORT);
  await installBrowserTauriHarness(page);
  await page.goto("/");
  // Welcome New Drawing claims the harness folder and opens one tab.
  await page
    .getByTestId("welcome-screen")
    .getByRole("button", { name: "New Drawing", exact: true })
    .click();
  await expect(page.locator(".excalidraw-editor")).toBeVisible();
});

function sidebarToggle(page: Page): Locator {
  return page.getByRole("button", {
    name: "Toggle workspace sidebar",
    exact: true,
  });
}

/** Hidden → Overlay → Pinned. */
async function pinSidebar(page: Page): Promise<void> {
  await sidebarToggle(page).click();
  await sidebarToggle(page).click();
  await expect(page.locator(".app-shell-body")).toHaveAttribute(
    "data-sidebar-mode",
    "pinned",
  );
}

async function expectInsideViewport(locator: Locator, what: string) {
  await expect(locator, what).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, what).not.toBeNull();
  if (box === null) return;
  expect(box.x, `${what} left edge`).toBeGreaterThanOrEqual(0);
  expect(box.y, `${what} top edge`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${what} right edge`).toBeLessThanOrEqual(
    MINIMUM_VIEWPORT.width,
  );
  expect(box.y + box.height, `${what} bottom edge`).toBeLessThanOrEqual(
    MINIMUM_VIEWPORT.height,
  );
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    document: [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ],
    body: [document.body.scrollWidth, document.body.clientWidth],
  }));
  expect(overflow.document[0]).toBeLessThanOrEqual(overflow.document[1]);
  expect(overflow.body[0]).toBeLessThanOrEqual(overflow.body[1]);
}

async function expectShellUsable(page: Page) {
  await expectNoHorizontalOverflow(page);
  await expectInsideViewport(sidebarToggle(page), "sidebar toggle");
  await expectInsideViewport(page.getByRole("tab").first(), "drawing tab");
  for (const tool of ["Selection", "Rectangle", "Text"]) {
    await expectInsideViewport(
      page.getByRole("radio", { name: tool, exact: false }).first(),
      `${tool} tool`,
    );
  }
}

test("the shell stays usable at the minimum window size with the sidebar hidden", async ({
  page,
}) => {
  await expectShellUsable(page);
});

test("the pinned sidebar leaves a usable canvas at the minimum window size", async ({
  page,
}) => {
  await pinSidebar(page);
  await expectShellUsable(page);
  const sidebar = page.getByRole("complementary").first();
  await expectInsideViewport(sidebar, "pinned sidebar");

  // At its narrowest the sidebar leaves the canvas its planned width.
  const resizer = page.getByRole("separator", {
    name: "Resize workspace sidebar",
  });
  await resizer.focus();
  await page.keyboard.press("Home");
  await expect(resizer).toHaveAttribute("aria-valuenow", "280");
  await expectShellUsable(page);
  const canvas = await page.locator(".excalidraw-editor").boundingBox();
  expect(canvas).not.toBeNull();
  expect(canvas?.width ?? 0).toBeGreaterThanOrEqual(MINIMUM_CANVAS_WIDTH);
});
