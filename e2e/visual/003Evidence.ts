import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const GATE_IDS = [
  "VSL-001",
  "HF2-01",
  "HF2-02",
  "HF2-04",
  "HF2-05",
  "HF2-06",
  "FINAL-003",
] as const;

export const LEGACY_CHECK_IDS = [
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
] as const;

const SDK_MASK_SURFACES = [
  "canvas",
  "editor-toolbar",
  "library",
  "presentation",
] as const;

const THEMES = ["light", "dark"] as const;
const SIDEBAR_STATES = ["hidden", "overlay", "pinned"] as const;
const SESSION_STATES = ["empty", "restored"] as const;
const VERDICTS = ["PASS", "FAIL", "BLOCKED"] as const;
const OWNER_DECISIONS = ["APPROVED", "PENDING", "REJECTED"] as const;
const FINDING_SEVERITIES = [
  "INFO",
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const;

export const HF2_FONT_DEVIATION_ID = "HF2-FONT-001";
export const PLATFORM_UI_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const PLATFORM_MONO_FONT_STACK =
  "ui-monospace, SFMono-Regular, Menlo, monospace";

export type GateId = (typeof GATE_IDS)[number];
export type Verdict = (typeof VERDICTS)[number];
export type ProductOwnerDecision = (typeof OWNER_DECISIONS)[number];
export type SdkMaskSurface = (typeof SDK_MASK_SURFACES)[number];

export class EvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceValidationError";
  }
}

export interface RuntimeIdentity {
  readonly agent: string;
  readonly runIdentity: string;
  readonly configuredModel: string;
  readonly configuredReasoningEffort: string;
}

export interface EnvironmentEvidence {
  readonly commit: string;
  readonly os: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly browserOrAppBuild: string;
  readonly fontReady: boolean;
  readonly fontPolicy: PlatformFontEvidence;
  readonly theme: (typeof THEMES)[number];
  readonly sidebar: (typeof SIDEBAR_STATES)[number];
  readonly session: (typeof SESSION_STATES)[number];
  readonly fixture: string;
  readonly implementation: RuntimeIdentity;
  readonly reviewer: RuntimeIdentity;
}

export interface PlatformFontEvidence {
  readonly deviationId: typeof HF2_FONT_DEVIATION_ID;
  readonly uiStack: typeof PLATFORM_UI_FONT_STACK;
  readonly monoStack: typeof PLATFORM_MONO_FONT_STACK;
  readonly computedUiFamily: string;
  readonly computedMonoFamily: string;
  readonly remoteFontRequests: 0;
  readonly englishTargetVerified: true;
  readonly unicodeFallbackVerified: true;
}

export interface MaskDeclaration {
  readonly maskId: string;
  readonly selectorOrRect: string;
  readonly surface: SdkMaskSurface;
  readonly reason: string;
  readonly perimeterChecked: true;
  readonly approved: true;
}

export interface MaskEvidence {
  readonly gateId: GateId;
  readonly masks: readonly MaskDeclaration[];
}

export interface VisualReport {
  readonly gateId: GateId;
  readonly commit: string;
  readonly baseline: { readonly path: string; readonly sha256: string };
  readonly actualPath: string;
  readonly environment: EnvironmentEvidence;
  readonly maskDeclarations: readonly MaskDeclaration[];
  readonly legacyCounts: Readonly<
    Record<(typeof LEGACY_CHECK_IDS)[number], number>
  >;
  readonly geometryAssertions: readonly AssertionResult[];
  readonly tokenAssertions: readonly AssertionResult[];
  readonly rasterSummary: RasterSummary;
  readonly findings: readonly Finding[];
  readonly reviewer: RuntimeIdentity;
  readonly reviewerVerdict: Verdict;
  readonly productOwnerDecision: ProductOwnerDecision;
  readonly productOwnerDecisionPath: string;
}

export interface AssertionResult {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly tolerance: string;
  readonly result: "PASS" | "FAIL";
}

export interface RasterSummary {
  readonly scope: "component-crops-only";
  readonly maxDiffPixelRatio: number;
  readonly threshold: number;
  readonly auxiliary: true;
}

