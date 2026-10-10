import { expect, type Page } from "@playwright/test";

const SHELL_PREFERENCES_STORAGE_KEY = "excalidraw-desktop.shell";

/**
 * The Workspace Sidebar starts hidden (canvas-first overlay). Open it before
 * looking for tree rows, Mount folder, or New drawing.
 */
export async function openWorkspaceSidebar(
  page: Page,
  names = { files: "Files", toggle: "Toggle workspace sidebar" },
): Promise<void> {
  const sidebar = page.getByRole("complementary", { name: names.files });
  const toggle = page.getByRole("button", { name: names.toggle, exact: true });
  // Wait for the shell first: a pinned sidebar renders with it, and toggling
  // before then would close it.
  await expect(toggle).toBeVisible();
  if (await sidebar.isVisible()) {
    return;
  }
  await toggle.click();
  await expect(sidebar).toBeVisible();
}

/** Persist pinned layout so the tree has a real height across reloads. Call before `goto`. */
export async function persistPinnedWorkspaceSidebar(
  page: Page,
  expandedWorkspaceIds: readonly string[] = [],
  currentWorkspaceId: string | null = null,
): Promise<void> {
  await persistShellPreferences(page, {
    sidebarPinned: true,
    expandedWorkspaceIds,
    currentWorkspaceId,
  });
}

/**
 * Select the Current Workspace while keeping the default hidden Sidebar. Without
 * a Current Workspace the shell starts on Welcome with an empty tree. Call
 * before `goto`.
 */
export async function persistCurrentWorkspace(
  page: Page,
  currentWorkspaceId: string,
  expandedWorkspaceIds: readonly string[] = [currentWorkspaceId],
): Promise<void> {
  await persistShellPreferences(page, {
    sidebarPinned: false,
    expandedWorkspaceIds,
    currentWorkspaceId,
  });
}

async function persistShellPreferences(
  page: Page,
  preferences: {
    sidebarPinned: boolean;
    expandedWorkspaceIds: readonly string[];
    currentWorkspaceId: string | null;
  },
): Promise<void> {
  await page.addInitScript(
    ({ key, snapshot }) => {
      localStorage.setItem(key, snapshot);
    },
    {
      key: SHELL_PREFERENCES_STORAGE_KEY,
      snapshot: JSON.stringify({
        version: 1,
        sidebarPinned: preferences.sidebarPinned,
        sidebarWidth: 360,
        expandedWorkspaceIds: [...preferences.expandedWorkspaceIds],
        currentWorkspaceId: preferences.currentWorkspaceId,
      }),
    },
  );
}
