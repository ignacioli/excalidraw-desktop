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
  await page.addInitScript(
    ({ key, snapshot }) => {
      localStorage.setItem(key, snapshot);
    },
    {
      key: SHELL_PREFERENCES_STORAGE_KEY,
      snapshot: JSON.stringify({
        version: 1,
        sidebarPinned: true,
        sidebarWidth: 360,
        expandedWorkspaceIds: [...expandedWorkspaceIds],
        currentWorkspaceId,
      }),
    },
  );
}
