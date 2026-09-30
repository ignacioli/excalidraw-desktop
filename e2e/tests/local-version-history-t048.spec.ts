import { expect, test, type Page } from "@playwright/test";
import historyDesign from "../../docs/design/local-version-history/high-fi/t048/tokens.json" with { type: "json" };
import shellDesign from "../../docs/design/desktop-shell/hf-2/tokens.json" with { type: "json" };
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
      colorScheme === "light" ? "rgb(206, 212, 218)" : "rgb(92, 92, 92)",
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
      return {
        markHeight: mark.getBoundingClientRect().height,
        markBorder: getComputedStyle(mark).borderTopColor,
        markBackground: getComputedStyle(mark).backgroundColor,
        restoreBackground: getComputedStyle(restore).backgroundColor,
        restoreText: getComputedStyle(restore).color,
      };
    });
    expect(approvedControls.markHeight).toBe(
      historyDesign.components.markCurrentButton.height,
    );
    expect(approvedControls.markBorder).toBe(
      designColor(colorScheme, "color.border.strong"),
    );
    expect(approvedControls.markBackground).toBe(
      designColor(colorScheme, "color.panel.background"),
    );
    expect(approvedControls.restoreBackground).toBe(
      designColor(colorScheme, "color.accent.base"),
    );
    expect(approvedControls.restoreText).toBe(
      designColor(colorScheme, "color.accent.contrast"),
    );

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

test("matches approved History hierarchy and typography before native packaging", async ({
  page,
}, testInfo) => {
  await page.evaluate(() => document.fonts.ready);
  const actual = await historyPanel(page).evaluate((panel) => {
    const required = (selector: string) => {
      const element = panel.querySelector<HTMLElement>(selector);
      if (element === null)
        throw new Error(`Missing History design role: ${selector}`);
      return element;
    };
    const heading = required(".history-panel-header h1");
    const filename = required(".history-panel-file-name");
    const row = required(".history-list-row");
    const summary = required(".history-list-summary");
    const time = required(".history-list-row time");
    const current = required(".history-current-card");
    const target = required(".history-selection-title");
    const actions = [
      ...panel.querySelectorAll<HTMLElement>(
        ".history-selection-actions button",
      ),
    ];
    const policy = required(".history-retention-policy");
    const mark = required(".history-mark-current");
    const count = panel.querySelector<HTMLElement>(".history-version-count");
    return {
      redundantEyebrowCount: panel.querySelectorAll(".history-panel-eyebrow")
        .length,
      fontFamilies: getComputedStyle(heading)
        .fontFamily.split(",")
        .map((family) => family.trim().replaceAll('"', "")),
      headingSize: Number.parseFloat(getComputedStyle(heading).fontSize),
      headingWeight: Number(getComputedStyle(heading).fontWeight),
      filenameSize: Number.parseFloat(getComputedStyle(filename).fontSize),
      rowHeight: Math.round(row.getBoundingClientRect().height),
      rowRadius: Number.parseFloat(getComputedStyle(row).borderRadius),
      summarySize: Number.parseFloat(getComputedStyle(summary).fontSize),
      summaryWeight: Number(getComputedStyle(summary).fontWeight),
      summaryBeforeMetadata:
        summary.getBoundingClientRect().top < time.getBoundingClientRect().top,
      currentCardHeight: Math.round(current.getBoundingClientRect().height),
      targetWeight: Number(getComputedStyle(target).fontWeight),
      policyOutsideVisualFlow: policy.getBoundingClientRect().width <= 1,
      countAndMarkInline:
        count !== null &&
        Math.abs(
          count.getBoundingClientRect().top - mark.getBoundingClientRect().top,
        ) < 12,
      actionHeights: actions.map((button) =>
        Math.round(button.getBoundingClientRect().height),
      ),
      actionWidthRatio:
        actions.length === 2
          ? Math.round(
              (actions[0].getBoundingClientRect().width /
                actions[1].getBoundingClientRect().width) *
                100,
            ) / 100
          : null,
      fontsReady: document.fonts.status === "loaded",
    };
  });
  const expected = {
    redundantEyebrowCount: 0,
    fontFamilies: [
      "-apple-system",
      "BlinkMacSystemFont",
      "Segoe UI",
      "sans-serif",
    ],
    headingSize: shellDesign.primitives["font.size.section"].value,
    headingWeight: shellDesign.primitives["font.weight.semibold"].value,
    filenameSize: shellDesign.primitives["font.size.label"].value,
    rowHeight: historyDesign.components.selectedHistoryRow.height,
    rowRadius: historyDesign.components.selectedHistoryRow.radiusPx,
    summarySize: shellDesign.primitives["font.size.body"].value,
    summaryWeight: shellDesign.primitives["font.weight.semibold"].value,
    summaryBeforeMetadata: true,
    currentCardHeight: historyDesign.components.currentDrawingCard.height,
    targetWeight: shellDesign.primitives["font.weight.semibold"].value,
    policyOutsideVisualFlow: true,
    countAndMarkInline: true,
    actionHeights: [
      historyDesign.components.selectedVersionActions.height,
      historyDesign.components.selectedVersionActions.height,
    ],
    actionWidthRatio: Math.round((146 / 174) * 100) / 100,
    fontsReady: true,
  };
  await testInfo.attach("design-contract-comparison", {
    body: JSON.stringify({ actual, expected }, null, 2),
    contentType: "application/json",
  });
  expect(actual).toEqual(expected);
});

