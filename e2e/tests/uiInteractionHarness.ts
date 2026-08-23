import type { Page } from "@playwright/test";

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

export interface UiHarnessInvocation {
  command: string;
  args: Record<string, unknown>;
}

export interface UiInteractionHarnessOptions {
  workspaces?: readonly UiHarnessWorkspace[];
  entries?: readonly UiHarnessWorkspaceEntry[];
  failures?: Readonly<Record<string, UiHarnessFailure>>;
  responses?: Readonly<Record<string, unknown>>;
  dialogPaths?: readonly (string | null)[];
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
  appState: {},
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
      responseSeeds,
      pathSeeds,
      emptyScene,
    }) => {
      type HarnessState = {
        invocations: UiHarnessInvocation[];
        workspaces: UiHarnessWorkspace[];
        entries: UiHarnessWorkspaceEntry[];
        failures: Record<string, UiHarnessFailure>;
        responses: Record<string, unknown>;
        dialogPaths: (string | null)[];
        nextDialogPath: number;
      };
      type HarnessWindow = typeof globalThis & {
        __TAURI_INTERNALS__?: {
          invoke(
            command: string,
            args?: Record<string, unknown>,
          ): Promise<unknown>;
        };
        __uiInteractionHarness?: { state: HarnessState };
      };

      const state: HarnessState = {
        invocations: [],
        workspaces: workspaceSeeds.map((workspace) => ({ ...workspace })),
        entries: entrySeeds.map((entry) => ({ ...entry })),
        failures: { ...failureSeeds },
        responses: { ...responseSeeds },
        dialogPaths: [...pathSeeds],
        nextDialogPath: 0,
      };
      const browser = globalThis as HarnessWindow;

      browser.__TAURI_INTERNALS__ = {
        async invoke(command, args = {}) {
          state.invocations.push({ command, args: { ...args } });
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
              abnormalExit: false,
              pendingOpenPaths: [],
            };
          }
          if (command === "workspace_list") {
            return state.workspaces.map((workspace) => ({ ...workspace }));
          }
          if (command === "workspace_add") {
            const rootPath = String(
              args.rootPath ?? "/ui-interactions/mounted",
            );
            const workspace = {
              id: `workspace-${state.workspaces.length + 1}`,
              name: rootPath.split("/").filter(Boolean).at(-1) ?? "Workspace",
              rootPath,
              createdAt: state.workspaces.length + 1,
            };
            state.workspaces.push(workspace);
            return { ...workspace };
          }
          if (command === "workspace_remove") {
            const workspaceId = String(args.workspaceId ?? "");
            state.workspaces = state.workspaces.filter(
              (workspace) => workspace.id !== workspaceId,
            );
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
          throw new Error(
            `Unexpected UI interaction harness command: ${command}`,
          );
        },
      };
      browser.__uiInteractionHarness = { state };
    },
    {
      workspaceSeeds: workspaces,
      entrySeeds: entries,
      failureSeeds: { ...(options.failures ?? {}) },
      responseSeeds: { ...(options.responses ?? {}) },
      pathSeeds: [...(options.dialogPaths ?? [])],
      emptyScene: EMPTY_SCENE,
    },
  );
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
export async function installUiInteractionFileEvents(page: Page): Promise<void> {
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
