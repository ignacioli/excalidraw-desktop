import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  SHELL_PREFERENCES_STORAGE_KEY,
  SHELL_PREFERENCES_VERSION,
} from "../../src/app/shellPreferences";
import {
  getShellFixture,
  UNICODE_WORKSPACE,
  type ShellFixture,
} from "../fixtures/003-shell-fixtures";
import {
  COMPONENT_CROP_THRESHOLD,
  SDK_BOUNDARY_SELECTOR,
  SHELL_VISUAL_SELECTORS,
  VISUAL_VIEWPORT,
  assertComponentCropDiff,
  assertComponentCropWithinViewport,
  assertGeometry,
  assertLegacyCounts,
  assertNoPrivateSdkSelectors,
  assertPlatformFontPolicy,
} from "../visual/003ShellAssertions";
import { LEGACY_CHECK_IDS } from "../visual/003Evidence";
import { installUiInteractionHarness } from "./uiInteractionHarness";

const GEOMETRY_TOLERANCE_PX = 2;
const CAPTURE_NAMES = {
  welcomeLight: "welcome-light",
  restoredHiddenLight: "restored-hidden-light",
  workspacePinnedLight: "workspace-pinned-light",
  workspaceOverlayLight: "workspace-overlay-light",
  welcomeDark: "welcome-dark",
  workspacePinnedDark: "workspace-pinned-dark",
} as const;

type Box = { x: number; y: number; width: number; height: number };
type ComputedTypography = {
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
};
const remoteFontRequestsByPage = new WeakMap<Page, number>();

