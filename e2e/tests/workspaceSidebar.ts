import { expect, type Page } from "@playwright/test";

const SHELL_PREFERENCES_STORAGE_KEY = "excalidraw-desktop.shell";

/**
 * The Workspace Sidebar starts hidden (canvas-first overlay). Open it before
 * looking for tree rows, Mount folder, or New drawing.
 */
export async function openWorkspaceSidebar(page: Page): Promise<void> {
  const sidebar = page.getByRole("complementary", { name: "Files" });
  if (await sidebar.isVisible()) {
    return;
  }
  await page
    .getByRole("button", { name: "Workspace sidebar", exact: true })
    .click();
  await expect(sidebar).toBeVisible();
}

/** Persist pinned layout so the tree has a real height across reloads. Call before `goto`. */
export async function persistPinnedWorkspaceSidebar(
  page: Page,
  expandedWorkspaceIds: readonly string[] = [],
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
        expandedWorkspaceIds: [...expandedWorkspaceIds],
      }),
    },
  );
}

