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
    ({ exportPaths, failReadonlyTarget, openScene }) => {
      type InvokeArgs = Record<string, unknown>;
      type BrowserWindow = Window & {
        __TAURI_INTERNALS__?: {
          invoke(command: string, args?: InvokeArgs): Promise<unknown>;
        };
      };

      const browser = globalThis as unknown as BrowserWindow & {
        __exportCalls: CapturedExport[];
        __exportStore: { files: Record<string, number[]>; tmp: string[] };
      };
      browser.__exportCalls = [];
      browser.__exportStore = { files: {}, tmp: [] };
      let saveDialogCount = 0;

      browser.__TAURI_INTERNALS__ = {
        async invoke(command, args = {}) {
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
            return [];
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
              path: args.path === null || args.path === undefined
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
    },
    {
      exportPaths: [...options.exportPaths],
      failReadonlyTarget: options.failReadonlyTarget ?? null,
      openScene: options.openScene ?? null,
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

export async function exportBytes(page: Page, targetPath: string): Promise<Uint8Array> {
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
