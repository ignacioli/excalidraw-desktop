import { expect, test, type Page } from "@playwright/test";
import { en } from "../../src/i18n/messages/en.ts";
import { zhCN } from "../../src/i18n/messages/zh-CN.ts";
import {
  installBrowserTauriHarness,
  readHarnessDraft,
} from "./browserTauriHarness";
import {
  activeEditor,
  emitNativeCommand,
  focusCanvas,
  nativeMenuState,
  openCanvasMenu,
} from "./preferencesI18nMenu";
import {
  openWorkspaceSidebar,
  persistPinnedWorkspaceSidebar,
} from "./workspaceSidebar";

const LANGUAGE_KEY = "excalidraw-desktop.language";
const DRAWING = "/virtual/first.excalidraw";
const SECOND = "/virtual/second.excalidraw";
// The SDK's own Simplified Chinese toolbar and history labels.
const SDK_ZH = { rectangle: "矩形", undo: "撤销" };

type Catalog = typeof en | typeof zhCN;

async function startWithSystemLanguages(
  page: Page,
  preferredLanguages: readonly string[],
): Promise<void> {
  await installBrowserTauriHarness(
    page,
    DRAWING,
    undefined,
    [DRAWING, SECOND],
    undefined,
    true,
    preferredLanguages,
  );
  await page.goto("/");
  await page.evaluate(
    (key) => globalThis.localStorage.removeItem(key),
    LANGUAGE_KEY,
  );
  await page.reload();
}

async function openDrawing(page: Page, catalog: Catalog = en): Promise<void> {
  await persistPinnedWorkspaceSidebar(page, ["workspace-1"], "workspace-1");
  await page.reload();
  await openWorkspaceSidebar(page, {
    files: catalog["shell.files"],
    toggle: catalog["shell.toggleSidebar"],
  });
  await page.getByRole("treeitem", { name: "first" }).click();
  await expect(activeEditor(page)).toBeVisible();
}

async function expectShellLanguage(page: Page, catalog: Catalog) {
  await expect(
    page.getByRole("button", { name: catalog["shell.toggleSidebar"] }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: catalog["tabs.closeNamed"].replace("{title}", "first.excalidraw"),
    }),
  ).toBeAttached();
  await expect(
    page.getByRole("complementary", { name: catalog["shell.files"] }),
  ).toBeVisible();
}

async function expectNativeMenuLabels(page: Page, catalog: Catalog) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __browserTauriNativeMenuSync?: {
                labels?: Record<string, string>;
              };
            }
          ).__browserTauriNativeMenuSync?.labels?.["file.save"],
      ),
    )
    .toBe(catalog["menu.native.file.save"]);
}

async function liveElementCount(page: Page): Promise<number> {
  const draft = await readHarnessDraft(page, DRAWING);
  if (draft === null) return 0;
  const scene = JSON.parse(draft) as {
    elements?: { isDeleted?: boolean }[];
  };
  return (scene.elements ?? []).filter((element) => !element.isDeleted).length;
}