test.describe("003 shell visual harness", () => {
  test("captures Welcome / Light at the fixed 1280x760 viewport", async ({
    page,
  }, testInfo) => {
    await prepare(page, getShellFixture("empty"), "light");
    await expect(page.getByTestId("welcome-screen")).toBeVisible();
    await assertShellContract(page, { session: "empty", sidebar: "hidden" });
    await capture(page, testInfo, CAPTURE_NAMES.welcomeLight);
    await compareCropStability(page.locator(".welcome-screen"), "welcome");
  });

  test("captures Restored / Hidden / Light without old top-level commands", async ({
    page,
  }, testInfo) => {
    const fixture = getShellFixture("restored");
    await prepare(page, fixture, "light");
    await assertRestoredFixture(page, fixture);
    await expect(page.locator(".file-sidebar")).not.toBeVisible();
    await assertShellContract(page, { session: "restored", sidebar: "hidden" });
    await capture(page, testInfo, CAPTURE_NAMES.restoredHiddenLight);
    await compareCropStability(page.locator(".app-shell-tabs"), "header");
  });

  test("captures Workspace / Pinned / Light with exact shell geometry", async ({
    page,
  }, testInfo) => {
    const fixture = getShellFixture("pinned");
    await prepare(page, fixture, "light");
    await expect(page.locator(".file-sidebar")).toBeVisible();
    await expect(
      page.getByRole("treeitem", { name: "Design Workspace" }),
    ).toBeVisible();
    await assertRestoredFixture(page, fixture);
    await assertPinnedWorkspaceHeader(page);
    await assertDefaultWorkspaceRowState(page);
    await assertShellContract(page, { session: "restored", sidebar: "pinned" });
    await assertGeometrySet(page, "pinned");
    await capture(page, testInfo, CAPTURE_NAMES.workspacePinnedLight);
    await compareCropStability(page.locator(".file-sidebar"), "sidebar");
  });

  test("captures Workspace / Overlay / Light without changing the canvas box", async ({
    page,
  }, testInfo) => {
    await prepare(page, getShellFixture("overlay"), "light");
    await page
      .getByRole("button", { name: "Toggle workspace sidebar" })
      .click();
    await expect(page.locator(".file-sidebar")).toBeVisible();
    await assertShellContract(page, {
      session: "restored",
      sidebar: "overlay",
    });
    const canvas = page.locator(".canvas-region");
    const before = await readBox(canvas);
    await page
      .getByRole("button", { name: "Toggle workspace sidebar" })
      .click();
    await expect(page.locator(".file-sidebar")).not.toBeVisible();
    const after = await readBox(canvas);
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(
      GEOMETRY_TOLERANCE_PX,
    );
    await page
      .getByRole("button", { name: "Toggle workspace sidebar" })
      .click();
    await expect(page.locator(".file-sidebar")).toBeVisible();
    await capture(page, testInfo, CAPTURE_NAMES.workspaceOverlayLight);
    await compareCropStability(
      page.locator(".file-sidebar"),
      "overlay-sidebar",
    );
  });

  test("captures Welcome / Dark with the same shell geometry", async ({
    page,
  }, testInfo) => {
    await prepare(page, getShellFixture("empty"), "dark");
    await expect(page.getByTestId("welcome-screen")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-scheme",
      "dark",
    );
    await assertShellContract(page, { session: "empty", sidebar: "hidden" });
    await capture(page, testInfo, CAPTURE_NAMES.welcomeDark);
    await compareCropStability(page.locator(".welcome-screen"), "welcome-dark");
  });

  test("captures Workspace / Pinned / Dark and Unicode fallback text", async ({
    page,
  }, testInfo) => {
    await prepare(page, getShellFixture("unicode-pinned"), "dark");
    await expect(page.locator(".file-sidebar")).toBeVisible();
    await expect(
      page.getByRole("treeitem", { name: UNICODE_WORKSPACE.name }),
    ).toBeVisible();
    await expect(page.getByRole("treeitem", { name: "流程" })).toBeVisible();
    await assertRestoredFixture(page, getShellFixture("unicode-pinned"));
    await assertShellContract(page, { session: "restored", sidebar: "pinned" });
    await assertGeometrySet(page, "pinned");
    await assertUnicodeFallback(page, getShellFixture("unicode-pinned"));
    await capture(page, testInfo, CAPTURE_NAMES.workspacePinnedDark);
    await compareCropStability(page.locator(".file-sidebar"), "sidebar-dark");
  });

  test("records computed HF2-FONT-001 styles while externally offline", async ({
    page,
    context,
  }, testInfo) => {
    const fixture = getShellFixture("unicode-pinned");
    await prepare(page, fixture, "dark");
    await context.setOffline(true);
    try {
      const fontPolicy = await readFontPolicy(page);
      const offline = await page.evaluate(() => navigator.onLine === false);
      expect(offline).toBe(true);
      expect(documentFontsLoaded(fontPolicy)).toBe(true);
      expect(remoteFontRequestsByPage.get(page) ?? 0).toBe(0);
      expect(fontPolicy.computedUiFamily).not.toMatch(/\bInter\b/iu);
      expect(fontPolicy.computedMonoFamily).not.toMatch(/IBM Plex Mono/iu);
      expect(fontPolicy.styles).toMatchObject({
        body: { fontSize: "14px", fontWeight: "400", lineHeight: "19.6px" },
        header: { fontSize: "20px", fontWeight: "600", lineHeight: "28px" },
        tab: { fontSize: "14px", fontWeight: "400", lineHeight: "19.6px" },
        workspaceRow: {
          fontSize: "14px",
          fontWeight: "400",
          lineHeight: "28px",
        },
      });
      await assertUnicodeFallback(page, fixture);
      const evidence = {
        fixture: fixture.id,
        offline,
        remoteFontRequests: remoteFontRequestsByPage.get(page) ?? 0,
        ...fontPolicy,
      };
      if (process.env.PHASE2_PRINT_FONT_EVIDENCE === "1") {
        console.info(`PHASE2_FONT_EVIDENCE=${JSON.stringify(evidence)}`);
      }
      await testInfo.attach("phase2-font-policy.json", {
        body: Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
        contentType: "application/json",
      });
    } finally {
      await context.setOffline(false);
    }
  });

  test("proves the visual harness has no private SDK selector dependency", async ({
    page,
  }) => {
    await prepare(page, getShellFixture("empty"), "light");
    await page.getByRole("button", { name: "New Drawing" }).click();
    await expect(page.locator(SDK_BOUNDARY_SELECTOR)).toHaveCount(1);
    expect(assertNoPrivateSdkSelectors(SHELL_VISUAL_SELECTORS)).toMatchObject({
      result: "PASS",
    });
    expect(
      assertNoPrivateSdkSelectors([".excalidraw-editor .App-menu__items"]),
    ).toMatchObject({ result: "FAIL" });
  });
});

