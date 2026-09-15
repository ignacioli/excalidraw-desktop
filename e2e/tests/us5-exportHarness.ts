import type { Page } from "@playwright/test";

export interface CapturedExport {
  path: string | null;
  sceneJson: string;
  format: "png" | "svg";
  targetPath: string;
  options: {
    scale?: number;
    background?: string;
    theme?: string;
  };
  bytes: number[];
}

export const EXPORT_WORKSPACE = {
  id: "export-workspace",
  name: "Exports",
  rootPath: "/virtual",
  createdAt: 1,
} as const;

interface ExportHarnessOptions {
  exportPaths: readonly string[];
  failReadonlyTarget?: string;
  openScene?: Record<string, unknown>;
}

declare global {
  interface Window {
    __exportCalls: CapturedExport[];
    __exportStore: {
      files: Record<string, number[]>;
      tmp: string[];
    };
  }
}

export async function installExportHarness(
  page: Page,
  options: ExportHarnessOptions,
): Promise<void> {
  await page.addInitScript(
    ({ exportPaths, failReadonlyTarget, openScene, workspace }) => {
      type InvokeArgs = Record<string, unknown>;
      type BrowserWindow = Window & {
        __TAURI_INTERNALS__?: {
          transformCallback(callback: (...args: unknown[]) => void): number;
          unregisterCallback(callbackId: number): void;
          metadata: { currentWindow: { label: string } };
          invoke(command: string, args?: InvokeArgs): Promise<unknown>;
        };
        __TAURI_EVENT_PLUGIN_INTERNALS__?: {
          unregisterListener(event: string, eventId: number): void;
        };
      };

      const browser = globalThis as unknown as BrowserWindow & {
        __exportCalls: CapturedExport[];
        __exportStore: { files: Record<string, number[]>; tmp: string[] };
        __browserTauriEmit?: (event: string, payload: unknown) => void;
      };
      browser.__exportCalls = [];
      browser.__exportStore = { files: {}, tmp: [] };
      let saveDialogCount = 0;
      let nextCallbackId = 1;
      const callbacks = new Map<
        number,
        (event: { event: string; id: number; payload: unknown }) => void
      >();
      const listeners = new Map<string, Set<number>>();

      browser.__TAURI_INTERNALS__ = {
        transformCallback(callback) {
          const callbackId = nextCallbackId++;
          callbacks.set(callbackId, callback);
          return callbackId;
        },
        unregisterCallback(callbackId) {
          callbacks.delete(callbackId);
        },
        metadata: { currentWindow: { label: "main" } },
        async invoke(command, args = {}) {
          if (command === "plugin:event|listen") {
            const event = String(args.event ?? "");
            const callbackId = Number(args.handler);
            const eventListeners = listeners.get(event) ?? new Set<number>();
            eventListeners.add(callbackId);
            listeners.set(event, eventListeners);
            return callbackId;
          }
          if (command === "plugin:event|unlisten") {
            const event = String(args.event ?? "");
            const callbackId = Number(args.eventId);
            listeners.get(event)?.delete(callbackId);
            callbacks.delete(callbackId);
            return {};
          }
          if (
            command === "plugin:event|emit" ||
            command === "plugin:event|emit_to"
          ) {
            return {};
          }
          if (command === "plugin:window|on_close_requested") {
            return 1;
          }
          if (command === "plugin:window|destroy") {
            return {};
          }
          if (command === "app_handshake") {
            return {
              contractVersion: 2,
              appVersion: "0.2.0-e2e",
              abnormalExit: false,
              pendingOpenPaths: [],
            };
          }
          if (command === "recovery_list") {
            return [];
          }
          if (command === "plugin:dialog|open") {
            return "/virtual/drawing.excalidraw";
          }
          if (command === "plugin:dialog|save") {
            const selected =
              exportPaths[Math.min(saveDialogCount, exportPaths.length - 1)];
            saveDialogCount += 1;
            return selected;
          }
          if (command === "workspace_list") {
            return [{ ...workspace }];
          }
          if (command === "workspace_recent_list") {
            return [{ ...workspace }];
          }
          if (command === "workspace_entry_list") {
            if (String(args.parentRelativePath ?? "") !== "") {
              return [];
            }
            return [
              {
                workspaceId: workspace.id,
                kind: "drawing",
                canonicalPath: `${workspace.rootPath}/drawing.excalidraw`,
                relativePath: "drawing.excalidraw",
                parentRelativePath: "",
                name: "drawing.excalidraw",
                displayName: "drawing",
                mtime: 1,
                fileSize: 100,
              },
            ];
          }
          if (command === "doc_open") {
            return {
              scene: openScene ?? {
                type: "excalidraw",
                version: 2,
                source: "excalidraw-desktop-e2e",
                elements: [],
                appState: {},
                files: {},
              },
              baseHash: "browser-base",
              hasNewerDraft: false,
            };
          }
          if (command === "doc_save_draft") {
            return { contentHash: "browser-draft", savedAt: Date.now() };
          }
          if (command === "doc_checkpoint") {
            return { newBaseHash: "browser-base", mtime: Date.now() };
          }
          if (command === "doc_close") {
            return {};
          }
          if (command === "doc_export") {
            const bytes = Array.isArray(args.bytes)
              ? args.bytes.map(Number)
              : [];
            const targetPath = String(args.targetPath ?? "");
            const options = (args.options ?? {}) as {
              scale?: unknown;
              background?: unknown;
              theme?: unknown;
            };
            browser.__exportCalls.push({
              path:
                args.path === null || args.path === undefined
                  ? null
                  : String(args.path),
              sceneJson: String(args.sceneJson ?? ""),
              format: String(args.format) === "svg" ? "svg" : "png",
              targetPath,
              options: {
                scale: Number(options.scale ?? 1),
                background: String(options.background ?? "transparent"),
                theme: String(options.theme ?? "light"),
              },
              bytes,
            });
            if (targetPath === failReadonlyTarget) {
              throw {
                code: "IO_ERROR",
                message: "The destination is read-only",
                retriable: true,
              };
            }
            browser.__exportStore.files[targetPath] = bytes;
            return { writtenPath: targetPath };
          }
          throw new Error(`Unexpected export harness command: ${command}`);
        },
      };
      browser.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener(event, eventId) {
          listeners.get(event)?.delete(eventId);
          callbacks.delete(eventId);
        },
      };
      browser.__browserTauriEmit = (event, payload) => {
        for (const callbackId of listeners.get(event) ?? []) {
          callbacks.get(callbackId)?.({ event, id: callbackId, payload });
        }
      };
    },
    {
      exportPaths: [...options.exportPaths],
      failReadonlyTarget: options.failReadonlyTarget ?? null,
      openScene: options.openScene ?? null,
      workspace: EXPORT_WORKSPACE,
    },
  );
}

export async function capturedExport(
  page: Page,
  targetPath: string,
): Promise<CapturedExport> {
  return page.evaluate((target) => {
    const windowWithExports = globalThis as unknown as {
      __exportCalls: CapturedExport[];
    };
    const capture = windowWithExports.__exportCalls.find(
      (call) => call.targetPath === target,
    );
    if (capture === undefined) {
      throw new Error(`No export captured for ${target}`);
    }
    return capture;
  }, targetPath);
}

export async function exportBytes(
  page: Page,
  targetPath: string,
): Promise<Uint8Array> {
  const capture = await capturedExport(page, targetPath);
  return Uint8Array.from(capture.bytes);
}

export async function waitForDrawingFonts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const families = ["Virgil", "Excalifont", "Xiaolai"];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const missing = families.filter(
        (family) => !document.fonts.check(`16px "${family}"`),
      );
      if (missing.length === 0) {
        return;
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
      await document.fonts.ready;
    }
  });
}

export async function pngDimensions(bytes: Uint8Array): Promise<{
  width: number;
  height: number;
}> {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    throw new Error("Captured export is not a PNG file");
  }
  const width =
    (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
  const height =
    (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  return { width, height };
}
