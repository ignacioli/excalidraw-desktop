import { expect, test, type Page } from "@playwright/test";
import {
  emitBrowserTauriEvent,
  installBrowserTauriHarness,
} from "./browserTauriHarness";
import {
  openWorkspaceSidebar,
  persistPinnedWorkspaceSidebar,
} from "./workspaceSidebar";

const DOCUMENT_PATH = "/virtual/t048-drawing.excalidraw";
const HISTORY_VERSIONS = Array.from({ length: 100 }, (_, sequence) => ({
  versionId: `v-${String(sequence).padStart(3, "0")}`,
  source: sequence === 1 ? "manual" : "automatic",
  recordedAt: Date.UTC(2025, 0, 1 + sequence, 12, 0) / 1_000,
  sequence,
  contentHash: `${String(sequence).padStart(3, "0")}${"0".repeat(61)}`,
  availability: { status: "available" },
}));

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.emulateMedia({ colorScheme: "light" });
  await installBrowserTauriHarness(
    page,
    DOCUMENT_PATH,
    undefined,
    [DOCUMENT_PATH],
    undefined,
    true,
  );
  await installHistoryListFixture(page);
  await persistPinnedWorkspaceSidebar(page, ["workspace-1"], "workspace-1");
  await page.goto("/");
  await openWorkspaceSidebar(page);
  await page.getByRole("treeitem", { name: "t048-drawing" }).click();
  await expect(
    page.getByRole("tab", { name: "t048-drawing.excalidraw" }),
  ).toBeVisible();
  await emitBrowserTauriEvent(page, "native-menu-command", {
    command: "versionHistory",
  });
  await expect(historyPanel(page)).toBeVisible();
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`keeps the 360 px history drawer and fixed selection usable in ${colorScheme}`, async ({
    page,
  }) => {
    await useColorScheme(page, colorScheme);

    const panel = historyPanel(page);
    const rows = panel.getByRole("option");
    const list = panel.getByRole("listbox", { name: "Version history" });
    const selectedActions = panel.getByRole("region", {
      name: "Selected version actions",
    });
    const resizeHandle = panel.getByRole("separator", {
      name: "Resize version history panel",
    });

    await expect(page.locator("html")).toHaveAttribute(
      "data-color-scheme",
      colorScheme,
    );
    await expect(rows).toHaveCount(50);
    await expect(
      panel.getByRole("region", { name: "Current drawing" }),
    ).toBeVisible();
    await expect(panel.getByRole("option", { name: /Current/ })).toHaveCount(0);

    const panelGeometry = await panel.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom,
        backgroundColor: style.backgroundColor,
        borderColor: style.borderLeftColor,
      };
    });
    expect(panelGeometry.width).toBe(360);
    expect(panelGeometry.height).toBeGreaterThan(680);
    expect(panelGeometry.right).toBeLessThanOrEqual(1280);
    expect(panelGeometry.bottom).toBeLessThanOrEqual(760);
    expect(panelGeometry.backgroundColor).toBe(
      colorScheme === "light" ? "rgb(255, 255, 255)" : "rgb(35, 35, 41)",
    );
    expect(panelGeometry.borderColor).toBe(
      colorScheme === "light" ? "rgb(233, 236, 239)" : "rgb(54, 53, 65)",
    );
    await expect(resizeHandle).toHaveAttribute("aria-valuenow", "360");

    const approvedControls = await panel.evaluate((element) => {
      const mark = element.querySelector<HTMLButtonElement>(
        ".history-mark-current",
      );
      const restore = element.querySelector<HTMLButtonElement>(
        ".history-selection-actions .primary-action",
      );
      if (mark === null || restore === null)
        throw new Error("Approved History actions are missing.");
      const resolveTokenColor = (token: string) => {
        const probe = document.createElement("span");
        probe.style.color = `var(${token})`;
        element.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      return {
        markHeight: mark.getBoundingClientRect().height,
        markBorder: getComputedStyle(mark).borderTopColor,
        markBackground: getComputedStyle(mark).backgroundColor,
        restoreBackground: getComputedStyle(restore).backgroundColor,
        restoreText: getComputedStyle(restore).color,
        panelBackground: getComputedStyle(element).backgroundColor,
        accent: resolveTokenColor("--accent"),
        accentContrast: resolveTokenColor("--accent-contrast"),
        borderStrong: resolveTokenColor("--border-strong"),
      };
    });
    expect(approvedControls.markHeight).toBe(30);
    expect(approvedControls.markBorder).toBe(approvedControls.borderStrong);
    expect(approvedControls.markBackground).toBe(
      approvedControls.panelBackground,
    );
    expect(approvedControls.restoreBackground).toBe(approvedControls.accent);
    expect(approvedControls.restoreText).toBe(approvedControls.accentContrast);

    const listLayout = await list.evaluate((element) => {
      const body = element.closest<HTMLElement>(".history-panel-body");
      if (body === null) throw new Error("History list body is missing.");
      return {
        overflowY: getComputedStyle(body).overflowY,
        scrollHeight: body.scrollHeight,
        clientHeight: body.clientHeight,
      };
    });
    expect(listLayout.overflowY).toBe("auto");
    expect(listLayout.scrollHeight).toBeGreaterThan(listLayout.clientHeight);

    await expect(
      panel.getByRole("button", { name: /More actions for/ }).first(),
    ).toBeVisible();
    await expect(
      selectedActions.getByRole("button", { name: "Preview" }),
    ).toBeVisible();
    await expect(
      selectedActions.getByRole("button", { name: "Restore this version" }),
    ).toBeVisible();
    await expect(selectedActions).toContainText("v-000");

    await rows.last().scrollIntoViewIfNeeded();
    await expect(rows.last()).toBeInViewport();
    await expect(rows.first()).toHaveAttribute("aria-selected", "true");
    await expect(selectedActions).toContainText("v-000");
    await expect(
      selectedActions.getByRole("button", { name: "Preview" }),
    ).toBeVisible();
    await expect(
      selectedActions.getByRole("button", { name: "Restore this version" }),
    ).toBeVisible();
    await expect(selectedActions).toBeInViewport();
  });
}

