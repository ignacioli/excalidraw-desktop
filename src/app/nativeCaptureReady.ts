import { invoke } from "@tauri-apps/api/core";

export const NATIVE_CAPTURE_SCHEMA_VERSION = 1 as const;
export const NATIVE_CAPTURE_STATE_FINGERPRINT_VERSION =
  "shell-state-v1" as const;

export interface NativeCaptureStateProjection {
  readonly gateId: string;
  readonly theme: "light" | "dark";
  readonly sessionState: "empty" | "restored" | "workspace" | "recovery";
  readonly sidebarState: "hidden" | "overlay" | "pinned";
  readonly workspaceName: string | null;
  readonly selectedDirectory: string | null;
  readonly tabs: readonly string[];
  readonly activeDocument: string | null;
  readonly unsaved: boolean;
  readonly fixtureDigest: string;
}

export interface NativeCaptureBootstrap {
  readonly schemaVersion: typeof NATIVE_CAPTURE_SCHEMA_VERSION;
  readonly runId: string;
  readonly runNonce: string;
  readonly gateId: string;
  readonly productCommit: string;
  readonly packageArtifactSha256: string;
  readonly fixtureDigest: string;
  readonly expectedStateFingerprint: string;
  readonly stateFingerprintVersion: typeof NATIVE_CAPTURE_STATE_FINGERPRINT_VERSION;
}

export interface NativeCaptureObservationInput {
  readonly theme: NativeCaptureStateProjection["theme"];
  readonly sessionState: NativeCaptureStateProjection["sessionState"];
  readonly sidebarState: NativeCaptureStateProjection["sidebarState"];
  readonly workspaceName: string | null;
  readonly selectedDirectory: string | null;
  readonly tabs: readonly string[];
  readonly activeDocument: string | null;
  readonly unsaved: boolean;
  readonly pendingOperations: number;
}

interface NativeCaptureReadyInput {
  readonly schemaVersion: typeof NATIVE_CAPTURE_SCHEMA_VERSION;
  readonly runId: string;
  readonly runNonce: string;
  readonly gateId: string;
  readonly productCommit: string;
  readonly packageArtifactSha256: string;
  readonly stateFingerprint: string;
  readonly stateFingerprintVersion: typeof NATIVE_CAPTURE_STATE_FINGERPRINT_VERSION;
  readonly fontReady: true;
  readonly remoteFontRequests: number;
  readonly stableFrames: number;
  readonly pendingOperations: number;
  readonly logicalWindow: { readonly width: number; readonly height: number };
  readonly frontmost: boolean;
}

let publishedBinding: string | null = null;

export function deriveNativeCaptureSessionState(input: {
  readonly showWelcome: boolean;
  readonly currentWorkspaceId: string | null;
  readonly recoveryCandidateCount: number;
}): NativeCaptureStateProjection["sessionState"] {
  if (input.showWelcome) return "empty";
  if (input.currentWorkspaceId !== null) return "workspace";
  if (input.recoveryCandidateCount > 0) return "recovery";
  return "restored";
}

export function canonicalNativeCaptureJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalNativeCaptureJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalNativeCaptureJson(record[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function hashNativeCaptureState(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalNativeCaptureJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function remoteFontRequestCount(): number {
  return performance.getEntriesByType("resource").filter((entry) => {
    const resource = entry as PerformanceResourceTiming;
    if (resource.initiatorType !== "font") return false;
    try {
      const url = new URL(resource.name);
      return !["tauri.localhost", "localhost", "127.0.0.1"].includes(
        url.hostname,
      );
    } catch {
      return true;
    }
  }).length;
}

async function waitForStableFrames(projection: NativeCaptureStateProjection) {
  const expected = canonicalNativeCaptureJson(projection);
  let stableFrames = 0;
  for (let attempt = 0; attempt < 4 && stableFrames < 2; attempt += 1) {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    if (canonicalNativeCaptureJson(projection) === expected) stableFrames += 1;
    else stableFrames = 0;
  }
  return stableFrames;
}

export async function publishNativeCaptureReady(
  observation: NativeCaptureObservationInput,
): Promise<boolean> {
  const bootstrap = await invoke<NativeCaptureBootstrap | null>(
    "native_capture_bootstrap",
  );
  if (bootstrap === null) return false;
  const bindingKey = `${bootstrap.runId}:${bootstrap.gateId}:${bootstrap.packageArtifactSha256}`;
  if (publishedBinding === bindingKey) return true;
  const projection: NativeCaptureStateProjection = {
    gateId: bootstrap.gateId,
    theme: observation.theme,
    sessionState: observation.sessionState,
    sidebarState: observation.sidebarState,
    workspaceName: observation.workspaceName,
    selectedDirectory: observation.selectedDirectory,
    tabs: [...observation.tabs],
    activeDocument: observation.activeDocument,
    unsaved: observation.unsaved,
    fixtureDigest: bootstrap.fixtureDigest,
  };
  await document.fonts.ready;
  const stableFrames = await waitForStableFrames(projection);
  const stateFingerprint = await hashNativeCaptureState(projection);
  if (
    stateFingerprint !== bootstrap.expectedStateFingerprint ||
    observation.pendingOperations !== 0 ||
    stableFrames < 2
  ) {
    return false;
  }
  const ready: NativeCaptureReadyInput = {
    schemaVersion: NATIVE_CAPTURE_SCHEMA_VERSION,
    runId: bootstrap.runId,
    runNonce: bootstrap.runNonce,
    gateId: bootstrap.gateId,
    productCommit: bootstrap.productCommit,
    packageArtifactSha256: bootstrap.packageArtifactSha256,
    stateFingerprint,
    stateFingerprintVersion: NATIVE_CAPTURE_STATE_FINGERPRINT_VERSION,
    fontReady: true,
    remoteFontRequests: remoteFontRequestCount(),
    stableFrames,
    pendingOperations: observation.pendingOperations,
    logicalWindow: { width: window.innerWidth, height: window.innerHeight },
    frontmost: document.visibilityState === "visible" && document.hasFocus(),
  };
  await invoke("native_capture_publish_ready", { ready });
  publishedBinding = bindingKey;
  return true;
}

export function resetNativeCaptureReadyForTests(): void {
  publishedBinding = null;
}
