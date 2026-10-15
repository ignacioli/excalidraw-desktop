import type { Page } from "@playwright/test";
import type { RecoveryCandidate } from "../../src/ipc/contracts";

export interface UiHarnessWorkspace {
  id: string;
  name: string;
  rootPath: string;
  createdAt: number;
}

export type UiHarnessEntryKind = "drawing" | "directory";

export interface UiHarnessWorkspaceEntry {
  workspaceId: string;
  kind: UiHarnessEntryKind;
  canonicalPath: string;
  relativePath: string;
  parentRelativePath: string;
  name: string;
  displayName: string;
  mtime: number;
  fileSize: number;
}

export interface UiHarnessFailure {
  code: string;
  message: string;
  retriable: boolean;
  context?: Record<string, string>;
}

export interface UiHarnessStartupOptions {
  abnormalExit?: boolean;
  recoveryCandidates?: readonly RecoveryCandidate[];
  nativeWindowRuntime?: boolean;
}

export interface UiHarnessInvocation {
  command: string;
  args: Record<string, unknown>;
}

export interface UiInteractionHarnessOptions {
  workspaces?: readonly UiHarnessWorkspace[];
  entries?: readonly UiHarnessWorkspaceEntry[];
  failures?: Readonly<Record<string, UiHarnessFailure>>;
  latenciesMs?: Readonly<Record<string, number>>;
  responses?: Readonly<Record<string, unknown>>;
  dialogPaths?: readonly (string | null)[];
  /** What the system clipboard holds before the test copies anything. */
  clipboardText?: string;
  startup?: UiHarnessStartupOptions;
  tenThousandRows?: {
    workspaceId?: string;
    parentRelativePath?: string;
    count?: number;
    namePrefix?: string;
  };
}

export interface UiInteractionHarnessState {
  invocations: UiHarnessInvocation[];
  workspaces: UiHarnessWorkspace[];
  entryCount: number;
  entryCountByParent: Record<string, number>;
  failures: Record<string, UiHarnessFailure>;
  errors: string[];
  clipboardText: string;
}

const DEFAULT_WORKSPACE: UiHarnessWorkspace = {
  id: "workspace-1",
  name: "Workspace",
  rootPath: "/ui-interactions/workspace-1",
  createdAt: 1,
};

const EMPTY_SCENE = {
  type: "excalidraw",
  version: 2,
  source: "excalidraw-desktop-ui-interaction-e2e",
  elements: [],
  appState: {
    gridModeEnabled: false,
    gridSize: 20,
    gridStep: 5,
    viewBackgroundColor: "#ffffff",
  },
  files: {},
};

/**
 * Installs a deterministic browser-only Tauri transport for feature 002 UI
 * tests. It records what the application asks the backend to do; it does not
 * reproduce Rust authorization, filesystem, or mutation invariants.
 */
