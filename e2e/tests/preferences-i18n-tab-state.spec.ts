import { expect, test, type Page } from "@playwright/test";
import {
  installBrowserTauriHarness,
  readHarnessFile,
} from "./browserTauriHarness";
import {
  emitNativeCommand,
  expectPreference,
  type CanvasPreference,
} from "./preferencesI18nMenu";
import {
  openWorkspaceSidebar,
  persistPinnedWorkspaceSidebar,
} from "./workspaceSidebar";

const FIRST = "/virtual/first.excalidraw";
const SECOND = "/virtual/second.excalidraw";

test.beforeEach(async ({ page }) => {
  await installBrowserTauriHarness(
    page,
    FIRST,
    undefined,
    [FIRST, SECOND],
    undefined,
    true,
  );
  await persistPinnedWorkspaceSidebar(page, ["workspace-1"], "workspace-1");
  await page.goto("/");
  await openWorkspaceSidebar(page);
});

async function openDrawing(page: Page, name: "first" | "second") {
  await page.getByRole("treeitem", { name }).click();
  await expect(
    page.getByRole("tab", { name: `${name}.excalidraw` }),
  ).toHaveAttribute("aria-selected", "true");
}

async function expectPreferences(
  page: Page,
  expected: Readonly<Record<CanvasPreference, boolean>>,
) {
  for (const [preference, enabled] of Object.entries(expected)) {
    await expectPreference(page, preference as CanvasPreference, enabled);
  }
}

const ALL_OFF = {
  toolLock: false,
  grid: false,
  snap: false,
  zen: false,
  viewMode: false,
} as const;

test("keeps preferences per tab and resets session-only ones on reopen", async ({
  page,
}) => {
  await openDrawing(page, "first");
  await emitNativeCommand(page, "toggleToolLock");
  await emitNativeCommand(page, "toggleZen");
  await emitNativeCommand(page, "toggleViewMode");
  const firstState = { ...ALL_OFF, toolLock: true, zen: true, viewMode: true };
  await expectPreferences(page, firstState);

  await openDrawing(page, "second");
  await expectPreferences(page, ALL_OFF);

  await page.getByRole("tab", { name: "first.excalidraw" }).click();
  await expectPreferences(page, firstState);

  await page.getByRole("button", { name: "Close first.excalidraw" }).click();
  await expect(page.getByRole("tab", { name: "first.excalidraw" })).toHaveCount(
    0,
  );
  await openDrawing(page, "first");
  await expectPreferences(page, ALL_OFF);
});

for (const [preference, command, key] of [
  ["grid", "toggleGrid", "gridModeEnabled"],
  ["snap", "toggleSnap", "objectsSnapModeEnabled"],
] as const) {
  test(`saves ${preference} with the drawing and restores it on reopen`, async ({
    page,
  }) => {
    await openDrawing(page, "first");
    await emitNativeCommand(page, command);
    await expectPreference(page, preference, true);

    await page.keyboard.press("Meta+s");
    await expect
      .poll(async () => {
        const saved = await readHarnessFile(page, FIRST);
        if (saved === null) return undefined;
        return (JSON.parse(saved) as { appState?: Record<string, unknown> })
          .appState?.[key];
      })
      .toBe(true);

    await page.getByRole("button", { name: "Close first.excalidraw" }).click();
    await expect(
      page.getByRole("tab", { name: "first.excalidraw" }),
    ).toHaveCount(0);
    await openDrawing(page, "first");
    await expectPreference(page, preference, true);
  });
}

test("keeps the tab bar and sidebar control usable in Zen mode", async ({
  page,
}) => {
  await openDrawing(page, "first");
  await emitNativeCommand(page, "toggleZen");
  await expectPreference(page, "zen", true);

  await expect(page.getByRole("tablist")).toBeVisible();
  await page.getByRole("tab", { name: "first.excalidraw" }).focus();
  await expect(
    page.getByRole("tab", { name: "first.excalidraw" }),
  ).toBeFocused();
  const toggle = page.getByRole("button", {
    name: "Toggle workspace sidebar",
    exact: true,
  });
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(page.getByRole("complementary", { name: "Files" })).toBeHidden();
  await toggle.click();
  await expect(
    page.getByRole("complementary", { name: "Files" }),
  ).toBeVisible();
});
