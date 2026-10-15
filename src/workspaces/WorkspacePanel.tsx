import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import collapseAllIcon from "../../docs/design/desktop-shell/hf-2/icons/collapse-all.svg";
import expandAllIcon from "../../docs/design/desktop-shell/hf-2/icons/expand-all.svg";
import newDrawingIcon from "../../docs/design/desktop-shell/hf-2/icons/new-drawing.svg";
import newFolderIcon from "../../docs/design/desktop-shell/hf-2/icons/new-folder.svg";
import refreshIcon from "../../docs/design/desktop-shell/hf-2/icons/refresh.svg";
import {
  ApplicationDialog,
  ApplicationDialogActions,
  ApplicationDialogButton,
  ContextMenu,
  DirectoryNotEmptyDialog,
  EntryDeleteConfirmationDialog,
  EntryNamingDialog,
  interactionStore,
  useInteractionStore,
  type ContextMenuItem,
  type EntryNamingMode,
  type MenuDismissalReason,
} from "../app/interaction";
import { ShellPreferences } from "../app/shellPreferences";
import { documentManager, useDocumentStore } from "../documents/documentStore";
import {
  closeAllTabsForWorkspaceSwitch,
  containsOpenError,
  openWorkspaceInWindow,
} from "../app/workspaceClaim";
import type { BrowsingLocation } from "../app/browsingHistory";
import type { CommandInvoker } from "../ipc/client";
import {
  createTauriCommandInvoker,
  hasTauriCommandRuntime,
} from "../ipc/client";
import type {
  FileEntry,
  Workspace,
  WorkspaceEntriesChangedEvent,
  WorkspaceEntry,
  EntryDeleteResult,
} from "../ipc/contracts";
import { defaultEventListener } from "../ipc/events";
import { t, useI18n, type MessageKey } from "../i18n";
import {
  describeError,
  DescribedError,
  errorCodeOf,
  LocalizedError,
} from "../i18n/describeError";
import { WorkspaceTree } from "./WorkspaceTree";
import { abbreviateHome, useHomeDirectory } from "./displayPath";
import {
  makeEntryRowKey,
  makeWorkspaceRowKey,
  type WorkspaceTreeEntriesByWorkspace,
  type WorkspaceTreeRow,
} from "./workspaceTreeModel";

export interface WorkspacePanelProps {
  invoker?: CommandInvoker;
  currentWorkspaceId?: string | null;
  selectDirectory?: () => Promise<string | null>;
  onOpenFile?: (entry: FileEntry) => void;
  onCurrentWorkspaceChange?: (workspace: Workspace | null) => void;
  onBrowse?: (location: BrowsingLocation) => void;
  backLocation?: BrowsingLocation | null;
  onBackLocationApplied?: () => void;
  /**
   * A folder of this window's Workspace to show: the root row and every
   * folder down to it are expanded, and the folder is selected.
   */
  revealLocation?: BrowsingLocation | null;
  onRevealLocationApplied?: () => void;
  /**
   * The chosen folder contains a Workspace open in another window. Without
   * it the overlap is shown as an error.
   */
  onNestedConflict?: (
    rootPath: string,
    outcome: { label: string; workspaceId: string },
  ) => Promise<void>;
  onWorkspacePresenceChange?: (hasAny: boolean) => void;
  onWorkspacesChange?: (workspaces: Workspace[]) => void;
  preferences?: ShellPreferences;
  captureFocus?: boolean;
}

interface NamingState {
  mode: EntryNamingMode;
  workspaceId: string;
  parentRelativePath: string;
  entry?: WorkspaceEntry;
}

interface DeletingState {
  workspaceId: string;
  workspaceRoot: string;
  entry: WorkspaceEntry;
  phase: "confirmation" | "nonEmpty";
  busy: boolean;
  error: Failure | null;
}

/** A failure kept as data so it re-translates when the language changes. */
interface Failure {
  source: unknown;
  fallback: MessageKey;
  /** Show the workspace-boundary wording for PATH_ACCESS_DENIED. */
  scoped: boolean;
}

function failure(
  source: unknown,
  fallback: MessageKey,
  scoped = false,
): Failure {
  return { source, fallback, scoped };
}

function describeFailure(value: Failure): string {
  if (value.scoped && errorCodeOf(value.source) === "PATH_ACCESS_DENIED") {
    return t("workspace.error.outsideWorkspace");
  }
  return describeError(value.source, value.fallback);
}

interface TreeMenuState {
  row: WorkspaceTreeRow;
  trigger: HTMLButtonElement;
  anchor: { x: number; y: number };
}

