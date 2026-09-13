import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  HF2_FONT_DEVIATION_ID,
  LEGACY_CHECK_IDS,
  PLATFORM_MONO_FONT_STACK,
  PLATFORM_UI_FONT_STACK,
  collectionDigestFor,
  type AssertionResult,
  type EvidenceBinding,
  type GateId,
  type MaskDeclaration,
  writeCollectorReport,
  writeEnvironmentEvidence,
  writeMaskEvidence,
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

export interface ComponentCropComparison {
  readonly componentId: string;
  readonly baselineComponentId: string;
  readonly baselineSha256: string;
  readonly actualSha256: string;
  readonly fontReady: boolean;
  readonly maxDiffPixelRatio: number;
  readonly threshold?: number;
}

export interface ShellCollectionInput {
  readonly collectionDir: string;
  readonly gateId: GateId;
  readonly collectionId: string;
  readonly binding: EvidenceBinding;
  readonly actualPath: string;
  readonly baselinePath: string;
  readonly baselineSha256: string;
  readonly os: string;
  readonly browserOrAppBuild: string;
  readonly theme: "light" | "dark";
  readonly sidebar: "hidden" | "overlay" | "pinned";
  readonly session: "empty" | "restored" | "workspace" | "recovery";
  readonly fixture: string;
  readonly fontPolicy: {
    readonly computedUiFamily: string;
    readonly computedMonoFamily: string;
    readonly remoteFontRequests: number;
    readonly englishTargetVerified: boolean;
    readonly unicodeFallbackVerified: boolean;
  };
  readonly masks: readonly MaskDeclaration[];
  readonly legacyCounts: Readonly<Partial<Record<LegacyCheckId, number>>>;
  readonly semanticAssertions: readonly AssertionResult[];
  readonly geometryAssertions: readonly AssertionResult[];
  readonly tokenAssertions: readonly AssertionResult[];
  readonly cropComparisons: readonly ComponentCropComparison[];
}

export const VISUAL_VIEWPORT: ViewportSize = {
  width: 1280,
  height: 760,
};

export const COMPONENT_CROP_THRESHOLD = 0.01;

export const SDK_BOUNDARY_SELECTOR =
  ".canvas-document:not([hidden]) .excalidraw-editor";

/**
 * Selectors owned by the application shell.  The editor wrapper is the only
 * SDK boundary selector: it is rendered by Excalidraw Desktop, while all
 * descendants remain deliberately opaque to these checks.
 */
export const SHELL_VISUAL_SELECTORS = [
  ".app-shell-tabs",
  ".file-sidebar",
  ".workspace-panel-header",
  ".workspace-tree-row",
  ".workspace-tree-label",
  ".tab-list",
  ".welcome-screen",
  SDK_BOUNDARY_SELECTOR,
] as const;

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

export function assertComponentCropDiff(
  name: string,
  maxDiffPixelRatio: number,
  threshold = COMPONENT_CROP_THRESHOLD,
): AssertionResult {
  return result(
    `component-crop-diff.${name}`,
    `<=${threshold}`,
    String(maxDiffPixelRatio),
    "auxiliary; component crop only",
    Number.isFinite(maxDiffPixelRatio) &&
      Number.isFinite(threshold) &&
      threshold >= 0 &&
      maxDiffPixelRatio >= 0 &&
      maxDiffPixelRatio <= threshold,
  );
}

export function assertBoundComponentCropComparison(
  comparison: ComponentCropComparison,
): AssertionResult {
  const threshold = comparison.threshold ?? COMPONENT_CROP_THRESHOLD;
  const hashesAreValid =
    /^[0-9a-f]{64}$/u.test(comparison.baselineSha256) &&
    /^[0-9a-f]{64}$/u.test(comparison.actualSha256);
  const sameSemanticComponent =
    comparison.componentId === comparison.baselineComponentId;
  const ratioPass =
    Number.isFinite(comparison.maxDiffPixelRatio) &&
    comparison.maxDiffPixelRatio >= 0 &&
    comparison.maxDiffPixelRatio <= threshold;
  return result(
    `component-crop-binding.${comparison.componentId}`,
    `same semantic component; fonts ready; valid digests; diff <=${threshold}`,
    `baseline=${comparison.baselineComponentId}; fontReady=${comparison.fontReady}; diff=${comparison.maxDiffPixelRatio}`,
    "auxiliary; component crop only",
    sameSemanticComponent &&
      comparison.fontReady &&
      hashesAreValid &&
      ratioPass,
  );
}

