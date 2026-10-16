import { expect, test, type Locator, type Page } from "@playwright/test";
import { en } from "../../src/i18n/messages/en.ts";
import { zhCN } from "../../src/i18n/messages/zh-CN.ts";
import {
  emitBrowserTauriEvent,
  installBrowserTauriHarness,
  readHarnessDraft,
} from "./browserTauriHarness";
import { activeEditor, focusCanvas } from "./preferencesI18nMenu";
import {
  openWorkspaceSidebar,
  persistPinnedWorkspaceSidebar,
} from "./workspaceSidebar";

const LANGUAGE_KEY = "excalidraw-desktop.language";
const FIRST = "/virtual/first.excalidraw";
const SECOND = "/virtual/second.excalidraw";
const HISTORY_VERSIONS = Array.from({ length: 6 }, (_, sequence) => ({
  versionId: `v-${String(sequence).padStart(3, "0")}`,
  source: sequence === 1 ? "manual" : "automatic",
  recordedAt: Date.UTC(2025, 0, 1 + sequence, 12, 0) / 1_000,
  sequence,
  contentHash: `${String(sequence).padStart(3, "0")}${"0".repeat(61)}`,
  availability: { status: "available" },
}));
const RECOVERY_CANDIDATES = [
  {
    documentId: "recovery-1",
    originalPath: FIRST,
    displayName: "first.excalidraw",
    snapshotSavedAt: 1_710_000_000,
    coldFileMtime: 100,
    snapshotNewer: true,
  },
  {
    documentId: "recovery-2",
    originalPath: null,
    displayName: "untitled.excalidraw",
    snapshotSavedAt: 1_700_000_000,
    coldFileMtime: null,
    snapshotNewer: false,
  },
];

/**
 * Text that may truncate, each with the component rule that allows it. A
 * truncated element must use an ellipsis and keep its full text in an
 * accessible name or title.
 */
const TRUNCATION_ALLOWED: readonly { selector: string; rule: string }[] = [
  {
    selector: ".tab-title",
    rule: "HF-2 Tab: titles truncate with an ellipsis; the tab name and tooltip carry the full title",
  },
];

type Language = "en" | "zh-CN";
type Catalog = typeof en | typeof zhCN;
const CATALOGS: Readonly<Record<Language, Catalog>> = { en, "zh-CN": zhCN };

async function start(
  page: Page,
  language: Language,
  theme: "light" | "dark",
  options: { recovery?: boolean; workspace?: boolean } = {},
): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.emulateMedia({ colorScheme: theme });
  await installBrowserTauriHarness(
    page,
    FIRST,
    undefined,
    [FIRST, SECOND],
    undefined,
    true,
  );
  await page.addInitScript(
    ({ key, language, versions, recovery, candidates }) => {
      globalThis.localStorage.setItem(
        key,
        JSON.stringify({ version: 1, preference: language }),
      );
      type Invoke = (
        command: string,
        args?: Record<string, unknown>,
      ) => Promise<unknown>;
      const internals = (
        globalThis as typeof globalThis & {
          __TAURI_INTERNALS__?: { invoke: Invoke };
        }
      ).__TAURI_INTERNALS__;
      if (internals === undefined) throw new Error("Harness missing.");
      const invokeBase = internals.invoke.bind(internals);
      internals.invoke = async (command, args = {}) => {
        if (command === "history_list") {
          const document = args.document as { path?: unknown } | undefined;
          return {
            documentId: String(document?.path ?? ""),
            items: versions,
            listRevision: 1,
          };
        }
        if (recovery && command === "recovery_list") return candidates;
        const result = await invokeBase(command, args);
        if (recovery && command === "app_handshake") {
          return { ...(result as object), abnormalExit: true };
        }
        return result;
      };
    },
    {
      key: LANGUAGE_KEY,
      language,
      versions: HISTORY_VERSIONS,
      recovery: options.recovery === true,
      candidates: RECOVERY_CANDIDATES,
    },
  );
  if (options.workspace !== false) {
    await persistPinnedWorkspaceSidebar(page, ["workspace-1"], "workspace-1");
  }
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", language);
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    theme,
  );
}

interface LayoutReport {
  overflowing: string[];
  truncatedWithoutRule: string[];
  overlapping: string[];
  unnamed: string[];
}

