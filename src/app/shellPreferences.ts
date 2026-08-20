export const SHELL_PREFERENCES_VERSION = 1 as const;
export const SHELL_PREFERENCES_STORAGE_KEY = "excalidraw-desktop.shell";

export interface ShellPreferenceSnapshot {
  version: typeof SHELL_PREFERENCES_VERSION;
  sidebarPinned: boolean;
  expandedWorkspaceIds: string[];
}

type ShellPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const defaultSnapshot = (): ShellPreferenceSnapshot => ({
  version: SHELL_PREFERENCES_VERSION,
  sidebarPinned: false,
  expandedWorkspaceIds: [],
});

export class ShellPreferences {
  private snapshot: ShellPreferenceSnapshot;

  constructor(
    private readonly storage: ShellPreferenceStorage = globalThis.localStorage,
  ) {
    this.snapshot = readSnapshot(
      storage.getItem(SHELL_PREFERENCES_STORAGE_KEY),
    );
    this.persist();
  }

  getSnapshot(): ShellPreferenceSnapshot {
    return {
      ...this.snapshot,
      expandedWorkspaceIds: [...this.snapshot.expandedWorkspaceIds],
    };
  }

  setSidebarPinned(sidebarPinned: boolean): void {
    if (this.snapshot.sidebarPinned === sidebarPinned) return;
    this.snapshot = { ...this.snapshot, sidebarPinned };
    this.persist();
  }

  setWorkspaceExpanded(workspaceId: string, expanded: boolean): void {
    if (workspaceId.length === 0) return;
    const ids = new Set(this.snapshot.expandedWorkspaceIds);
    if (expanded) ids.add(workspaceId);
    else ids.delete(workspaceId);
    this.snapshot = { ...this.snapshot, expandedWorkspaceIds: [...ids] };
    this.persist();
  }

  pruneWorkspaceIds(validWorkspaceIds: ReadonlySet<string>): void {
    const expandedWorkspaceIds = this.snapshot.expandedWorkspaceIds.filter(
      (id) => validWorkspaceIds.has(id),
    );
    if (
      expandedWorkspaceIds.length === this.snapshot.expandedWorkspaceIds.length
    )
      return;
    this.snapshot = { ...this.snapshot, expandedWorkspaceIds };
    this.persist();
  }

  private persist(): void {
    this.storage.setItem(
      SHELL_PREFERENCES_STORAGE_KEY,
      JSON.stringify(this.snapshot),
    );
  }
}

function readSnapshot(stored: string | null): ShellPreferenceSnapshot {
  if (stored === null) return defaultSnapshot();
  try {
    const value: unknown = JSON.parse(stored);
    if (!isRecord(value)) return defaultSnapshot();
    if (
      value.version !== SHELL_PREFERENCES_VERSION ||
      typeof value.sidebarPinned !== "boolean" ||
      !Array.isArray(value.expandedWorkspaceIds) ||
      value.expandedWorkspaceIds.some(
        (id) => typeof id !== "string" || id.length === 0,
      )
    ) {
      return defaultSnapshot();
    }
    return {
      version: SHELL_PREFERENCES_VERSION,
      sidebarPinned: value.sidebarPinned,
      expandedWorkspaceIds: [...new Set(value.expandedWorkspaceIds)],
    };
  } catch {
    return defaultSnapshot();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
