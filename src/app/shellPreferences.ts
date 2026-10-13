export const SHELL_PREFERENCES_VERSION = 1 as const;
export const SHELL_PREFERENCES_STORAGE_KEY = "excalidraw-desktop.shell";
export const SIDEBAR_WIDTH_DEFAULT = 360;
export const SIDEBAR_WIDTH_MIN = 280;
export const SIDEBAR_WIDTH_MAX = 480;

export interface ShellPreferenceSnapshot {
  version: typeof SHELL_PREFERENCES_VERSION;
  sidebarPinned: boolean;
  sidebarWidth: number;
  expandedWorkspaceIds: string[];
  currentWorkspaceId: string | null;
}

type ShellPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const defaultSnapshot = (): ShellPreferenceSnapshot => ({
  version: SHELL_PREFERENCES_VERSION,
  sidebarPinned: false,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  expandedWorkspaceIds: [],
  currentWorkspaceId: null,
});

export class ShellPreferences {
  private snapshot: ShellPreferenceSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: ShellPreferenceStorage = createDefaultShellStorage(),
  ) {
    const stored = storage.getItem(SHELL_PREFERENCES_STORAGE_KEY);
    this.snapshot = readSnapshot(stored);
    // Writing defaults on first construct poisons first-launch expansion:
    // AppShell mounts before WorkspacePanel, so an empty persist would look
    // like "the user collapsed every Workspace".
    if (stored !== null) {
      this.persist();
    }
  }

  getSnapshot(): ShellPreferenceSnapshot {
    return {
      ...this.snapshot,
      expandedWorkspaceIds: [...this.snapshot.expandedWorkspaceIds],
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSidebarPinned(sidebarPinned: boolean): void {
    if (this.snapshot.sidebarPinned === sidebarPinned) return;
    this.snapshot = { ...this.snapshot, sidebarPinned };
    this.persist();
    this.notify();
  }

  setSidebarWidth(sidebarWidth: number): void {
    const nextWidth = clampSidebarWidth(sidebarWidth);
    if (this.snapshot.sidebarWidth === nextWidth) return;
    this.snapshot = { ...this.snapshot, sidebarWidth: nextWidth };
    this.persist();
    this.notify();
  }

  setCurrentWorkspaceId(currentWorkspaceId: string | null): void {
    if (this.snapshot.currentWorkspaceId === currentWorkspaceId) return;
    this.snapshot = { ...this.snapshot, currentWorkspaceId };
    this.persist();
    this.notify();
  }

  resolveCurrentWorkspaceId(
    validWorkspaceIds: ReadonlySet<string>,
    fallbackWorkspaceId: string | null = null,
  ): string | null {
    const currentWorkspaceId = this.snapshot.currentWorkspaceId;
    if (
      currentWorkspaceId !== null &&
      validWorkspaceIds.has(currentWorkspaceId)
    ) {
      return currentWorkspaceId;
    }
    return fallbackWorkspaceId !== null &&
      validWorkspaceIds.has(fallbackWorkspaceId)
      ? fallbackWorkspaceId
      : null;
  }

  setWorkspaceExpanded(workspaceId: string, expanded: boolean): void {
    if (workspaceId.length === 0) return;
    const ids = new Set(this.snapshot.expandedWorkspaceIds);
    if (expanded) ids.add(workspaceId);
    else ids.delete(workspaceId);
    this.snapshot = { ...this.snapshot, expandedWorkspaceIds: [...ids] };
    this.persist();
    this.notify();
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
    this.notify();
  }

  private persist(): void {
    this.storage.setItem(
      SHELL_PREFERENCES_STORAGE_KEY,
      JSON.stringify(this.snapshot),
    );
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
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
      (value.sidebarWidth !== undefined &&
        (typeof value.sidebarWidth !== "number" ||
          !Number.isFinite(value.sidebarWidth))) ||
      !Array.isArray(value.expandedWorkspaceIds) ||
      (value.currentWorkspaceId !== undefined &&
        value.currentWorkspaceId !== null &&
        (typeof value.currentWorkspaceId !== "string" ||
          value.currentWorkspaceId.length === 0)) ||
      value.expandedWorkspaceIds.some(
        (id) => typeof id !== "string" || id.length === 0,
      )
    ) {
      return defaultSnapshot();
    }
    return {
      version: SHELL_PREFERENCES_VERSION,
      sidebarPinned: value.sidebarPinned,
      sidebarWidth:
        value.sidebarWidth === undefined
          ? SIDEBAR_WIDTH_DEFAULT
          : clampSidebarWidth(value.sidebarWidth),
      expandedWorkspaceIds: [...new Set(value.expandedWorkspaceIds)],
      currentWorkspaceId:
        value.currentWorkspaceId === undefined
          ? null
          : value.currentWorkspaceId,
    };
  } catch {
    return defaultSnapshot();
  }
}

export function clampSidebarWidth(sidebarWidth: number): number {
  return Math.min(
    SIDEBAR_WIDTH_MAX,
    Math.max(SIDEBAR_WIDTH_MIN, Math.round(sidebarWidth)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createDefaultShellStorage(): ShellPreferenceStorage {
  const localStorage = globalThis.localStorage;
  if (
    localStorage !== undefined &&
    typeof localStorage.getItem === "function"
  ) {
    return localStorage;
  }
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
