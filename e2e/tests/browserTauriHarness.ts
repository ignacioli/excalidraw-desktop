import type { Page } from "@playwright/test";

const DEFAULT_PATH = "/virtual/us1-drawing.excalidraw";

export async function installBrowserTauriHarness(
  page: Page,
  documentPath = DEFAULT_PATH,
  initialSceneJson?: string,
  dialogPaths: readonly string[] = [documentPath],
  checkpointFailureAfter?: number,
  seedWorkspaceEntries?: boolean,
  preferredLanguages: readonly string[] = [],
): Promise<void> {
  await page.addInitScript(
    ({
      path,
      emptyScene,
      initialScene,
      paths,
      failCheckpointAfter,
      seedEntries,
      systemLanguages,
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
        __browserTauriNativeMenuSync?: Record<string, unknown>;
        /** Forced `window_probe_workspace`/`window_claim_workspace` result. */
        __browserTauriClaimOutcome?: Record<string, unknown>;
        /** Commands invoked so far, in order. */
        __browserTauriCommands?: string[];
        /** Workspaces another window has open, listed in Recent too. */
        __browserTauriRecentExtra?: Record<string, unknown>[];
        /** Entries listed besides the seeded drawings, by parent folder. */
        __browserTauriExtraEntries?: {
          parentRelativePath: string;
          [field: string]: unknown;
        }[];
        /** Drawings another window has open: path → that window's label. */
        __browserTauriOwnedElsewhere?: Record<string, string>;
        /** The last `window_close_other_and_claim` arguments. */
        __browserTauriPeerClose?: Record<string, unknown>;
        __browserTauriMountWorkspace?: () => void;
        addEventListener(
          type: "keydown",
          listener: (event: {
            key: string;
            metaKey: boolean;
            ctrlKey: boolean;
            altKey: boolean;
            preventDefault(): void;
          }) => void,
        ): void;
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
      // Seeded entries make the Workspace a Recent one. As at a normal
      // launch, no window holds it until this window claims it.
      const workspaceRecent = seedEntries !== undefined;
      let workspaceMounted = false;
      // A Workspace another test-chosen claim outcome put in this window.
      let claimedOverride: unknown;
      // Sidebar state as the backend keeps it: per Workspace, plus the
      // one-time import of the earlier localStorage preferences. Stored in
      // localStorage so it survives a reload, like the app database.
      type ShellState = {
        sidebarPinned: boolean;
        sidebarWidth: number;
        expanded: string[];
      };
      type ShellStore = {
        migrated: boolean;
        legacy: { sidebarPinned: boolean; sidebarWidth: number } | null;
        byWorkspace: Record<string, ShellState>;
        latest: string | null;
      };
      const shellStoreKey = "excalidraw-e2e:shell-store";
      const readShellStore = (): ShellStore => {
        const stored = browser.localStorage.getItem(shellStoreKey);
        return stored === null
          ? { migrated: false, legacy: null, byWorkspace: {}, latest: null }
          : (JSON.parse(stored) as ShellStore);
      };
      const writeShellStore = (store: ShellStore) =>
        browser.localStorage.setItem(shellStoreKey, JSON.stringify(store));
      // Own state, else the most recent pin and width, else the imported
      // ones; a first-opened Workspace shows its root expanded.
      const shellFor = (workspaceId: string): ShellState | null => {
        const store = readShellStore();
        const own = store.byWorkspace[workspaceId];
        if (own !== undefined) return own;
        const recent =
          store.latest === null ? undefined : store.byWorkspace[store.latest];
        const fallback = recent ?? store.legacy;
        return fallback === null || fallback === undefined
          ? null
          : {
              sidebarPinned: fallback.sidebarPinned,
              sidebarWidth: fallback.sidebarWidth,
              expanded: [""],
            };
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
          if (!command.startsWith("plugin:")) {
            (browser.__browserTauriCommands ??= []).push(command);
          }
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
          if (command === "native_menu_sync") {
            browser.__browserTauriNativeMenuSync = args;
            return {};
          }
          if (command === "app_handshake") {
            return {
              contractVersion: 2,
              appVersion: "0.2.0-e2e",
              abnormalExit: false,
              pendingOpenPaths: [],
              // The launch window, as the per-window bootstrap reports it.
              window: {
                label: "window-1",
                workspace: null,
                unavailableWorkspace: null,
                restore: null,
                shell: null,
                openWorkspaceNames: [],
              },
              preferredLanguages: systemLanguages,
            };
          }
          if (command === "recovery_list") {
            return [];
          }
          if (
            command === "workspace_list" ||
            command === "workspace_recent_list"
          ) {
            const extra =
              command === "workspace_recent_list"
                ? (browser.__browserTauriRecentExtra ?? [])
                : [];
            if (claimedOverride !== undefined) {
              return [claimedOverride, ...extra];
            }
            const listed =
              workspaceMounted ||
              (command === "workspace_recent_list" && workspaceRecent);
            return [...(listed ? [workspace] : []), ...extra];
          }
          // Welcome New Drawing mounts its chosen folder on first use; only
          // the harness root is a mountable folder.
          if (command === "workspace_add") {
            if (args.rootPath !== workspaceRoot) {
              throw {
                code: "PATH_ACCESS_DENIED",
                message: "The requested folder is outside the harness.",
              };
            }
            workspaceMounted = true;
            return workspace;
          }
          if (
            command === "window_probe_workspace" ||
            command === "window_claim_workspace"
          ) {
            const forced = browser.__browserTauriClaimOutcome;
            // "Switch to that window" claims the Workspace inside, which
            // only brings its window to the front.
            if (
              forced?.kind === "containsOpen" &&
              args.workspaceId === forced.workspaceId
            ) {
              return {
                kind: "ownedBy",
                label: forced.label,
                workspaceId: forced.workspaceId,
              };
            }
            if (forced !== undefined) {
              if (
                command === "window_claim_workspace" &&
                forced.kind === "claimed"
              ) {
                claimedOverride = forced.workspace;
              }
              return forced;
            }
            if (
              args.rootPath !== workspaceRoot &&
              args.workspaceId !== workspace.id
            ) {
              throw {
                code: "PATH_ACCESS_DENIED",
                message: "The requested folder is outside the harness.",
              };
            }
            if (command === "window_probe_workspace") {
              return {
                kind: "claimed",
                workspace: null,
                replaced: null,
                shell: null,
              };
            }
            workspaceMounted = true;
            return {
              kind: "claimed",
              workspace,
              replaced: null,
              shell: shellFor(workspace.id),
            };
          }
          if (command === "shell_preferences_migrate") {
            const store = readShellStore();
            if (store.migrated) return { migrated: false };
            writeShellStore({
              ...store,
              migrated: true,
              legacy: {
                sidebarPinned: args.sidebarPinned === true,
                sidebarWidth: Number(args.sidebarWidth),
              },
            });
            return { migrated: true };
          }
          if (command === "workspace_shell_state_save") {
            if (!workspaceMounted) {
              throw {
                code: "WORKSPACE_NOT_OWNED",
                message: "This window has no Workspace.",
                retriable: false,
              };
            }
            const store = readShellStore();
            writeShellStore({
              ...store,
              byWorkspace: {
                ...store.byWorkspace,
                [workspace.id]: {
                  sidebarPinned: args.sidebarPinned === true,
                  sidebarWidth: Number(args.sidebarWidth),
                  expanded: Array.isArray(args.expanded)
                    ? args.expanded.map(String)
                    : [],
                },
              },
              latest: workspace.id,
            });
            return {};
          }
          if (command === "workspace_entry_list") {
            const workspaceId = String(args.workspaceId ?? "");
            const parentRelativePath = String(args.parentRelativePath ?? "");
            if (workspaceId !== workspace.id) return [];
            const extra = (browser.__browserTauriExtraEntries ?? []).filter(
              (entry) => entry.parentRelativePath === parentRelativePath,
            );
            return parentRelativePath === ""
              ? [...workspaceEntries, ...extra]
              : extra;
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
            command === "plugin:dialog|open" &&
            (args.options as { directory?: boolean } | undefined)?.directory ===
              true
          ) {
            return workspaceRoot;
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
          if (command === "window_close_other_and_claim") {
            browser.__browserTauriPeerClose = args;
            return { status: "closing", requestId: "peer-request-1" };
          }
          if (command === "window_peer_close_failed") {
            return {};
          }
          if (command === "doc_open") {
            const owner = browser.__browserTauriOwnedElsewhere?.[requestedPath];
            if (owner !== undefined) {
              return { kind: "ownedElsewhere", label: owner };
            }
            const sceneJson =
              browser.localStorage.getItem(requestedFileKey) ?? emptyScene;
            return {
              kind: "opened",
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
          if (
            command === "app_preferences_broadcast" ||
            command === "plugin:window|set_title"
          ) {
            return {};
          }
          // Only "Keep local changes" is modelled; it rebases without writing.
          if (
            command === "doc_resolve_conflict" &&
            args.resolution === "keepLocal"
          ) {
            return { newBaseHash: "external-base" };
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
      browser.__browserTauriMountWorkspace = () => {
        workspaceMounted = true;
      };
      browser.__browserTauriArmCheckpointFailure = () => {
        checkpointFailureArmed = true;
      };
      // The desktop shell leaves Command-S to the native File > Save
      // accelerator; deliver it the way the native menu does.
      browser.addEventListener("keydown", (event) => {
        if (
          event.key.toLowerCase() === "s" &&
          (event.metaKey || event.ctrlKey) &&
          !event.altKey
        ) {
          event.preventDefault();
          browser.__browserTauriEmit?.("native-menu-command", {
            command: "save",
          });
        }
      });
    },
    {
      path: documentPath,
      paths: [...dialogPaths],
      failCheckpointAfter: checkpointFailureAfter,
      seedEntries: seedWorkspaceEntries,
      systemLanguages: [...preferredLanguages],
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

/**
 * Make every later Workspace probe and claim return `outcome`, as when
 * another window holds the folder. Call after `goto`.
 */
export async function setBrowserTauriClaimOutcome(
  page: Page,
  outcome: Record<string, unknown>,
): Promise<void> {
  await page.evaluate((forced) => {
    (
      globalThis as typeof globalThis & {
        __browserTauriClaimOutcome?: Record<string, unknown>;
      }
    ).__browserTauriClaimOutcome = forced;
  }, outcome);
}

/** The non-plugin commands invoked so far, in order. */
export async function readBrowserTauriCommands(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __browserTauriCommands?: string[];
        }
      ).__browserTauriCommands ?? [],
  );
}

/** Set a harness global; call after `goto`. */
async function setHarnessGlobal(
  page: Page,
  name: string,
  value: unknown,
): Promise<void> {
  await page.evaluate(
    ({ key, next }) => {
      (globalThis as unknown as Record<string, unknown>)[key] = next;
    },
    { key: name, next: value },
  );
}

/** Workspaces another window has open, listed in Recent too. */
export async function setBrowserTauriRecentExtra(
  page: Page,
  workspaces: readonly Record<string, unknown>[],
): Promise<void> {
  await setHarnessGlobal(page, "__browserTauriRecentExtra", workspaces);
}

/** Entries of the harness Workspace besides the seeded drawings. */
export async function setBrowserTauriExtraEntries(
  page: Page,
  entries: readonly { parentRelativePath: string; [field: string]: unknown }[],
): Promise<void> {
  await setHarnessGlobal(page, "__browserTauriExtraEntries", entries);
}

/** Drawings another window has open: path → that window's label. */
export async function setBrowserTauriOwnedElsewhere(
  page: Page,
  owners: Record<string, string>,
): Promise<void> {
  await setHarnessGlobal(page, "__browserTauriOwnedElsewhere", owners);
}

/** The last `window_close_other_and_claim` arguments, if any. */
export async function readBrowserTauriPeerClose(
  page: Page,
): Promise<Record<string, unknown> | null> {
  return page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __browserTauriPeerClose?: Record<string, unknown>;
        }
      ).__browserTauriPeerClose ?? null,
  );
}

/**
 * Answer the pending "Close it and open here" request. A `claimed` outcome
 * also makes the harness Workspace this window's own.
 */
export async function answerBrowserTauriPeerClose(
  page: Page,
  outcome: Record<string, unknown>,
): Promise<void> {
  if (outcome.kind === "claimed") {
    await page.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          __browserTauriMountWorkspace?: () => void;
        }
      ).__browserTauriMountWorkspace?.(),
    );
  }
  await emitBrowserTauriEvent(page, "window-claim-result", {
    requestId: "peer-request-1",
    outcome,
  });
}