export function WorkspacePanel({
  invoker: providedInvoker,
  currentWorkspaceId: controlledCurrentWorkspaceId,
  selectDirectory: providedSelectDirectory,
  onOpenFile,
  onCurrentWorkspaceChange,
  onBrowse,
  backLocation = null,
  onBackLocationApplied,
  revealLocation = null,
  onRevealLocationApplied,
  onNestedConflict,
  onWorkspacePresenceChange,
  onWorkspacesChange,
  preferences: providedPreferences,
  captureFocus = true,
}: WorkspacePanelProps) {
  const { t } = useI18n();
  const fallbackInvoker = useMemo(() => createTauriCommandInvoker(), []);
  const invoker = providedInvoker ?? fallbackInvoker;
  const selectDirectory = providedSelectDirectory ?? selectNativeDirectory;
  const [ownedPreferences] = useState(
    () => providedPreferences ?? new ShellPreferences(),
  );
  const preferences = providedPreferences ?? ownedPreferences;
  const knownWorkspaceIdsRef = useRef<Set<string> | null>(null);
  const workspaceListGenerationRef = useRef(0);
  const expandedWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const entriesRef = useRef<Record<string, Record<string, WorkspaceEntry[]>>>(
    {},
  );
  const loadingRef = useRef(new Set<string>());
  const loadingPromisesRef = useRef(
    new Map<string, Promise<WorkspaceEntry[] | undefined>>(),
  );
  const loadGenerationRef = useRef(new Map<string, number>());
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const mountButtonRef = useRef<HTMLButtonElement | null>(null);
  const openMenu = useInteractionStore((state) => state.menu);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string | null>(
    () => controlledCurrentWorkspaceId ?? null,
  );
  const [entriesByWorkspace, setEntriesByWorkspace] = useState<
    Record<string, Record<string, WorkspaceEntry[]>>
  >({});
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [expandedDirectoryKeys, setExpandedDirectoryKeys] = useState<
    Set<string>
  >(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Failure | null>(null);
  const [loadingKeys, setLoadingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingRemoval, setPendingRemoval] = useState<Workspace | null>(null);
  const [naming, setNaming] = useState<NamingState | null>(null);
  const [deleting, setDeleting] = useState<DeletingState | null>(null);
  const [treeMenu, setTreeMenu] = useState<TreeMenuState | null>(null);
  const [focusRequestKey, setFocusRequestKey] = useState<string | null>(null);
  const [selectedDirectoryRelativePath, setSelectedDirectoryRelativePath] =
    useState<string | null>(null);

  entriesRef.current = entriesByWorkspace;
  expandedWorkspaceIdsRef.current = expandedWorkspaceIds;

  useEffect(() => {
    if (controlledCurrentWorkspaceId !== undefined) {
      setCurrentWorkspaceId(controlledCurrentWorkspaceId);
    }
  }, [controlledCurrentWorkspaceId]);

  const dismissMenu = useCallback((reason: MenuDismissalReason): void => {
    if (interactionStore.getState().menu !== null) {
      interactionStore.getState().dispatch({ type: "closeMenu", reason });
    }
    setTreeMenu(null);
  }, []);

  const activeDocumentPath = useDocumentStore((state) => {
    const activeId = state.activeDocumentId;
    return activeId === null
      ? null
      : (state.sessionsById[activeId]?.path ?? null);
  });

  const forgetEntrySubtree = useCallback(
    (workspaceId: string, relativePath: string): void => {
      setEntriesByWorkspace((current) => {
        const listings = current[workspaceId];
        if (listings === undefined) return current;
        const next = {
          ...current,
          [workspaceId]: dropListingsForPath(listings, relativePath),
        };
        entriesRef.current = next;
        return next;
      });
      setExpandedDirectoryKeys((current) =>
        dropExpandedKeysForPath(current, workspaceId, relativePath),
      );
    },
    [],
  );

  const loadEntries = useCallback(
    (
      workspaceId: string,
      parentRelativePath: string,
      force = false,
    ): Promise<WorkspaceEntry[] | undefined> => {
      const loadKey = `${workspaceId}:${parentRelativePath}`;
      if (!force) {
        const pending = loadingPromisesRef.current.get(loadKey);
        if (pending !== undefined) return pending;
        const cached = entriesRef.current[workspaceId]?.[parentRelativePath];
        if (cached !== undefined) return Promise.resolve(cached);
      }
      const pending = (async (): Promise<WorkspaceEntry[] | undefined> => {
        const generation = (loadGenerationRef.current.get(loadKey) ?? 0) + 1;
        loadGenerationRef.current.set(loadKey, generation);
        loadingRef.current.add(loadKey);
        setLoadingKeys((current) => {
          const next = new Set(current);
          next.add(loadKey);
          return next;
        });
        try {
          const entries = await invoker.invoke("workspace_entry_list", {
            workspaceId,
            parentRelativePath,
          });
          if (loadGenerationRef.current.get(loadKey) !== generation)
            return undefined;
          setEntriesByWorkspace((current) => ({
            ...current,
            [workspaceId]: {
              ...(current[workspaceId] ?? {}),
              [parentRelativePath]: entries,
            },
          }));
          return entries;
        } catch (nextError) {
          if (loadGenerationRef.current.get(loadKey) !== generation) return;
          setError(failure(nextError, "workspace.error.loadFolder", true));
          return undefined;
        } finally {
          if (loadGenerationRef.current.get(loadKey) === generation) {
            loadingRef.current.delete(loadKey);
            loadingPromisesRef.current.delete(loadKey);
            setLoadingKeys((current) => {
              const next = new Set(current);
              next.delete(loadKey);
              return next;
            });
          }
        }
      })();
      loadingPromisesRef.current.set(loadKey, pending);
      return pending;
    },
    [invoker],
  );

  const applyWorkspaceList = useCallback(
    (items: Workspace[]) => {
      const liveIds = new Set(items.map((workspace) => workspace.id));
      // The list holds this window's Workspace, if it has one; it wins over
      // a Current Workspace the shell has not learned about yet.
      const nextCurrentWorkspaceId =
        controlledCurrentWorkspaceId !== undefined &&
        controlledCurrentWorkspaceId !== null &&
        liveIds.has(controlledCurrentWorkspaceId)
          ? controlledCurrentWorkspaceId
          : (items[0]?.id ?? null);
      setCurrentWorkspaceId(nextCurrentWorkspaceId);
      onCurrentWorkspaceChange?.(
        items.find((workspace) => workspace.id === nextCurrentWorkspaceId) ??
          null,
      );
      const next = preferences.isWorkspaceExpanded()
        ? new Set(liveIds)
        : new Set<string>();
      knownWorkspaceIdsRef.current = liveIds;
      expandedWorkspaceIdsRef.current = next;
      setExpandedWorkspaceIds(next);
      setWorkspaces(items);
      setEntriesByWorkspace((current) => {
        const remaining: Record<string, Record<string, WorkspaceEntry[]>> = {};
        for (const workspace of items) {
          const existing = current[workspace.id];
          if (existing !== undefined) remaining[workspace.id] = existing;
        }
        return remaining;
      });
      for (const workspace of items) {
        if (next.has(workspace.id)) {
          void loadEntries(workspace.id, "");
        }
      }
    },
    [
      controlledCurrentWorkspaceId,
      loadEntries,
      onCurrentWorkspaceChange,
      preferences,
    ],
  );

  // Opening a Workspace loads its saved expansion.
  useEffect(
    () =>
      preferences.subscribe(() => {
        const next = preferences.isWorkspaceExpanded()
          ? new Set(knownWorkspaceIdsRef.current ?? [])
          : new Set<string>();
        const current = expandedWorkspaceIdsRef.current;
        if (
          next.size === current.size &&
          [...next].every((id) => current.has(id))
        ) {
          return;
        }
        expandedWorkspaceIdsRef.current = next;
        setExpandedWorkspaceIds(next);
        for (const id of next) void loadEntries(id, "");
      }),
    [loadEntries, preferences],
  );

  useEffect(() => {
    let disposed = false;
    const generation = ++workspaceListGenerationRef.current;
    void invoker
      .invoke("workspace_list", {})
      .then((items) => {
        if (!disposed && workspaceListGenerationRef.current === generation) {
          applyWorkspaceList(items);
          onWorkspacePresenceChange?.(items.length > 0);
          onWorkspacesChange?.(items);
        }
      })
      .catch((nextError: unknown) => {
        if (!disposed)
          setError(failure(nextError, "workspace.error.loadWorkspaces"));
      });
    return () => {
      disposed = true;
    };
  }, [
    applyWorkspaceList,
    invoker,
    onWorkspacePresenceChange,
    onWorkspacesChange,
  ]);

  useEffect(() => {
    if (
      controlledCurrentWorkspaceId === undefined ||
      controlledCurrentWorkspaceId === null
    ) {
      return;
    }
    let disposed = false;
    const generation = ++workspaceListGenerationRef.current;
    void invoker
      .invoke("workspace_list", {})
      .then((items) => {
        if (!disposed && workspaceListGenerationRef.current === generation) {
          applyWorkspaceList(items);
          onWorkspacePresenceChange?.(items.length > 0);
          onWorkspacesChange?.(items);
        }
      })
      .catch((nextError: unknown) => {
        if (!disposed) {
          setError(failure(nextError, "workspace.error.loadWorkspaces"));
        }
      });
    return () => {
      disposed = true;
    };
  }, [
    applyWorkspaceList,
    controlledCurrentWorkspaceId,
    invoker,
    onWorkspacePresenceChange,
    onWorkspacesChange,
  ]);

  useEffect(() => {
    if (!hasTauriCommandRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void defaultEventListener("workspace-entries-changed", (event) => {
      const payload = event.payload;
      if (payload.change !== "created" && payload.change !== "invalidated") {
        forgetEntrySubtree(payload.workspaceId, payload.relativePath);
      }
      for (const parentRelativePath of parentsToReload(payload)) {
        void loadEntries(payload.workspaceId, parentRelativePath, true);
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [forgetEntrySubtree, loadEntries]);

  useEffect(() => {
    if (openMenu === null && treeMenu !== null) setTreeMenu(null);
  }, [openMenu, treeMenu]);

  useEffect(() => {
    if (
      backLocation === null ||
      backLocation.workspaceId !== currentWorkspaceId
    ) {
      return;
    }
    setSelectedDirectoryRelativePath(
      backLocation.directoryRelativePath.length > 0
        ? backLocation.directoryRelativePath
        : null,
    );
    setFocusRequestKey(
      backLocation.directoryRelativePath.length === 0
        ? makeWorkspaceRowKey(backLocation.workspaceId)
        : makeEntryRowKey(
            backLocation.workspaceId,
            backLocation.directoryRelativePath,
          ),
    );
    if (backLocation.directoryRelativePath.length > 0) {
      const parentRelativePath = backLocation.directoryRelativePath.includes(
        "/",
      )
        ? backLocation.directoryRelativePath.slice(
            0,
            backLocation.directoryRelativePath.lastIndexOf("/"),
          )
        : "";
      void loadEntries(backLocation.workspaceId, parentRelativePath);
    }
    onBackLocationApplied?.();
  }, [backLocation, currentWorkspaceId, loadEntries, onBackLocationApplied]);

  useEffect(() => {
    if (
      revealLocation === null ||
      revealLocation.workspaceId !== currentWorkspaceId
    ) {
      return;
    }
    const { workspaceId, directoryRelativePath } = revealLocation;
    const segments = directoryRelativePath.split("/").filter(Boolean);
    const folders = segments.map((_, index) =>
      segments.slice(0, index + 1).join("/"),
    );
    preferences.setWorkspaceExpanded(true);
    setExpandedWorkspaceIds((current) => {
      const next = new Set(current).add(workspaceId);
      expandedWorkspaceIdsRef.current = next;
      return next;
    });
    setExpandedDirectoryKeys((current) => {
      const next = new Set(current);
      for (const folder of folders) {
        next.add(makeEntryRowKey(workspaceId, folder));
      }
      return next;
    });
    for (const parent of ["", ...folders]) {
      void loadEntries(workspaceId, parent);
    }
    const target = folders.at(-1) ?? null;
    setSelectedDirectoryRelativePath(target);
    setFocusRequestKey(
      target === null
        ? makeWorkspaceRowKey(workspaceId)
        : makeEntryRowKey(workspaceId, target),
    );
    onRevealLocationApplied?.();
  }, [
    currentWorkspaceId,
    loadEntries,
    onRevealLocationApplied,
    preferences,
    revealLocation,
  ]);

  useEffect(() => {
    if (treeMenu === null) return;
    if (
      !workspaces.some((workspace) => workspace.id === treeMenu.row.workspaceId)
    ) {
      dismissMenu("workspaceRemoved");
      return;
    }
    if (!treeMenu.trigger.isConnected) {
      dismissMenu("triggerRemoved");
    }
  }, [dismissMenu, entriesByWorkspace, treeMenu, workspaces]);

  const mountWorkspace = async () => {
    if (!selectDirectory) {
      setError(
        failure(
          new LocalizedError("workspace.error.mountNoDialog"),
          "workspace.error.mount",
        ),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const rootPath = await selectDirectory();
      if (rootPath) {
        workspaceListGenerationRef.current += 1;
        // A window shows one Workspace: opening another replaces it after
        // every tab is closed, or brings the window that owns it forward.
        const result = await openWorkspaceInWindow({
          invoker,
          target: { rootPath },
          closeTabs: () => closeAllTabsForWorkspaceSwitch(documentManager),
        });
        if (result.status === "declined") {
          if (result.outcome.kind === "containsOpen") {
            if (onNestedConflict === undefined) throw containsOpenError();
            await onNestedConflict(rootPath, result.outcome);
          }
          return;
        }
        const { workspace } = result;
        const next = [workspace];
        knownWorkspaceIdsRef.current = new Set([workspace.id]);
        setWorkspaces(next);
        setEntriesByWorkspace((current) => {
          const existing = current[workspace.id];
          return existing === undefined ? {} : { [workspace.id]: existing };
        });
        onWorkspacesChange?.(next);
        setCurrentWorkspaceId(workspace.id);
        onCurrentWorkspaceChange?.(workspace);
        // Shows the Workspace's saved pin, width and expansion.
        preferences.loadWorkspace(result.shell);
        onWorkspacePresenceChange?.(true);
      }
    } catch (nextError) {
      setError(failure(nextError, "workspace.error.mount"));
    } finally {
      setBusy(false);
    }
  };

  const removeWorkspace = async (workspace: Workspace) => {
    setBusy(true);
    setError(null);
    try {
      const closeOutcome = await documentManager.closeWorkspaceDocuments(
        workspace.rootPath,
      );
      if (closeOutcome.status === "orphaned") {
        await documentManager.activate(closeOutcome.documentId);
        throw new LocalizedError("workspace.error.removeOrphaned");
      }
      if (closeOutcome.status === "failed") {
        throw new DescribedError(closeOutcome.message);
      }
      if (closeOutcome.status !== "closed") {
        throw new LocalizedError("workspace.error.removeStillClosing");
      }
      await invoker.invoke("window_release_workspace", {});
      workspaceListGenerationRef.current += 1;
      const next = workspaces.filter((item) => item.id !== workspace.id);
      const nextCurrentWorkspaceId =
        workspace.id === currentWorkspaceId
          ? (next[0]?.id ?? null)
          : currentWorkspaceId;
      if (nextCurrentWorkspaceId === null) preferences.closeWorkspace();
      setCurrentWorkspaceId(nextCurrentWorkspaceId);
      onCurrentWorkspaceChange?.(
        next.find((item) => item.id === nextCurrentWorkspaceId) ?? null,
      );
      setWorkspaces(next);
      onWorkspacesChange?.(next);
      setExpandedWorkspaceIds((current) => {
        const withoutRemoved = new Set(current);
        withoutRemoved.delete(workspace.id);
        expandedWorkspaceIdsRef.current = withoutRemoved;
        return withoutRemoved;
      });
      knownWorkspaceIdsRef.current?.delete(workspace.id);
      setEntriesByWorkspace((current) => {
        const remaining = { ...current };
        delete remaining[workspace.id];
        return remaining;
      });
      onWorkspacePresenceChange?.(next.length > 0);
      returnFocusRef.current = null;
      setPendingRemoval(null);
      if (next[0] !== undefined) {
        setFocusRequestKey(makeWorkspaceRowKey(next[0].id));
      } else {
        setFocusRequestKey(null);
        queueMicrotask(() => mountButtonRef.current?.focus());
      }
    } catch (nextError) {
      setError(failure(nextError, "workspace.error.remove"));
    } finally {
      setBusy(false);
    }
  };

  const openDialogMenu = (): void => {
    dismissMenu("dialogOpened");
  };

  const handleRowAction = (
    row: WorkspaceTreeRow,
    trigger: HTMLButtonElement,
    pointer?: { x: number; y: number },
  ): void => {
    const triggerId = `tree:${row.key}`;
    interactionStore.getState().dispatch({
      type: "openMenu",
      menuId: `tree:${row.key}`,
      triggerId,
      returnFocusId: triggerId,
    });
    if (interactionStore.getState().menu === null) {
      setTreeMenu(null);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    // Dialogs opened from the menu return focus to the row: its actions
    // button is hidden unless the row is hovered or focused.
    returnFocusRef.current =
      trigger.closest<HTMLElement>('[role="treeitem"]') ?? trigger;
    menuTriggerRef.current = trigger;
    setTreeMenu({
      row,
      trigger,
      anchor: pointer ?? { x: rect.left, y: rect.bottom },
    });
  };

  const workspaceRootFor = (workspaceId: string): string =>
    workspaces.find((workspace) => workspace.id === workspaceId)?.rootPath ??
    "";

  const beginNaming = (
    mode: EntryNamingMode,
    workspaceId: string,
    parentRelativePath: string,
    entry?: WorkspaceEntry,
  ): void => {
    openDialogMenu();
    setError(null);
    setNaming({ mode, workspaceId, parentRelativePath, entry });
  };

  const submitNaming = async (baseName: string) => {
    if (naming === null) return;
    if (naming.mode === "newDrawing" || naming.mode === "newDirectory") {
      const created = await invoker.invoke("workspace_entry_create", {
        workspaceId: naming.workspaceId,
        parentRelativePath: naming.parentRelativePath,
        kind: naming.mode === "newDrawing" ? "drawing" : "directory",
        baseName,
      });
      await loadEntries(naming.workspaceId, naming.parentRelativePath, true);
      if (created.entry.kind === "drawing") {
        onOpenFile?.(asFileEntry(created.entry));
      } else {
        const key = makeEntryRowKey(
          created.entry.workspaceId,
          created.entry.relativePath,
        );
        setExpandedDirectoryKeys((current) => new Set(current).add(key));
        await loadEntries(
          created.entry.workspaceId,
          created.entry.relativePath,
          true,
        );
      }
      returnFocusRef.current = null;
      setFocusRequestKey(
        makeEntryRowKey(created.entry.workspaceId, created.entry.relativePath),
      );
    } else if (naming.entry !== undefined) {
      const entry = naming.entry;
      const root = workspaceRootFor(naming.workspaceId);
      const renamed = await documentManager.coordinateEntryRename(
        root,
        entry.canonicalPath,
        (expectedOpenDocuments) =>
          invoker.invoke("workspace_entry_rename", {
            workspaceId: naming.workspaceId,
            relativePath: entry.relativePath,
            baseName,
            expectedOpenDocuments,
          }),
      );
      forgetEntrySubtree(naming.workspaceId, entry.relativePath);
      await loadEntries(naming.workspaceId, entry.parentRelativePath, true);
      returnFocusRef.current = null;
      setFocusRequestKey(
        makeEntryRowKey(naming.workspaceId, renamed.newRelativePath),
      );
    }
    setNaming(null);
  };

  const requestDelete = async (
    workspaceId: string,
    entry: WorkspaceEntry,
  ): Promise<void> => {
    openDialogMenu();
    const root = workspaceRootFor(workspaceId);
    try {
      const blockedDocumentId = documentManager.entryDeleteBlock(
        entry.canonicalPath,
      );
      if (blockedDocumentId !== null) {
        await documentManager.activate(blockedDocumentId);
        setError(
          failure(
            new LocalizedError("workspace.error.saveBeforeDelete"),
            "workspace.error.fileOperation",
          ),
        );
        return;
      }
      const preflight = await invoker.invoke(
        "workspace_entry_delete_preflight",
        {
          workspaceId,
          relativePath: entry.relativePath,
        },
      );
      setDeleting({
        workspaceId,
        workspaceRoot: root,
        entry,
        phase:
          preflight.status === "directoryNotEmpty"
            ? "nonEmpty"
            : "confirmation",
        busy: false,
        error: null,
      });
    } catch (nextError) {
      setError(failure(nextError, "workspace.error.fileOperation", true));
    }
  };

  const confirmDelete = async () => {
    if (deleting === null) return;
    const { workspaceId, workspaceRoot, entry } = deleting;
    setDeleting((current) =>
      current === null ? current : { ...current, busy: true, error: null },
    );
    try {
      const deleteResult =
        await documentManager.coordinateCleanEntryDelete<EntryDeleteResult>(
          workspaceRoot,
          entry.canonicalPath,
          (expectedOpenDocument) =>
            invoker.invoke("workspace_entry_delete", {
              workspaceId,
              relativePath: entry.relativePath,
              ...(expectedOpenDocument === undefined
                ? {}
                : { expectedOpenDocument }),
            }),
        );
      forgetEntrySubtree(workspaceId, entry.relativePath);
      await loadEntries(workspaceId, entry.parentRelativePath, true);
      returnFocusRef.current = null;
      setFocusRequestKey(
        entry.parentRelativePath.length === 0
          ? makeWorkspaceRowKey(workspaceId)
          : makeEntryRowKey(workspaceId, entry.parentRelativePath),
      );
      setDeleting(null);
      if (deleteResult.historyMaintenance !== undefined) {
        setError(historyMaintenanceFailure(deleteResult.historyMaintenance));
      }
    } catch (nextError) {
      setDeleting((current) =>
        current === null
          ? current
          : {
              ...current,
              busy: false,
              error: failure(nextError, "workspace.error.deleteEntry", true),
            },
      );
    }
  };

  const revealDeleting = async () => {
    if (deleting === null) return;
    const { workspaceId, entry } = deleting;
    setDeleting((current) =>
      current === null ? current : { ...current, busy: true, error: null },
    );
    try {
      await invoker.invoke("workspace_entry_reveal", {
        workspaceId,
        relativePath: entry.relativePath,
      });
      setDeleting(null);
    } catch (nextError) {
      setDeleting((current) =>
        current === null
          ? current
          : {
              ...current,
              busy: false,
              error: failure(nextError, "workspace.error.revealFolder", true),
            },
      );
    }
  };

  const menuItems = (row: WorkspaceTreeRow): ContextMenuItem[] => {
    if (row.kind === "workspace") {
      return [
        {
          id: "new-drawing",
          label: t("workspace.newDrawing"),
          onSelect: () => beginNaming("newDrawing", row.workspaceId, ""),
        },
        {
          id: "new-folder",
          label: t("workspace.newFolder"),
          onSelect: () => beginNaming("newDirectory", row.workspaceId, ""),
        },
        {
          id: "remove-workspace",
          label: t("workspace.menu.removeWorkspace"),
          onSelect: () => {
            openDialogMenu();
            setError(null);
            setPendingRemoval(row.workspace);
          },
        },
      ];
    }
    if (row.kind === "directory") {
      return [
        {
          id: "new-drawing",
          label: t("workspace.newDrawing"),
          onSelect: () =>
            beginNaming("newDrawing", row.workspaceId, row.entry.relativePath),
        },
        {
          id: "new-folder",
          label: t("workspace.newFolder"),
          onSelect: () =>
            beginNaming(
              "newDirectory",
              row.workspaceId,
              row.entry.relativePath,
            ),
        },
        {
          id: "rename",
          label: t("workspace.menu.rename"),
          onSelect: () =>
            beginNaming(
              "renameDirectory",
              row.workspaceId,
              row.entry.parentRelativePath,
              row.entry,
            ),
        },
        {
          id: "delete",
          label: t("workspace.menu.delete"),
          destructive: true,
          onSelect: () => {
            void requestDelete(row.workspaceId, row.entry);
          },
        },
      ];
    }
    return [
      {
        id: "rename",
        label: t("workspace.menu.rename"),
        onSelect: () =>
          beginNaming(
            "renameDrawing",
            row.workspaceId,
            row.entry.parentRelativePath,
            row.entry,
          ),
      },
      {
        id: "delete",
        label: t("workspace.menu.delete"),
        destructive: true,
        onSelect: () => {
          void requestDelete(row.workspaceId, row.entry);
        },
      },
    ];
  };

  const currentWorkspace = workspaces.find(
    (workspace) => workspace.id === currentWorkspaceId,
  );
  const currentWorkspaceEntries =
    currentWorkspaceId === null
      ? {}
      : (entriesByWorkspace[currentWorkspaceId] ?? {});
  const knownDirectoryKeys = Object.values(currentWorkspaceEntries)
    .flat()
    .filter(
      (entry) =>
        entry.workspaceId === currentWorkspaceId && entry.kind === "directory",
    )
    .map((entry) => makeEntryRowKey(entry.workspaceId, entry.relativePath));
  const allCurrentDirectoriesExpanded =
    currentWorkspaceId !== null &&
    expandedWorkspaceIds.has(currentWorkspaceId) &&
    knownDirectoryKeys.every((key) => expandedDirectoryKeys.has(key));

  const expandAllDirectories = async (
    workspaceId: string,
    parentRelativePath: string,
    visited: Set<string>,
  ): Promise<void> => {
    const pathKey = `${workspaceId}:${parentRelativePath}`;
    if (visited.has(pathKey)) return;
    visited.add(pathKey);
    const entries = await loadEntries(workspaceId, parentRelativePath);
    if (entries === undefined) return;
    const directories = entries.filter((entry) => entry.kind === "directory");
    if (directories.length === 0) return;
    setExpandedDirectoryKeys((current) => {
      const next = new Set(current);
      for (const directory of directories) {
        next.add(
          makeEntryRowKey(directory.workspaceId, directory.relativePath),
        );
      }
      return next;
    });
    await Promise.all(
      directories.map((directory) =>
        expandAllDirectories(workspaceId, directory.relativePath, visited),
      ),
    );
  };

  const toggleAllCurrentWorkspace = (): void => {
    if (currentWorkspaceId === null) return;
    const shouldExpand = !allCurrentDirectoriesExpanded;
    preferences.setWorkspaceExpanded(shouldExpand);
    setExpandedWorkspaceIds((current) => {
      const next = new Set(current);
      if (shouldExpand) next.add(currentWorkspaceId);
      else next.delete(currentWorkspaceId);
      expandedWorkspaceIdsRef.current = next;
      return next;
    });
    setExpandedDirectoryKeys((current) => {
      const next = new Set(current);
      for (const key of knownDirectoryKeys) {
        if (shouldExpand) next.add(key);
        else next.delete(key);
      }
      return next;
    });
    if (shouldExpand) {
      void expandAllDirectories(currentWorkspaceId, "", new Set());
    }
  };

  const refreshCurrentWorkspace = (): void => {
    if (currentWorkspaceId === null) return;
    forgetEntrySubtree(currentWorkspaceId, "");
    void loadEntries(currentWorkspaceId, "", true);
  };

  const targetRelativePath = selectedDirectoryRelativePath ?? "";

  const treeEntries: WorkspaceTreeEntriesByWorkspace = entriesByWorkspace;

  return (
    <section
      aria-busy={loadingKeys.size > 0 || undefined}
      aria-label={t("workspace.panelLabel")}
      className="workspace-panel"
    >
      <div className="workspace-panel-header">
        <p className="workspace-panel-eyebrow">{t("workspace.eyebrow")}</p>
        <div className="workspace-panel-title-row">
          <h2 title={currentWorkspace?.name ?? t("workspace.defaultTitle")}>
            {currentWorkspace?.name ?? t("workspace.defaultTitle")}
          </h2>
          <div
            aria-label={t("workspace.actionsLabel")}
            className="workspace-panel-actions"
            role="toolbar"
          >
            <button
              aria-label={t("workspace.newDrawing")}
              className="icon-button"
              disabled={busy || currentWorkspaceId === null}
              onClick={(event) => {
                if (currentWorkspaceId === null) return;
                returnFocusRef.current = event.currentTarget;
                beginNaming(
                  "newDrawing",
                  currentWorkspaceId,
                  targetRelativePath,
                );
              }}
              title={t("workspace.newDrawing")}
              type="button"
            >
              <img alt="" aria-hidden="true" src={newDrawingIcon} />
            </button>
            <button
              aria-label={t("workspace.newFolder")}
              className="icon-button"
              disabled={busy || currentWorkspaceId === null}
              onClick={(event) => {
                if (currentWorkspaceId === null) return;
                returnFocusRef.current = event.currentTarget;
                beginNaming(
                  "newDirectory",
                  currentWorkspaceId,
                  targetRelativePath,
                );
              }}
              title={t("workspace.newFolder")}
              type="button"
            >
              <img alt="" aria-hidden="true" src={newFolderIcon} />
            </button>
            <button
              aria-label={
                allCurrentDirectoriesExpanded
                  ? t("workspace.collapseAll")
                  : t("workspace.expandAll")
              }
              className="icon-button"
              disabled={busy || currentWorkspaceId === null}
              onClick={toggleAllCurrentWorkspace}
              title={
                allCurrentDirectoriesExpanded
                  ? t("workspace.collapseAll")
                  : t("workspace.expandAll")
              }
              type="button"
            >
              <img
                alt=""
                aria-hidden="true"
                className={
                  allCurrentDirectoriesExpanded
                    ? "workspace-panel-collapse-all-icon"
                    : undefined
                }
                src={
                  allCurrentDirectoriesExpanded
                    ? collapseAllIcon
                    : expandAllIcon
                }
              />
            </button>
            <button
              aria-label={t("workspace.refresh")}
              className="icon-button"
              disabled={busy || currentWorkspaceId === null}
              onClick={refreshCurrentWorkspace}
              title={t("workspace.refresh")}
              type="button"
            >
              <img alt="" aria-hidden="true" src={refreshIcon} />
            </button>
          </div>
        </div>
      </div>
      {loadingKeys.size > 0 ? (
        <p aria-live="polite" role="status">
          {t("workspace.loadingFolder")}
        </p>
      ) : null}
      {error && pendingRemoval === null && deleting === null ? (
        <p role="alert">{describeFailure(error)}</p>
      ) : null}
      {workspaces.length === 0 ? (
        <div className="sidebar-placeholder">
          <p>{t("workspace.empty")}</p>
          <button
            ref={mountButtonRef}
            type="button"
            disabled={busy}
            onClick={() => void mountWorkspace()}
          >
            {t("workspace.mountFolder")}
          </button>
        </div>
      ) : (
        <WorkspaceTree
          workspaces={workspaces}
          entriesByWorkspace={treeEntries}
          currentWorkspaceId={currentWorkspaceId}
          expandedWorkspaceIds={expandedWorkspaceIds}
          expandedDirectoryKeys={expandedDirectoryKeys}
          activeDocumentPath={activeDocumentPath}
          captureFocus={captureFocus}
          onToggleWorkspace={(workspaceId, expanded) => {
            preferences.setWorkspaceExpanded(expanded);
            setExpandedWorkspaceIds((current) => {
              const next = new Set(current);
              if (expanded) next.add(workspaceId);
              else next.delete(workspaceId);
              expandedWorkspaceIdsRef.current = next;
              return next;
            });
            if (expanded) void loadEntries(workspaceId, "");
            else if (treeMenu?.row.workspaceId === workspaceId) {
              dismissMenu("ownerCollapsed");
            }
          }}
          onToggleDirectory={(entry, expanded) => {
            const key = makeEntryRowKey(entry.workspaceId, entry.relativePath);
            setExpandedDirectoryKeys((current) => {
              const next = new Set(current);
              if (expanded) next.add(key);
              else next.delete(key);
              return next;
            });
            if (expanded)
              void loadEntries(entry.workspaceId, entry.relativePath);
            else if (
              treeMenu !== null &&
              menuOwnedByDirectory(treeMenu.row, entry)
            ) {
              dismissMenu("ownerCollapsed");
            }
          }}
          onOpenDrawing={(entry) => onOpenFile?.(asFileEntry(entry))}
          onSelectRow={(row) => {
            const directoryRelativePath =
              row.kind === "directory" ? row.entry.relativePath : "";
            setSelectedDirectoryRelativePath(
              directoryRelativePath.length > 0 ? directoryRelativePath : null,
            );
            onBrowse?.({
              workspaceId: row.workspaceId,
              directoryRelativePath,
            });
          }}
          onRowAction={handleRowAction}
          focusRequestKey={focusRequestKey}
          onFocusRequestApplied={() => setFocusRequestKey(null)}
          onScroll={() => {
            if (openMenu !== null) dismissMenu("treeScroll");
          }}
        />
      )}
      {openMenu !== null && treeMenu !== null ? (
        <ContextMenu
          key={openMenu.menuId}
          anchor={treeMenu.anchor}
          description={
            treeMenu.row.kind === "workspace"
              ? t("workspace.menu.filesNotDeleted")
              : undefined
          }
          items={menuItems(treeMenu.row)}
          label={t("workspace.menu.actionsFor", {
            name: treeMenu.row.displayName,
          })}
          onDismiss={dismissMenu}
          triggerRef={menuTriggerRef}
        />
      ) : null}
      {naming ? (
        <EntryNamingDialog
          currentName={naming.entry?.name}
          mode={naming.mode}
          returnFocusRef={returnFocusRef}
          onCancel={() => setNaming(null)}
          onSubmit={submitNaming}
        />
      ) : null}
      {deleting?.phase === "confirmation" ? (
        <EntryDeleteConfirmationDialog
          busy={deleting.busy}
          displayName={deleting.entry.name}
          path={deleting.entry.canonicalPath}
          errorMessage={
            deleting.error === null ? null : describeFailure(deleting.error)
          }
          returnFocusRef={returnFocusRef}
          onCancel={() => {
            if (!deleting.busy) setDeleting(null);
          }}
          onDelete={() => void confirmDelete()}
        />
      ) : null}
      {deleting?.phase === "nonEmpty" ? (
        <DirectoryNotEmptyDialog
          busy={deleting.busy}
          path={deleting.entry.canonicalPath}
          errorMessage={
            deleting.error === null ? null : describeFailure(deleting.error)
          }
          returnFocusRef={returnFocusRef}
          onCancel={() => {
            if (!deleting.busy) setDeleting(null);
          }}
          onReveal={() => void revealDeleting()}
        />
      ) : null}
      {pendingRemoval ? (
        <RemoveWorkspaceDialog
          busy={busy}
          errorMessage={error === null ? null : describeFailure(error)}
          onCancel={() => {
            if (busy) return;
            setPendingRemoval(null);
            setError(null);
          }}
          onRemove={() => void removeWorkspace(pendingRemoval)}
          returnFocusRef={returnFocusRef}
          workspace={pendingRemoval}
        />
      ) : null}
    </section>
  );
}

/**
 * Removing a Workspace from the list keeps its files, so the action uses the
 * primary style. Sidebar confirmation anatomy with the root path; Cancel has
 * the initial focus.
 */
function RemoveWorkspaceDialog({
  workspace,
  busy,
  errorMessage,
  returnFocusRef,
  onCancel,
  onRemove,
}: {
  workspace: Workspace;
  busy: boolean;
  errorMessage: string | null;
  returnFocusRef: RefObject<HTMLElement | null>;
  onCancel(): void;
  onRemove(): void;
}) {
  const { t } = useI18n();
  const home = useHomeDirectory();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <ApplicationDialog
      actions={
        <ApplicationDialogActions>
          <ApplicationDialogButton
            buttonRef={cancelRef}
            disabled={busy}
            kind="secondary"
            onClick={onCancel}
          >
            {t("workspace.remove.cancel")}
          </ApplicationDialogButton>
          <ApplicationDialogButton
            disabled={busy}
            kind="primary"
            onClick={onRemove}
          >
            {t("workspace.remove.confirm")}
          </ApplicationDialogButton>
        </ApplicationDialogActions>
      }
      busy={busy}
      description={t("workspace.remove.description")}
      errorMessage={errorMessage}
      initialFocusRef={cancelRef}
      objectPath={abbreviateHome(workspace.rootPath, home)}
      onDismiss={onCancel}
      returnFocusRef={returnFocusRef}
      title={t("workspace.remove.title", { name: workspace.name })}
      variant="sidebar"
    >
      {null}
    </ApplicationDialog>
  );
}

function asFileEntry(entry: WorkspaceEntry): FileEntry {
  return {
    canonicalPath: entry.canonicalPath,
    workspaceId: entry.workspaceId,
    displayName: entry.displayName,
    relativePath: entry.relativePath,
    mtime: entry.mtime,
    fileSize: entry.fileSize,
  };
}

function historyMaintenanceFailure(
  status: "pendingReplay" | "cleanupPending",
): Failure {
  return failure(
    new LocalizedError(
      status === "pendingReplay"
        ? "workspace.notice.historyCleanupPending"
        : "workspace.notice.historyResourcesPending",
    ),
    "workspace.error.fileOperation",
  );
}

function parentRelativePathOf(relativePath: string): string {
  if (relativePath.length === 0) return "";
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? "" : relativePath.slice(0, index);
}

function listingCoversPath(root: string, candidate: string): boolean {
  if (root.length === 0) return true;
  return candidate === root || candidate.startsWith(`${root}/`);
}

function dropListingsForPath(
  listings: Record<string, WorkspaceEntry[]>,
  relativePath: string,
): Record<string, WorkspaceEntry[]> {
  const next: Record<string, WorkspaceEntry[]> = {};
  for (const [parent, entries] of Object.entries(listings)) {
    if (!listingCoversPath(relativePath, parent)) next[parent] = entries;
  }
  return next;
}

function dropExpandedKeysForPath(
  keys: ReadonlySet<string>,
  workspaceId: string,
  relativePath: string,
): Set<string> {
  const prefix = `entry:${encodeURIComponent(workspaceId)}:`;
  const next = new Set<string>();
  for (const key of keys) {
    if (!key.startsWith(prefix)) {
      next.add(key);
      continue;
    }
    const path = decodeURIComponent(key.slice(prefix.length));
    if (!listingCoversPath(relativePath, path)) next.add(key);
  }
  return next;
}

function parentsToReload(event: WorkspaceEntriesChangedEvent): string[] {
  if (event.change === "invalidated") return [event.relativePath];
  const parents = [parentRelativePathOf(event.relativePath)];
  if (event.newRelativePath !== undefined) {
    parents.push(parentRelativePathOf(event.newRelativePath));
  }
  return [...new Set(parents)];
}

function menuOwnedByDirectory(
  row: WorkspaceTreeRow,
  directory: WorkspaceEntry,
): boolean {
  if (row.workspaceId !== directory.workspaceId) return false;
  if (row.kind === "workspace") return false;
  return (
    row.relativePath === directory.relativePath ||
    row.relativePath.startsWith(`${directory.relativePath}/`)
  );
}

async function selectNativeDirectory(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    directory: true,
    multiple: false,
    title: t("workspace.mountDialogTitle"),
  });
  return typeof selected === "string" ? selected : null;
}
