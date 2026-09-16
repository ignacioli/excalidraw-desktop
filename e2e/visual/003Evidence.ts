import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const GATE_IDS = [
  "VSL-001",
  "HF2-01",
  "HF2-02",
  "HF2-03",
  "HF2-04",
  "HF2-05",
  "HF2-06",
  "FINAL-003",
  "T023b",
  "T024",
] as const;

export const EVIDENCE_ROUTES = [
  "shell-filesystem",
  "semantic-browser",
  "macos-accessibility",
  "deterministic-runtime",
  "fixed-capture-review",
] as const;

export const FACT_CLASSES = [
  "repository-package-identity",
  "webview-semantic",
  "native-menu-action",
  "application-route-outcome",
  "visual-fidelity",
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
const SESSION_STATES = ["empty", "restored", "workspace", "recovery"] as const;
const VERDICTS = ["PASS", "FAIL", "BLOCKED"] as const;
const PROHIBITED_COLLECTOR_KEYS = new Set([
  "reviewer",
  "reviewerIdentity",
  "reviewerVerdict",
  "reviewedCollections",
  "productOwnerDecision",
  "productOwnerDecisionPath",
  "ownerDecision",
  "ownerRequirement",
]);

export const HF2_FONT_DEVIATION_ID = "HF2-FONT-001";
export const PLATFORM_UI_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
export const PLATFORM_MONO_FONT_STACK =
  "ui-monospace, SFMono-Regular, Menlo, monospace";

export type GateId = (typeof GATE_IDS)[number];
export type Verdict = (typeof VERDICTS)[number];
export type EvidenceRoute = (typeof EVIDENCE_ROUTES)[number];
export type FactClass = (typeof FACT_CLASSES)[number];
export type SdkMaskSurface = (typeof SDK_MASK_SURFACES)[number];

export class EvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceValidationError";
  }
}

export interface EvidenceBinding {
  readonly productCommit: string;
  readonly hf2ManifestSha256: string;
  readonly fixtureDigest: string;
  readonly harnessVersion: string;
  readonly packageArtifactSha256?: string;
}

export interface CollectorIdentity {
  readonly tool: string;
  readonly version: string;
  readonly runIdentity: string;
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

export interface EnvironmentEvidence {
  readonly schemaVersion: 1;
  readonly collectionId: string;
  readonly gateId: GateId;
  readonly route: EvidenceRoute;
  readonly binding: EvidenceBinding;
  readonly os: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly browserOrAppBuild: string;
  readonly fontReady?: true;
  readonly fontPolicy?: PlatformFontEvidence;
  readonly theme?: (typeof THEMES)[number];
  readonly sidebar?: (typeof SIDEBAR_STATES)[number];
  readonly session?: (typeof SESSION_STATES)[number];
  readonly fixture: string;
  readonly collector: CollectorIdentity;
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
  readonly schemaVersion: 1;
  readonly collectionId: string;
  readonly gateId: GateId;
  readonly binding: EvidenceBinding;
  readonly masks: readonly MaskDeclaration[];
}

export interface AssertionResult {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly tolerance: string;
  readonly result: "PASS" | "FAIL";
}

export interface EvidenceClaim {
  readonly claimId: string;
  readonly factClass: FactClass;
  readonly primaryRoute: EvidenceRoute;
  readonly result: Verdict;
  readonly artifactRefs: readonly string[];
}

export interface ArtifactDigest {
  readonly path: string;
  readonly sha256: string;
}

export interface CollectorReport {
  readonly schemaVersion: 1;
  readonly collectionId: string;
  readonly gateId: GateId;
  readonly route: EvidenceRoute;
  readonly binding: EvidenceBinding;
  readonly collector: CollectorIdentity;
  readonly environmentPath: string;
  readonly maskPath?: string;
  readonly claims: readonly EvidenceClaim[];
  readonly artifactDigests: readonly ArtifactDigest[];
  readonly collectionDigest: string;
  readonly result: Verdict;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value))
    throw new EvidenceValidationError(`${label} must be an object`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EvidenceValidationError(`${label} must be a non-empty string`);
  }
  return value;
}

function enumeration<T extends readonly string[]>(
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

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value))
    throw new EvidenceValidationError(`${label} must be an array`);
  return value;
}

function sha(value: unknown, label: string, length: 40 | 64): string {
  const candidate = string(value, label);
  if (!new RegExp(`^[0-9a-f]{${length}}$`, "u").test(candidate)) {
    throw new EvidenceValidationError(
      `${label} must be a lowercase ${length === 40 ? "SHA-1" : "SHA-256"}`,
    );
  }
  return candidate;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new EvidenceValidationError(`${label} must be a positive integer`);
  }
  return value;
}

function relativePath(value: unknown, label: string): string {
  const candidate = string(value, label);
  if (candidate.startsWith("/") || candidate.split(/[\\/]/u).includes("..")) {
    throw new EvidenceValidationError(
      `${label} must stay inside the collection`,
    );
  }
  return candidate;
}