export interface Finding {
  readonly severity: (typeof FINDING_SEVERITIES)[number];
  readonly description: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new EvidenceValidationError(`${label} must be an object`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EvidenceValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new EvidenceValidationError(`${label} must be a boolean`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new EvidenceValidationError(`${label} must be a finite number`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const number = requireFiniteNumber(value, label);
  if (!Number.isInteger(number) || number <= 0) {
    throw new EvidenceValidationError(`${label} must be a positive integer`);
  }
  return number;
}

function requireEnum<T extends readonly string[]>(
  value: unknown,
  choices: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new EvidenceValidationError(
      `${label} must be one of ${choices.join(", ")}`,
    );
  }
  return value as T[number];
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new EvidenceValidationError(`${label} must be an array`);
  }
  return value;
}

function requireCommit(value: unknown, label: string): string {
  const commit = requireString(value, label);
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new EvidenceValidationError(
      `${label} must be a 40-character lowercase SHA-1`,
    );
  }
  return commit;
}

function requireSha256(value: unknown, label: string): string {
  const sha256 = requireString(value, label);
  if (!/^[0-9a-f]{64}$/u.test(sha256)) {
    throw new EvidenceValidationError(
      `${label} must be a 64-character lowercase SHA-256`,
    );
  }
  return sha256;
}

function requireRuntimeIdentity(
  value: unknown,
  label: string,
): RuntimeIdentity {
  const record = requireRecord(value, label);
  return {
    agent: requireString(record.agent, `${label}.agent`),
    runIdentity: requireString(record.runIdentity, `${label}.runIdentity`),
    configuredModel: requireString(
      record.configuredModel,
      `${label}.configuredModel`,
    ),
    configuredReasoningEffort: requireString(
      record.configuredReasoningEffort,
      `${label}.configuredReasoningEffort`,
    ),
  };
}

function validatePlatformFontEvidence(value: unknown): PlatformFontEvidence {
  const record = requireRecord(value, "environment.fontPolicy");
  if (record.deviationId !== HF2_FONT_DEVIATION_ID) {
    throw new EvidenceValidationError(
      `environment.fontPolicy.deviationId must be ${HF2_FONT_DEVIATION_ID}`,
    );
  }
  if (record.uiStack !== PLATFORM_UI_FONT_STACK) {
    throw new EvidenceValidationError(
      "environment.fontPolicy.uiStack must match the approved platform UI stack",
    );
  }
  if (record.monoStack !== PLATFORM_MONO_FONT_STACK) {
    throw new EvidenceValidationError(
      "environment.fontPolicy.monoStack must match the approved platform mono stack",
    );
  }
  if (record.remoteFontRequests !== 0) {
    throw new EvidenceValidationError(
      "environment.fontPolicy.remoteFontRequests must be zero",
    );
  }
  if (
    record.englishTargetVerified !== true ||
    record.unicodeFallbackVerified !== true
  ) {
    throw new EvidenceValidationError(
      "environment.fontPolicy must verify English target and Unicode fallback rendering",
    );
  }
  return {
    deviationId: HF2_FONT_DEVIATION_ID,
    uiStack: PLATFORM_UI_FONT_STACK,
    monoStack: PLATFORM_MONO_FONT_STACK,
    computedUiFamily: requireString(
      record.computedUiFamily,
      "environment.fontPolicy.computedUiFamily",
    ),
    computedMonoFamily: requireString(
      record.computedMonoFamily,
      "environment.fontPolicy.computedMonoFamily",
    ),
    remoteFontRequests: 0,
    englishTargetVerified: true,
    unicodeFallbackVerified: true,
  };
}