async function prepare(
  page: Page,
  fixture: ShellFixture,
  colorScheme: "light" | "dark",
): Promise<void> {
  await page.setViewportSize(VISUAL_VIEWPORT);
  await page.emulateMedia({ colorScheme });
  remoteFontRequestsByPage.set(page, 0);
  page.on("request", (request) => {
    if (request.resourceType() !== "font") return;
    const requestHost = new URL(request.url()).hostname;
    if (requestHost !== "127.0.0.1" && requestHost !== "localhost") {
      remoteFontRequestsByPage.set(
        page,
        (remoteFontRequestsByPage.get(page) ?? 0) + 1,
      );
    }
  });
  await installUiInteractionHarness(page, {
    workspaces: fixture.workspaces,
    entries: fixture.entries,
    startup: { nativeWindowRuntime: true },
  });
  await page.addInitScript(
    ({ key, version, currentWorkspaceId, sidebarPinned }) => {
      localStorage.setItem(
        key,
        JSON.stringify({
          version,
          sidebarPinned,
          expandedWorkspaceIds:
            currentWorkspaceId === null ? [] : [currentWorkspaceId],
          currentWorkspaceId,
        }),
      );
    },
    {
      key: SHELL_PREFERENCES_STORAGE_KEY,
      version: SHELL_PREFERENCES_VERSION,
      currentWorkspaceId: fixture.currentWorkspaceId,
      sidebarPinned: fixture.sidebar === "pinned",
    },
  );
  await page.goto("/");
  await openFixtureDocuments(page, fixture);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

async function openFixtureDocuments(
  page: Page,
  fixture: ShellFixture,
): Promise<void> {
  if (fixture.tabs.length === 0) return;
  const sidebar = page.locator(".file-sidebar");
  const startedVisible = await sidebar.isVisible();
  if (!startedVisible) {
    await page
      .getByRole("button", { name: "Toggle workspace sidebar" })
      .click();
    await expect(sidebar).toBeVisible();
  }
  for (const tab of fixture.tabs) {
    if (tab.path === null) {
      throw new Error(
        `Fixture ${fixture.id} needs a persisted path for visual restore.`,
      );
    }
    const entry = fixture.entries.find(
      ({ canonicalPath }) => canonicalPath === tab.path,
    );
    if (entry === undefined) {
      throw new Error(
        `Fixture ${fixture.id} is missing the entry for ${tab.path}.`,
      );
    }
    const parentDirectories = fixture.entries
      .filter(
        (candidate) =>
          candidate.kind === "directory" &&
          entry.relativePath.startsWith(`${candidate.relativePath}/`),
      )
      .sort(
        (left, right) =>
          left.relativePath.split("/").length -
          right.relativePath.split("/").length,
      );
    for (const directory of parentDirectories) {
      const directoryRow = page.getByRole("treeitem", {
        name: directory.displayName,
      });
      await expect(directoryRow).toBeVisible();
      if ((await directoryRow.getAttribute("aria-expanded")) !== "true") {
        await directoryRow.click();
      }
    }
    await page.getByRole("treeitem", { name: entry.displayName }).click();
    await expect(
      page.getByRole("tab", { name: new RegExp(tab.title) }),
    ).toBeVisible();
  }
  if (!startedVisible) {
    await page
      .getByRole("button", { name: "Toggle workspace sidebar" })
      .click();
    await expect(sidebar).not.toBeVisible();
  }
  if (fixture.sidebar === "pinned") {
    const libraryButton = page.getByRole("checkbox", {
      name: "Library",
      exact: true,
    });
    await expect(libraryButton).toBeVisible();
    // This public checkbox is visually wrapped by the SDK trigger. Force is
    // limited to deterministic fixture setup; acceptance never inspects SDK DOM.
    await libraryButton.check({ force: true });
    await expect(libraryButton).toBeChecked();
  }
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.mouse.move(VISUAL_VIEWPORT.width - 8, VISUAL_VIEWPORT.height - 8);
}

async function assertRestoredFixture(
  page: Page,
  fixture: ShellFixture,
): Promise<void> {
  const activeTab = fixture.tabs.find(
    ({ documentId }) => documentId === fixture.activeDocumentId,
  );
  expect(
    activeTab,
    "restored fixture must declare an active tab",
  ).toBeDefined();
  await expect(page.locator(".canvas-empty-state")).toHaveCount(0);
  await expect(
    page
      .getByRole("tab", { name: new RegExp(activeTab?.title ?? "") })
      .filter({ has: page.locator(".tab-title") }),
  ).toHaveCount(1);
  if (activeTab?.saveState === "clean") {
    await expect(
      page.getByRole("tab", {
        name: new RegExp(`${activeTab.title}(?!.*unsaved changes)`, "i"),
      }),
    ).toBeVisible();
    await expect(page.locator(".dirty-indicator")).toHaveCount(0);
  }
  await expect(page.locator(SDK_BOUNDARY_SELECTOR)).toBeVisible();
}

async function assertShellContract(
  page: Page,
  expected: {
    session: "empty" | "restored";
    sidebar: "hidden" | "overlay" | "pinned";
  },
): Promise<void> {
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  expect(viewport).toEqual(VISUAL_VIEWPORT);
  await expect(page.locator(".app-shell-body")).toHaveAttribute(
    "data-sidebar-mode",
    expected.sidebar,
  );
  const fontPolicy = await readFontPolicy(page);
  const fontAssertions = assertPlatformFontPolicy({
    deviationId: "HF2-FONT-001",
    uiStack: fontPolicy.uiStack,
    monoStack: fontPolicy.monoStack,
    remoteFontRequests: remoteFontRequestsByPage.get(page) ?? 0,
    englishTargetVerified: fontPolicy.englishTargetVerified,
    unicodeFallbackVerified: fontPolicy.unicodeFallbackVerified,
  });
  expect(fontPolicy.computedUiFamily).not.toMatch(/\bInter\b/iu);
  expect(fontAssertions.filter(({ result }) => result === "FAIL")).toEqual([]);
  const counts = await readLegacyCounts(page);
  expect(
    assertLegacyCounts(counts).every(({ result }) => result === "PASS"),
  ).toBe(true);
  if (expected.session === "empty") {
    await expect(page.getByTestId("welcome-screen")).toBeVisible();
  } else {
    await expect(page.locator(".welcome-screen")).toHaveCount(0);
  }
}

async function assertGeometrySet(page: Page, state: "pinned"): Promise<void> {
  const selectors = [
    ["top-layer", ".app-shell-tabs", 44, "height"],
    ["workspace-sidebar", ".file-sidebar", 360, "width"],
    ["icon-hit-target", ".workspace-panel-actions .icon-button", 32],
    ["workspace-action-icon", ".workspace-panel-actions .icon-button img", 16],
    ["workspace-row", ".workspace-tree-row", 28],
    ["tab-width", ".tab-cluster", 196, "width"],
    ["tab-height", ".tab-cluster", 36, "height"],
  ] as const;
  for (const [name, selector, expected, dimension] of selectors) {
    const locator = page.locator(selector).first();
    await expect(locator).toBeVisible();
    const box = await readBox(locator);
    const value =
      dimension === "height" || name === "workspace-row"
        ? box.height
        : box.width;
    expect(
      assertGeometry({
        name: `${state}.${name}`,
        expected,
        actual: value,
        tolerance: GEOMETRY_TOLERANCE_PX,
      }),
    ).toMatchObject({ result: "PASS" });
  }
  const sidebarBox = await readBox(page.locator(".file-sidebar"));
  const canvasBox = await readBox(page.locator(".canvas-region"));
  const editorBox = await readBox(page.locator(SDK_BOUNDARY_SELECTOR));
  expect(
    Math.abs(sidebarBox.x + sidebarBox.width - canvasBox.x),
  ).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX);
  expect(editorBox.x).toBeGreaterThanOrEqual(canvasBox.x);
  expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(
    canvasBox.x + canvasBox.width + GEOMETRY_TOLERANCE_PX,
  );
}