function rejectForeignRoleFields(value: unknown, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectForeignRoleFields(entry, `${label}[${index}]`),
    );
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (PROHIBITED_COLLECTOR_KEYS.has(key)) {
        throw new EvidenceValidationError(
          `${label}.${key} crosses the collector/reviewer/owner role boundary`,
        );
      }
      rejectForeignRoleFields(entry, `${label}.${key}`);
    }
  }
}

function binding(value: unknown, label: string): EvidenceBinding {
  const item = record(value, label);
  return {
    productCommit: sha(item.productCommit, `${label}.productCommit`, 40),
    hf2ManifestSha256: sha(
      item.hf2ManifestSha256,
      `${label}.hf2ManifestSha256`,
      64,
    ),
    fixtureDigest: sha(item.fixtureDigest, `${label}.fixtureDigest`, 64),
    harnessVersion: string(item.harnessVersion, `${label}.harnessVersion`),
    ...(item.packageArtifactSha256 === undefined
      ? {}
      : {
          packageArtifactSha256: sha(
            item.packageArtifactSha256,
            `${label}.packageArtifactSha256`,
            64,
          ),
        }),
  };
}

function collector(value: unknown, label: string): CollectorIdentity {
  const item = record(value, label);
  return {
    tool: string(item.tool, `${label}.tool`),
    version: string(item.version, `${label}.version`),
    runIdentity: string(item.runIdentity, `${label}.runIdentity`),
  };
}