export function assertNoPrivateSdkSelectors(
  selectors: readonly string[],
): AssertionResult {
  const privateSelector =
    /(?:\.excalidraw-(?!editor\b)|\.App-menu|\.ToolIcon|\[data-testid\s*=\s*["'](?:library|canvas|editor|toolbar))/iu;
  const offenders = selectors.filter((selector) =>
    privateSelector.test(selector),
  );
  return result(
    "sdk-boundary.private-selectors",
    "0",
    String(offenders.length),
    "shell selectors only",
    offenders.length === 0,
  );
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function writeShellCollection(
  input: ShellCollectionInput,
): Promise<void> {
  await mkdir(dirname(input.collectionDir), { recursive: true });
  await mkdir(input.collectionDir);
  const actualOutput = join(input.collectionDir, "actual.png");
  await copyFile(input.actualPath, actualOutput, fsConstants.COPYFILE_EXCL);
  await writeFile(
    join(input.collectionDir, "baseline.sha256"),
    `${input.baselinePath} ${input.baselineSha256}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  await writeEnvironmentEvidence(
    join(input.collectionDir, "environment.json"),
    {
      schemaVersion: 1,
      collectionId: input.collectionId,
      gateId: input.gateId,
      route: "semantic-browser",
      binding: input.binding,
      os: input.os,
      viewport: VISUAL_VIEWPORT,
      browserOrAppBuild: input.browserOrAppBuild,
      fontReady: true,
      fontPolicy: {
        deviationId: HF2_FONT_DEVIATION_ID,
        uiStack: PLATFORM_UI_FONT_STACK,
        monoStack: PLATFORM_MONO_FONT_STACK,
        ...input.fontPolicy,
      },
      theme: input.theme,
      sidebar: input.sidebar,
      session: input.session,
      fixture: input.fixture,
      collector: {
        tool: "playwright-003-shell",
        version: "3",
        runIdentity: `${input.binding.productCommit}:${input.collectionId}`,
      },
    },
  );
  await writeMaskEvidence(join(input.collectionDir, "mask.json"), {
    schemaVersion: 1,
    collectionId: input.collectionId,
    gateId: input.gateId,
    binding: input.binding,
    masks: input.masks,
  });
  const cropAssertions = input.cropComparisons.map(
    assertBoundComponentCropComparison,
  );
  const legacyAssertions = assertLegacyCounts(input.legacyCounts);
  const assertions = {
    schemaVersion: 1,
    legacyCounts: input.legacyCounts,
    legacyAssertions,
    semanticAssertions: input.semanticAssertions,
    geometryAssertions: input.geometryAssertions,
    tokenAssertions: input.tokenAssertions,
    cropComparisons: input.cropComparisons,
    cropAssertions,
  };
  await writeFile(
    join(input.collectionDir, "assertions.json"),
    `${JSON.stringify(assertions, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  const artifactNames = [
    "actual.png",
    "assertions.json",
    "baseline.sha256",
    "environment.json",
    "mask.json",
  ];
  const artifactDigests = await Promise.all(
    artifactNames.map(async (artifactPath) => ({
      path: artifactPath,
      sha256: await sha256File(join(input.collectionDir, artifactPath)),
    })),
  );
  const allAssertions = [
    ...legacyAssertions,
    ...input.semanticAssertions,
    ...input.geometryAssertions,
    ...input.tokenAssertions,
    ...cropAssertions,
  ];
  const result = allAssertions.every((assertion) => assertion.result === "PASS")
    ? "PASS"
    : "FAIL";
  const collectorReport = {
    schemaVersion: 1,
    collectionId: input.collectionId,
    gateId: input.gateId,
    route: "semantic-browser",
    binding: input.binding,
    collector: {
      tool: "playwright-003-shell",
      version: "3",
      runIdentity: `${input.binding.productCommit}:${input.collectionId}`,
    },
    environmentPath: "environment.json",
    maskPath: "mask.json",
    claims: [
      {
        claimId: `${input.gateId}-shell-semantic`,
        factClass: "webview-semantic",
        primaryRoute: "semantic-browser",
        result,
        artifactRefs: artifactNames,
      },
    ],
    artifactDigests,
    collectionDigest: collectionDigestFor(artifactDigests),
    result,
  } as const;
  await writeCollectorReport(
    join(input.collectionDir, "collector-report.json"),
    collectorReport,
  );
  await writeFile(
    join(input.collectionDir, "collector-report.md"),
    `# ${input.gateId} semantic browser collection\n\n- Collection: \`${input.collectionId}\`\n- Result: **${result}**\n- Baseline: \`${basename(input.baselinePath)}\`\n- Collection digest: \`${collectorReport.collectionDigest}\`\n- Visual reviewer verdict: not authored by this collector\n`,
    { encoding: "utf8", flag: "wx" },
  );
}
