import type { Page } from "@playwright/test";

const DEFAULT_PATH = "/virtual/us1-drawing.excalidraw";

export async function installBrowserTauriHarness(
  page: Page,
  documentPath = DEFAULT_PATH,
  initialSceneJson?: string,
  dialogPaths: readonly string[] = [documentPath],
  checkpointFailureAfter?: number,
): Promise<void> {
  await page.addInitScript(
    ({ path, emptyScene, initialScene, paths, failCheckpointAfter }) => {
      type BrowserStorage = {
        getItem(key: string): string | null;
        setItem(key: string, value: string): void;
      };
      type HarnessWindow = {
        localStorage: BrowserStorage;
        __TAURI_INTERNALS__?: {
          invoke(
            command: string,
            args?: Record<string, unknown>,
          ): Promise<unknown>;
        };
      };

      const browser = globalThis as unknown as HarnessWindow;
      const fileKey = `excalidraw-e2e:file:${path}`;
      let nextDialogPath = 0;
      let checkpointCount = 0;
      if (
        initialScene !== undefined &&
        browser.localStorage.getItem(fileKey) === null
      ) {
        browser.localStorage.setItem(fileKey, initialScene);
      }

      browser.__TAURI_INTERNALS__ = {
        async invoke(command, args = {}) {
          if (
            command === "plugin:dialog|open" ||
            command === "plugin:dialog|save"
          ) {
            const selected = paths[Math.min(nextDialogPath, paths.length - 1)];
            nextDialogPath += 1;
            return selected ?? null;
          }
          const requestedPath =
            typeof args.path === "string" ? args.path : path;
          const requestedFileKey = `excalidraw-e2e:file:${requestedPath}`;
          const requestedDraftKey = `excalidraw-e2e:draft:${requestedPath}`;
          if (command === "doc_open") {
            const sceneJson =
              browser.localStorage.getItem(requestedFileKey) ?? emptyScene;
            return {
              scene: JSON.parse(sceneJson),
              baseHash: `browser-${sceneJson.length}`,
              hasNewerDraft: false,
            };
          }
          if (command === "doc_save_draft") {
            const sceneJson = String(args.sceneJson ?? "");
            browser.localStorage.setItem(requestedDraftKey, sceneJson);
            return {
              contentHash: `draft-${sceneJson.length}`,
              savedAt: Date.now(),
            };
          }
          if (command === "doc_checkpoint") {
            if (
              failCheckpointAfter !== undefined &&
              checkpointCount >= failCheckpointAfter
            ) {
              throw {
                code: "DISK_FULL",
                message: "No space left on device",
                retriable: true,
              };
            }
            checkpointCount += 1;
            const sceneJson = String(args.sceneJson ?? "");
            browser.localStorage.setItem(requestedFileKey, sceneJson);
            return {
              newBaseHash: `browser-${sceneJson.length}`,
              mtime: Date.now(),
            };
          }
          if (command === "doc_close") {
            return {};
          }
          throw new Error(`Unexpected browser harness command: ${command}`);
        },
      };
    },
    {
      path: documentPath,
      paths: [...dialogPaths],
      failCheckpointAfter: checkpointFailureAfter,
      initialScene: initialSceneJson,
      emptyScene: JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "excalidraw-desktop-e2e",
        elements: [],
        appState: {},
        files: {},
      }),
    },
  );
}

export async function readHarnessFile(
  page: Page,
  documentPath = DEFAULT_PATH,
): Promise<string | null> {
  return page.evaluate(
    (path) => globalThis.localStorage.getItem(`excalidraw-e2e:file:${path}`),
    documentPath,
  );
}

export async function readHarnessDraft(
  page: Page,
  documentPath = DEFAULT_PATH,
): Promise<string | null> {
  return page.evaluate(
    (path) => globalThis.localStorage.getItem(`excalidraw-e2e:draft:${path}`),
    documentPath,
  );
}