async function assertPinnedWorkspaceHeader(page: Page): Promise<void> {
  const toolbar = page.getByRole("toolbar", { name: "Workspace actions" });
  await expect(toolbar.getByRole("button")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Mount folder…" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Unpin workspace sidebar" }),
  ).toHaveCount(0);
  const titleMetrics = await page
    .locator(".workspace-panel-title-row h2")
    .evaluate((title) => {
      const style = getComputedStyle(title);
      return {
        clientHeight: title.clientHeight,
        scrollHeight: title.scrollHeight,
        whiteSpace: style.whiteSpace,
      };
    });
  expect(titleMetrics.scrollHeight).toBeLessThanOrEqual(
    titleMetrics.clientHeight,
  );
  expect(titleMetrics.whiteSpace).toBe("nowrap");
}

async function assertDefaultWorkspaceRowState(page: Page): Promise<void> {
  await expect(page.locator(".workspace-tree")).not.toBeFocused();
  await expect(page.locator(".workspace-tree-action").first()).toBeHidden();
}

async function assertUnicodeFallback(
  page: Page,
  fixture: ShellFixture,
): Promise<void> {
  const result = await page.evaluate((rootPath) => {
    const bodyText = document.body.textContent ?? "";
    const visibleLabels = [
      ...document.querySelectorAll<HTMLElement>(".workspace-tree-label"),
    ]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      })
      .map((element) => element.textContent ?? "");
    return {
      rootPath,
      hasReplacementGlyph: bodyText.includes("�"),
      visibleLabels,
    };
  }, fixture.workspaces[0]?.rootPath ?? "");
  expect(result.rootPath).toContain("设计");
  expect(result.hasReplacementGlyph).toBe(false);
  expect(result.visibleLabels).toEqual(
    expect.arrayContaining([UNICODE_WORKSPACE.name, "流程"]),
  );
}

