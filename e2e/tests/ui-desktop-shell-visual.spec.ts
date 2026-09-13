import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  SHELL_PREFERENCES_STORAGE_KEY,
  SHELL_PREFERENCES_VERSION,
} from "../../src/app/shellPreferences";
import {
  assertShellFixtureConsistency,
  getShellFixture,
  UNICODE_WORKSPACE,
  type ShellFixture,
} from "../fixtures/003-shell-fixtures";
import {
  makeEntryRowKey,
  makeWorkspaceRowKey,
} from "../../src/workspaces/workspaceTreeModel";
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
  assertToken,
  writeShellCollection,
  type ComponentCropComparison,
} from "../visual/003ShellAssertions";
import { LEGACY_CHECK_IDS, type AssertionResult } from "../visual/003Evidence";
import {
  getUiInteractionHarnessState,
  installUiInteractionHarness,
} from "./uiInteractionHarness";

const GEOMETRY_TOLERANCE_PX = 2;
const REPO_ROOT = resolve(import.meta.dirname, "../..");
const HF2_MANIFEST_PATH = resolve(
  REPO_ROOT,
  "docs/design/desktop-shell/hf-2/manifest.json",
);
const HF2_MANIFEST_BYTES = readFileSync(HF2_MANIFEST_PATH);
const HF2_MANIFEST_SHA256 = createHash("sha256")
  .update(HF2_MANIFEST_BYTES)
  .digest("hex");
const HF2_MANIFEST = JSON.parse(HF2_MANIFEST_BYTES.toString("utf8")) as {
  screens: Array<{ path: string; sha256: string }>;
};
const PRODUCT_COMMIT = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
}).trim();
const CAPTURE_NAMES = {
  welcomeLight: "welcome-light",
  restoredHiddenLight: "restored-hidden-light",
  workspacePinnedLight: "workspace-pinned-light",
  workspaceOverlayLight: "workspace-overlay-light",
  welcomeDark: "welcome-dark",
  workspacePinnedDark: "workspace-pinned-dark",
} as const;

