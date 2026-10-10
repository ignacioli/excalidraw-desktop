import { expect, test } from "@playwright/test";
import { installBrowserTauriHarness } from "./browserTauriHarness";
import {
  PREFERENCE_ENTRIES,
  activeEditor,
  canvasMenuEntries,
  canvasMenuItem,
  closeCanvasMenu,
  emitNativeCommand,
  expectPreference,
  focusCanvas,
  openCanvasMenu,
  openWelcomeDrawing,
  type CanvasPreference,
} from "./preferencesI18nMenu";

const LANGUAGE_KEY = "excalidraw-desktop.language";

test.beforeEach(async ({ page }) => {
  await installBrowserTauriHarness(page);
  await page.goto("/");
  await page.evaluate(
    (key) => globalThis.localStorage.removeItem(key),
    LANGUAGE_KEY,
  );
  await page.reload();
  await openWelcomeDrawing(page);
});

test("lists exactly the contract entries in order, in both languages", async ({
  page,
}) => {
  await openCanvasMenu(page);
  expect(
    await canvasMenuEntries(page, "Menu", "text:Canvas background"),
  ).toEqual([
    "button:Find on canvas",
    "button:Help",
    "paragraph:Preferences",
    "button:Tool lock Q",
    "button:Toggle grid Cmd+'",
    "button:Snap to objects Option+S",
    "button:Zen mode Option+Z",
    "button:View mode Option+R",
    "combobox:Language",
    "text:Theme",
    "radio:Light mode - Shift+Option+D",
    "radio:Dark mode - Shift+Option+D",
    "radio:System mode",
    "text:Canvas background",
  ]);
  await expect(activeEditor(page).getByRole("link")).toHaveCount(0);

  await activeEditor(page)
    .getByRole("combobox", { name: "Language" })
    .selectOption("zh-CN");
  await expect(activeEditor(page).getByRole("combobox")).toHaveCount(0);
  await openCanvasMenu(page, "菜单");
  expect(await canvasMenuEntries(page, "菜单", "text:画布背景")).toEqual([
    "button:在画布上查找",
    "button:帮助",
    "paragraph:偏好设置",
    "button:工具锁定 Q",
    "button:切换网格 Cmd+'",
    "button:吸附至对象 Option+S",
    "button:禅模式 Option+Z",
    "button:查看模式 Option+R",
    "combobox:语言",
    "text:主题",
    "radio:浅色模式 - Shift+Option+D",
    "radio:深色模式 - Shift+Option+D",
    "radio:跟随系统",
    "text:画布背景",
  ]);
  await expect(activeEditor(page).getByRole("link")).toHaveCount(0);
});

const PREFERENCES: readonly CanvasPreference[] = [
  "toolLock",
  "grid",
  "snap",
  "zen",
  "viewMode",
];

for (const preference of PREFERENCES) {
  test(`keeps ${preference} consistent across canvas menu, shortcut, and native menu`, async ({
    page,
  }) => {
    const entry = PREFERENCE_ENTRIES[preference];
    await expectPreference(page, preference, false);

    await openCanvasMenu(page);
    await canvasMenuItem(page, entry.label).click();
    await expectPreference(page, preference, true);

    await focusCanvas(page);
    await page.keyboard.press(entry.shortcut);
    await expectPreference(page, preference, false);

    await emitNativeCommand(page, entry.nativeCommand);
    await expectPreference(page, preference, true);

    await emitNativeCommand(page, entry.nativeCommand);
    await expectPreference(page, preference, false);
    await closeCanvasMenu(page);
  });
}
