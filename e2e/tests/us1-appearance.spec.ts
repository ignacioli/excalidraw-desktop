import { expect, test } from "@playwright/test";
import { installBrowserTauriHarness } from "./browserTauriHarness";

const APPEARANCE_KEY = "excalidraw-desktop.appearance";

test.beforeEach(async ({ page }) => {
  await installBrowserTauriHarness(page);
  await page.goto("/");
  await page.evaluate(
    (key) => globalThis.localStorage.removeItem(key),
    APPEARANCE_KEY,
  );
  await page.reload();
  await page.getByRole("button", { name: "New drawing" }).click();
  await expect(page.locator(".excalidraw-editor")).toBeVisible();
});

test("keeps shell appearance synchronized and restores the preference", async ({
  page,
}) => {
  await expect(page.getByRole("radio", { name: "System" })).toBeChecked();

  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "dark",
  );
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(page.locator(".excalidraw")).toHaveClass(/theme--dark/);

  await page.reload();
  await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "dark",
  );
  await page.getByRole("button", { name: "Open drawing…" }).click();
  await expect(page.locator(".excalidraw-editor")).toBeVisible();

  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("radio", { name: "System" }).click();
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

  await expect(page.getByRole("radio", { name: "System" })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "excalidraw",
  );
  await expect(page.locator(".app-shell")).toBeVisible();
});

test("matches the approved light and dark shell baselines", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("radio", { name: "Light" }).click();
  await expect(page.locator(".app-shell")).toHaveScreenshot(
    "us1-shell-light.png",
    {
      animations: "disabled",
      maxDiffPixelRatio: 0.001,
    },
  );

  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator(".app-shell")).toHaveScreenshot(
    "us1-shell-dark.png",
    {
      animations: "disabled",
      maxDiffPixelRatio: 0.001,
    },
  );
});
