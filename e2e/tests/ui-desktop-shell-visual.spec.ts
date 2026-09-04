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
    await prepare(page, getShellFixture("restored"), "light");
    await expect(page.locator(".canvas-empty-state")).toBeVisible();
    await expect(page.locator(".file-sidebar")).not.toBeVisible();
    await assertShellContract(page, { session: "restored", sidebar: "hidden" });
    await capture(page, testInfo, CAPTURE_NAMES.restoredHiddenLight);
    await compareCropStability(page.locator(".app-shell-tabs"), "header");
  });

  test("captures Workspace / Pinned / Light with exact shell geometry", async ({
    page,
  }, testInfo) => {
    await prepare(page, getShellFixture("pinned"), "light");
    await expect(page.locator(".file-sidebar")).toBeVisible();
    await expect(
      page.getByRole("treeitem", { name: "Design Workspace" }),
    ).toBeVisible();
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
    await assertShellContract(page, { session: "restored", sidebar: "pinned" });
    await assertGeometrySet(page, "pinned");
    await assertUnicodeFallback(page, getShellFixture("unicode-pinned"));
    await capture(page, testInfo, CAPTURE_NAMES.workspacePinnedDark);
    await compareCropStability(page.locator(".file-sidebar"), "sidebar-dark");
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
    const requestOrigin = new URL(request.url()).origin;
    const baseOrigin = new URL("http://127.0.0.1:1420/").origin;
    if (requestOrigin !== baseOrigin) {
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
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
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
  expect(
    assertPlatformFontPolicy({
      deviationId: "HF2-FONT-001",
      uiStack: fontPolicy.uiStack,
      monoStack: fontPolicy.monoStack,
      remoteFontRequests: remoteFontRequestsByPage.get(page) ?? 0,
      englishTargetVerified: fontPolicy.englishTargetVerified,
      unicodeFallbackVerified: fontPolicy.unicodeFallbackVerified,
    }).every(({ result }) => result === "PASS"),
  ).toBe(true);
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
    ["icon-hit-target", ".workspace-panel-actions .icon-button", 32],
    ["workspace-action-icon", ".workspace-panel-actions .icon-button img", 16],
    ["workspace-row", ".workspace-tree-row", 28],
  ] as const;
  for (const [name, selector, expected] of selectors) {
    const locator = page.locator(selector).first();
    await expect(locator).toBeVisible();
    const box = await readBox(locator);
    const value =
      name === "workspace-action-icon"
        ? box.width
        : name === "workspace-row"
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
      headerActionOverflow: count(
        ".workspace-panel-actions [aria-label*='overflow' i], .workspace-panel-actions [data-overflow]",
      ),
    };
  });
}

async function readFontPolicy(page: Page): Promise<{
  uiStack: string;
  monoStack: string;
  englishTargetVerified: boolean;
  unicodeFallbackVerified: boolean;
}> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const uiStack = root.style.getPropertyValue("--font-ui").trim();
    const monoStack = root.style.getPropertyValue("--font-mono").trim();
    return {
      uiStack,
      monoStack,
      englishTargetVerified:
        body.textContent?.includes("Welcome") === true ||
        body.textContent?.includes("Select a drawing") === true,
      unicodeFallbackVerified: !(body.textContent ?? "").includes("�"),
    };
  });
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
