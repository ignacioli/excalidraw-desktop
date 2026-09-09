import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HF2_FONT_DEVIATION_ID,
  PLATFORM_MONO_FONT_STACK,
  PLATFORM_UI_FONT_STACK,
} from "./003Evidence";
import {
  COMPONENT_CROP_THRESHOLD,
  SDK_BOUNDARY_SELECTOR,
  SHELL_VISUAL_SELECTORS,
  assertComponentCropDiff,
  assertBoundComponentCropComparison,
  assertComponentCropWithinViewport,
  assertGeometry,
  assertLegacyCounts,
  assertNoPrivateSdkSelectors,
  assertPlatformFontPolicy,
  writeShellCollection,
} from "./003ShellAssertions";

describe("HF2-FONT-001 visual assertions", () => {
  it("accepts only the approved platform stacks with offline Unicode evidence", () => {
    expect(
      assertPlatformFontPolicy({
        deviationId: HF2_FONT_DEVIATION_ID,
        uiStack: PLATFORM_UI_FONT_STACK,
        monoStack: PLATFORM_MONO_FONT_STACK,
        remoteFontRequests: 0,
        englishTargetVerified: true,
        unicodeFallbackVerified: true,
      }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ result: "PASS" })]),
    );
  });

  it("fails an unapproved family or missing Unicode fallback proof", () => {
    const assertions = assertPlatformFontPolicy({
      deviationId: "HF2-FONT-001",
      uiStack: "Inter, sans-serif",
      monoStack: PLATFORM_MONO_FONT_STACK,
      remoteFontRequests: 0,
      englishTargetVerified: true,
      unicodeFallbackVerified: false,
    });

    expect(assertions.filter(({ result }) => result === "FAIL")).toHaveLength(
      2,
    );
  });
});

