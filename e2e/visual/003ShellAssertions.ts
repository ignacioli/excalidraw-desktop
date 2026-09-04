import {
  HF2_FONT_DEVIATION_ID,
  LEGACY_CHECK_IDS,
  PLATFORM_MONO_FONT_STACK,
  PLATFORM_UI_FONT_STACK,
  type AssertionResult,
  type MaskDeclaration,
} from "./003Evidence";

export type LegacyCheckId = (typeof LEGACY_CHECK_IDS)[number];

export interface GeometryValue {
  readonly name: string;
  readonly expected: number;
  readonly actual: number;
  readonly tolerance: number;
  readonly unit?: string;
}

export interface TokenValue {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
}

export interface ComponentCrop {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface PlatformFontValues {
  readonly deviationId: string;
  readonly uiStack: string;
  readonly monoStack: string;
  readonly remoteFontRequests: number;
  readonly englishTargetVerified: boolean;
  readonly unicodeFallbackVerified: boolean;
}

function result(
  name: string,
  expected: string,
  actual: string,
  tolerance: string,
  passed: boolean,
): AssertionResult {
  return {
    name,
    expected,
    actual,
    tolerance,
    result: passed ? "PASS" : "FAIL",
  };
}

export function assertLegacyCounts(
  counts: Readonly<Partial<Record<LegacyCheckId, number>>>,
  expected = 0,
): readonly AssertionResult[] {
  return LEGACY_CHECK_IDS.map((id) => {
    const actual = counts[id] ?? 0;
    return result(
      `legacy.${id}`,
      String(expected),
      String(actual),
      "exact",
      Number.isInteger(actual) && actual >= 0 && actual === expected,
    );
  });
}

export function assertGeometry(value: GeometryValue): AssertionResult {
  const unit = value.unit ?? "px";
  const delta = Math.abs(value.actual - value.expected);
  return result(
    `geometry.${value.name}`,
    String(value.expected),
    String(value.actual),
    `${value.tolerance}${unit}`,
    Number.isFinite(delta) && value.tolerance >= 0 && delta <= value.tolerance,
  );
}

export function assertToken(value: TokenValue): AssertionResult {
  return result(
    `token.${value.name}`,
    value.expected,
    value.actual,
    "exact",
    value.expected === value.actual,
  );
}

export function assertPlatformFontPolicy(
  value: PlatformFontValues,
): readonly AssertionResult[] {
  return [
    result(
      "font.deviation",
      HF2_FONT_DEVIATION_ID,
      value.deviationId,
      "exact",
      value.deviationId === HF2_FONT_DEVIATION_ID,
    ),
    result(
      "font.ui-stack",
      PLATFORM_UI_FONT_STACK,
      value.uiStack,
      "exact",
      value.uiStack === PLATFORM_UI_FONT_STACK,
    ),
    result(
      "font.mono-stack",
      PLATFORM_MONO_FONT_STACK,
      value.monoStack,
      "exact",
      value.monoStack === PLATFORM_MONO_FONT_STACK,
    ),
    result(
      "font.remote-requests",
      "0",
      String(value.remoteFontRequests),
      "exact",
      value.remoteFontRequests === 0,
    ),
    result(
      "font.english-target",
      "verified",
      String(value.englishTargetVerified),
      "exact",
      value.englishTargetVerified,
    ),
    result(
      "font.unicode-fallback",
      "verified",
      String(value.unicodeFallbackVerified),
      "exact",
      value.unicodeFallbackVerified,
    ),
  ];
}

export function assertMaskBoundary(
  mask: Pick<MaskDeclaration, "selectorOrRect" | "surface">,
): AssertionResult {
  const shellWord = /shell|sidebar|tab|workspace|header|\bback\b/iu.test(
    mask.selectorOrRect,
  );
  return result(
    `mask.${mask.surface}`,
    "SDK-owned surface only",
    shellWord ? "shell-owned reference" : mask.selectorOrRect,
    "no shell-owned selector or rect",
    !shellWord,
  );
}

export function assertComponentCropWithinViewport(
  name: string,
  crop: ComponentCrop,
  viewport: ViewportSize,
): AssertionResult {
  const valid =
    Number.isFinite(crop.x) &&
    Number.isFinite(crop.y) &&
    Number.isFinite(crop.width) &&
    Number.isFinite(crop.height) &&
    crop.x >= 0 &&
    crop.y >= 0 &&
    crop.width > 0 &&
    crop.height > 0 &&
    crop.x + crop.width <= viewport.width &&
    crop.y + crop.height <= viewport.height;
  return result(
    `component-crop.${name}`,
    `inside ${viewport.width}x${viewport.height}`,
    `${crop.x},${crop.y},${crop.width},${crop.height}`,
    "within viewport bounds",
    valid,
  );
}
