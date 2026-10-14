import type { CommandInvoker } from "../ipc/client";
import type { WorkspaceShellState } from "../ipc/contracts";

/** Pre-multi-window localStorage key, read once for migration only. */
export const SHELL_PREFERENCES_STORAGE_KEY = "excalidraw-desktop.shell";
export const SHELL_PREFERENCES_VERSION = 1 as const;
export const SIDEBAR_WIDTH_DEFAULT = 360;
export const SIDEBAR_WIDTH_MIN = 280;
export const SIDEBAR_WIDTH_MAX = 480;
/** The relative path of the Workspace row itself in `expanded`. */
export const WORKSPACE_ROOT_PATH = "";

export interface ShellPreferenceSnapshot {
  sidebarPinned: boolean;
  sidebarWidth: number;
  /** Expanded folders of the window's Workspace, by relative path. */
  expanded: string[];
}

/** Stores the window Workspace's sidebar state. */
export type ShellStateSave = (state: WorkspaceShellState) => void;

const defaultSnapshot = (): ShellPreferenceSnapshot => ({
  sidebarPinned: false,
  sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  expanded: [WORKSPACE_ROOT_PATH],
});

/**
 * The sidebar state of this window's Workspace. Each Workspace keeps its own
 * pin, width, and expanded folders; a Welcome window keeps whatever it shows
 * and stores nothing.
 */
export class ShellPreferences {
  private snapshot = defaultSnapshot();
  private hasWorkspaceState = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly save: ShellStateSave = () => undefined) {}

  getSnapshot(): ShellPreferenceSnapshot {
    return { ...this.snapshot, expanded: [...this.snapshot.expanded] };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Show the state of the Workspace this window just opened; `null` is a
   * Workspace with nothing saved yet. Loading stores nothing.
   */
  loadWorkspace(shell: WorkspaceShellState | null): void {
    this.hasWorkspaceState = true;
    this.apply(shell);
  }

  /** Show `shell` in a window without a Workspace; nothing is stored. */
  showWithoutWorkspace(shell: WorkspaceShellState): void {
    this.hasWorkspaceState = false;
    this.apply(shell);
  }

  /** Whether the state shown is a Workspace's own and is stored. */
  hasWorkspace(): boolean {
    return this.hasWorkspaceState;
  }

  /** The window no longer has a Workspace; later changes are not stored. */
  closeWorkspace(): void {
    this.hasWorkspaceState = false;
  }

  setSidebarPinned(sidebarPinned: boolean): void {
    if (this.snapshot.sidebarPinned === sidebarPinned) return;
    this.update({ ...this.snapshot, sidebarPinned });
  }

  setSidebarWidth(sidebarWidth: number): void {
    const nextWidth = clampSidebarWidth(sidebarWidth);
    if (this.snapshot.sidebarWidth === nextWidth) return;
    this.update({ ...this.snapshot, sidebarWidth: nextWidth });
  }

  isWorkspaceExpanded(): boolean {
    return this.snapshot.expanded.includes(WORKSPACE_ROOT_PATH);
  }

  setWorkspaceExpanded(expanded: boolean): void {
    if (this.isWorkspaceExpanded() === expanded) return;
    const others = this.snapshot.expanded.filter(
      (path) => path !== WORKSPACE_ROOT_PATH,
    );
    this.update({
      ...this.snapshot,
      expanded: expanded ? [WORKSPACE_ROOT_PATH, ...others] : others,
    });
  }

  private apply(shell: WorkspaceShellState | null): void {
    this.snapshot =
      shell === null
        ? defaultSnapshot()
        : {
            sidebarPinned: shell.sidebarPinned,
            sidebarWidth: clampSidebarWidth(shell.sidebarWidth),
            expanded: [...new Set(shell.expanded)],
          };
    this.notify();
  }

  private update(snapshot: ShellPreferenceSnapshot): void {
    this.snapshot = snapshot;
    if (this.hasWorkspaceState) {
      this.save({
        sidebarPinned: snapshot.sidebarPinned,
        sidebarWidth: snapshot.sidebarWidth,
        expanded: [...snapshot.expanded],
      });
    }
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Shell preferences stored by versions before per-Workspace state. */
export interface LegacyShellPreferences {
  sidebarPinned: boolean;
  sidebarWidth: number;
  expandedWorkspaceIds: string[];
  currentWorkspaceId: string | null;
}

/**
 * Read the pre-multi-window shell preferences, or `null` when there are
 * none or they are malformed. The key is never written again.
 */
export function readLegacyShellPreferences(
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): LegacyShellPreferences | null {
  let stored: string | null;
  try {
    stored = storage?.getItem(SHELL_PREFERENCES_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  if (stored === null) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (!isRecord(value)) return null;
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
      return null;
    }
    return {
      sidebarPinned: value.sidebarPinned,
      sidebarWidth:
        value.sidebarWidth === undefined
          ? SIDEBAR_WIDTH_DEFAULT
          : clampSidebarWidth(value.sidebarWidth),
      expandedWorkspaceIds: [
        ...new Set(value.expandedWorkspaceIds as string[]),
      ],
      currentWorkspaceId:
        value.currentWorkspaceId === undefined
          ? null
          : value.currentWorkspaceId,
    };
  } catch {
    return null;
  }
}

/**
 * The shell preferences from before per-Workspace state while they are still
 * in effect: they are imported once, and until the import is recorded (or
 * when it cannot be) they keep applying. `null` once imported or when there
 * are none.
 */
export async function importLegacyShellPreferences(
  invoker: CommandInvoker,
  storage?: Pick<Storage, "getItem">,
): Promise<LegacyShellPreferences | null> {
  const legacy = readLegacyShellPreferences(storage);
  if (legacy === null) return null;
  const inEffect = await invoker
    .invoke("shell_preferences_migrate", {
      sidebarPinned: legacy.sidebarPinned,
      sidebarWidth: legacy.sidebarWidth,
    })
    .then(
      ({ migrated }) => migrated,
      () => true,
    );
  return inEffect ? legacy : null;
}

/** The legacy preferences as one Workspace's shell state. */
export function legacyShellStateFor(
  legacy: LegacyShellPreferences,
  workspaceId: string | null,
): WorkspaceShellState {
  return {
    sidebarPinned: legacy.sidebarPinned,
    sidebarWidth: legacy.sidebarWidth,
    expanded:
      workspaceId !== null && legacy.expandedWorkspaceIds.includes(workspaceId)
        ? [WORKSPACE_ROOT_PATH]
        : [],
  };
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