/**
 * Check one app-owned surface: text fits (or truncates by an allowed rule),
 * interactive elements do not overlap, and each has an accessible name.
 */
async function expectLayout(root: Locator, surface: string): Promise<void> {
  await expect(root).toBeVisible();
  const report = await root.evaluate((element, allowed): LayoutReport => {
    const INTERACTIVE =
      "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=treeitem], [role=radio], [role=option], [role=menuitem], [role=checkbox], [role=switch], [role=combobox], [role=separator][tabindex]";
    const excluded = (node: Element) =>
      node.closest(".excalidraw-editor") !== null;
    const shown = (node: Element) => {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden")
        return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    };
    const describe = (node: Element) =>
      `${node.tagName.toLowerCase()}.${[...node.classList].join(".")} "${(node.textContent ?? "").trim().slice(0, 60)}"`;
    const accessibleName = (node: Element): string => {
      const labelledBy = node.getAttribute("aria-labelledby");
      if (labelledBy) {
        return labelledBy
          .split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
      }
      const label = node.getAttribute("aria-label");
      if (label?.trim()) return label.trim();
      if (
        node instanceof HTMLInputElement ||
        node instanceof HTMLSelectElement ||
        node instanceof HTMLTextAreaElement
      ) {
        const labels = [...(node.labels ?? [])]
          .map((item) => item.textContent ?? "")
          .join(" ")
          .trim();
        if (labels) return labels;
      }
      const text = (node.textContent ?? "").trim();
      if (text) return text;
      const alt = node.querySelector("img[alt]")?.getAttribute("alt");
      if (alt?.trim()) return alt.trim();
      return node.getAttribute("title")?.trim() ?? "";
    };

    // The visible part of a box: ancestors that clip overflow cut it.
    const visibleRect = (node: Element) => {
      let { left, top, right, bottom } = node.getBoundingClientRect();
      for (
        let parent = node.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        const style = getComputedStyle(parent);
        if (style.overflowX === "visible" && style.overflowY === "visible")
          continue;
        const clip = parent.getBoundingClientRect();
        left = Math.max(left, clip.left);
        top = Math.max(top, clip.top);
        right = Math.min(right, clip.right);
        bottom = Math.min(bottom, clip.bottom);
      }
      return { left, top, right, bottom };
    };

    const report: LayoutReport = {
      overflowing: [],
      truncatedWithoutRule: [],
      overlapping: [],
      unnamed: [],
    };
    for (const node of element.querySelectorAll("*")) {
      if (excluded(node) || !shown(node)) continue;
      const ownText = [...node.childNodes].some(
        (child) =>
          child.nodeType === Node.TEXT_NODE &&
          (child.textContent ?? "").trim() !== "",
      );
      if (!ownText || node.scrollWidth <= node.clientWidth + 1) continue;
      const rule = allowed.find((item) => node.matches(item.selector));
      if (rule === undefined) {
        report.overflowing.push(describe(node));
        continue;
      }
      const fullText = (node.textContent ?? "").trim();
      const carrier = node.closest("[aria-label], [title]");
      const carried =
        (carrier?.getAttribute("aria-label") ?? "").includes(fullText) ||
        (carrier?.getAttribute("title") ?? "").includes(fullText);
      if (getComputedStyle(node).textOverflow !== "ellipsis" || !carried) {
        report.truncatedWithoutRule.push(`${describe(node)} (${rule.rule})`);
      }
    }

    const interactive = [...element.querySelectorAll(INTERACTIVE)].filter(
      (node) => !excluded(node) && shown(node),
    );
    if (element.matches(INTERACTIVE) && shown(element)) {
      interactive.unshift(element);
    }
    for (const node of interactive) {
      if (accessibleName(node) === "") report.unnamed.push(describe(node));
    }
    for (let first = 0; first < interactive.length; first += 1) {
      for (let second = first + 1; second < interactive.length; second += 1) {
        const a = interactive[first];
        const b = interactive[second];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = visibleRect(a);
        const rb = visibleRect(b);
        const overlapX =
          Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const overlapY =
          Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (overlapX > 1 && overlapY > 1) {
          report.overlapping.push(`${describe(a)} × ${describe(b)}`);
        }
      }
    }
    return report;
  }, TRUNCATION_ALLOWED);
  expect(report, surface).toEqual({
    overflowing: [],
    truncatedWithoutRule: [],
    overlapping: [],
    unnamed: [],
  });
}