test("follows a Simplified Chinese system language on first launch", async ({
  page,
}) => {
  await startWithSystemLanguages(page, ["zh-Hans-US", "en-US"]);
  await expect(
    page
      .getByTestId("welcome-screen")
      .getByRole("button", { name: zhCN["welcome.newDrawing"], exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");

  await openDrawing(page, zhCN);
  await expectShellLanguage(page, zhCN);
  await expect(
    activeEditor(page).getByRole("radio", {
      name: new RegExp(SDK_ZH.rectangle),
    }),
  ).toBeAttached();
  await expect(
    activeEditor(page).getByRole("button", { name: SDK_ZH.undo, exact: true }),
  ).toBeAttached();
  await expectNativeMenuLabels(page, zhCN);
});

test("falls back to English for an unsupported system language", async ({
  page,
}) => {
  await startWithSystemLanguages(page, ["zh-Hant-TW"]);
  await expect(
    page
      .getByTestId("welcome-screen")
      .getByRole("button", { name: en["welcome.newDrawing"], exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await openDrawing(page);
  await expectShellLanguage(page, en);
  await expectNativeMenuLabels(page, en);
});

test("switches from the native menu, keeps editing state, and persists the choice", async ({
  page,
}) => {
  await startWithSystemLanguages(page, ["zh-Hans-US"]);
  await openDrawing(page, zhCN);
  await expectShellLanguage(page, zhCN);

  await emitNativeCommand(page, "languageEn");
  await expectShellLanguage(page, en);
  await expectNativeMenuLabels(page, en);
  await expect
    .poll(async () => (await nativeMenuState(page))?.language)
    .toBe("en");

  // Draw a rectangle and start editing a text element.
  const box = await activeEditor(page).boundingBox();
  if (box === null) throw new Error("The canvas was not measurable.");
  await focusCanvas(page);
  await page.keyboard.press("r");
  await page.mouse.move(box.x + 300, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 280, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => liveElementCount(page)).toBe(1);
  await page.keyboard.press("t");
  await page.mouse.click(box.x + 600, box.y + 300);
  const editor = activeEditor(page).locator("textarea");
  await expect(editor).toBeFocused();
  await page.keyboard.type("hello");

  for (let index = 0; index < 20; index += 1) {
    const [command, language] =
      index % 2 === 0
        ? (["languageZhCn", "zh-CN"] as const)
        : (["languageEn", "en"] as const);
    const startedAt = Date.now();
    await emitNativeCommand(page, command);
    await expect(page.locator("html")).toHaveAttribute("lang", language);
    await expect(
      page.getByRole("button", {
        name: (language === "en" ? en : zhCN)["shell.toggleSidebar"],
      }),
    ).toBeVisible();
    expect(Date.now() - startedAt).toBeLessThanOrEqual(1_000);
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("hello");
  }

  // Twenty switches end in English; commit the text, then undo it.
  await page.keyboard.press("Escape");
  await expect.poll(() => liveElementCount(page)).toBe(2);
  const undo = activeEditor(page).getByRole("button", {
    name: "Undo",
    exact: true,
  });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect.poll(() => liveElementCount(page)).toBe(1);

  // The manual choice survives a restart.
  await emitNativeCommand(page, "languageZhCn");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect
    .poll(async () => (await nativeMenuState(page))?.language)
    .toBe("zh-CN");
  await expect(
    page.getByRole("button", { name: zhCN["shell.toggleSidebar"] }),
  ).toBeVisible();
});

test("the canvas menu Language item shows the same preference as the native menu", async ({
  page,
}) => {
  await startWithSystemLanguages(page, ["en-US"]);
  await openDrawing(page);
  for (const [command, preference, menuName] of [
    ["languageZhCn", "zh-CN", "菜单"],
    ["languageSystem", "system", "Menu"],
    ["languageEn", "en", "Menu"],
  ] as const) {
    await emitNativeCommand(page, command);
    await expect
      .poll(async () => (await nativeMenuState(page))?.language)
      .toBe(preference);
    await openCanvasMenu(page, menuName);
    await expect(activeEditor(page).getByRole("combobox")).toHaveValue(
      preference,
    );
    await page.keyboard.press("Escape");
  }
});

// Proper nouns, fixture data, and shortcut notation allowed in Chinese UI.
const ALLOWED_LATIN = new Set([
  "Excalidraw",
  "Virtual",
  "Workspace",
  "first",
  "second",
  "excalidraw",
  "json",
  "Cmd",
  "Option",
  "Shift",
  "PNG",
  "SVG",
]);

test("leaves no English in app-owned UI under Simplified Chinese", async ({
  page,
}) => {
  await startWithSystemLanguages(page, ["zh-Hans"]);
  await openDrawing(page, zhCN);
  await expectShellLanguage(page, zhCN);

  const residue = await page.evaluate(() => {
    // The SDK editor container owns its own localization.
    const excluded = (element: Element) =>
      element.closest(".excalidraw-editor") !== null;
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    };
    const found: string[] = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      const text = node.textContent?.trim() ?? "";
      if (!parent || text === "" || excluded(parent) || !visible(parent))
        continue;
      found.push(text);
    }
    // Row tooltips show file paths, which are data rather than UI copy.
    const isPath = (value: string) => /^[/~]/u.test(value);
    for (const element of document.body.querySelectorAll(
      "[aria-label], [title], [alt], [placeholder]",
    )) {
      if (excluded(element)) continue;
      for (const name of ["aria-label", "title", "alt", "placeholder"]) {
        const value = element.getAttribute(name)?.trim();
        if (value && !isPath(value)) found.push(value);
      }
    }
    return found;
  });
  // The scan must actually reach app-owned copy.
  expect(residue).toContain(zhCN["shell.toggleSidebar"]);
  expect(residue).toContain("first.excalidraw");
  const english = residue.filter((text) =>
    (text.match(/[A-Za-z]{3,}/gu) ?? []).some(
      (word) => !ALLOWED_LATIN.has(word),
    ),
  );
  expect(english).toEqual([]);
});
