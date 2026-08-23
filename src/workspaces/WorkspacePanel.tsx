import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApplicationDialog,
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
import {
  SHELL_PREFERENCES_STORAGE_KEY,
  ShellPreferences,
} from "../app/shellPreferences";
import { documentManager, useDocumentStore } from "../documents/documentStore";
import type { CommandInvoker } from "../ipc/client";
import {
  createTauriCommandInvoker,
  hasTauriCommandRuntime,
} from "../ipc/client";
import type {
  FileEntry,
  IpcError,
  Workspace,
  WorkspaceEntriesChangedEvent,
  WorkspaceEntry,
} from "../ipc/contracts";
import { defaultEventListener } from "../ipc/events";
import { WorkspaceTree } from "./WorkspaceTree";
import {
  makeEntryRowKey,
  makeWorkspaceRowKey,
  type WorkspaceTreeEntriesByWorkspace,
  type WorkspaceTreeRow,
} from "./workspaceTreeModel";

export interface WorkspacePanelProps {
  invoker?: CommandInvoker;
  selectDirectory?: () => Promise<string | null>;
  onOpenFile?: (entry: FileEntry) => void;
  onWorkspacePresenceChange?: (hasAny: boolean) => void;
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
  error: string | null;
}

interface TreeMenuState {
  row: WorkspaceTreeRow;
  trigger: HTMLButtonElement;
  anchor: { x: number; y: number };
}

const firstLaunchByStorage = new WeakMap<object, boolean>();
const firstListAppliedByStorage = new WeakMap<object, boolean>();

