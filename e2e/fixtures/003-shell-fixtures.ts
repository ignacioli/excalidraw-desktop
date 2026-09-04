/**
 * Deterministic, browser-safe state for the corrective 003 shell checks.
 *
 * The fixtures describe shell state only. They do not create files, touch the
 * filesystem, or stand in for Rust authorization and persistence behavior.
 */

export type ShellMode = "empty" | "restored";
export type SidebarMode = "hidden" | "overlay" | "pinned";
export type FixtureId =
  | "empty"
  | "restored"
  | "pinned"
  | "overlay"
  | "nested-tree"
  | "selected-directory"
  | "unsaved-tab";

export interface ShellFixtureWorkspace {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly createdAt: number;
}

export interface ShellFixtureEntry {
  readonly workspaceId: string;
  readonly kind: "drawing" | "directory";
  readonly canonicalPath: string;
  readonly relativePath: string;
  readonly parentRelativePath: string;
  readonly name: string;
  readonly displayName: string;
  readonly mtime: number;
  readonly fileSize: number;
}

export interface ShellFixtureTab {
  readonly documentId: string;
  readonly title: string;
  readonly workspaceId: string | null;
  readonly path: string | null;
  readonly saveState: "clean" | "dirty";
  readonly availability: "available" | "orphaned";
  readonly conflictState: "none" | "pending";
}

export interface ShellFixture {
  readonly id: FixtureId;
  readonly shell: ShellMode;
  readonly sidebar: SidebarMode;
  readonly currentWorkspaceId: string | null;
  readonly workspaces: readonly ShellFixtureWorkspace[];
  readonly entries: readonly ShellFixtureEntry[];
  readonly expandedDirectoryPaths: readonly string[];
  readonly selectedDirectoryRelativePath: string | null;
  readonly activeDocumentId: string | null;
  readonly tabs: readonly ShellFixtureTab[];
}

const WORKSPACE: ShellFixtureWorkspace = {
  id: "fixture-workspace",
  name: "Design Workspace",
  rootPath: "/fixtures/design-workspace",
  createdAt: 1_700_000_000,
};

const ROOT_DRAWING: ShellFixtureEntry = {
  workspaceId: WORKSPACE.id,
  kind: "drawing",
  canonicalPath: `${WORKSPACE.rootPath}/overview.excalidraw`,
  relativePath: "overview.excalidraw",
  parentRelativePath: "",
  name: "overview.excalidraw",
  displayName: "overview",
  mtime: 1_700_000_100,
  fileSize: 256,
};

const NESTED_ENTRIES: readonly ShellFixtureEntry[] = [
  {
    workspaceId: WORKSPACE.id,
    kind: "directory",
    canonicalPath: `${WORKSPACE.rootPath}/planning`,
    relativePath: "planning",
    parentRelativePath: "",
    name: "planning",
    displayName: "planning",
    mtime: 1_700_000_101,
    fileSize: 0,
  },
  {
    workspaceId: WORKSPACE.id,
    kind: "directory",
    canonicalPath: `${WORKSPACE.rootPath}/planning/weekly`,
    relativePath: "planning/weekly",
    parentRelativePath: "planning",
    name: "weekly",
    displayName: "weekly",
    mtime: 1_700_000_102,
    fileSize: 0,
  },
  {
    workspaceId: WORKSPACE.id,
    kind: "drawing",
    canonicalPath: `${WORKSPACE.rootPath}/planning/weekly/notes.excalidraw`,
    relativePath: "planning/weekly/notes.excalidraw",
    parentRelativePath: "planning/weekly",
    name: "notes.excalidraw",
    displayName: "notes",
    mtime: 1_700_000_103,
    fileSize: 512,
  },
  ROOT_DRAWING,
];

const CLEAN_TAB: ShellFixtureTab = {
  documentId: "fixture-document-clean",
  title: "overview",
  workspaceId: WORKSPACE.id,
  path: ROOT_DRAWING.canonicalPath,
  saveState: "clean",
  availability: "available",
  conflictState: "none",
};

const UNSAVED_TAB: ShellFixtureTab = {
  documentId: "fixture-document-unsaved",
  title: "Untitled",
  workspaceId: null,
  path: null,
  saveState: "dirty",
  availability: "available",
  conflictState: "none",
};

export const EMPTY_SHELL_FIXTURE: ShellFixture = {
  id: "empty",
  shell: "empty",
  sidebar: "hidden",
  currentWorkspaceId: null,
  workspaces: [],
  entries: [],
  expandedDirectoryPaths: [],
  selectedDirectoryRelativePath: null,
  activeDocumentId: null,
  tabs: [],
};

export const RESTORED_SHELL_FIXTURE: ShellFixture = {
  id: "restored",
  shell: "restored",
  sidebar: "hidden",
  currentWorkspaceId: WORKSPACE.id,
  workspaces: [WORKSPACE],
  entries: [ROOT_DRAWING],
  expandedDirectoryPaths: [],
  selectedDirectoryRelativePath: null,
  activeDocumentId: CLEAN_TAB.documentId,
  tabs: [CLEAN_TAB],
};

export const PINNED_SHELL_FIXTURE: ShellFixture = {
  ...RESTORED_SHELL_FIXTURE,
  id: "pinned",
  sidebar: "pinned",
};

export const OVERLAY_SHELL_FIXTURE: ShellFixture = {
  ...RESTORED_SHELL_FIXTURE,
  id: "overlay",
  sidebar: "overlay",
};

export const NESTED_TREE_SHELL_FIXTURE: ShellFixture = {
  ...PINNED_SHELL_FIXTURE,
  id: "nested-tree",
  entries: NESTED_ENTRIES,
  expandedDirectoryPaths: ["planning", "planning/weekly"],
};

export const SELECTED_DIRECTORY_SHELL_FIXTURE: ShellFixture = {
  ...NESTED_TREE_SHELL_FIXTURE,
  id: "selected-directory",
  selectedDirectoryRelativePath: "planning/weekly",
};

export const UNSAVED_TAB_SHELL_FIXTURE: ShellFixture = {
  id: "unsaved-tab",
  shell: "restored",
  sidebar: "hidden",
  currentWorkspaceId: null,
  workspaces: [],
  entries: [],
  expandedDirectoryPaths: [],
  selectedDirectoryRelativePath: null,
  activeDocumentId: UNSAVED_TAB.documentId,
  tabs: [UNSAVED_TAB],
};

export const SHELL_FIXTURES: readonly ShellFixture[] = [
  EMPTY_SHELL_FIXTURE,
  RESTORED_SHELL_FIXTURE,
  PINNED_SHELL_FIXTURE,
  OVERLAY_SHELL_FIXTURE,
  NESTED_TREE_SHELL_FIXTURE,
  SELECTED_DIRECTORY_SHELL_FIXTURE,
  UNSAVED_TAB_SHELL_FIXTURE,
];

export function getShellFixture(id: FixtureId): ShellFixture {
  const fixture = SHELL_FIXTURES.find((candidate) => candidate.id === id);
  if (fixture === undefined) {
    throw new Error(`Unknown 003 shell fixture: ${id}`);
  }
  return cloneShellFixture(fixture);
}

export function cloneShellFixture(fixture: ShellFixture): ShellFixture {
  return structuredClone(fixture);
}

export function entriesForParent(
  fixture: ShellFixture,
  parentRelativePath = "",
): ShellFixtureEntry[] {
  return fixture.entries
    .filter((entry) => entry.parentRelativePath === parentRelativePath)
    .map((entry) => ({ ...entry }));
}