async function openDrawing(page: Page, catalog: Catalog, name: string) {
  await openWorkspaceSidebar(page, {
    files: catalog["shell.files"],
    toggle: catalog["shell.toggleSidebar"],
  });
  await page.getByRole("treeitem", { name }).click();
  await expect(
    page.getByRole("tab", { name: `${name}.excalidraw` }),
  ).toHaveAttribute("aria-selected", "true");
}

async function drawRectangle(page: Page): Promise<void> {
  await expect(activeEditor(page)).toBeVisible();
  let box: { x: number; y: number; width: number; height: number } | null =
    null;
  await expect
    .poll(async () => {
      box = await activeEditor(page).boundingBox();
      return box !== null && box.width > 0 && box.height > 0;
    })
    .toBe(true);
  if (box === null) throw new Error("The canvas was not measurable.");
  await focusCanvas(page);
  await page.keyboard.press("r");
  await page.mouse.move(box.x + 300, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 280, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await readHarnessDraft(page, FIRST)) ?? "")
    .toContain('"rectangle"');
}

for (const language of ["en", "zh-CN"] as const) {
  const catalog = CATALOGS[language];
  for (const theme of ["light", "dark"] as const) {
    test(`${language} ${theme}: shell surfaces fit at 1280×760`, async ({
      page,
    }) => {
      await start(page, language, theme);
      const sidebar = page.getByRole("complementary", {
        name: catalog["shell.files"],
      });
      await expectLayout(sidebar, "Workspace Sidebar");

      await openDrawing(page, catalog, "first");
      await openDrawing(page, catalog, "second");
      await expectLayout(
        page.getByRole("navigation", { name: catalog["tabs.openDrawings"] }),
        "TabBar",
      );
      await expectLayout(sidebar, "Workspace Sidebar with rows");

      await emitBrowserTauriEvent(page, "native-menu-command", {
        command: "exportImage",
      });
      const exportDialog = page.getByRole("dialog", {
        name: catalog["export.title"],
      });
      await expectLayout(exportDialog, "Export dialog");
      await page.keyboard.press("Escape");
      await expect(exportDialog).toHaveCount(0);

      await sidebar
        .getByRole("toolbar", { name: catalog["workspace.actionsLabel"] })
        .getByRole("button", { name: catalog["workspace.newDrawing"] })
        .click();
      const naming = page.getByRole("dialog", {
        name: catalog["entry.naming.newDrawing"],
      });
      await expectLayout(naming, "Entry naming dialog");
      await page.keyboard.press("Escape");
      await expect(naming).toHaveCount(0);

      await emitBrowserTauriEvent(page, "native-menu-command", {
        command: "versionHistory",
      });
      const history = page.getByRole("complementary", {
        name: catalog["history.panel.title"],
      });
      await expect(history.getByRole("option").first()).toBeVisible();
      await expectLayout(history, "History drawer 360");
      const resize = history.getByRole("separator", {
        name: catalog["history.panel.resizeLabel"],
      });
      await resize.focus();
      await page.keyboard.press("Home");
      await expect(resize).toHaveAttribute("aria-valuenow", "300");
      await expectLayout(history, "History drawer 300");
      await history
        .getByRole("button", { name: catalog["history.panel.closeLabel"] })
        .click();
      await expect(history).toHaveCount(0);

      await page.getByRole("tab", { name: "first.excalidraw" }).click();
      await drawRectangle(page);
      await emitBrowserTauriEvent(page, "file-changed", {
        path: FIRST,
        change: "modified",
        mtime: 200,
        contentHash: "external-1",
      });
      await expectLayout(
        page.getByRole("dialog", { name: catalog["conflict.title"] }),
        "Conflict dialog",
      );
    });

    test(`${language} ${theme}: Welcome fits at 1280×760`, async ({ page }) => {
      await start(page, language, theme, { workspace: false });
      await expectLayout(page.getByTestId("welcome-screen"), "Welcome");
    });

    test(`${language} ${theme}: recovery dialog fits at 1280×760`, async ({
      page,
    }) => {
      await start(page, language, theme, { recovery: true });
      await expectLayout(
        page.getByRole("dialog", { name: catalog["recovery.title"] }),
        "Recovery dialog",
      );
    });
  }
}
