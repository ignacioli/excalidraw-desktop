import { expect, test } from "@playwright/test";
import {
  emitBrowserTauriEvent,
  installBrowserTauriHarness,
} from "./browserTauriHarness";
import { persistPinnedWorkspaceSidebar } from "./workspaceSidebar";

const APPEARANCE_KEY = "excalidraw-desktop.appearance";

test.beforeEach(async ({ page }) => {
  await installBrowserTauriHarness(page);
  await persistPinnedWorkspaceSidebar(page);
  await page.goto("/");
  await page.evaluate(
    (key) => globalThis.localStorage.removeItem(key),
    APPEARANCE_KEY,
  );
  await page.reload();
  await openWelcomeDrawing(page);
});

test("keeps shell appearance synchronized and restores the preference", async ({
  page,
}) => {
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "excalidraw",
  );

  await setNativeAppearance(page, "appearanceDark");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "dark",
  );
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator(".excalidraw")).toHaveClass(/theme--dark/);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "dark",
  );
  await expectPersistedAppearance(page, "dark");
  await openWelcomeDrawing(page);

  await page.emulateMedia({ colorScheme: "light" });
  await setNativeAppearance(page, "appearanceSystem");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "light",
  );
  await expect(page.locator(".excalidraw")).not.toHaveClass(/theme--dark/);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "dark",
  );
  await expect(page.locator(".excalidraw")).toHaveClass(/theme--dark/);
});

async function openWelcomeDrawing(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page
    .getByTestId("welcome-screen")
    .getByRole("button", { name: "New Drawing", exact: true })
    .click();
  await expect(page.locator(".excalidraw-editor")).toBeVisible();
}

async function setNativeAppearance(
  page: import("@playwright/test").Page,
  command: "appearanceSystem" | "appearanceLight" | "appearanceDark",
): Promise<void> {
  await emitBrowserTauriEvent(page, "native-menu-command", { command });
}

async function expectPersistedAppearance(
  page: import("@playwright/test").Page,
  modePreference: "system" | "light" | "dark",
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((key) => localStorage.getItem(key), APPEARANCE_KEY),
    )
    .toBe(
      JSON.stringify({
        version: 1,
        themeId: "excalidraw",
        modePreference,
      }),
    );
}

test("restores a dark preference before the application module runs", async ({
  page,
}) => {
  await page.evaluate(
    ({ key }) =>
      globalThis.localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          themeId: "excalidraw",
          modePreference: "dark",
        }),
      ),
    { key: APPEARANCE_KEY },
  );
  await page.route(
    "**/src/main.tsx",
    async (route) => {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 1_500));
      await route.continue();
    },
    { times: 1 },
  );

  await page.reload({ waitUntil: "commit" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "dark",
    { timeout: 750 },
  );
  await page.waitForLoadState("load");
});

test("falls back safely from a corrupt preference before the shell is interactive", async ({
  page,
}) => {
  await page.evaluate(
    ({ key }) => globalThis.localStorage.setItem(key, "not-json"),
    { key: APPEARANCE_KEY },
  );
  await page.reload();

  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "excalidraw",
  );
  await expectPersistedAppearance(page, "system");
  await expect(page.locator(".app-shell")).toBeVisible();
});

test("matches the approved light and dark shell baselines", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setNativeAppearance(page, "appearanceLight");
  await expect(page.locator(".app-shell")).toHaveScreenshot(
    "us1-shell-light.png",
    {
      animations: "disabled",
      maxDiffPixelRatio: 0.001,
    },
  );

  await setNativeAppearance(page, "appearanceDark");
  await expect(page.locator(".app-shell")).toHaveScreenshot(
    "us1-shell-dark.png",
    {
      animations: "disabled",
      maxDiffPixelRatio: 0.001,
    },
  );
});