test("resizes by drag and keyboard without changing the selected version", async ({
  page,
}) => {
  const panel = historyPanel(page);
  const separator = panel.getByRole("separator", {
    name: "Resize version history panel",
  });
  const selectedActions = panel.getByRole("region", {
    name: "Selected version actions",
  });
  await expect(selectedActions).toContainText("v-000");

  const separatorBox = await separator.boundingBox();
  if (separatorBox === null) throw new Error("Resize separator has no box.");
  const dragY = separatorBox.y + 80;
  await page.mouse.move(separatorBox.x + separatorBox.width / 2, dragY);
  await page.mouse.down();
  await page.mouse.move(separatorBox.x + separatorBox.width / 2 + 80, dragY);
  await page.mouse.up();
  await expect(separator).toHaveAttribute("aria-valuenow", "300");
  await expect(panel).toHaveCSS("width", "300px");
  await expect(selectedActions).toContainText("v-000");

  await separator.focus();
  await page.keyboard.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "300");
  await page.keyboard.press("End");
  await expect(separator).toHaveAttribute("aria-valuenow", "360");
  await page.keyboard.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "360");
  await page.keyboard.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "350");
  await expect(separator).toBeFocused();
  await expect(selectedActions).toContainText("v-000");
});

test("keeps the 360 px default drawer inside a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 760 });
  const panel = historyPanel(page);
  const rows = panel.getByRole("option");
  const geometry = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      width: rect.width,
      left: rect.left,
      right: rect.right,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  });

  await expect(rows).toHaveCount(50);
  expect(geometry.width).toBe(360);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(360);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  await expect(
    panel
      .getByRole("region", { name: "Selected version actions" })
      .getByRole("button", { name: "Restore this version" }),
  ).toBeVisible();

  const trigger = panel
    .getByRole("button", { name: /More actions for/ })
    .nth(49);
  await trigger.focus();
  await page.keyboard.press("Enter");

  const menu = panel.getByRole("menu", { name: "More version actions" });
  const menuBox = await menu.boundingBox();
  const panelBox = await panel.boundingBox();
  const scrollportBox = await panel
    .locator(".history-panel-body")
    .boundingBox();
  if (menuBox === null || panelBox === null || scrollportBox === null) {
    throw new Error("Compact row menu or panel has no layout box.");
  }
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("v-049");
  expect(menuBox.x).toBeGreaterThanOrEqual(panelBox.x);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(
    panelBox.x + panelBox.width,
  );
  expect(menuBox.y).toBeGreaterThanOrEqual(scrollportBox.y);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(
    scrollportBox.y + scrollportBox.height,
  );
  await expect(
    menu.getByRole("menuitem", { name: "Mark version" }),
  ).toBeFocused();

  await page.keyboard.press("End");
  await expect(
    menu.getByRole("menuitem", { name: "Delete version" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("honors reduced motion and keeps row focus visible with 50 versions", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });

  const panel = historyPanel(page);
  const rows = panel.getByRole("option");
  const row = rows.first();
  await expect(rows).toHaveCount(50);
  await row.focus();
  await page.keyboard.press("ArrowDown");
  const keyboardFocusedRow = rows.nth(1);
  await expect(keyboardFocusedRow).toBeFocused();

  const computed = await keyboardFocusedRow.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      transitionDuration: style.transitionDuration,
      animationDuration: style.animationDuration,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  expect(
    durationInMilliseconds(computed.transitionDuration),
  ).toBeLessThanOrEqual(0.01);
  expect(
    durationInMilliseconds(computed.animationDuration),
  ).toBeLessThanOrEqual(0.01);
  expect(computed.outlineStyle).toBe("solid");
  expect(computed.outlineWidth).toBe("2px");
});

function historyPanel(page: Page) {
  return page.getByRole("complementary", { name: "Version History" });
}

async function useColorScheme(
  page: Page,
  colorScheme: "light" | "dark",
): Promise<void> {
  await page.emulateMedia({ colorScheme });
  await expect(historyPanel(page)).toBeVisible();
}

async function installHistoryListFixture(page: Page): Promise<void> {
  await page.addInitScript((versions) => {
    type InvokeArgs = Record<string, unknown>;
    type Invoke = (command: string, args?: InvokeArgs) => Promise<unknown>;
    type HarnessWindow = Window & {
      __TAURI_INTERNALS__?: { invoke: Invoke };
    };
    const browser = globalThis as HarnessWindow;
    const internals = browser.__TAURI_INTERNALS__;
    if (internals === undefined) {
      throw new Error("Browser Tauri harness was not installed first.");
    }
    const invokeBase = internals.invoke.bind(internals);
    internals.invoke = async (command, args = {}) => {
      if (command !== "history_list") return invokeBase(command, args);
      const document = args.document as { path?: unknown } | undefined;
      return {
        documentId: String(document?.path ?? ""),
        items: versions.slice(0, Number(args.limit ?? 50)),
        listRevision: 1,
      };
    };
  }, HISTORY_VERSIONS);
}

function durationInMilliseconds(value: string): number {
  const numeric = Number.parseFloat(value);
  return value.endsWith("s") && !value.endsWith("ms")
    ? numeric * 1_000
    : numeric;
}
