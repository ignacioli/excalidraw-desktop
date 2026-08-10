import type { Page } from "@playwright/test";

const EMPTY_SCENE = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "excalidraw-desktop-e2e",
  elements: [],
  appState: {},
  files: {},
});

/**
 * Browser UI mock for US4: the same `__TAURI_INTERNALS__` invoke mock style as
 * the other browser-ui suites, plus a working event channel so the app's
 * `listen` calls receive `file-changed` / `conflict-detected` events.
 */
export async function installUs4Harness(
  page: Page,
  initialFiles: readonly string[] = ["drawing.excalidraw"],
): Promise<void> {
  await page.addInitScript(
    ({ files, emptyScene }) => {
      type EventHandler = (event: {
        event: string;
        id: number;
        payload: unknown;
      }) => void;

      const browser = globalThis as typeof globalThis & {
        __TAURI_INTERNALS__?: {
          invoke(
            command: string,
            args?: Record<string, unknown>,
          ): Promise<unknown>;
          transformCallback?: (callback: EventHandler) => number;
        };
        __TAURI_EVENT_PLUGIN_INTERNALS__?: {
          unregisterListener(event: string, eventId: number): void;
        };
        __us4?: {
          state: Us4State;
          emit(event: string, payload: unknown): void;
        };
      };

      interface Us4State {
        fileNames: string[];
        files: Map<string, string>;
        drafts: Map<string, string>;
        mounted: boolean;
        checkpointCount: number;
        openCount: number;
        saveAsPath: string | null;
      }

      const state: Us4State = {
        fileNames: [...files],
        files: new Map(),
        drafts: new Map(),
        mounted: false,
        checkpointCount: 0,
        openCount: 0,
        saveAsPath: "/workspace/saved.excalidraw",
      };
      const listeners = new Map<string, Map<number, EventHandler>>();
      const callbacks = new Map<number, EventHandler>();
      let nextCallbackId = 1;

      const emit = (event: string, payload: unknown) => {
        const handlers = listeners.get(event);
        if (handlers === undefined) {
          return;
        }
        for (const [id, handler] of handlers) {
          handler({ event, id, payload });
        }
      };

      browser.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener(event, eventId) {
          listeners.get(event)?.delete(eventId);
        },
      };
      browser.__TAURI_INTERNALS__ = {
        transformCallback(callback) {
          callbacks.set(nextCallbackId, callback);
          return nextCallbackId++;
        },
        async invoke(command, args = {}) {
          if (command === "plugin:event|listen") {
            const event = String(args.event ?? "");
            const handler = callbacks.get(Number(args.handler));
            if (handler === undefined) {
              throw new Error(`Unknown event callback ${args.handler}`);
            }
            const byEvent = listeners.get(event) ?? new Map<number, EventHandler>();
            byEvent.set(Number(args.handler), handler);
            listeners.set(event, byEvent);
            return args.handler;
          }
          if (command === "plugin:event|unlisten") {
            return {};
          }
          if (command === "plugin:window|on_close_requested") {
            return 1;
          }
          if (command === "plugin:window|destroy") {
            return {};
          }
          if (command === "plugin:dialog|open") {
            return "/workspace";
          }
          if (command === "plugin:dialog|save") {
            return state.saveAsPath;
          }
          if (command === "app_handshake") {
            return {
              contractVersion: 1,
              appVersion: "0.1.0",
              abnormalExit: false,
            };
          }
          if (command === "workspace_list") {
            return state.mounted
              ? [
                  {
                    id: "workspace-1",
                    name: "Workspace",
                    rootPath: "/workspace",
                    createdAt: 1,
                  },
                ]
              : [];
          }
          if (command === "workspace_add") {
            state.mounted = true;
            return {
              id: "workspace-1",
              name: "Workspace",
              rootPath: "/workspace",
              createdAt: 1,
            };
          }
          if (command === "dir_list") {
            return state.fileNames.map((name) => ({
              name,
              relativePath: name,
              kind: "file",
              mtime: 1,
              fileSize: 100,
            }));
          }
          const path = String(args.path ?? "");
          if (command === "doc_open") {
            state.openCount += 1;
            const sceneJson = state.files.get(path) ?? emptyScene;
            return {
              scene: JSON.parse(sceneJson),
              baseHash: `hash-${sceneJson.length}`,
              hasNewerDraft: false,
            };
          }
          if (command === "doc_save_draft") {
            const sceneJson = String(args.sceneJson ?? "");
            state.drafts.set(path, sceneJson);
            return {
              contentHash: `draft-${sceneJson.length}`,
              savedAt: Date.now(),
            };
          }
          if (command === "doc_checkpoint") {
            state.checkpointCount += 1;
            const sceneJson = String(args.sceneJson ?? "");
            state.files.set(path, sceneJson);
            return {
              newBaseHash: `hash-${sceneJson.length}`,
              mtime: Date.now(),
            };
          }
          if (command === "doc_resolve_conflict") {
            if (args.resolution === "takeExternal") {
              const sceneJson = state.files.get(path) ?? emptyScene;
              return {
                scene: JSON.parse(sceneJson),
                newBaseHash: `hash-${sceneJson.length}`,
              };
            }
            if (args.resolution === "saveAsNew") {
              const target = String(args.saveAsPath ?? "");
              const sceneJson =
                state.drafts.get(path) ?? state.files.get(path) ?? emptyScene;
              state.files.set(target, sceneJson);
              state.drafts.delete(path);
              return { newBaseHash: `hash-${sceneJson.length}` };
            }
            return { newBaseHash: "external-base" };
          }
          if (command === "doc_close") {
            state.drafts.delete(path);
            return {};
          }
          throw new Error(`Unexpected US4 harness command: ${command}`);
        },
      };
      browser.__us4 = { state, emit };
    },
    { files: [...initialFiles], emptyScene: EMPTY_SCENE },
  );
}

export async function emitFileChanged(
  page: Page,
  payload: {
    path: string;
    change: "modified" | "created" | "removed" | "renamed";
    newPath?: string;
    mtime?: number;
    contentHash?: string;
  },
): Promise<void> {
  await page.evaluate(
    ({ event, payload: eventPayload }) => {
      (globalThis as { __us4?: { emit(e: string, p: unknown): void } })
        .__us4?.emit(event, eventPayload);
    },
    { event: "file-changed", payload },
  );
}

export async function setExternalFile(
  page: Page,
  path: string,
  sceneJson: string,
): Promise<void> {
  await page.evaluate(
    ({ path: filePath, scene }) => {
      (globalThis as {
        __us4?: { state: { files: Map<string, string> } };
      }).__us4?.state.files.set(filePath, scene);
    },
    { path, scene: sceneJson },
  );
}

export async function setSaveAsPath(
  page: Page,
  path: string | null,
): Promise<void> {
  await page.evaluate((saveAsPath) => {
    (globalThis as {
      __us4?: { state: { saveAsPath: string | null } };
    }).__us4!.state.saveAsPath = saveAsPath;
  }, path);
}

export async function getHarnessState(
  page: Page,
): Promise<{ checkpointCount: number; openCount: number }> {
  return page.evaluate(() => {
    const state = (globalThis as {
      __us4?: { state: { checkpointCount: number; openCount: number } };
    }).__us4?.state;
    return { checkpointCount: state?.checkpointCount ?? 0, openCount: state?.openCount ?? 0 };
  });
}