describe("003 shell visual contract assertions", () => {
  it("requires every canonical legacy-visible count to be exactly zero", () => {
    const counts = Object.fromEntries(
      [
        "globalNewDrawing",
        "textSidebar",
        "largePinUnpin",
        "topLevelSaveExportAppearance",
        "autosaveStrip",
        "tabScrollbar",
        "sidebarScrollbar",
        "placeholderIcons",
        "horizontalEllipsis",
        "duplicateWorkspaceRoots",
        "headerActionOverflow",
      ].map((id) => [id, 0]),
    );
    expect(assertLegacyCounts(counts)).toHaveLength(11);
    expect(
      assertLegacyCounts(counts).some(({ result }) => result === "FAIL"),
    ).toBe(false);
  });

  it("enforces exact shell geometry defaults and viewport-contained crops", () => {
    expect(
      assertGeometry({
        name: "icon hit target",
        expected: 32,
        actual: 32,
        tolerance: 0,
      }),
    ).toMatchObject({ result: "PASS" });
    expect(
      assertGeometry({
        name: "icon glyph",
        expected: 16,
        actual: 18,
        tolerance: 0,
      }),
    ).toMatchObject({ result: "FAIL" });
    expect(
      assertComponentCropWithinViewport(
        "header",
        { x: 0, y: 0, width: 1280, height: 48 },
        { width: 1280, height: 760 },
      ),
    ).toMatchObject({ result: "PASS" });
    expect(
      assertComponentCropWithinViewport(
        "outside",
        { x: 0, y: 0, width: 1281, height: 48 },
        { width: 1280, height: 760 },
      ),
    ).toMatchObject({ result: "FAIL" });
    expect(
      assertComponentCropDiff("header", COMPONENT_CROP_THRESHOLD),
    ).toMatchObject({ result: "PASS" });
    expect(assertComponentCropDiff("header", 0.011)).toMatchObject({
      result: "FAIL",
    });
  });

  it("keeps visual selectors on the shell side of the SDK boundary", () => {
    expect(SHELL_VISUAL_SELECTORS).toContain(SDK_BOUNDARY_SELECTOR);
    expect(assertNoPrivateSdkSelectors(SHELL_VISUAL_SELECTORS)).toMatchObject({
      result: "PASS",
    });
    expect(assertNoPrivateSdkSelectors([".App-menu__items"])).toMatchObject({
      result: "FAIL",
    });
  });

  it("requires component-crop semantic, font, digest, and ratio bindings", () => {
    const comparison = {
      componentId: "workspace-header",
      baselineComponentId: "workspace-header",
      baselineSha256: "ab".repeat(32),
      actualSha256: "cd".repeat(32),
      fontReady: true,
      maxDiffPixelRatio: 0.009,
    };
    expect(assertBoundComponentCropComparison(comparison)).toMatchObject({
      result: "PASS",
    });
    expect(
      assertBoundComponentCropComparison({
        ...comparison,
        baselineComponentId: "welcome-actions",
      }),
    ).toMatchObject({ result: "FAIL" });
    expect(
      assertBoundComponentCropComparison({
        ...comparison,
        fontReady: false,
      }),
    ).toMatchObject({ result: "FAIL" });
    expect(
      assertBoundComponentCropComparison({
        ...comparison,
        maxDiffPixelRatio: 0.011,
      }),
    ).toMatchObject({ result: "FAIL" });
  });

  it("writes the immutable T011 collector layout without reviewer state", async () => {
    const root = await mkdtemp(join(tmpdir(), "003-shell-collection-"));
    try {
      const actualPath = join(root, "source.png");
      await writeFile(actualPath, Buffer.from("deterministic-png-fixture"));
      const collectionDir = join(root, "gate", "collection", "browser");
      await writeShellCollection({
        collectionDir,
        collectionId: "VSL-001-browser",
        gateId: "VSL-001",
        binding: {
          productCommit: "ab".repeat(20),
          hf2ManifestSha256: "cd".repeat(32),
          fixtureDigest: "ef".repeat(32),
          harnessVersion: "003-shell-v2",
        },
        actualPath,
        baselinePath: "screens/workspace-pinned-light.png",
        baselineSha256: "12".repeat(32),
        os: "darwin",
        browserOrAppBuild: "chromium",
        theme: "light",
        sidebar: "pinned",
        session: "workspace",
        fixture: "pinned",
        fontPolicy: {
          computedUiFamily: PLATFORM_UI_FONT_STACK,
          computedMonoFamily: PLATFORM_MONO_FONT_STACK,
          remoteFontRequests: 0,
          englishTargetVerified: true,
          unicodeFallbackVerified: true,
        },
        masks: [
          {
            maskId: "sdk-canvas",
            selectorOrRect: ".excalidraw-editor",
            surface: "canvas",
            reason: "SDK-owned interior",
            perimeterChecked: true,
            approved: true,
          },
        ],
        legacyCounts: Object.fromEntries(
          [
            "globalNewDrawing",
            "textSidebar",
            "largePinUnpin",
            "topLevelSaveExportAppearance",
            "autosaveStrip",
            "tabScrollbar",
            "sidebarScrollbar",
            "placeholderIcons",
            "horizontalEllipsis",
            "duplicateWorkspaceRoots",
            "headerActionOverflow",
          ].map((id) => [id, 0]),
        ),
        geometryAssertions: [
          assertGeometry({
            name: "sidebar",
            expected: 360,
            actual: 360,
            tolerance: 2,
          }),
        ],
        tokenAssertions: [],
        cropComparisons: [
          {
            componentId: "workspace-header",
            baselineComponentId: "workspace-header",
            baselineSha256: "34".repeat(32),
            actualSha256: "56".repeat(32),
            fontReady: true,
            maxDiffPixelRatio: 0,
          },
        ],
      });
      const report = JSON.parse(
        await readFile(join(collectionDir, "collector-report.json"), "utf8"),
      );
      expect(report).toMatchObject({
        route: "semantic-browser",
        result: "PASS",
      });
      expect(report).not.toHaveProperty("reviewerVerdict");
      expect(report).not.toHaveProperty("productOwnerDecision");
      await expect(
        writeShellCollection({
          collectionDir,
        } as never),
      ).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
