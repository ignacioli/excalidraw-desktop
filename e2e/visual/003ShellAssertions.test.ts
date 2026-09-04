import { describe, expect, it } from "vitest";
import {
  HF2_FONT_DEVIATION_ID,
  PLATFORM_MONO_FONT_STACK,
  PLATFORM_UI_FONT_STACK,
} from "./003Evidence";
import { assertPlatformFontPolicy } from "./003ShellAssertions";

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
