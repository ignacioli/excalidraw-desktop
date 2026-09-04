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
  assertComponentCropWithinViewport,
  assertGeometry,
  assertLegacyCounts,
  assertNoPrivateSdkSelectors,
  assertPlatformFontPolicy,
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
});