async function readLegacyCounts(
  page: Page,
): Promise<Record<(typeof LEGACY_CHECK_IDS)[number], number>> {
  return page.evaluate(() => {
    const visible = (element: Element): boolean => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        box.width > 0 &&
        box.height > 0
      );
    };
    const visibleText = (selector: string, pattern: RegExp): number =>
      [...document.querySelectorAll(selector)].filter(
        (element) =>
          visible(element) && pattern.test(element.textContent?.trim() ?? ""),
      ).length;
    const count = (selector: string): number =>
      [...document.querySelectorAll(selector)].filter(visible).length;
    const workspaceRoots = count('.workspace-tree-row[data-kind="workspace"]');
    return {
      globalNewDrawing: visibleText(
        ".workspace-empty-state button",
        /^New drawing$/u,
      ),
      textSidebar: visibleText("button", /^Workspace sidebar$/u),
      largePinUnpin: visibleText(
        "button",
        /^(?:Pin|Unpin) workspace sidebar$/u,
      ),
      topLevelSaveExportAppearance: visibleText(
        ".app-commands button, .app-commands fieldset",
        /^(?:Save|Export(?:…| \.{3})?|Appearance)$/u,
      ),
      autosaveStrip: count(".save-status:not(.visually-hidden)"),
      tabScrollbar: count(".tab-scrollbar, [data-legacy-scrollbar='tabs']"),
      sidebarScrollbar: count(
        ".sidebar-scrollbar, [data-legacy-scrollbar='sidebar']",
      ),
      placeholderIcons: count(
        "[data-placeholder-icon], [data-slot='placeholder-icon']",
      ),
      horizontalEllipsis: visibleText("button", /⋯/u),
      duplicateWorkspaceRoots: Math.max(0, workspaceRoots - 1),
      headerActionOverflow:
        count(
          ".workspace-panel-actions [aria-label*='overflow' i], .workspace-panel-actions [data-overflow]",
        ) +
        [
          ...document.querySelectorAll<HTMLElement>(
            ".workspace-panel-title-row",
          ),
        ].filter((row) => {
          const title = row.querySelector<HTMLElement>("h2");
          const actions = row.querySelector<HTMLElement>(
            ".workspace-panel-actions",
          );
          if (title === null || actions === null || !visible(row)) return false;
          const rowBox = row.getBoundingClientRect();
          const actionsBox = actions.getBoundingClientRect();
          return (
            title.scrollHeight > title.clientHeight ||
            actionsBox.right > rowBox.right + 0.5 ||
            actions.scrollWidth > actions.clientWidth
          );
        }).length,
    };
  });
}

