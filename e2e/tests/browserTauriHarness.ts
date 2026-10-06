import type { Page } from "@playwright/test";

const DEFAULT_PATH = "/virtual/us1-drawing.excalidraw";

export async function installBrowserTauriHarness(
  page: Page,
  documentPath = DEFAULT_PATH,
  initialSceneJson?: string,
  dialogPaths: readonly string[] = [documentPath],
  checkpointFailureAfter?: number,
  seedWorkspaceEntries?: boolean,
): Promise<void> {
  await page.addInitScript(
    ({
      path,
      emptyScene,
      initialScene,
      paths,
      failCheckpointAfter,
      seedEntries,
    }) => {
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
        __browserTauriArmCheckpointFailure?: () => void;
      };

      const browser = globalThis as unknown as HarnessWindow;
      const fileKey = `excalidraw-e2e:file:${path}`;
      const workspaceRoot = "/virtual";
      const workspace = {
        id: "workspace-1",
        name: "Virtual Workspace",
        rootPath: workspaceRoot,
        createdAt: 1,
      };
      const workspaceEntriesKey = `excalidraw-e2e:workspace-entries:${workspace.id}`;
      const seedWorkspaceEntry = (entryPath: string) => {
        const relativePath = entryPath.startsWith(`${workspaceRoot}/`)
          ? entryPath.slice(workspaceRoot.length + 1)
          : entryPath.replace(/^\/+/, "");
        const name = relativePath.split("/").at(-1) ?? relativePath;
        return {
          workspaceId: workspace.id,
          kind: "drawing",
          canonicalPath: `${workspaceRoot}/${relativePath}`,
          relativePath,
          parentRelativePath: "",
          name,
          displayName: name.replace(/\.excalidraw(?:\.json)?$/iu, ""),
          mtime: 1,
          fileSize: 100,
        };
      };
      const seededEntries = paths.map(seedWorkspaceEntry);
      let workspaceEntries = (() => {
        const stored = browser.localStorage.getItem(workspaceEntriesKey);
        if (stored !== null) {
          try {
            const parsed: unknown = JSON.parse(stored);
            if (Array.isArray(parsed)) return parsed;
          } catch {
            // Ignore malformed test state and restore the declared fixture.
          }
        }
        return seedEntries ? seededEntries : [];
      })();
      const persistWorkspaceEntries = () => {
        browser.localStorage.setItem(
          workspaceEntriesKey,
          JSON.stringify(workspaceEntries),
        );
      };
      let nextDialogPath = 0;
      let checkpointCount = 0;
      let checkpointFailureArmed = false;
      const hashScene = async (sceneJson: string): Promise<string> => {
        const digest = await globalThis.crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(sceneJson),
        );
        return Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
      };
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
          if (command === "native_menu_set_enabled") {
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
          if (
            command === "workspace_list" ||
            command === "workspace_recent_list"
          ) {
            return seedEntries === undefined ? [] : [workspace];
          }
          if (command === "workspace_entry_list") {
            const workspaceId = String(args.workspaceId ?? "");
            const parentRelativePath = String(args.parentRelativePath ?? "");
            if (workspaceId !== workspace.id || parentRelativePath !== "") {
              return [];
            }
            return workspaceEntries;
          }
          if (command === "workspace_entry_create") {
            const workspaceId = String(args.workspaceId ?? "");
            const parentRelativePath = String(args.parentRelativePath ?? "");
            const kind = String(args.kind ?? "");
            const baseName = String(args.baseName ?? "");
            if (workspaceId !== workspace.id || kind !== "drawing") {
              throw {
                code: "PATH_ACCESS_DENIED",
                message: "The requested entry is outside the Workspace.",
              };
            }
            const relativePath = parentRelativePath
              ? `${parentRelativePath}/${baseName}.excalidraw`
              : `${baseName}.excalidraw`;
            const existing = workspaceEntries.find(
              (entry) => entry.relativePath === relativePath,
            );
            if (existing !== undefined) {
              throw {
                code: "NAME_CONFLICT",
                message: "An entry with that name already exists.",
              };
            }
            const name = relativePath.split("/").at(-1) ?? relativePath;
            const entry = {
              workspaceId: workspace.id,
              kind: "drawing",
              canonicalPath: `${workspaceRoot}/${relativePath}`,
              relativePath,
              parentRelativePath,
              name,
              displayName: name.replace(/\.excalidraw(?:\.json)?$/iu, ""),
              mtime: 1,
              fileSize: 0,
            };
            workspaceEntries = [...workspaceEntries, entry];
            persistWorkspaceEntries();
            return { entry };
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
              baseHash: await hashScene(sceneJson),
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
              checkpointFailureArmed &&
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
              newBaseHash: await hashScene(sceneJson),
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
      browser.__browserTauriArmCheckpointFailure = () => {
        checkpointFailureArmed = true;
      };
    },
    {
      path: documentPath,
      paths: [...dialogPaths],
      failCheckpointAfter: checkpointFailureAfter,
      seedEntries: seedWorkspaceEntries,
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

export async function armBrowserTauriCheckpointFailure(
  page: Page,
): Promise<void> {
  await page.evaluate(() => {
    const arm = (
      globalThis as typeof globalThis & {
        __browserTauriArmCheckpointFailure?: () => void;
      }
    ).__browserTauriArmCheckpointFailure;
    if (arm === undefined) {
      throw new Error("Browser Tauri checkpoint failure is not configured.");
    }
    arm();
  });
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