test("keeps populated History geometry stable through both Mark paths", async ({
  page,
}, testInfo) => {
  const panel = historyPanel(page);
  await expect(panel.getByRole("option")).toHaveCount(50);
  await page.evaluate(() => {
    type ProbeWindow = typeof globalThis & {
      __TAURI_INTERNALS__: {
        invoke: (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
      __markGeometry: {
        calls: string[];
        scrolls: number;
        samples: number[][];
        done: boolean;
      };
    };
    const browser = globalThis as ProbeWindow;
    const invoke = browser.__TAURI_INTERNALS__.invoke.bind(
      browser.__TAURI_INTERNALS__,
    );
    browser.__markGeometry = {
      calls: [],
      scrolls: 0,
      samples: [],
      done: false,
    };
    let marked = false;
    browser.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command.startsWith("history_"))
        browser.__markGeometry.calls.push(command);
      if (command === "history_mark" || command === "history_set_marked") {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const request = args.request as { marked?: boolean } | undefined;
        marked = command === "history_mark" || request?.marked === true;
        return command === "history_mark"
          ? {
              versionId: "v-000",
              recordedAt: 1,
              source: "manual",
              contentHash: "0".repeat(64),
              reused: true,
            }
          : { versionId: "v-000", marked, retained: true };
      }
      if (command === "history_list") {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const response = (await invoke(command, args)) as {
          items: Array<{ versionId: string }>;
        };
        return {
          ...response,
          items: response.items.map((item) =>
            item.versionId === "v-000" ? { ...item, marked } : item,
          ),
        };
      }
      return invoke(command, args);
    };
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (...args) {
      browser.__markGeometry.scrolls += 1;
      return scrollIntoView.apply(this, args);
    };
  });

  const observations = [];
  for (const action of ["current", "current", "row"] as const) {
    await panel.locator(".history-panel-body").evaluate((element) => {
      element.scrollTop = 0;
    });
    if (action === "row") {
      await panel
        .getByRole("button", { name: /More actions for v-000/ })
        .click();
    }
    await page.evaluate(() => {
      const browser = globalThis as typeof globalThis & {
        __markGeometry: {
          calls: string[];
          scrolls: number;
          samples: number[][];
          done: boolean;
        };
      };
      const probe = browser.__markGeometry;
      probe.calls = [];
      probe.scrolls = 0;
      probe.samples = [];
      probe.done = false;
      const body = document.querySelector<HTMLElement>(".history-panel-body")!;
      const button = document.querySelector<HTMLElement>(
        ".history-mark-current",
      )!;
      const row = document.querySelector<HTMLElement>(".history-list-row")!;
      const started = performance.now();
      const sample = () => {
        probe.samples.push([
          Math.round(performance.now() - started),
          body.scrollTop,
          button.getBoundingClientRect().top,
          row.getBoundingClientRect().top,
          body.clientHeight,
          body.scrollHeight,
        ]);
        if (performance.now() - started < 1200) requestAnimationFrame(sample);
        else probe.done = true;
      };
      sample();
    });
    if (action === "current") {
      await panel
        .getByRole("button", { name: "Mark current version", exact: true })
        .click();
    } else {
      await panel
        .getByRole("menuitem", { name: /^(Mark|Unmark) version$/ })
        .click();
    }
    await page.waitForFunction(
      () =>
        (
          globalThis as typeof globalThis & {
            __markGeometry: { done: boolean };
          }
        ).__markGeometry.done,
    );
    const observation = await page.evaluate(() => {
      const probe = (
        globalThis as typeof globalThis & {
          __markGeometry: {
            calls: string[];
            scrolls: number;
            samples: number[][];
          };
        }
      ).__markGeometry;
      return {
        ...probe,
        samples: probe.samples.filter(
          (sample, index, all) =>
            index === 0 ||
            sample
              .slice(1)
              .some((value, column) => value !== all[index - 1][column + 1]),
        ),
      };
    });
    observations.push({ action, ...observation });
    expect(observation.calls).toEqual([
      action === "current" ? "history_mark" : "history_set_marked",
      "history_list",
    ]);
    expect(observation.scrolls).toBeLessThanOrEqual(1);
    for (const column of [1, 2, 3]) {
      const values = observation.samples.map((sample) => sample[column]);
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
    }
  }
  console.log("MARK_GEOMETRY", JSON.stringify(observations));
  await testInfo.attach("mark-geometry", {
    body: JSON.stringify(observations, null, 2),
    contentType: "application/json",
  });
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

function designColor(
  scheme: "light" | "dark",
  token: keyof typeof shellDesign.semantics.light,
): string {
  const hex = shellDesign.semantics[scheme][token].value.slice(1);
  return `rgb(${[0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)).join(", ")})`;
}

function durationInMilliseconds(value: string): number {
  const numeric = Number.parseFloat(value);
  return value.endsWith("s") && !value.endsWith("ms")
    ? numeric * 1_000
    : numeric;
}
