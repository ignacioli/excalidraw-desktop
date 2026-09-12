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
  | "welcome"
  | "restored"
  | "pinned"
  | "overlay"
  | "nested-tree"
  | "selected-directory"
  | "unsaved-tab"
  | "unicode-pinned";

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

const WELCOME_WORKSPACES: readonly ShellFixtureWorkspace[] = [
  {
    id: "fixture-recent-architecture",
    name: "Architecture",
    rootPath: "/fixtures/Documents/Architecture",
    createdAt: 1_700_000_032,
  },
  {
    id: "fixture-recent-product-flows",
    name: "Product flows",
    rootPath: "/fixtures/Work/Product/Flows",
    createdAt: 1_700_000_031,
  },
  {
    id: "fixture-recent-research",
    name: "Research",
    rootPath: "/fixtures/Documents/Research",
    createdAt: 1_700_000_030,
  },
];

/** Stable Unicode fallback probe used by browser-visible visual checks. */
export const UNICODE_WORKSPACE: ShellFixtureWorkspace = {
  id: "fixture-unicode-workspace",
  name: "设计 Workspace ✦",
  rootPath: "/fixtures/设计-workspace/图纸",
  createdAt: 1_700_000_010,
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

export const UNICODE_ENTRIES: readonly ShellFixtureEntry[] = [
  {
    workspaceId: UNICODE_WORKSPACE.id,
    kind: "directory",
    canonicalPath: `${UNICODE_WORKSPACE.rootPath}/流程`,
    relativePath: "流程",
    parentRelativePath: "",
    name: "流程",
    displayName: "流程",
    mtime: 1_700_000_011,
    fileSize: 0,
  },
  {
    workspaceId: UNICODE_WORKSPACE.id,
    kind: "drawing",
    canonicalPath: `${UNICODE_WORKSPACE.rootPath}/流程/会议 ✦.excalidraw`,
    relativePath: "流程/会议 ✦.excalidraw",
    parentRelativePath: "流程",
    name: "会议 ✦.excalidraw",
    displayName: "会议 ✦",
    mtime: 1_700_000_012,
    fileSize: 512,
  },
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

const VSL_WORKSPACE: ShellFixtureWorkspace = {
  id: "fixture-vsl-workspace",
  name: "Design Workspace",
  rootPath: "/fixtures/design-workspace",
  createdAt: 1_700_000_020,
};

const VSL_ENTRIES: readonly ShellFixtureEntry[] = [
  {
    workspaceId: VSL_WORKSPACE.id,
    kind: "directory",
    canonicalPath: `${VSL_WORKSPACE.rootPath}/flows`,
    relativePath: "flows",
    parentRelativePath: "",
    name: "flows",
    displayName: "Flows",
    mtime: 1_700_000_021,
    fileSize: 0,
  },
  ...["Architecture", "Migration", "Research"].map(
    (title, index): ShellFixtureEntry => ({
      workspaceId: VSL_WORKSPACE.id,
      kind: "drawing",
      canonicalPath: `${VSL_WORKSPACE.rootPath}/flows/${title}.excalidraw`,
      relativePath: `flows/${title}.excalidraw`,
      parentRelativePath: "flows",
      name: `${title}.excalidraw`,
      displayName: title,
      mtime: 1_700_000_022 + index,
      fileSize: 512,
    }),
  ),
];

const VSL_TABS: readonly ShellFixtureTab[] = VSL_ENTRIES.filter(
  (entry) => entry.kind === "drawing",
).map((entry, index) => ({
  documentId: `fixture-vsl-document-${index + 1}`,
  title: entry.displayName,
  workspaceId: VSL_WORKSPACE.id,
  path: entry.canonicalPath,
  saveState: "clean",
  availability: "available",
  conflictState: "none",
}));

const UNSAVED_TAB: ShellFixtureTab = {
  documentId: "fixture-document-unsaved",
  title: "Untitled",
  workspaceId: null,
  path: null,
  saveState: "dirty",
  availability: "available",
  conflictState: "none",
};

const UNICODE_TAB: ShellFixtureTab = {
  documentId: "fixture-document-unicode",
  title: "会议 ✦",
  workspaceId: UNICODE_WORKSPACE.id,
  path: UNICODE_ENTRIES[1].canonicalPath,
  saveState: "clean",
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

export const WELCOME_SHELL_FIXTURE: ShellFixture = {
  ...EMPTY_SHELL_FIXTURE,
  id: "welcome",
  workspaces: WELCOME_WORKSPACES,
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
  id: "pinned",
  shell: "restored",
  sidebar: "pinned",
  currentWorkspaceId: VSL_WORKSPACE.id,
  workspaces: [VSL_WORKSPACE],
  entries: VSL_ENTRIES,
  expandedDirectoryPaths: ["flows"],
  selectedDirectoryRelativePath: "flows",
  activeDocumentId: VSL_TABS[0]?.documentId ?? null,
  tabs: VSL_TABS,
};

export const OVERLAY_SHELL_FIXTURE: ShellFixture = {
  ...RESTORED_SHELL_FIXTURE,
  id: "overlay",
  sidebar: "overlay",
};

export const NESTED_TREE_SHELL_FIXTURE: ShellFixture = {
  ...RESTORED_SHELL_FIXTURE,
  id: "nested-tree",
  sidebar: "pinned",
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

export const UNICODE_PINNED_SHELL_FIXTURE: ShellFixture = {
  ...RESTORED_SHELL_FIXTURE,
  id: "unicode-pinned",
  sidebar: "pinned",
  currentWorkspaceId: UNICODE_WORKSPACE.id,
  workspaces: [UNICODE_WORKSPACE],
  entries: UNICODE_ENTRIES,
  expandedDirectoryPaths: ["流程"],
  selectedDirectoryRelativePath: "流程",
  activeDocumentId: UNICODE_TAB.documentId,
  tabs: [UNICODE_TAB],
};

export const SHELL_FIXTURES: readonly ShellFixture[] = [
  EMPTY_SHELL_FIXTURE,
  WELCOME_SHELL_FIXTURE,
  RESTORED_SHELL_FIXTURE,
  PINNED_SHELL_FIXTURE,
  OVERLAY_SHELL_FIXTURE,
  NESTED_TREE_SHELL_FIXTURE,
  SELECTED_DIRECTORY_SHELL_FIXTURE,
  UNSAVED_TAB_SHELL_FIXTURE,
  UNICODE_PINNED_SHELL_FIXTURE,
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