export async function installUiInteractionHarness(
  page: Page,
  options: UiInteractionHarnessOptions = {},
): Promise<void> {
  const workspaces = [...(options.workspaces ?? [DEFAULT_WORKSPACE])];
  const entries = [...(options.entries ?? [])];
  const largeFixture = options.tenThousandRows;
  if (largeFixture !== undefined) {
    const workspaceId = largeFixture.workspaceId ?? workspaces[0]?.id;
    if (workspaceId === undefined) {
      throw new Error("The 10k fixture requires at least one Workspace.");
    }
    const parentRelativePath = largeFixture.parentRelativePath ?? "bulk";
    const count = largeFixture.count ?? 10_000;
    const namePrefix = largeFixture.namePrefix ?? "drawing";
    if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) {
      throw new Error(
        "The browser fixture row count must be between 0 and 10,000.",
      );
    }
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index).padStart(5, "0");
      const name = `${namePrefix}-${suffix}.excalidraw`;
      const relativePath = `${parentRelativePath}/${name}`;
      entries.push({
        workspaceId,
        kind: "drawing",
        canonicalPath: `${workspaces.find((item) => item.id === workspaceId)?.rootPath ?? "/ui-interactions"}/${relativePath}`,
        relativePath,
        parentRelativePath,
        name,
        displayName: `${namePrefix}-${suffix}`,
        mtime: index + 1,
        fileSize: 100,
      });
    }
  }

  await page.addInitScript(
    ({
      workspaceSeeds,
      entrySeeds,
      failureSeeds,
      latencySeeds,
      responseSeeds,
      pathSeeds,
      clipboardSeed,
      emptyScene,
      startup,
    }) => {
      type HarnessState = {
        invocations: UiHarnessInvocation[];
        /** The Workspace this window holds: zero or one. */
        workspaces: UiHarnessWorkspace[];
        recent: UiHarnessWorkspace[];
        entries: UiHarnessWorkspaceEntry[];
        failures: Record<string, UiHarnessFailure>;
        latenciesMs: Record<string, number>;
        responses: Record<string, unknown>;
        dialogPaths: (string | null)[];
        nextDialogPath: number;
        errors: string[];
        clipboardText: string;
      };
      type HarnessWindow = typeof globalThis & {
        __TAURI_INTERNALS__?: {
          invoke(
            command: string,
            args?: Record<string, unknown>,
          ): Promise<unknown>;
          transformCallback?: (...args: unknown[]) => number;
          unregisterCallback?: (id: number) => void;
          metadata?: { currentWindow: { label: string } };
        };
        __TAURI_EVENT_PLUGIN_INTERNALS__?: {
          unregisterListener: (event: string, id: number) => void;
        };
        __uiInteractionHarness?: { state: HarnessState };
      };

      const state: HarnessState = {
        invocations: [],
        // As at a normal launch, the window holds no Workspace until it
        // claims one; the seeds are Recent Workspaces.
        workspaces: [],
        recent: workspaceSeeds.map((workspace) => ({ ...workspace })),
        entries: entrySeeds.map((entry) => ({ ...entry })),
        failures: { ...failureSeeds },
        latenciesMs: { ...latencySeeds },
        responses: { ...responseSeeds },
        dialogPaths: [...pathSeeds],
        nextDialogPath: 0,
        errors: [],
        clipboardText: clipboardSeed,
      };
      const browser = globalThis as HarnessWindow;

      // The Window Session as the backend stores it: the claimed Workspace
      // and the reported tabs. A reload is a restart, which claims the
      // Workspace again before the window loads and hands back the tabs.
      type WindowSession = {
        workspaceId: string | null;
        tabs: string[];
        activePath: string | null;
      };
      const windowSessionKey = "excalidraw-e2e:ui-window-session";
      const readWindowSession = (): WindowSession => {
        const stored = browser.localStorage.getItem(windowSessionKey);
        return stored === null
          ? { workspaceId: null, tabs: [], activePath: null }
          : (JSON.parse(stored) as WindowSession);
      };
      const writeWindowSession = (next: Partial<WindowSession>) =>
        browser.localStorage.setItem(
          windowSessionKey,
          JSON.stringify({ ...readWindowSession(), ...next }),
        );
      const restoredSession = readWindowSession();
      const restoredWorkspace = state.recent.find(
        (workspace) => workspace.id === restoredSession.workspaceId,
      );
      if (restoredWorkspace !== undefined) {
        state.workspaces = [restoredWorkspace];
      }

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
      const shellStoreKey = "excalidraw-e2e:ui-shell-store";
      const shellSavesKey = "excalidraw-e2e:ui-shell-saves";
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
      const shellFor = (workspaceId: string | undefined): ShellState | null => {
        if (workspaceId === undefined) return null;
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

      const internals: NonNullable<HarnessWindow["__TAURI_INTERNALS__"]> = {
        async invoke(command, args = {}) {
          state.invocations.push({ command, args: { ...args } });
          const latencyMs = state.latenciesMs[command];
          if (typeof latencyMs === "number" && latencyMs > 0) {
            await new Promise<void>((resolve) => {
              globalThis.setTimeout(resolve, latencyMs);
            });
          }
          const failure = state.failures[command];
          if (failure !== undefined) {
            throw {
              ...failure,
              context:
                failure.context === undefined
                  ? undefined
                  : { ...failure.context },
            };
          }
          if (Object.hasOwn(state.responses, command)) {
            return state.responses[command];
          }
          if (command === "plugin:event|listen") {
            return state.invocations.length;
          }
          if (
            command === "plugin:event|unlisten" ||
            command === "plugin:event|emit" ||
            command === "plugin:event|emit_to"
          ) {
            return {};
          }
          if (
            command === "plugin:dialog|open" ||
            command === "plugin:dialog|save"
          ) {
            const selected =
              state.dialogPaths[
                Math.min(state.nextDialogPath, state.dialogPaths.length - 1)
              ];
            state.nextDialogPath += 1;
            return selected ?? null;
          }
          if (command === "app_handshake") {
            return {
              contractVersion: 2,
              appVersion: "0.2.0-e2e",
              abnormalExit: startup.abnormalExit,
              pendingOpenPaths: [],
              // The launch window, as the per-window bootstrap reports it.
              window: {
                label: "window-1",
                workspace:
                  restoredWorkspace === undefined
                    ? null
                    : { ...restoredWorkspace },
                unavailableWorkspace: null,
                restore:
                  restoredSession.tabs.length > 0
                    ? {
                        tabs: restoredSession.tabs,
                        activePath: restoredSession.activePath,
                        skipped: 0,
                      }
                    : null,
                shell: shellFor(state.workspaces[0]?.id),
                openWorkspaceNames: [],
              },
              preferredLanguages: [],
            };
          }
          if (command === "recovery_list") {
            return startup.recoveryCandidates.map((candidate) => ({
              ...candidate,
            }));
          }
          if (command === "workspace_list") {
            return state.workspaces.map((workspace) => ({ ...workspace }));
          }
          if (command === "workspace_recent_list") {
            return state.recent.map((workspace) => ({ ...workspace }));
          }
          if (command === "workspace_add") {
            const rootPath = String(
              args.rootPath ?? "/ui-interactions/mounted",
            );
            const workspace = {
              id: `workspace-${state.recent.length + 1}`,
              name: rootPath.split("/").filter(Boolean).at(-1) ?? "Workspace",
              rootPath,
              createdAt: state.recent.length + 1,
            };
            state.recent.push(workspace);
            state.workspaces = [workspace];
            writeWindowSession({ workspaceId: workspace.id });
            return { ...workspace };
          }
          if (command === "window_probe_workspace") {
            return {
              kind: "claimed",
              workspace: null,
              replaced: null,
              shell: null,
            };
          }
          if (command === "window_claim_workspace") {
            const existing = state.recent.find(
              (workspace) =>
                workspace.id === args.workspaceId ||
                (args.rootPath !== undefined &&
                  workspace.rootPath === args.rootPath),
            );
            const rootPath = String(
              args.rootPath ?? "/ui-interactions/mounted",
            );
            const workspace = existing ?? {
              id: `workspace-${state.recent.length + 1}`,
              name: rootPath.split("/").filter(Boolean).at(-1) ?? "Workspace",
              rootPath,
              createdAt: state.recent.length + 1,
            };
            if (existing === undefined) state.recent.push(workspace);
            const replaced = state.workspaces[0]?.id ?? null;
            state.workspaces = [workspace];
            writeWindowSession({ workspaceId: workspace.id });
            return {
              kind: "claimed",
              workspace: { ...workspace },
              replaced,
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
            const workspaceId = state.workspaces[0]?.id;
            if (workspaceId === undefined) {
              throw {
                code: "WORKSPACE_NOT_OWNED",
                message: "This window has no Workspace.",
                retriable: false,
              };
            }
            // Specs assert the payload the app sent, not the fallback above.
            const saves = JSON.parse(
              browser.localStorage.getItem(shellSavesKey) ?? "[]",
            ) as unknown[];
            browser.localStorage.setItem(
              shellSavesKey,
              JSON.stringify([...saves, { workspaceId, ...args }]),
            );
            const store = readShellStore();
            writeShellStore({
              ...store,
              byWorkspace: {
                ...store.byWorkspace,
                [workspaceId]: {
                  sidebarPinned: args.sidebarPinned === true,
                  sidebarWidth: Number(args.sidebarWidth),
                  expanded: Array.isArray(args.expanded)
                    ? args.expanded.map(String)
                    : [],
                },
              },
              latest: workspaceId,
            });
            return {};
          }
          if (
            command === "app_preferences_broadcast" ||
            command === "plugin:window|set_title"
          ) {
            return {};
          }
          if (command === "window_release_workspace") {
            state.workspaces = [];
            writeWindowSession({ workspaceId: null });
            return {};
          }
          if (command === "workspace_remove") {
            const workspaceId = String(args.workspaceId ?? "");
            state.workspaces = state.workspaces.filter(
              (workspace) => workspace.id !== workspaceId,
            );
            writeWindowSession({
              workspaceId: state.workspaces[0]?.id ?? null,
            });
            return {};
          }
          if (command === "window_session_update") {
            writeWindowSession({
              tabs: Array.isArray(args.tabs) ? args.tabs.map(String) : [],
              activePath:
                typeof args.activePath === "string" ? args.activePath : null,
            });
            return {};
          }
          if (
            command === "app_quit_ready" ||
            command === "startup_recovery_done"
          ) {
            return {};
          }
          if (command === "workspace_entry_list") {
            const workspaceId = String(args.workspaceId ?? "");
            const parentRelativePath = String(args.parentRelativePath ?? "");
            return state.entries
              .filter(
                (entry) =>
                  entry.workspaceId === workspaceId &&
                  entry.parentRelativePath === parentRelativePath,
              )
              .map((entry) => ({ ...entry }));
          }
          if (command === "workspace_entry_create") {
            const workspaceId = String(args.workspaceId ?? "");
            const parentRelativePath = String(args.parentRelativePath ?? "");
            const kind = args.kind === "directory" ? "directory" : "drawing";
            const baseName = String(args.baseName ?? "");
            const name =
              kind === "drawing" ? `${baseName}.excalidraw` : baseName;
            if (
              state.entries.some(
                (entry) =>
                  entry.workspaceId === workspaceId &&
                  entry.parentRelativePath === parentRelativePath &&
                  entry.name.toLowerCase() === name.toLowerCase(),
              )
            ) {
              throw {
                code: "NAME_CONFLICT",
                message: "Entry already exists",
                retriable: false,
              };
            }
            const workspace = state.workspaces.find(
              (item) => item.id === workspaceId,
            );
            const relativePath = [parentRelativePath, name]
              .filter(Boolean)
              .join("/");
            const entry = {
              workspaceId,
              kind,
              canonicalPath: `${workspace?.rootPath ?? "/ui-interactions"}/${relativePath}`,
              relativePath,
              parentRelativePath,
              name,
              displayName: kind === "drawing" ? baseName : name,
              mtime: Date.now(),
              fileSize: 0,
            } satisfies UiHarnessWorkspaceEntry;
            state.entries.push(entry);
            return { operationId: `create-${state.invocations.length}`, entry };
          }
          if (command === "workspace_entry_rename") {
            const workspaceId = String(args.workspaceId ?? "");
            const oldRelativePath = String(args.relativePath ?? "");
            const baseName = String(args.baseName ?? "");
            const source = state.entries.find(
              (entry) =>
                entry.workspaceId === workspaceId &&
                entry.relativePath === oldRelativePath,
            );
            if (source === undefined)
              throw new Error("Harness entry not found");
            const suffix = source.name
              .toLowerCase()
              .endsWith(".excalidraw.json")
              ? ".excalidraw.json"
              : source.kind === "drawing"
                ? ".excalidraw"
                : "";
            const nextName = `${baseName}${suffix}`;
            const newRelativePath = [source.parentRelativePath, nextName]
              .filter(Boolean)
              .join("/");
            const oldCanonicalPath = source.canonicalPath;
            const newCanonicalPath =
              oldCanonicalPath.slice(0, -source.name.length) + nextName;
            const pathMigrations = state.entries
              .filter(
                (entry) =>
                  entry.kind === "drawing" &&
                  (entry.relativePath === oldRelativePath ||
                    entry.relativePath.startsWith(`${oldRelativePath}/`)),
              )
              .map((entry) => ({
                oldRelativePath: entry.relativePath,
                newRelativePath: entry.relativePath.replace(
                  oldRelativePath,
                  newRelativePath,
                ),
                oldCanonicalPath: entry.canonicalPath,
                newCanonicalPath: entry.canonicalPath.replace(
                  oldCanonicalPath,
                  newCanonicalPath,
                ),
              }));
            for (const entry of state.entries) {
              if (
                entry.relativePath === oldRelativePath ||
                entry.relativePath.startsWith(`${oldRelativePath}/`)
              ) {
                entry.relativePath = entry.relativePath.replace(
                  oldRelativePath,
                  newRelativePath,
                );
                entry.canonicalPath = entry.canonicalPath.replace(
                  oldCanonicalPath,
                  newCanonicalPath,
                );
                entry.parentRelativePath = entry.parentRelativePath.replace(
                  oldRelativePath,
                  newRelativePath,
                );
              }
            }
            source.name = nextName;
            source.displayName = baseName;
            return {
              operationId: `rename-${state.invocations.length}`,
              entry: { ...source },
              oldRelativePath,
              newRelativePath,
              pathMigrations,
            };
          }
          if (command === "workspace_entry_delete_preflight") {
            const relativePath = String(args.relativePath ?? "");
            const entry = state.entries.find(
              (item) => item.relativePath === relativePath,
            );
            if (entry === undefined) throw new Error("Harness entry not found");
            const nonEmpty =
              entry.kind === "directory" &&
              state.entries.some((item) =>
                item.relativePath.startsWith(`${relativePath}/`),
              );
            return {
              status: nonEmpty ? "directoryNotEmpty" : "confirmable",
              entry: { ...entry },
            };
          }
          if (command === "workspace_entry_delete") {
            const relativePath = String(args.relativePath ?? "");
            const entry = state.entries.find(
              (item) => item.relativePath === relativePath,
            );
            if (entry === undefined) throw new Error("Harness entry not found");
            state.entries = state.entries.filter(
              (item) => item.relativePath !== relativePath,
            );
            return {
              operationId: `delete-${state.invocations.length}`,
              kind: entry.kind,
              oldRelativePath: relativePath,
            };
          }
          if (command === "workspace_entry_reveal") return {};
          if (command === "doc_open") {
            return {
              scene: emptyScene,
              baseHash: `ui-harness-${String(args.path ?? "").length}`,
              hasNewerDraft: false,
            };
          }
          if (command === "doc_save_draft") {
            return {
              contentHash: `ui-harness-draft-${String(args.sceneJson ?? "").length}`,
              savedAt: Date.now(),
            };
          }
          if (command === "doc_checkpoint") {
            return {
              newBaseHash: `ui-harness-checkpoint-${String(args.sceneJson ?? "").length}`,
              mtime: Date.now(),
            };
          }
          if (command === "doc_close") return {};
          if (
            command === "native_menu_sync" ||
            command === "native_menu_set_enabled"
          )
            return {};
          // Copy Path: the clipboard plugin's only granted command.
          if (command === "plugin:clipboard-manager|write_text") {
            state.clipboardText = String(args.text ?? "");
            return null;
          }
          // `homeDir()` for the row path tooltips.
          if (command === "plugin:path|resolve_directory")
            return "/Users/tester";
          const message = `Unexpected UI interaction harness command: ${command}`;
          state.errors.push(message);
          throw new Error(message);
        },
      };
      if (startup.nativeWindowRuntime) {
        let nextCallbackId = 0;
        internals.transformCallback = () => nextCallbackId++;
        internals.unregisterCallback = () => undefined;
        internals.metadata = { currentWindow: { label: "main" } };
      }
      browser.__TAURI_INTERNALS__ = internals;
      if (startup.nativeWindowRuntime) {
        browser.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
          unregisterListener: () => undefined,
        };
      }
      browser.__uiInteractionHarness = { state };
    },
    {
      workspaceSeeds: workspaces,
      entrySeeds: entries,
      failureSeeds: { ...(options.failures ?? {}) },
      latencySeeds: { ...(options.latenciesMs ?? {}) },
      responseSeeds: { ...(options.responses ?? {}) },
      pathSeeds: [...(options.dialogPaths ?? [])],
      clipboardSeed: options.clipboardText ?? "",
      emptyScene: EMPTY_SCENE,
      startup: {
        abnormalExit: options.startup?.abnormalExit ?? false,
        recoveryCandidates: [...(options.startup?.recoveryCandidates ?? [])],
        nativeWindowRuntime: options.startup?.nativeWindowRuntime ?? false,
      },
    },
  );
}

