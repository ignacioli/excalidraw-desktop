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
          transformCallback(callback: (...args: unknown[]) => void): number;
          unregisterCallback(callbackId: number): void;
          metadata: { currentWindow: { label: string } };
          invoke(
            command: string,
            args?: Record<string, unknown>,
          ): Promise<unknown>;
        };
        __TAURI_EVENT_PLUGIN_INTERNALS__?: {
          unregisterListener(event: string, eventId: number): void;
        };
        __browserTauriEmit?: (event: string, payload: unknown) => void;
      };

      const browser = globalThis as unknown as HarnessWindow;
      const fileKey = `excalidraw-e2e:file:${path}`;
      let nextDialogPath = 0;
      let checkpointCount = 0;
      let nextCallbackId = 1;
      const callbacks = new Map<
        number,
        (event: { event: string; id: number; payload: unknown }) => void
      >();
      const listeners = new Map<string, Set<number>>();
      if (
        initialScene !== undefined &&
        browser.localStorage.getItem(fileKey) === null
      ) {
        browser.localStorage.setItem(fileKey, initialScene);
      }

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
          if (command === "workspace_list" || command === "workspace_recent_list") {
            return [];
          }
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

export async function emitBrowserTauriEvent(
  page: Page,
  event: string,
  payload: unknown,
): Promise<void> {
  await page.evaluate(
    ({ eventName, eventPayload }) => {
      const emit = (
        globalThis as typeof globalThis & {
          __browserTauriEmit?: (name: string, value: unknown) => void;
        }
      ).__browserTauriEmit;
      if (emit === undefined) {
        throw new Error("Browser Tauri events are not installed.");
      }
      emit(eventName, eventPayload);
    },
    { eventName: event, eventPayload: payload },
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