async function readFontPolicy(page: Page): Promise<{
  uiStack: string;
  monoStack: string;
  computedUiFamily: string;
  computedMonoFamily: string;
  fontStatus: FontFaceSetLoadStatus;
  styles: {
    body: ComputedTypography;
    header: ComputedTypography;
    tab: ComputedTypography;
    workspaceRow: ComputedTypography;
  };
  englishTargetVerified: boolean;
  unicodeFallbackVerified: boolean;
}> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const uiStack = root.style.getPropertyValue("--font-ui").trim();
    const monoStack = root.style.getPropertyValue("--font-mono").trim();
    const uiTargets = [
      ...document.querySelectorAll<HTMLElement>(
        ".workspace-panel-eyebrow, .workspace-panel-title-row h2, .welcome-content h1, .tab-title",
      ),
    ];
    const uiTarget =
      uiTargets.find((element) =>
        /[A-Za-z]/u.test(element.textContent ?? ""),
      ) ??
      uiTargets[0] ??
      null;
    const computedUiFamily =
      uiTarget === null ? "" : getComputedStyle(uiTarget).fontFamily;
    const uiTargetText = uiTarget?.textContent?.trim() ?? "";
    const monoProbe = document.createElement("span");
    monoProbe.textContent = "font-policy-probe";
    monoProbe.style.position = "fixed";
    monoProbe.style.visibility = "hidden";
    monoProbe.style.fontFamily = "var(--font-mono)";
    body.append(monoProbe);
    const computedMonoFamily = getComputedStyle(monoProbe).fontFamily;
    monoProbe.remove();
    const typography = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) {
        return { fontFamily: "", fontSize: "", fontWeight: "", lineHeight: "" };
      }
      const style = getComputedStyle(element);
      return {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
      };
    };
    const normalizeFamily = (value: string) =>
      value.replace(/[\s"']/gu, "").toLowerCase();
    const normalizedComputedUi = normalizeFamily(computedUiFamily);
    const computedUiUsesApprovedNativeStack =
      normalizedComputedUi === normalizeFamily(uiStack) ||
      (normalizedComputedUi.includes("-apple-system") &&
        normalizedComputedUi.includes("system-ui") &&
        normalizedComputedUi.includes("segoeui") &&
        normalizedComputedUi.includes("sans-serif"));
    return {
      uiStack,
      monoStack,
      computedUiFamily,
      computedMonoFamily,
      fontStatus: document.fonts.status,
      styles: {
        body: typography("body"),
        header: typography(".workspace-panel-title-row h2"),
        tab: typography(".tab-title"),
        workspaceRow: typography(".workspace-tree-row"),
      },
      englishTargetVerified:
        /[A-Za-z]/u.test(uiTargetText) && computedUiUsesApprovedNativeStack,
      unicodeFallbackVerified: !(body.textContent ?? "").includes("�"),
    };
  });
}

function documentFontsLoaded(value: {
  fontStatus: FontFaceSetLoadStatus;
}): boolean {
  return value.fontStatus === "loaded";
}

async function readBox(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("Expected a measurable shell component.");
  return box;
}

async function capture(
  page: Page,
  testInfo: { outputPath(path: string): string },
  name: string,
): Promise<void> {
  const outputPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: outputPath, animations: "disabled" });
  const size = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  expect(size).toEqual(VISUAL_VIEWPORT);
}

async function compareCropStability(
  locator: Locator,
  name: string,
): Promise<void> {
  const box = await readBox(locator);
  expect(
    assertComponentCropWithinViewport(name, box, VISUAL_VIEWPORT),
  ).toMatchObject({ result: "PASS" });
  const first = await locator.screenshot({ animations: "disabled" });
  const second = await locator.screenshot({ animations: "disabled" });
  expect(Buffer.compare(first, second)).toBe(0);
  expect(
    assertComponentCropDiff(name, 0, COMPONENT_CROP_THRESHOLD),
  ).toMatchObject({ result: "PASS" });
}
