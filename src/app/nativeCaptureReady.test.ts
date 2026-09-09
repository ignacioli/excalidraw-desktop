import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalNativeCaptureJson,
  hashNativeCaptureState,
  publishNativeCaptureReady,
  resetNativeCaptureReadyForTests,
} from "./nativeCaptureReady";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const observation = {
  theme: "light",
  sessionState: "workspace",
  sidebarState: "pinned",
  workspaceName: "Design Workspace",
  selectedDirectory: "flows",
  tabs: ["Overview.excalidraw"],
  activeDocument: "Overview.excalidraw",
  unsaved: false,
  pendingOperations: 0,
} as const;

describe("native capture ready probe", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    resetNativeCaptureReadyForTests();
  });

  it("canonicalizes and hashes shell state independently of key order", async () => {
    expect(canonicalNativeCaptureJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(await hashNativeCaptureState({ b: 2, a: 1 })).toBe(
      await hashNativeCaptureState({ a: 1, b: 2 }),
    );
  });

  it("is inert when the production backend has no nonce-bound capture run", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    await expect(publishNativeCaptureReady(observation)).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("native_capture_bootstrap");
  });

  it("publishes only a matching, stable, font-ready observation", async () => {
    const expectedStateFingerprint = await hashNativeCaptureState({
      gateId: "VSL-001",
      theme: observation.theme,
      sessionState: observation.sessionState,
      sidebarState: observation.sidebarState,
      workspaceName: observation.workspaceName,
      selectedDirectory: observation.selectedDirectory,
      tabs: observation.tabs,
      activeDocument: observation.activeDocument,
      unsaved: observation.unsaved,
      fixtureDigest: "12".repeat(32),
    });
    const bootstrap = {
      schemaVersion: 1,
      runId: "run-001",
      runNonce: "ab".repeat(32),
      gateId: "VSL-001",
      productCommit: "cd".repeat(20),
      packageArtifactSha256: "ef".repeat(32),
      fixtureDigest: "12".repeat(32),
      expectedStateFingerprint,
      stateFingerprintVersion: "shell-state-v1",
    } as const;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.mocked(invoke)
      .mockResolvedValueOnce(bootstrap)
      .mockResolvedValueOnce(undefined);

    await expect(publishNativeCaptureReady(observation)).resolves.toBe(true);
    expect(invoke).toHaveBeenLastCalledWith(
      "native_capture_publish_ready",
      expect.objectContaining({
        ready: expect.objectContaining({
          runNonce: bootstrap.runNonce,
          stableFrames: 2,
          fontReady: true,
          pendingOperations: 0,
        }),
      }),
    );
  });
});