export function validateEnvironmentEvidence(
  value: unknown,
): EnvironmentEvidence {
  const record = requireRecord(value, "environment");
  const viewport = requireRecord(record.viewport, "environment.viewport");
  const fontReady = requireBoolean(record.fontReady, "environment.fontReady");
  if (!fontReady) {
    throw new EvidenceValidationError(
      "environment.fontReady must confirm document.fonts.ready before capture",
    );
  }
  return {
    commit: requireCommit(record.commit, "environment.commit"),
    os: requireString(record.os, "environment.os"),
    viewport: {
      width: requirePositiveInteger(
        viewport.width,
        "environment.viewport.width",
      ),
      height: requirePositiveInteger(
        viewport.height,
        "environment.viewport.height",
      ),
    },
    browserOrAppBuild: requireString(
      record.browserOrAppBuild,
      "environment.browserOrAppBuild",
    ),
    fontReady,
    fontPolicy: validatePlatformFontEvidence(record.fontPolicy),
    theme: requireEnum(record.theme, THEMES, "environment.theme"),
    sidebar: requireEnum(record.sidebar, SIDEBAR_STATES, "environment.sidebar"),
    session: requireEnum(record.session, SESSION_STATES, "environment.session"),
    fixture: requireString(record.fixture, "environment.fixture"),
    implementation: requireRuntimeIdentity(
      record.implementation,
      "environment.implementation",
    ),
    reviewer: requireRuntimeIdentity(record.reviewer, "environment.reviewer"),
  };
}

function validateMaskDeclaration(
  value: unknown,
  label: string,
): MaskDeclaration {
  const record = requireRecord(value, label);
  const selectorOrRect = requireString(
    record.selectorOrRect,
    `${label}.selectorOrRect`,
  );
  if (/shell|sidebar|tab|workspace|header|\bback\b/iu.test(selectorOrRect)) {
    throw new EvidenceValidationError(`${label} may not mask shell-owned UI`);
  }
  if (record.perimeterChecked !== true || record.approved !== true) {
    throw new EvidenceValidationError(
      `${label} must have perimeterChecked and approved set to true`,
    );
  }
  return {
    maskId: requireString(record.maskId, `${label}.maskId`),
    selectorOrRect,
    surface: requireEnum(record.surface, SDK_MASK_SURFACES, `${label}.surface`),
    reason: requireString(record.reason, `${label}.reason`),
    perimeterChecked: true,
    approved: true,
  };
}

export function validateMaskEvidence(value: unknown): MaskEvidence {
  const record = requireRecord(value, "mask");
  return {
    gateId: requireEnum(record.gateId, GATE_IDS, "mask.gateId"),
    masks: requireArray(record.masks, "mask.masks").map((mask, index) =>
      validateMaskDeclaration(mask, `mask.masks[${index}]`),
    ),
  };
}

function validateAssertions(
  value: unknown,
  label: string,
): readonly AssertionResult[] {
  return requireArray(value, label).map((assertion, index) => {
    const record = requireRecord(assertion, `${label}[${index}]`);
    return {
      name: requireString(record.name, `${label}[${index}].name`),
      expected: requireString(record.expected, `${label}[${index}].expected`),
      actual: requireString(record.actual, `${label}[${index}].actual`),
      tolerance: requireString(
        record.tolerance,
        `${label}[${index}].tolerance`,
      ),
      result: requireEnum(
        record.result,
        ["PASS", "FAIL"] as const,
        `${label}[${index}].result`,
      ),
    };
  });
}

function validateFindings(value: unknown): readonly Finding[] {
  return requireArray(value, "report.findings").map((finding, index) => {
    const record = requireRecord(finding, `report.findings[${index}]`);
    return {
      severity: requireEnum(
        record.severity,
        FINDING_SEVERITIES,
        `report.findings[${index}].severity`,
      ),
      description: requireString(
        record.description,
        `report.findings[${index}].description`,
      ),
    };
  });
}

function validateLegacyCounts(value: unknown): VisualReport["legacyCounts"] {
  const record = requireRecord(value, "report.legacyCounts");
  const result = {} as Record<(typeof LEGACY_CHECK_IDS)[number], number>;
  for (const id of LEGACY_CHECK_IDS) {
    const count = requireFiniteNumber(record[id], `report.legacyCounts.${id}`);
    if (!Number.isInteger(count) || count < 0) {
      throw new EvidenceValidationError(
        `report.legacyCounts.${id} must be a non-negative integer`,
      );
    }
    result[id] = count;
  }
  return result;
}