export function WorkspacePanel({
  invoker: providedInvoker,
  selectDirectory: providedSelectDirectory,
  onOpenFile,
  onWorkspacePresenceChange,
  preferences: providedPreferences,
  captureFocus = true,
}: WorkspacePanelProps) {
  const fallbackInvoker = useMemo(() => createTauriCommandInvoker(), []);
  const invoker = providedInvoker ?? fallbackInvoker;
  const selectDirectory = providedSelectDirectory ?? selectNativeDirectory;
  const firstLaunch = storageIsFirstLaunch(globalThis.localStorage);
  const [ownedPreferences] = useState(
    () => providedPreferences ?? new ShellPreferences(),
  );
  const preferences = providedPreferences ?? ownedPreferences;
  const knownWorkspaceIdsRef = useRef<Set<string> | null>(null);
  const expandedWorkspaceIdsRef = useRef<Set<string>>(new Set());
  const entriesRef = useRef<Record<string, Record<string, WorkspaceEntry[]>>>(
    {},
  );
  const loadingRef = useRef(new Set<string>());
  const loadGenerationRef = useRef(new Map<string, number>());
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const mountButtonRef = useRef<HTMLButtonElement | null>(null);
  const openMenu = useInteractionStore((state) => state.menu);

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [entriesByWorkspace, setEntriesByWorkspace] = useState<
    Record<string, Record<string, WorkspaceEntry[]>>
  >({});
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Set<string>>(
    () => {
      const initial = firstLaunch
        ? new Set<string>()
        : new Set(preferences.getSnapshot().expandedWorkspaceIds);
      expandedWorkspaceIdsRef.current = initial;
      return initial;
    },
  );
  const [expandedDirectoryKeys, setExpandedDirectoryKeys] = useState<
    Set<string>
  >(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<Workspace | null>(null);
  const [naming, setNaming] = useState<NamingState | null>(null);
  const [deleting, setDeleting] = useState<DeletingState | null>(null);
  const [treeMenu, setTreeMenu] = useState<TreeMenuState | null>(null);
  const [focusRequestKey, setFocusRequestKey] = useState<string | null>(null);

  entriesRef.current = entriesByWorkspace;
  expandedWorkspaceIdsRef.current = expandedWorkspaceIds;

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
    async (
      workspaceId: string,
      parentRelativePath: string,
      force = false,
    ) => {
      const loadKey = `${workspaceId}:${parentRelativePath}`;
      if (!force) {
        if (loadingRef.current.has(loadKey)) return;
        if (entriesRef.current[workspaceId]?.[parentRelativePath] !== undefined)
          return;
      }
      const generation = (loadGenerationRef.current.get(loadKey) ?? 0) + 1;
      loadGenerationRef.current.set(loadKey, generation);
      loadingRef.current.add(loadKey);
      try {
        const entries = await invoker.invoke("workspace_entry_list", {
          workspaceId,
          parentRelativePath,
        });
        if (loadGenerationRef.current.get(loadKey) !== generation) return;
        setEntriesByWorkspace((current) => ({
          ...current,
          [workspaceId]: {
            ...(current[workspaceId] ?? {}),
            [parentRelativePath]: entries,
          },
        }));
      } catch (nextError) {
        if (loadGenerationRef.current.get(loadKey) !== generation) return;
        setError(operationError(nextError, "Unable to load this folder."));
      } finally {
        if (loadGenerationRef.current.get(loadKey) === generation) {
          loadingRef.current.delete(loadKey);
        }
      }
    },
    [invoker],
  );

  const applyWorkspaceList = useCallback(
    (items: Workspace[]) => {
      const liveIds = new Set(items.map((workspace) => workspace.id));
      preferences.pruneWorkspaceIds(liveIds);
      const known = knownWorkspaceIdsRef.current;
      const next = new Set(expandedWorkspaceIdsRef.current);
      if (known === null) {
        const alreadyAppliedFirstLaunch =
          firstListAppliedByStorage.get(globalThis.localStorage) === true;
        if (firstLaunch && !alreadyAppliedFirstLaunch) {
          for (const workspace of items) {
            next.add(workspace.id);
            preferences.setWorkspaceExpanded(workspace.id, true);
          }
          firstListAppliedByStorage.set(globalThis.localStorage, true);
        } else {
          next.clear();
          for (const id of preferences.getSnapshot().expandedWorkspaceIds) {
            if (liveIds.has(id)) next.add(id);
          }
        }
      } else {
        for (const workspace of items) {
          if (!known.has(workspace.id)) {
            next.add(workspace.id);
            preferences.setWorkspaceExpanded(workspace.id, true);
          }
        }
        for (const id of [...next]) {
          if (!liveIds.has(id)) next.delete(id);
        }
      }
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
    [firstLaunch, loadEntries, preferences],
  );

  useEffect(() => {
    let disposed = false;
    void invoker
      .invoke("workspace_list", {})
      .then((items) => {
        if (!disposed) {
          applyWorkspaceList(items);
          onWorkspacePresenceChange?.(items.length > 0);
        }
      })
      .catch((nextError: unknown) => {
        if (!disposed)
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Unable to load workspaces.",
          );
      });
    return () => {
      disposed = true;
    };
  }, [applyWorkspaceList, invoker, onWorkspacePresenceChange]);

  useEffect(() => {
    if (!hasTauriCommandRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void defaultEventListener("workspace-entries-changed", (event) => {
      const payload = event.payload;
      if (payload.change !== "created") {
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

  const expandWorkspace = (workspaceId: string): void => {
    preferences.setWorkspaceExpanded(workspaceId, true);
    setExpandedWorkspaceIds((current) => {
      const next = new Set(current);
      next.add(workspaceId);
      expandedWorkspaceIdsRef.current = next;
      return next;
    });
    knownWorkspaceIdsRef.current = new Set([
      ...(knownWorkspaceIdsRef.current ?? []),
      workspaceId,
    ]);
    void loadEntries(workspaceId, "");
  };

  const mountWorkspace = async () => {
    if (!selectDirectory) {
      setError(
        "Choose a directory from the native file dialog to mount a workspace.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const rootPath = await selectDirectory();
      if (rootPath) {
        const workspace = await invoker.invoke("workspace_add", { rootPath });
        setWorkspaces((current) => [...current, workspace]);
        expandWorkspace(workspace.id);
        onWorkspacePresenceChange?.(true);
      }
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to mount this workspace.",
      );
    } finally {
      setBusy(false);
    }
  };

  const removeWorkspace = async (workspace: Workspace) => {
    setBusy(true);
    setError(null);
    try {
      await invoker.invoke("workspace_remove", { workspaceId: workspace.id });
      const next = workspaces.filter((item) => item.id !== workspace.id);
      setWorkspaces(next);
      setExpandedWorkspaceIds((current) => {
        const withoutRemoved = new Set(current);
        withoutRemoved.delete(workspace.id);
        expandedWorkspaceIdsRef.current = withoutRemoved;
        return withoutRemoved;
      });
      preferences.pruneWorkspaceIds(new Set(next.map((item) => item.id)));
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
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Unable to remove this workspace.",
      );
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
    returnFocusRef.current = trigger;
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
      await loadEntries(
        naming.workspaceId,
        naming.parentRelativePath,
        true,
      );
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
        setError("Save the open drawing before deleting it.");
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
      setError(operationError(nextError, "The file operation failed."));
    }
  };

  const confirmDelete = async () => {
    if (deleting === null) return;
    const { workspaceId, workspaceRoot, entry } = deleting;
    setDeleting((current) =>
      current === null ? current : { ...current, busy: true, error: null },
    );
    try {
      await documentManager.coordinateCleanEntryDelete(
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
    } catch (nextError) {
      setDeleting((current) =>
        current === null
          ? current
          : {
              ...current,
              busy: false,
              error: operationError(
                nextError,
                "The entry could not be deleted.",
              ),
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
              error: operationError(
                nextError,
                "Finder could not open this folder.",
              ),
            },
      );
    }
  };

  const menuItems = (row: WorkspaceTreeRow): ContextMenuItem[] => {
    if (row.kind === "workspace") {
      return [
        {
          id: "new-drawing",
          label: "New Drawing",
          onSelect: () => beginNaming("newDrawing", row.workspaceId, ""),
        },
        {
          id: "new-folder",
          label: "New Folder",
          onSelect: () => beginNaming("newDirectory", row.workspaceId, ""),
        },
        {
          id: "remove-workspace",
          label: "Remove Workspace",
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
          label: "New Drawing",
          onSelect: () =>
            beginNaming(
              "newDrawing",
              row.workspaceId,
              row.entry.relativePath,
            ),
        },
        {
          id: "new-folder",
          label: "New Folder",
          onSelect: () =>
            beginNaming(
              "newDirectory",
              row.workspaceId,
              row.entry.relativePath,
            ),
        },
        {
          id: "rename",
          label: "Rename",
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
          label: "Delete",
          onSelect: () => {
            void requestDelete(row.workspaceId, row.entry);
          },
        },
      ];
    }
    return [
      {
        id: "rename",
        label: "Rename",
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
        label: "Delete",
        onSelect: () => {
          void requestDelete(row.workspaceId, row.entry);
        },
      },
    ];
  };

  const treeEntries: WorkspaceTreeEntriesByWorkspace = entriesByWorkspace;

  return (
    <section className="workspace-panel" aria-label="Workspaces">
      <div className="workspace-panel-header">
        <h2>Workspaces</h2>
        <button
          ref={mountButtonRef}
          type="button"
          disabled={busy}
          onClick={() => void mountWorkspace()}
        >
          Mount folder…
        </button>
      </div>
      {error && pendingRemoval === null && deleting === null ? (
        <p role="alert">{error}</p>
      ) : null}
      {workspaces.length === 0 ? (
        <p className="sidebar-placeholder">No workspace mounted.</p>
      ) : (
        <WorkspaceTree
          workspaces={workspaces}
          entriesByWorkspace={treeEntries}
          expandedWorkspaceIds={expandedWorkspaceIds}
          expandedDirectoryKeys={expandedDirectoryKeys}
          activeDocumentPath={activeDocumentPath}
          captureFocus={captureFocus}
          onToggleWorkspace={(workspaceId, expanded) => {
            preferences.setWorkspaceExpanded(workspaceId, expanded);
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
            if (expanded) void loadEntries(entry.workspaceId, entry.relativePath);
            else if (
              treeMenu !== null &&
              menuOwnedByDirectory(treeMenu.row, entry)
            ) {
              dismissMenu("ownerCollapsed");
            }
          }}
          onOpenDrawing={(entry) => onOpenFile?.(asFileEntry(entry))}
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
              ? "Files on disk will not be deleted"
              : undefined
          }
          items={menuItems(treeMenu.row)}
          label={`Actions for ${treeMenu.row.displayName}`}
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
          errorMessage={deleting.error}
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
          errorMessage={deleting.error}
          returnFocusRef={returnFocusRef}
          onCancel={() => {
            if (!deleting.busy) setDeleting(null);
          }}
          onReveal={() => void revealDeleting()}
        />
      ) : null}
      {pendingRemoval ? (
        <ApplicationDialog
          busy={busy}
          errorMessage={error}
          onDismiss={() => {
            if (busy) return;
            setPendingRemoval(null);
            setError(null);
          }}
          returnFocusRef={returnFocusRef}
          title={`Remove ${pendingRemoval.name}?`}
        >
          <p>Files on disk will not be deleted.</p>
          <div className="application-dialog-actions conflict-dialog-actions">
            <button
              disabled={busy}
              onClick={() => {
                if (busy) return;
                setPendingRemoval(null);
                setError(null);
              }}
              type="button"
            >
              Cancel
            </button>
            <button
              disabled={busy}
              onClick={() => void removeWorkspace(pendingRemoval)}
              type="button"
            >
              Remove Workspace
            </button>
          </div>
        </ApplicationDialog>
      ) : null}
    </section>
  );
}

function storageIsFirstLaunch(storage: Pick<Storage, "getItem">): boolean {
  const cached = firstLaunchByStorage.get(storage);
  if (cached !== undefined) return cached;
  const first = storage.getItem(SHELL_PREFERENCES_STORAGE_KEY) === null;
  firstLaunchByStorage.set(storage, first);
  return first;
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

function operationError(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.length > 0) {
    return reason.message;
  }
  if (reason !== null && typeof reason === "object") {
    const ipc = reason as Partial<IpcError>;
    if (typeof ipc.message === "string" && ipc.message.length > 0) {
      return ipc.message;
    }
  }
  return fallback;
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
    title: "Mount workspace folder",
  });
  return typeof selected === "string" ? selected : null;
}