/**
 * The last `workspace_shell_state_save` payload the app sent for
 * `workspaceId`, or null when it sent none.
 */
export async function readUiHarnessLastShellSave(
  page: Page,
  workspaceId: string,
): Promise<{
  sidebarPinned: boolean;
  sidebarWidth: number;
  expanded: string[];
} | null> {
  return page.evaluate((id) => {
    const saves = JSON.parse(
      localStorage.getItem("excalidraw-e2e:ui-shell-saves") ?? "[]",
    ) as Array<{
      workspaceId: string;
      sidebarPinned: boolean;
      sidebarWidth: number;
      expanded: string[];
    }>;
    const save = saves.filter((entry) => entry.workspaceId === id).at(-1);
    return save === undefined
      ? null
      : {
          sidebarPinned: save.sidebarPinned,
          sidebarWidth: save.sidebarWidth,
          expanded: save.expanded,
        };
  }, workspaceId);
}

export async function getUiInteractionHarnessState(
  page: Page,
): Promise<UiInteractionHarnessState> {
  return page.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        __uiInteractionHarness?: {
          state: {
            invocations: UiHarnessInvocation[];
            workspaces: UiHarnessWorkspace[];
            entries: UiHarnessWorkspaceEntry[];
            failures: Record<string, UiHarnessFailure>;
            errors: string[];
            clipboardText: string;
          };
        };
      }
    ).__uiInteractionHarness?.state;
    const entryCountByParent: Record<string, number> = {};
    for (const entry of state?.entries ?? []) {
      const key = `${entry.workspaceId}:${entry.parentRelativePath}`;
      entryCountByParent[key] = (entryCountByParent[key] ?? 0) + 1;
    }
    return {
      invocations:
        state?.invocations.map((invocation) => ({
          command: invocation.command,
          args: { ...invocation.args },
        })) ?? [],
      workspaces:
        state?.workspaces.map((workspace) => ({ ...workspace })) ?? [],
      entryCount: state?.entries.length ?? 0,
      entryCountByParent,
      failures: { ...(state?.failures ?? {}) },
      errors: [...(state?.errors ?? [])],
      clipboardText: state?.clipboardText ?? "",
    };
  });
}