export function validateVisualReport(value: unknown): VisualReport {
  const record = requireRecord(value, "report");
  const baseline = requireRecord(record.baseline, "report.baseline");
  const rasterSummary = requireRecord(
    record.rasterSummary,
    "report.rasterSummary",
  );
  const report: VisualReport = {
    gateId: requireEnum(record.gateId, GATE_IDS, "report.gateId"),
    commit: requireCommit(record.commit, "report.commit"),
    baseline: {
      path: requireString(baseline.path, "report.baseline.path"),
      sha256: requireSha256(baseline.sha256, "report.baseline.sha256"),
    },
    actualPath: requireString(record.actualPath, "report.actualPath"),
    environment: validateEnvironmentEvidence(record.environment),
    maskDeclarations: requireArray(
      record.maskDeclarations,
      "report.maskDeclarations",
    ).map((mask, index) =>
      validateMaskDeclaration(mask, `report.maskDeclarations[${index}]`),
    ),
    legacyCounts: validateLegacyCounts(record.legacyCounts),
    geometryAssertions: validateAssertions(
      record.geometryAssertions,
      "report.geometryAssertions",
    ),
    tokenAssertions: validateAssertions(
      record.tokenAssertions,
      "report.tokenAssertions",
    ),
    rasterSummary: {
      scope: requireEnum(
        rasterSummary.scope,
        ["component-crops-only"] as const,
        "report.rasterSummary.scope",
      ),
      maxDiffPixelRatio: requireFiniteNumber(
        rasterSummary.maxDiffPixelRatio,
        "report.rasterSummary.maxDiffPixelRatio",
      ),
      threshold: requireFiniteNumber(
        rasterSummary.threshold,
        "report.rasterSummary.threshold",
      ),
      auxiliary:
        rasterSummary.auxiliary === true
          ? true
          : (() => {
              throw new EvidenceValidationError(
                "report.rasterSummary.auxiliary must be true",
              );
            })(),
    },
    findings: validateFindings(record.findings),
    reviewer: requireRuntimeIdentity(record.reviewer, "report.reviewer"),
    reviewerVerdict: requireEnum(
      record.reviewerVerdict,
      VERDICTS,
      "report.reviewerVerdict",
    ),
    productOwnerDecision: requireEnum(
      record.productOwnerDecision,
      OWNER_DECISIONS,
      "report.productOwnerDecision",
    ),
    productOwnerDecisionPath: requireString(
      record.productOwnerDecisionPath,
      "report.productOwnerDecisionPath",
    ),
  };
  if (!report.baseline.path.startsWith("screens/")) {
    throw new EvidenceValidationError(
      "report.baseline.path must be a frozen manifest screen path",
    );
  }
  if (!report.productOwnerDecisionPath.endsWith("product-owner-decision.md")) {
    throw new EvidenceValidationError(
      "report.productOwnerDecisionPath must reference product-owner-decision.md",
    );
  }
  if (
    report.rasterSummary.maxDiffPixelRatio < 0 ||
    report.rasterSummary.threshold !== 0.01
  ) {
    throw new EvidenceValidationError(
      "report.rasterSummary must use a non-negative value and 0.01 threshold",
    );
  }
  if (
    report.productOwnerDecision === "APPROVED" &&
    report.reviewerVerdict !== "PASS"
  ) {
    throw new EvidenceValidationError(
      "owner approval requires an independent reviewer PASS",
    );
  }
  return report;
}

async function writeValidatedJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeEnvironmentEvidence(
  path: string,
  value: unknown,
): Promise<EnvironmentEvidence> {
  const evidence = validateEnvironmentEvidence(value);
  await writeValidatedJson(path, evidence);
  return evidence;
}

export async function writeMaskEvidence(
  path: string,
  value: unknown,
): Promise<MaskEvidence> {
  const evidence = validateMaskEvidence(value);
  await writeValidatedJson(path, evidence);
  return evidence;
}

export async function writeVisualReport(
  path: string,
  value: unknown,
): Promise<VisualReport> {
  const report = validateVisualReport(value);
  await writeValidatedJson(path, report);
  return report;
}

export async function writePendingProductOwnerDecision(
  path: string,
): Promise<void> {
  if (!path.endsWith("product-owner-decision.md")) {
    throw new EvidenceValidationError(
      "product-owner decision path must end in product-owner-decision.md",
    );
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "# Product-owner decision\n\n**PENDING**\n", "utf8");
}