function fontPolicy(value: unknown): PlatformFontEvidence {
  const item = record(value, "environment.fontPolicy");
  if (
    item.deviationId !== HF2_FONT_DEVIATION_ID ||
    item.uiStack !== PLATFORM_UI_FONT_STACK ||
    item.monoStack !== PLATFORM_MONO_FONT_STACK ||
    item.remoteFontRequests !== 0 ||
    item.englishTargetVerified !== true ||
    item.unicodeFallbackVerified !== true
  ) {
    throw new EvidenceValidationError(
      "environment.fontPolicy must match HF2-FONT-001 and prove offline fallback",
    );
  }
  return {
    deviationId: HF2_FONT_DEVIATION_ID,
    uiStack: PLATFORM_UI_FONT_STACK,
    monoStack: PLATFORM_MONO_FONT_STACK,
    computedUiFamily: string(
      item.computedUiFamily,
      "environment.fontPolicy.computedUiFamily",
    ),
    computedMonoFamily: string(
      item.computedMonoFamily,
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
  rejectForeignRoleFields(value, "environment");
  const item = record(value, "environment");
  if (item.schemaVersion !== 1)
    throw new EvidenceValidationError("environment.schemaVersion must be 1");
  const route = enumeration(item.route, EVIDENCE_ROUTES, "environment.route");
  const viewport =
    item.viewport === undefined
      ? undefined
      : record(item.viewport, "environment.viewport");
  const parsedFontPolicy =
    item.fontPolicy === undefined ? undefined : fontPolicy(item.fontPolicy);
  if (
    route === "semantic-browser" &&
    (item.fontReady !== true || !parsedFontPolicy)
  ) {
    throw new EvidenceValidationError(
      "semantic-browser environment requires document.fonts.ready and HF2-FONT-001 evidence",
    );
  }
  return {
    schemaVersion: 1,
    collectionId: string(item.collectionId, "environment.collectionId"),
    gateId: enumeration(item.gateId, GATE_IDS, "environment.gateId"),
    route,
    binding: binding(item.binding, "environment.binding"),
    os: string(item.os, "environment.os"),
    ...(viewport === undefined
      ? {}
      : {
          viewport: {
            width: positiveInteger(
              viewport.width,
              "environment.viewport.width",
            ),
            height: positiveInteger(
              viewport.height,
              "environment.viewport.height",
            ),
          },
        }),
    browserOrAppBuild: string(
      item.browserOrAppBuild,
      "environment.browserOrAppBuild",
    ),
    ...(item.fontReady === true ? { fontReady: true as const } : {}),
    ...(parsedFontPolicy === undefined ? {} : { fontPolicy: parsedFontPolicy }),
    ...(item.theme === undefined
      ? {}
      : { theme: enumeration(item.theme, THEMES, "environment.theme") }),
    ...(item.sidebar === undefined
      ? {}
      : {
          sidebar: enumeration(
            item.sidebar,
            SIDEBAR_STATES,
            "environment.sidebar",
          ),
        }),
    ...(item.session === undefined
      ? {}
      : {
          session: enumeration(
            item.session,
            SESSION_STATES,
            "environment.session",
          ),
        }),
    fixture: string(item.fixture, "environment.fixture"),
    collector: collector(item.collector, "environment.collector"),
  };
}

function maskDeclaration(value: unknown, label: string): MaskDeclaration {
  const item = record(value, label);
  const selectorOrRect = string(item.selectorOrRect, `${label}.selectorOrRect`);
  if (/shell|sidebar|tab|workspace|header|\bback\b/iu.test(selectorOrRect)) {
    throw new EvidenceValidationError(`${label} may not mask shell-owned UI`);
  }
  if (item.perimeterChecked !== true || item.approved !== true) {
    throw new EvidenceValidationError(
      `${label} must be approved with its perimeter checked`,
    );
  }
  return {
    maskId: string(item.maskId, `${label}.maskId`),
    selectorOrRect,
    surface: enumeration(item.surface, SDK_MASK_SURFACES, `${label}.surface`),
    reason: string(item.reason, `${label}.reason`),
    perimeterChecked: true,
    approved: true,
  };
}

export function validateMaskEvidence(value: unknown): MaskEvidence {
  rejectForeignRoleFields(value, "mask");
  const item = record(value, "mask");
  if (item.schemaVersion !== 1)
    throw new EvidenceValidationError("mask.schemaVersion must be 1");
  return {
    schemaVersion: 1,
    collectionId: string(item.collectionId, "mask.collectionId"),
    gateId: enumeration(item.gateId, GATE_IDS, "mask.gateId"),
    binding: binding(item.binding, "mask.binding"),
    masks: array(item.masks, "mask.masks").map((entry, index) =>
      maskDeclaration(entry, `mask.masks[${index}]`),
    ),
  };
}

export function collectionDigestFor(
  artifactDigests: readonly ArtifactDigest[],
): string {
  const canonical = [...artifactDigests]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ path, sha256 }) => `${path}\u0000${sha256}`)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export function validateCollectorReport(value: unknown): CollectorReport {
  rejectForeignRoleFields(value, "collectorReport");
  const item = record(value, "collectorReport");
  if (item.schemaVersion !== 1)
    throw new EvidenceValidationError(
      "collectorReport.schemaVersion must be 1",
    );
  const route = enumeration(
    item.route,
    EVIDENCE_ROUTES,
    "collectorReport.route",
  );
  const claims = array(item.claims, "collectorReport.claims").map(
    (entry, index): EvidenceClaim => {
      const claim = record(entry, `collectorReport.claims[${index}]`);
      const primaryRoute = enumeration(
        claim.primaryRoute,
        EVIDENCE_ROUTES,
        `collectorReport.claims[${index}].primaryRoute`,
      );
      if (primaryRoute !== route)
        throw new EvidenceValidationError(
          `collectorReport.claims[${index}] must use the collection route`,
        );
      return {
        claimId: string(
          claim.claimId,
          `collectorReport.claims[${index}].claimId`,
        ),
        factClass: enumeration(
          claim.factClass,
          FACT_CLASSES,
          `collectorReport.claims[${index}].factClass`,
        ),
        primaryRoute,
        result: enumeration(
          claim.result,
          VERDICTS,
          `collectorReport.claims[${index}].result`,
        ),
        artifactRefs: array(
          claim.artifactRefs,
          `collectorReport.claims[${index}].artifactRefs`,
        ).map((artifact, artifactIndex) =>
          relativePath(
            artifact,
            `collectorReport.claims[${index}].artifactRefs[${artifactIndex}]`,
          ),
        ),
      };
    },
  );
  const artifactDigests = array(
    item.artifactDigests,
    "collectorReport.artifactDigests",
  ).map((entry, index): ArtifactDigest => {
    const artifact = record(entry, `collectorReport.artifactDigests[${index}]`);
    return {
      path: relativePath(
        artifact.path,
        `collectorReport.artifactDigests[${index}].path`,
      ),
      sha256: sha(
        artifact.sha256,
        `collectorReport.artifactDigests[${index}].sha256`,
        64,
      ),
    };
  });
  const collectionDigest = sha(
    item.collectionDigest,
    "collectorReport.collectionDigest",
    64,
  );
  if (collectionDigest !== collectionDigestFor(artifactDigests)) {
    throw new EvidenceValidationError(
      "collectorReport.collectionDigest does not match artifactDigests",
    );
  }
  return {
    schemaVersion: 1,
    collectionId: string(item.collectionId, "collectorReport.collectionId"),
    gateId: enumeration(item.gateId, GATE_IDS, "collectorReport.gateId"),
    route,
    binding: binding(item.binding, "collectorReport.binding"),
    collector: collector(item.collector, "collectorReport.collector"),
    environmentPath: relativePath(
      item.environmentPath,
      "collectorReport.environmentPath",
    ),
    ...(item.maskPath === undefined
      ? {}
      : { maskPath: relativePath(item.maskPath, "collectorReport.maskPath") }),
    claims,
    artifactDigests,
    collectionDigest,
    result: enumeration(item.result, VERDICTS, "collectorReport.result"),
  };
}

async function writeValidatedJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
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

export async function writeCollectorReport(
  path: string,
  value: unknown,
): Promise<CollectorReport> {
  const evidence = validateCollectorReport(value);
  await writeValidatedJson(path, evidence);
  return evidence;
}