const CAPTURE_GATES = {
  welcomeLight: {
    gateId: "HF2-01",
    baselinePath: "screens/welcome-light.png",
  },
  restoredHiddenLight: {
    gateId: "HF2-02",
    baselinePath: "screens/restored-hidden-light.png",
  },
  workspacePinnedLight: {
    gateId: "VSL-001",
    baselinePath: "screens/workspace-pinned-light.png",
  },
  workspaceOverlayLight: {
    gateId: "HF2-04",
    baselinePath: "screens/workspace-overlay-light.png",
  },
  welcomeDark: {
    gateId: "HF2-05",
    baselinePath: "screens/welcome-dark.png",
  },
  workspacePinnedDark: {
    gateId: "HF2-06",
    baselinePath: "screens/workspace-pinned-dark.png",
  },
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
  test("exercises Current Workspace header actions through keyboard and pointer routes", async ({
    page,
  }) => {
    const fixture = getShellFixture("nested-tree");
    await prepare(page, fixture, "light");

    const workspace = page.getByRole("treeitem", { name: "Design Workspace" });
    await workspace.click();
    await workspace.click();
    await expect(
      page.getByRole("treeitem", { name: "planning" }),
    ).toBeVisible();

    const newDrawing = page.getByRole("button", { name: "New Drawing" });
    await newDrawing.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("textbox", { name: "Name" }).fill("Root sketch");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(
      page.getByRole("treeitem", { name: "Root sketch" }),
    ).toBeVisible();
    let state = await getUiInteractionHarnessState(page);
    expect(
      state.invocations.filter(
        (call) =>
          call.command === "workspace_entry_create" &&
          call.args.parentRelativePath === "" &&
          call.args.kind === "drawing",
      ),
    ).toHaveLength(1);

    const planning = page.getByRole("treeitem", { name: "planning" });
    if ((await planning.getAttribute("aria-expanded")) !== "true") {
      await planning.click();
    }
    await page.getByRole("treeitem", { name: "weekly" }).click();
    const beforeCancel = (await getUiInteractionHarnessState(page)).entryCount;
    const newFolder = page.getByRole("button", { name: "New Folder" });
    await newFolder.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    expect((await getUiInteractionHarnessState(page)).entryCount).toBe(
      beforeCancel,
    );

    await newFolder.click();
    await page.getByRole("textbox", { name: "Name" }).fill("Sprint");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("treeitem", { name: "Sprint" })).toBeVisible();
    state = await getUiInteractionHarnessState(page);
    expect(state.entryCountByParent["fixture-workspace:planning/weekly"]).toBe(
      2,
    );
    expect(
      state.invocations.filter(
        (call) =>
          call.command === "workspace_entry_create" &&
          call.args.parentRelativePath === "planning/weekly" &&
          call.args.kind === "directory",
      ),
    ).toHaveLength(1);

    const beforeConflict = state.entryCount;
    await newDrawing.click();
    await page.getByRole("textbox", { name: "Name" }).fill("notes");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("alert")).toContainText("already exists");
    expect((await getUiInteractionHarnessState(page)).entryCount).toBe(
      beforeConflict,
    );
    await page.getByRole("button", { name: "Cancel" }).click();

    const collapseAll = page.getByRole("button", { name: "Collapse all" });
    await collapseAll.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("treeitem", { name: "planning" })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Expand all" }).click();
    await expect(page.getByRole("treeitem", { name: "notes" })).toBeVisible();

    const listsBeforeRefresh = (
      await getUiInteractionHarnessState(page)
    ).invocations.filter(
      (call) => call.command === "workspace_entry_list",
    ).length;
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect
      .poll(
        async () =>
          (await getUiInteractionHarnessState(page)).invocations.filter(
            (call) => call.command === "workspace_entry_list",
          ).length,
      )
      .toBeGreaterThan(listsBeforeRefresh);
  });

  test("captures Welcome / Light at the fixed 1280x760 viewport", async ({
    page,
  }, testInfo) => {
    const fixture = getShellFixture("welcome");
    await prepare(page, fixture, "light");
    await expect(page.getByTestId("welcome-screen")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Open workspace/ }),
    ).toHaveCount(3);
    await assertShellContract(page, { session: "empty", sidebar: "hidden" });
    await assertWelcomeVisualStyles(page, "light");
    const geometryAssertions = await assertWelcomeGeometry(page);
    await captureAndCollect(page, testInfo, {
      captureKey: "welcomeLight",
      fixture,
      theme: "light",
      sidebar: "hidden",
      session: "empty",
      cropLocator: page.locator(".welcome-screen"),
      componentId: "welcome-screen",
      geometryAssertions,
    });
  });

  test("captures Restored / Hidden / Light without old top-level commands", async ({
    page,
  }, testInfo) => {
    const fixture = getShellFixture("restored-recovery");
    await prepare(page, fixture, "light");
    const semanticAssertions = await assertRestoredFixture(page, fixture);
    await expect(page.locator(".recovery-notice")).toContainText(
      "Recovered · 3 drawings restored",
    );
    await expect(page.locator(".file-sidebar")).not.toBeVisible();
    await assertShellContract(page, { session: "restored", sidebar: "hidden" });
    const geometryAssertions = await assertRestoredHiddenGeometry(page);
    await captureAndCollect(page, testInfo, {
      captureKey: "restoredHiddenLight",
      fixture,
      theme: "light",
      sidebar: "hidden",
      session: "restored",
      cropLocator: page.locator(".app-shell-tabs"),
      componentId: "shell-tabs",
      semanticAssertions,
      geometryAssertions,
    });
  });

  test("captures Workspace / Pinned / Light with exact shell geometry", async ({
    page,
  }, testInfo) => {
    const fixture = getShellFixture("pinned");
    await prepare(page, fixture, "light");
    await expect(page.locator(".file-sidebar")).toBeVisible();
    await expect(
      page.locator('[role="treeitem"][data-kind="workspace"]', {
        hasText: "Design Workspace",
      }),
    ).toBeVisible();
    await expect(page.getByRole("treeitem", { name: "Flows" })).toBeVisible();
    await expect(page.locator(".tab-list").getByRole("tab")).toHaveCount(3);
    await assertRestoredFixture(page, fixture);
    await assertPinnedWorkspaceHeader(page);
    await assertDefaultWorkspaceRowState(page);
    await assertShellContract(page, { session: "restored", sidebar: "pinned" });
    const geometryAssertions = await assertGeometrySet(page, "pinned");
    await captureAndCollect(page, testInfo, {
      captureKey: "workspacePinnedLight",
      fixture,
      theme: "light",
      sidebar: "pinned",
      session: "workspace",
      cropLocator: page.locator(".file-sidebar"),
      componentId: "workspace-sidebar",
      geometryAssertions,
    });
  });

  test("captures Workspace / Overlay / Light without changing the canvas box", async ({
    page,
  }, testInfo) => {
    const fixture = getShellFixture("overlay");
    await prepare(page, fixture, "light");
    await expect(page.locator(".file-sidebar")).toBeVisible();
    await assertShellContract(page, {
      session: "restored",
      sidebar: "overlay",
    });
    const semanticAssertions = await assertRestoredFixture(page, fixture);
    const back = page.getByRole("button", { name: "Back" });
    await expect(back).toBeEnabled();
    const backBox = await readBox(back);
    const firstTabBox = await readBox(page.locator(".tab-cluster").first());
    const canvas = page.locator(".canvas-region");
    const before = await readBox(canvas);
    await page.keyboard.press("Escape");
    await expect(page.locator(".file-sidebar")).not.toBeVisible();
    const after = await readBox(canvas);
    expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(
      GEOMETRY_TOLERANCE_PX,
    );
    await page
      .getByRole("button", { name: "Toggle workspace sidebar" })
      .click();
    await expect(page.locator(".file-sidebar")).toBeVisible();
    await page.mouse.move(
      VISUAL_VIEWPORT.width - 8,
      VISUAL_VIEWPORT.height - 8,
    );
    await captureAndCollect(page, testInfo, {
      captureKey: "workspaceOverlayLight",
      fixture,
      theme: "light",
      sidebar: "overlay",
      session: "workspace",
      cropLocator: page.locator(".file-sidebar"),
      componentId: "workspace-sidebar",
      semanticAssertions: [
        ...semanticAssertions,
        {
          name: "semantic.back.valid-history-enabled",
          expected: "true",
          actual: String(await back.isEnabled()),
          tolerance: "exact",
          result: (await back.isEnabled()) ? "PASS" : "FAIL",
        },
      ],
      geometryAssertions: [
        ...(["x", "y", "width", "height"] as const).map((dimension) =>
          assertGeometry({
            name: `overlay.canvas-box.${dimension}.before-after`,
            expected: before[dimension],
            actual: after[dimension],
            tolerance: 0,
          }),
        ),
        assertGeometry({
          name: "overlay.back.width",
          expected: 32,
          actual: backBox.width,
          tolerance: 0,
        }),
        assertGeometry({
          name: "overlay.back.height",
          expected: 32,
          actual: backBox.height,
          tolerance: 0,
        }),
        assertGeometry({
          name: "overlay.first-tab.x",
          expected: 88,
          actual: firstTabBox.x,
          tolerance: GEOMETRY_TOLERANCE_PX,
        }),
      ],
    });
  });

  test("captures Welcome / Dark with the same shell geometry", async ({
    page,
  }, testInfo) => {
    const fixture = getShellFixture("welcome");
    await prepare(page, fixture, "dark");
    await expect(page.getByTestId("welcome-screen")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-scheme",
      "dark",
    );
    await assertShellContract(page, { session: "empty", sidebar: "hidden" });
    await assertWelcomeVisualStyles(page, "dark");
    const geometryAssertions = await assertWelcomeGeometry(page);
    await captureAndCollect(page, testInfo, {
      captureKey: "welcomeDark",
      fixture,
      theme: "dark",
      sidebar: "hidden",
      session: "empty",
      cropLocator: page.locator(".welcome-screen"),
      componentId: "welcome-screen",
      geometryAssertions,
    });
  });

  test("collects Pinned Dark semantic a11y, keyboard, contrast, non-color, reduced-motion, and geometry parity", async ({
    page,
  }, testInfo) => {
    const fixture = getShellFixture("pinned-dark");
    await prepare(page, fixture, "light");
    const lightGeometry = await readPhase8Geometry(page);

    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-scheme",
      "dark",
    );
    const darkGeometry = await readPhase8Geometry(page);
    const geometryAssertions = Object.entries(lightGeometry).flatMap(
      ([component, lightBox]) =>
        (["x", "y", "width", "height"] as const).map((dimension) =>
          assertGeometry({
            name: `theme-parity.${component}.${dimension}`,
            expected: lightBox[dimension],
            actual: darkGeometry[component]?.[dimension] ?? -1,
            tolerance: 0,
          }),
        ),
    );
    expect(geometryAssertions.every(({ result }) => result === "PASS")).toBe(
      true,
    );

    const axe = await new AxeBuilder({ page })
      .exclude(SDK_BOUNDARY_SELECTOR)
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(axe.violations).toEqual([]);

    const semanticAssertions = await assertRestoredFixture(page, fixture);
    const back = page.getByRole("button", { name: "Back" });
    const sidebarToggle = page.getByRole("button", {
      name: "Toggle workspace sidebar",
    });
    await sidebarToggle.focus();
    await expect(sidebarToggle).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(back).toBeFocused();
    await expect(back).toHaveCSS("outline-width", "2px");

    const selectedDrawing = page.locator(
      '.workspace-tree-row[data-kind="drawing"][aria-selected="true"]',
    );
    await expect(selectedDrawing).toHaveCount(1);
    await expect(
      selectedDrawing.locator(".workspace-tree-active-indicator"),
    ).toHaveCount(1);
    const expandedDirectory = page.locator(
      '.workspace-tree-row[data-kind="directory"][aria-expanded="true"]',
    );
    await expect(expandedDirectory).toHaveCount(1);
    const treeIconStyles = await page
      .locator(".workspace-tree-disclosure-icon, .workspace-tree-leading-icon")
      .evaluateAll((icons) =>
        icons.map((icon) => {
          const style = getComputedStyle(icon);
          return { filter: style.filter, opacity: style.opacity };
        }),
      );
    expect(treeIconStyles.length).toBeGreaterThan(0);
    expect(treeIconStyles.every(({ filter }) => filter === "invert(1)")).toBe(
      true,
    );
    expect(
      treeIconStyles.every(({ opacity }) => Number.parseFloat(opacity) >= 0.8),
    ).toBe(true);

    const contrast = await readPhase8Contrast(page);
    expect(contrast.primaryOnPanel).toBeGreaterThanOrEqual(4.5);
    expect(contrast.secondaryOnPanel).toBeGreaterThanOrEqual(4.5);
    expect(contrast.primaryOnActive).toBeGreaterThanOrEqual(4.5);
    const reducedMotion = await page.locator(".app-shell").evaluate((shell) => {
      const style = getComputedStyle(shell);
      const durationSeconds = (value: string): number =>
        value.endsWith("ms")
          ? Number.parseFloat(value) / 1_000
          : Number.parseFloat(value);
      return {
        mediaMatches: matchMedia("(prefers-reduced-motion: reduce)").matches,
        scrollBehavior: style.scrollBehavior,
        transitionSeconds: durationSeconds(style.transitionDuration),
        animationSeconds: durationSeconds(style.animationDuration),
      };
    });
    expect(reducedMotion.mediaMatches).toBe(true);
    expect(reducedMotion.scrollBehavior).toBe("auto");
    expect(reducedMotion.transitionSeconds).toBeLessThanOrEqual(0.000001);
    expect(reducedMotion.animationSeconds).toBeLessThanOrEqual(0.000001);

    await page.mouse.move(
      VISUAL_VIEWPORT.width - 8,
      VISUAL_VIEWPORT.height - 8,
    );
    await captureAndCollect(page, testInfo, {
      captureKey: "workspacePinnedDark",
      captureName: "workspace-pinned-dark-semantic",
      collectionId: "HF2-06-dark-pinned-semantic-browser",
      fixture,
      theme: "dark",
      sidebar: "pinned",
      session: "workspace",
      cropLocator: page.locator(".app-shell"),
      componentId: "phase8-shell-semantic",
      semanticAssertions: [
        ...semanticAssertions,
        {
          name: "semantic.a11y.axe-violation-count",
          expected: "0",
          actual: String(axe.violations.length),
          tolerance: "exact",
          result: axe.violations.length === 0 ? "PASS" : "FAIL",
        },
        {
          name: "semantic.keyboard.back-focus-ring",
          expected: "2px",
          actual: await back.evaluate(
            (element) => getComputedStyle(element).outlineWidth,
          ),
          tolerance: "exact",
          result: "PASS",
        },
        {
          name: "semantic.non-color.active-row-indicator-count",
          expected: "1",
          actual: String(
            await selectedDrawing
              .locator(".workspace-tree-active-indicator")
              .count(),
          ),
          tolerance: "exact",
          result: "PASS",
        },
        {
          name: "semantic.dark.workspace-tree-icon-readable-style-count",
          expected: String(treeIconStyles.length),
          actual: String(
            treeIconStyles.filter(
              ({ filter, opacity }) =>
                filter === "invert(1)" && Number.parseFloat(opacity) >= 0.8,
            ).length,
          ),
          tolerance: "exact",
          result: treeIconStyles.every(
            ({ filter, opacity }) =>
              filter === "invert(1)" && Number.parseFloat(opacity) >= 0.8,
          )
            ? "PASS"
            : "FAIL",
        },
        {
          name: "semantic.contrast.minimum-ratio",
          expected: ">=4.5",
          actual: String(Math.min(...Object.values(contrast))),
          tolerance: "WCAG AA",
          result: "PASS",
        },
        {
          name: "semantic.reduced-motion.transition-duration",
          expected: "<=0.000001s",
          actual: `${reducedMotion.transitionSeconds}s`,
          tolerance: "maximum",
          result: reducedMotion.transitionSeconds <= 0.000001 ? "PASS" : "FAIL",
        },
      ],
      geometryAssertions,
    });
  });

  test("captures Workspace / Pinned / Dark with the fixed HF2-06 visual fixture", async ({
    page,
  }, testInfo) => {
    const fixture = getShellFixture("pinned-dark");
    await prepare(page, fixture, "dark");
    await expect(page.locator(".file-sidebar")).toBeVisible();
    await expect(
      page
        .getByRole("treeitem", { name: "Architecture" })
        .and(page.locator('[data-kind="workspace"]')),
    ).toBeVisible();
    await expect(
      page.getByRole("treeitem", { name: "System Map" }),
    ).toBeVisible();
    const semanticAssertions = await assertRestoredFixture(page, fixture);
    await assertShellContract(page, { session: "restored", sidebar: "pinned" });
    const geometryAssertions = await assertGeometrySet(page, "pinned");
    await assertPinnedWorkspaceHeader(page);
    await assertDefaultWorkspaceRowState(page);
    await captureAndCollect(page, testInfo, {
      captureKey: "workspacePinnedDark",
      captureName: "workspace-pinned-dark-visual",
      collectionId: "HF2-06-dark-pinned-visual-browser",
      fixture,
      theme: "dark",
      sidebar: "pinned",
      session: "workspace",
      cropLocator: page.locator(".file-sidebar"),
      componentId: "workspace-sidebar",
      semanticAssertions,
      geometryAssertions,
    });
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
  assertShellFixtureConsistency(fixture);
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
  const recoveryCandidates =
    fixture.id === "restored-recovery"
      ? fixture.tabs.map((tab, index) => ({
          documentId: `visual-recovery-${index + 1}`,
          originalPath: tab.path,
          displayName: tab.path?.split("/").at(-1) ?? tab.title,
          snapshotSavedAt: 1_720_000_100 + index,
          coldFileMtime: 1_720_000_000,
          snapshotNewer: true,
        }))
      : [];
  await installUiInteractionHarness(page, {
    workspaces: fixture.workspaces,
    entries: fixture.entries,
    responses:
      fixture.id === "restored-recovery"
        ? {
            recovery_apply: {
              scene: {
                type: "excalidraw",
                version: 2,
                source: "003-restored-recovery-visual-fixture",
                elements: [],
                appState: { viewBackgroundColor: "#ffffff" },
                files: {},
              },
              newPath: null,
            },
          }
        : undefined,
    startup: {
      abnormalExit: fixture.id === "restored-recovery",
      nativeWindowRuntime: true,
      recoveryCandidates,
    },
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
  if (fixture.id === "restored-recovery") {
    await resolveRecoveryFixture(page, fixture);
  } else {
    await openFixtureDocuments(page, fixture);
    await applyDeclaredTabSaveStates(page, fixture);
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

async function resolveRecoveryFixture(
  page: Page,
  fixture: ShellFixture,
): Promise<void> {
  for (const tab of fixture.tabs) {
    const displayName = tab.path?.split("/").at(-1) ?? tab.title;
    await page.getByRole("button", { name: `Restore ${displayName}` }).click();
  }
  await expect(
    page.getByRole("dialog", { name: "Recover unsaved drawings" }),
  ).not.toBeAttached();
  await expect(page.locator(".tab-list").getByRole("tab")).toHaveCount(3);
  const activeTab = fixture.tabs.find(
    ({ documentId }) => documentId === fixture.activeDocumentId,
  );
  if (activeTab !== undefined) {
    await page
      .locator(".tab-list")
      .getByRole("tab", { name: new RegExp(activeTab.title) })
      .click();
  }
  await expect(page.locator(SDK_BOUNDARY_SELECTOR)).toBeVisible();
  await applyDeclaredTabSaveStates(page, fixture);
  await page.mouse.move(VISUAL_VIEWPORT.width - 8, VISUAL_VIEWPORT.height - 8);
}

async function applyDeclaredTabSaveStates(
  page: Page,
  fixture: ShellFixture,
): Promise<void> {
  const expectedStates = fixture.tabs.map(({ path, saveState }) => ({
    path,
    saveState,
  }));
  await page.evaluate(async (tabs) => {
    type DocumentStoreModule =
      typeof import("../../src/documents/documentStore");
    const modulePath = "/src/documents/documentStore.ts";
    const { documentManager } = (await import(
      /* @vite-ignore */ modulePath
    )) as DocumentStoreModule;
    const expectedByPath = new Map(
      tabs.map(({ path, saveState }) => [path, saveState]),
    );
    let matched = 0;
    documentManager.store.setState((state) => ({
      sessionsById: Object.fromEntries(
        Object.entries(state.sessionsById).map(([documentId, session]) => {
          const expected = expectedByPath.get(session.path);
          if (expected === undefined) return [documentId, session];
          matched += 1;
          return [documentId, { ...session, saveState: expected }];
        }),
      ),
    }));
    if (matched !== tabs.length) {
      throw new Error(
        `Visual fixture matched ${matched} of ${tabs.length} declared Tab paths.`,
      );
    }
  }, expectedStates);
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
  if (fixture.currentWorkspaceId !== null) {
    const workspaceRow = page.locator(
      `[data-row-key="${makeWorkspaceRowKey(fixture.currentWorkspaceId)}"]`,
    );
    await expect(workspaceRow).toBeVisible();
    if ((await workspaceRow.getAttribute("aria-expanded")) !== "true") {
      await workspaceRow.click();
      await expect(workspaceRow).toHaveAttribute("aria-expanded", "true");
    }
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
      const directoryRow = page
        .getByRole("treeitem", { name: directory.displayName })
        .and(
          page.locator(
            `[data-row-key="${makeEntryRowKey(directory.workspaceId, directory.relativePath)}"]`,
          ),
        );
      await expect(directoryRow).toBeVisible();
      if ((await directoryRow.getAttribute("aria-expanded")) !== "true") {
        await directoryRow.click();
      }
    }
    await page
      .getByRole("treeitem", { name: entry.displayName })
      .and(
        page.locator(
          `[data-row-key="${makeEntryRowKey(entry.workspaceId, entry.relativePath)}"]`,
        ),
      )
      .click();
    await expect(
      page.getByRole("tab", { name: new RegExp(tab.title) }),
    ).toBeVisible();
  }
  const activeTab = fixture.tabs.find(
    ({ documentId }) => documentId === fixture.activeDocumentId,
  );
  if (activeTab !== undefined) {
    const activeTabControl = page
      .locator(".tab-list")
      .getByRole("tab", { name: new RegExp(activeTab.title) });
    await activeTabControl.click();
    await expect(activeTabControl).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(SDK_BOUNDARY_SELECTOR)).toBeVisible();
  }
  await restoreDeclaredDirectoryExpansion(page, fixture);
  if (!startedVisible && fixture.sidebar === "hidden") {
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
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

async function restoreDeclaredDirectoryExpansion(
  page: Page,
  fixture: ShellFixture,
): Promise<void> {
  const desired = new Set(fixture.expandedDirectoryPaths);
  const directories = fixture.entries.filter(
    (entry) => entry.kind === "directory",
  );
  const byDescendingDepth = [...directories].sort(
    (left, right) =>
      right.relativePath.split("/").length -
      left.relativePath.split("/").length,
  );

  for (const directory of byDescendingDepth) {
    if (desired.has(directory.relativePath)) continue;
    const row = page.locator(
      `[data-row-key="${makeEntryRowKey(directory.workspaceId, directory.relativePath)}"]`,
    );
    if (
      (await row.count()) === 1 &&
      (await row.getAttribute("aria-expanded")) === "true"
    ) {
      await row.click();
    }
  }

  const byAscendingDepth = [...directories].sort(
    (left, right) =>
      left.relativePath.split("/").length -
      right.relativePath.split("/").length,
  );
  for (const directory of byAscendingDepth) {
    if (!desired.has(directory.relativePath)) continue;
    const row = page.locator(
      `[data-row-key="${makeEntryRowKey(directory.workspaceId, directory.relativePath)}"]`,
    );
    await expect(row).toHaveCount(1);
    if ((await row.getAttribute("aria-expanded")) !== "true") {
      await row.click();
    }
  }
}

async function assertRestoredFixture(
  page: Page,
  fixture: ShellFixture,
): Promise<AssertionResult[]> {
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
  const semanticAssertions: AssertionResult[] = [];
  for (const tab of fixture.tabs) {
    const tabControl = page.getByRole("tab", {
      name:
        tab.saveState === "dirty"
          ? new RegExp(`${tab.title}.*unsaved changes`, "i")
          : new RegExp(`${tab.title}(?!.*unsaved changes)`, "i"),
    });
    await expect(tabControl).toBeVisible();
    await expect(tabControl.locator(".dirty-indicator")).toHaveCount(
      tab.saveState === "dirty" ? 1 : 0,
    );
    const ariaLabel = (await tabControl.getAttribute("aria-label")) ?? "";
    const markerCount = await tabControl.locator(".dirty-indicator").count();
    const actualSaveState = ariaLabel.includes("unsaved changes")
      ? "dirty"
      : "clean";
    semanticAssertions.push(
      {
        name: `semantic.tab.${tab.documentId}.save-state`,
        expected: tab.saveState,
        actual: actualSaveState,
        tolerance: "exact",
        result: actualSaveState === tab.saveState ? "PASS" : "FAIL",
      },
      {
        name: `semantic.tab.${tab.documentId}.visible-unsaved-marker`,
        expected: tab.saveState === "dirty" ? "1" : "0",
        actual: String(markerCount),
        tolerance: "exact",
        result:
          markerCount === (tab.saveState === "dirty" ? 1 : 0) ? "PASS" : "FAIL",
      },
    );
  }
  await expect(page.locator(SDK_BOUNDARY_SELECTOR)).toBeVisible();
  return semanticAssertions;
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

async function assertGeometrySet(
  page: Page,
  state: "pinned",
): Promise<ReturnType<typeof assertGeometry>[]> {
  const assertions: ReturnType<typeof assertGeometry>[] = [];
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
    const assertion = assertGeometry({
      name: `${state}.${name}`,
      expected,
      actual: value,
      tolerance: GEOMETRY_TOLERANCE_PX,
    });
    expect(assertion).toMatchObject({ result: "PASS" });
    assertions.push(assertion);
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
  const canvasShare = canvasBox.width / (sidebarBox.width + canvasBox.width);
  const canvasShareAssertion = assertGeometry({
    name: `${state}.canvas-share-percent`,
    expected: 70,
    actual: canvasShare * 100,
    tolerance: Math.max(0, canvasShare * 100 - 70),
    unit: "% minimum",
  });
  expect(canvasShare).toBeGreaterThanOrEqual(0.7);
  assertions.push(canvasShareAssertion);
  return assertions;
}

async function readPhase8Geometry(page: Page): Promise<Record<string, Box>> {
  const selectors = {
    topLayer: ".app-shell-tabs",
    sidebar: ".file-sidebar",
    canvas: ".canvas-region",
    back: ".shell-back-button",
    tab: ".tab-cluster",
    workspaceRow: ".workspace-tree-row",
    headerAction: ".workspace-panel-actions .icon-button",
  } as const;
  return Object.fromEntries(
    await Promise.all(
      Object.entries(selectors).map(async ([name, selector]) => [
        name,
        await readBox(page.locator(selector).first()),
      ]),
    ),
  );
}

async function readPhase8Contrast(page: Page): Promise<{
  primaryOnPanel: number;
  secondaryOnPanel: number;
  primaryOnActive: number;
}> {
  const colors = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      primary: style.getPropertyValue("--text-primary").trim(),
      secondary: style.getPropertyValue("--text-secondary").trim(),
      panel: style.getPropertyValue("--panel-background").trim(),
      active: style.getPropertyValue("--surface-active").trim(),
    };
  });
  return {
    primaryOnPanel: contrastRatio(colors.primary, colors.panel),
    secondaryOnPanel: contrastRatio(colors.secondary, colors.panel),
    primaryOnActive: contrastRatio(colors.primary, colors.active),
  };
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string): number => {
    const match = /^#([0-9a-f]{6})$/iu.exec(color);
    if (match?.[1] === undefined) {
      throw new Error(`Expected a six-digit hex color, received ${color}`);
    }
    const hex = match[1];
    const channels = [0, 2, 4].map((offset) =>
      Number.parseInt(hex.slice(offset, offset + 2), 16),
    );
    const linear = channels.map((value) => {
      const normalized = value / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return (
      0.2126 * (linear[0] ?? 0) +
      0.7152 * (linear[1] ?? 0) +
      0.0722 * (linear[2] ?? 0)
    );
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

async function assertWelcomeGeometry(
  page: Page,
): Promise<ReturnType<typeof assertGeometry>[]> {
  const screenBox = await readBox(page.getByTestId("welcome-screen"));
  const actionBox = await readBox(page.locator(".welcome-action").first());
  const recentBox = await readBox(page.locator(".recent-workspaces"));
  const rowBox = await readBox(page.locator(".recent-workspace").first());
  const assertions = [
    assertGeometry({
      name: "welcome.screen-width",
      expected: 960,
      actual: screenBox.width,
      tolerance: GEOMETRY_TOLERANCE_PX,
    }),
    assertGeometry({
      name: "welcome.content-left",
      expected: 160,
      actual: screenBox.x,
      tolerance: GEOMETRY_TOLERANCE_PX,
    }),
    assertGeometry({
      name: "welcome.action-width",
      expected: 220,
      actual: actionBox.width,
      tolerance: 0,
    }),
    assertGeometry({
      name: "welcome.action-height",
      expected: 40,
      actual: actionBox.height,
      tolerance: 0,
    }),
    assertGeometry({
      name: "welcome.recent-width",
      expected: 760,
      actual: recentBox.width,
      tolerance: GEOMETRY_TOLERANCE_PX,
    }),
    assertGeometry({
      name: "welcome.recent-row-height",
      expected: 52,
      actual: rowBox.height,
      tolerance: 0,
    }),
  ];
  for (const assertion of assertions) {
    expect(
      assertion.result,
      `${assertion.name}: expected ${assertion.expected}, actual ${assertion.actual}, tolerance ${assertion.tolerance}`,
    ).toBe("PASS");
  }
  return assertions;
}

async function assertRestoredHiddenGeometry(
  page: Page,
): Promise<ReturnType<typeof assertGeometry>[]> {
  const topLayer = await readBox(page.locator(".app-shell-tabs"));
  const canvas = await readBox(page.locator(".canvas-region"));
  const firstTab = await readBox(page.locator(".tab-cluster").first());
  const notice = await readBox(page.locator(".recovery-notice"));
  const assertions = [
    assertGeometry({
      name: "restored-hidden.top-layer-height",
      expected: 44,
      actual: topLayer.height,
      tolerance: 0,
    }),
    assertGeometry({
      name: "restored-hidden.canvas-left",
      expected: 0,
      actual: canvas.x,
      tolerance: 0,
    }),
    assertGeometry({
      name: "restored-hidden.canvas-width",
      expected: VISUAL_VIEWPORT.width,
      actual: canvas.width,
      tolerance: GEOMETRY_TOLERANCE_PX,
    }),
    assertGeometry({
      name: "restored-hidden.tab-width",
      expected: 196,
      actual: firstTab.width,
      tolerance: 0,
    }),
    assertGeometry({
      name: "restored-hidden.first-tab-left",
      expected: 88,
      actual: firstTab.x,
      tolerance: GEOMETRY_TOLERANCE_PX,
    }),
    assertGeometry({
      name: "restored-hidden.tab-height",
      expected: 36,
      actual: firstTab.height,
      tolerance: 0,
    }),
    assertGeometry({
      name: "restored-hidden.notice-left",
      expected: 24,
      actual: notice.x,
      tolerance: 0,
    }),
    assertGeometry({
      name: "restored-hidden.notice-top",
      expected: 136,
      actual: notice.y,
      tolerance: GEOMETRY_TOLERANCE_PX,
    }),
    assertGeometry({
      name: "restored-hidden.notice-height",
      expected: 34,
      actual: notice.height,
      tolerance: GEOMETRY_TOLERANCE_PX,
    }),
  ];
  for (const assertion of assertions) {
    expect(
      assertion.result,
      `${assertion.name}: expected ${assertion.expected}, actual ${assertion.actual}, tolerance ${assertion.tolerance}`,
    ).toBe("PASS");
  }
  return assertions;
}

async function assertWelcomeVisualStyles(
  page: Page,
  theme: "light" | "dark",
): Promise<void> {
  const styles = await page.evaluate(() => {
    const primaryIcon = document.querySelector<HTMLElement>(
      ".welcome-action.primary-action img",
    );
    const secondaryAction = document.querySelector<HTMLElement>(
      ".welcome-action:not(.primary-action)",
    );
    const recentRow = document.querySelector<HTMLElement>(".recent-workspace");
    if (
      primaryIcon === null ||
      secondaryAction === null ||
      recentRow === null
    ) {
      throw new Error("Welcome visual-style targets are missing");
    }
    const iconStyle = getComputedStyle(primaryIcon);
    const rowStyle = getComputedStyle(recentRow);
    return {
      iconFilter: iconStyle.filter,
      secondaryBackground: getComputedStyle(secondaryAction).backgroundColor,
      rowBorderStyles: [
        rowStyle.borderTopStyle,
        rowStyle.borderRightStyle,
        rowStyle.borderBottomStyle,
        rowStyle.borderLeftStyle,
      ],
      rowBoxShadow: rowStyle.boxShadow,
    };
  });
  expect(styles.iconFilter).toBe(
    theme === "light" ? "brightness(0) invert(1)" : "none",
  );
  expect(styles.secondaryBackground).toBe(
    theme === "light" ? "rgb(255, 255, 255)" : "rgb(35, 35, 41)",
  );
  expect(styles.rowBorderStyles).toEqual(["solid", "solid", "solid", "solid"]);
  expect(styles.rowBoxShadow).toBe("none");
  const leadingRecent = page.getByRole("button", {
    name: "Open workspace Architecture",
  });
  await leadingRecent.hover();
  await expect(leadingRecent).toHaveCSS(
    "background-color",
    theme === "light" ? "rgb(241, 240, 255)" : "rgb(49, 48, 59)",
  );
}

async function assertPinnedWorkspaceHeader(page: Page): Promise<void> {
  const toolbar = page.getByRole("toolbar", { name: "Workspace actions" });
  await expect(toolbar.getByRole("button")).toHaveCount(4);
  expect(
    await toolbar.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await expect(page.getByRole("button", { name: "Mount folder…" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Unpin workspace sidebar" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Pin workspace sidebar" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("separator", { name: "Resize workspace sidebar" }),
  ).toBeVisible();
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
  const headerBox = await readBox(page.locator(".workspace-panel-header"));
  const firstRowBox = await readBox(
    page.locator(".workspace-tree-row").first(),
  );
  expect(
    firstRowBox.y - (headerBox.y + headerBox.height),
  ).toBeGreaterThanOrEqual(14);
}

async function assertDefaultWorkspaceRowState(page: Page): Promise<void> {
  await expect(page.locator(".workspace-tree")).not.toBeFocused();
  await expect(page.locator(".workspace-tree-action").first()).toBeHidden();

  const activeRow = page.locator('.workspace-tree-row[aria-selected="true"]');
  const inactiveRow = page.locator(
    '.workspace-tree-row:not([aria-selected="true"])[data-kind="drawing"]',
  );
  await expect(activeRow).toHaveCount(1);
  await expect(inactiveRow.first()).toBeVisible();
  const [activeIconX, inactiveIconX] = await Promise.all([
    activeRow
      .locator('[data-slot="workspace-tree-icon"]')
      .evaluate((icon) => icon.getBoundingClientRect().x),
    inactiveRow
      .first()
      .locator('[data-slot="workspace-tree-icon"]')
      .evaluate((icon) => icon.getBoundingClientRect().x),
  ]);
  expect(activeIconX).toBe(inactiveIconX);
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
): Promise<string> {
  const outputPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: outputPath, animations: "disabled" });
  const size = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  expect(size).toEqual(VISUAL_VIEWPORT);
  return outputPath;
}

async function compareCropStability(
  locator: Locator,
  name: string,
): Promise<ComponentCropComparison> {
  const box = await readBox(locator);
  expect(
    assertComponentCropWithinViewport(name, box, VISUAL_VIEWPORT),
  ).toMatchObject({ result: "PASS" });
  const first = await locator.screenshot({ animations: "disabled" });
  const second = await locator.screenshot({ animations: "disabled" });
  const identical = Buffer.compare(first, second) === 0;
  expect(identical).toBe(true);
  const maxDiffPixelRatio = identical ? 0 : 1;
  expect(
    assertComponentCropDiff(name, maxDiffPixelRatio, COMPONENT_CROP_THRESHOLD),
  ).toMatchObject({ result: "PASS" });
  return {
    componentId: name,
    baselineComponentId: name,
    baselineSha256: createHash("sha256").update(first).digest("hex"),
    actualSha256: createHash("sha256").update(second).digest("hex"),
    fontReady: true,
    maxDiffPixelRatio,
  };
}

async function captureAndCollect(
  page: Page,
  testInfo: Parameters<typeof capture>[1] & {
    project: { name: string };
    outputPath(path: string): string;
  },
  input: {
    captureKey: keyof typeof CAPTURE_NAMES;
    captureName?: string;
    collectionId?: string;
    fixture: ShellFixture;
    theme: "light" | "dark";
    sidebar: "hidden" | "overlay" | "pinned";
    session: "empty" | "restored" | "workspace";
    cropLocator: Locator;
    componentId: string;
    semanticAssertions?: readonly AssertionResult[];
    geometryAssertions?: ReturnType<typeof assertGeometry>[];
  },
): Promise<void> {
  const gate = CAPTURE_GATES[input.captureKey];
  const manifestScreen = HF2_MANIFEST.screens.find(
    (screen) => screen.path === gate.baselinePath,
  );
  if (manifestScreen === undefined) {
    throw new Error(`HF-2 manifest is missing ${gate.baselinePath}`);
  }
  const actualPath = await capture(
    page,
    testInfo,
    input.captureName ?? CAPTURE_NAMES[input.captureKey],
  );
  const cropComparison = await compareCropStability(
    input.cropLocator,
    input.componentId,
  );
  const fontPolicy = await readFontPolicy(page);
  const legacyCounts = await readLegacyCounts(page);
  const tokenAssertions = await readTokenAssertions(page, input.theme);
  const masks =
    input.session === "empty"
      ? []
      : [
          {
            maskId: "sdk-editor-interior",
            selectorOrRect: SDK_BOUNDARY_SELECTOR,
            surface: "canvas" as const,
            reason: "Official Excalidraw SDK-owned editor interior",
            perimeterChecked: true as const,
            approved: true as const,
          },
        ];
  const collectionId =
    input.collectionId ??
    `${gate.gateId}-${input.theme}-${input.sidebar}-browser`;
  const configuredRoot = process.env.SHELL_EVIDENCE_RUN_ROOT;
  const collectionDir =
    configuredRoot === undefined
      ? testInfo.outputPath(
          `immutable/${gate.gateId}/collection/${collectionId}`,
        )
      : resolve(configuredRoot, gate.gateId, "collection", collectionId);
  await writeShellCollection({
    collectionDir,
    gateId: gate.gateId,
    collectionId,
    binding: {
      productCommit: PRODUCT_COMMIT,
      hf2ManifestSha256: HF2_MANIFEST_SHA256,
      fixtureDigest: createHash("sha256")
        .update(JSON.stringify(input.fixture))
        .digest("hex"),
      harnessVersion: "003-shell-v3",
    },
    actualPath,
    baselinePath: gate.baselinePath,
    baselineSha256: manifestScreen.sha256,
    os: `${process.platform}/${process.arch}`,
    browserOrAppBuild: testInfo.project.name,
    theme: input.theme,
    sidebar: input.sidebar,
    session: input.session,
    fixture: input.fixture.id,
    fontPolicy: {
      computedUiFamily: fontPolicy.computedUiFamily,
      computedMonoFamily: fontPolicy.computedMonoFamily,
      remoteFontRequests: remoteFontRequestsByPage.get(page) ?? 0,
      englishTargetVerified: fontPolicy.englishTargetVerified,
      unicodeFallbackVerified: fontPolicy.unicodeFallbackVerified,
    },
    masks,
    legacyCounts,
    semanticAssertions: input.semanticAssertions ?? [],
    geometryAssertions: input.geometryAssertions ?? [],
    tokenAssertions,
    cropComparisons: [cropComparison],
  });
}

async function readTokenAssertions(
  page: Page,
  theme: "light" | "dark",
): Promise<ReturnType<typeof assertToken>[]> {
  const expected =
    theme === "light"
      ? {
          "--app-background": "#F8F9FA",
          "--panel-background": "#FFFFFF",
          "--surface-hover": "#F1F0FF",
          "--text-primary": "#1B1B1F",
          "--text-secondary": "#5C5C5C",
          "--focus-ring": "#1C7ED6",
        }
      : {
          "--app-background": "#121212",
          "--panel-background": "#232329",
          "--surface-hover": "#31303B",
          "--text-primary": "#F1F3F5",
          "--text-secondary": "#CED4DA",
          "--focus-ring": "#74C0FC",
        };
  const actual = await page.evaluate((variableNames) => {
    const styles = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      variableNames.map((name) => [name, styles.getPropertyValue(name).trim()]),
    );
  }, Object.keys(expected));
  const assertions = Object.entries(expected).map(([name, expectedValue]) =>
    assertToken({ name, expected: expectedValue, actual: actual[name] ?? "" }),
  );
  expect(assertions.every((assertion) => assertion.result === "PASS")).toBe(
    true,
  );
  return assertions;
}