export async function setUiInteractionHarnessFailure(
  page: Page,
  command: string,
  failure: UiHarnessFailure | null,
): Promise<void> {
  await page.evaluate(
    ({ commandName, nextFailure }) => {
      const state = (
        globalThis as typeof globalThis & {
          __uiInteractionHarness?: {
            state: { failures: Record<string, UiHarnessFailure> };
          };
        }
      ).__uiInteractionHarness?.state;
      if (state === undefined) {
        throw new Error("UI interaction harness is not installed.");
      }
      if (nextFailure === null) {
        delete state.failures[commandName];
      } else {
        state.failures[commandName] = nextFailure;
      }
    },
    { commandName: command, nextFailure: failure },
  );
}

/**
 * Opt-in file-changed emit for Orphaned Document journeys.
 * AppShell only registers `file-changed` when transformCallback exists, so
 * browser tests cannot mark a tab orphaned without this hook. Call after
 * `installUiInteractionHarness` and before `page.goto`. Default harness
 * behavior is unchanged.
 */
export async function installUiInteractionFileEvents(
  page: Page,
): Promise<void> {
  await page.addInitScript(() => {
    type EventCallback = (event: {
      event: string;
      id: number;
      payload: unknown;
    }) => void;
    type EventInternals = {
      invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
      transformCallback?: (callback: EventCallback) => number;
    };
    const browser = globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: EventInternals;
      __TAURI_EVENT_PLUGIN_INTERNALS__?: {
        unregisterListener(event: string, eventId: number): void;
      };
      __emitUiInteractionEvent?: (event: string, payload: unknown) => void;
    };
    const internals = browser.__TAURI_INTERNALS__;
    if (internals === undefined) return;
    const invoke = internals.invoke.bind(internals);
    const callbacks = new Map<number, EventCallback>();
    const listeners = new Map<string, Set<number>>();
    let nextCallbackId = 1;
    internals.transformCallback = (callback) => {
      const id = nextCallbackId++;
      callbacks.set(id, callback);
      return id;
    };
    browser.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(event, eventId) {
        listeners.get(event)?.delete(eventId);
        callbacks.delete(eventId);
      },
    };
    internals.invoke = async (command, args = {}) => {
      if (command === "plugin:event|listen") {
        const event = String(args.event ?? "");
        const eventId = Number(args.handler);
        const eventListeners = listeners.get(event) ?? new Set<number>();
        eventListeners.add(eventId);
        listeners.set(event, eventListeners);
        return eventId;
      }
      if (command === "plugin:event|unlisten") {
        const event = String(args.event ?? "");
        const eventId = Number(args.eventId);
        listeners.get(event)?.delete(eventId);
        callbacks.delete(eventId);
        return null;
      }
      if (
        command === "plugin:window|on_close_requested" ||
        command === "plugin:window|destroy"
      ) {
        return command === "plugin:window|on_close_requested" ? 1 : {};
      }
      return invoke(command, args);
    };
    browser.__emitUiInteractionEvent = (event, payload) => {
      for (const eventId of listeners.get(event) ?? []) {
        callbacks.get(eventId)?.({ event, id: eventId, payload });
      }
    };
  });
}

/** Emits any app event, e.g. `native-menu-command`; needs `installUiInteractionFileEvents`. */
export async function emitUiInteractionEvent(
  page: Page,
  event: string,
  payload: unknown,
): Promise<void> {
  await page.evaluate(
    ({ event: eventName, payload: eventPayload }) => {
      const emit = (
        globalThis as typeof globalThis & {
          __emitUiInteractionEvent?: (eventName: string, next: unknown) => void;
        }
      ).__emitUiInteractionEvent;
      if (emit === undefined) {
        throw new Error("UI interaction events are not installed.");
      }
      emit(eventName, eventPayload);
    },
    { event, payload },
  );
}

export async function emitUiInteractionFileChanged(
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
      const emit = (
        globalThis as typeof globalThis & {
          __emitUiInteractionEvent?: (eventName: string, next: unknown) => void;
        }
      ).__emitUiInteractionEvent;
      if (emit === undefined) {
        throw new Error("UI interaction file events are not installed.");
      }
      emit(event, eventPayload);
    },
    { event: "file-changed", payload },
  );
}
