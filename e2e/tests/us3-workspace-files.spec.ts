import { expect, test, type Page } from "@playwright/test";
import { openWorkspaceSidebar } from "./workspaceSidebar";

test("workspace file management closes the mount/create/rename/trash loop", async ({
  page,
}) => {
  await installWorkspaceHarness(page);
  await page.goto("/");
  await openWorkspaceSidebar(page);
  const mount = page.getByRole("button", { name: /Mount folder/i });
  await expect(mount).toBeVisible();
  await mount.click();
  await expect(page.getByRole("tree")).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "drawing" })).toBeVisible();

  await page.getByRole("treeitem", { name: "drawing" }).click();
  await expect(
    page.getByRole("tab", { name: "drawing.excalidraw" }),
  ).toBeVisible();
  await page.getByRole("treeitem", { name: "second" }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByRole("tab", { name: "drawing.excalidraw" }).click();
  await expect(
    page.getByRole("tab", { name: "drawing.excalidraw" }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("treeitem", { name: "drawing" }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);

  await page.getByRole("button", { name: "Actions for drawing" }).click();
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const input = page.getByRole("textbox", { name: "Name" });
  await expect(input).toHaveValue("drawing");
  await input.fill("renamed");
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("treeitem", { name: "renamed" })).toBeVisible();

  await page.getByRole("button", { name: "Actions for renamed" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Delete renamed.excalidraw?",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("treeitem", { name: "renamed" })).toHaveCount(0);
});

test("unmounting retains Recent history, remounts the same record, and forgets history only", async ({
  page,
}) => {
  await installWorkspaceHarness(page, true);
  await page.goto("/");
  await openWorkspaceSidebar(page);
  await page.getByRole("button", { name: "Open workspace Workspace" }).click();
  await page.getByRole("treeitem", { name: "drawing" }).click();
  await page.getByRole("treeitem", { name: "second" }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);

  await openWorkspaceSidebar(page);
  await page.getByRole("treeitem", { name: "Workspace" }).hover();
  await page.getByRole("button", { name: "Actions for Workspace" }).click();
  await page.getByRole("menuitem", { name: "Remove Workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "Remove Workspace?" });
  await expect(dialog).toContainText(
    "Open drawings from this Workspace will be saved and closed",
  );
  await dialog.getByRole("button", { name: "Remove Workspace" }).click();

  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByText("No workspace mounted.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open workspace Workspace" }),
  ).toBeVisible();
  await expect(
    page.getByText("Path is outside the mounted workspaces."),
  ).toHaveCount(0);

  await page.reload();
  const recent = page.getByRole("button", { name: "Open workspace Workspace" });
  await expect(recent).toBeVisible();
  await recent.click();
  await openWorkspaceSidebar(page);
  await expect(page.getByRole("heading", { name: "Workspace" })).toBeVisible();

  await page.getByRole("treeitem", { name: "Workspace" }).hover();
  await page.getByRole("button", { name: "Actions for Workspace" }).click();
  await page.getByRole("menuitem", { name: "Remove Workspace" }).click();
  await page
    .getByRole("dialog", { name: "Remove Workspace?" })
    .getByRole("button", { name: "Remove Workspace" })
    .click();
  await recent.hover();
  await page
    .getByRole("button", { name: "Remove Workspace from Recents" })
    .click();
  await expect(recent).toHaveCount(0);
});

test("an inaccessible Recent Workspace errors only on activation and remains removable", async ({
  page,
}) => {
  await installMissingRecentHarness(page);
  await page.goto("/");

  await expect(page.getByRole("alert")).toHaveCount(0);
  const recent = page.getByRole("button", {
    name: "Open workspace Missing Workspace",
  });
  await expect(recent).toBeVisible();
  const recentRow = recent.locator("..");
  const remove = page.getByRole("button", {
    name: "Remove Missing Workspace from Recents",
  });
  const recentPath = page.getByText("/missing/workspace");
  await expect(remove).toHaveCSS("opacity", "0");
  const beforeHover = await recentRow.boundingBox();
  const beforePath = await recentPath.boundingBox();
  await recent.hover();
  await expect(remove).toHaveCSS("opacity", "1");
  const afterHover = await recentRow.boundingBox();
  const afterPath = await recentPath.boundingBox();
  expect(afterHover).not.toBeNull();
  expect(beforeHover).not.toBeNull();
  expect(afterPath).not.toBeNull();
  expect(beforePath).not.toBeNull();
  expect(afterHover?.x).toBe(beforeHover?.x);
  expect(afterHover?.y).toBe(beforeHover?.y);
  expect(afterHover?.width).toBe(beforeHover?.width);
  expect(afterHover?.height).toBe(beforeHover?.height);
  expect(afterPath?.x).toBe(beforePath?.x);
  expect(afterPath?.y).toBe(beforePath?.y);
  expect(afterPath?.width).toBe(beforePath?.width);
  expect(afterPath?.height).toBe(beforePath?.height);
  await page.mouse.move(0, 0);
  await recent.focus();
  await expect(remove).toHaveCSS("opacity", "1");
  const afterFocus = await recentRow.boundingBox();
  const afterFocusPath = await recentPath.boundingBox();
  expect(afterFocus).toEqual(beforeHover);
  expect(afterFocusPath).toEqual(beforePath);
  await recent.click();
  await expect(page.getByRole("alert")).toContainText(
    "Workspace is no longer accessible.",
  );
  await expect(page.getByText("Folder unavailable")).toBeVisible();
  await expect(recent).toBeVisible();

  await page.mouse.move(0, 0);
  await page
    .getByRole("button", { name: "Open Workspace", exact: true })
    .focus();
  await expect(remove).toHaveCSS("opacity", "1");
  await expect(remove).toHaveAttribute("title", "Remove from Recents");
  await recent.focus();
  await page.keyboard.press("Tab");
  await expect(remove).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(recent).toHaveCount(0);
});

async function installWorkspaceHarness(
  page: Page,
  initiallyMounted = false,
): Promise<void> {
  await page.addInitScript((initiallyMounted) => {
    const browser = globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: {
        invoke(
          command: string,
          args?: Record<string, unknown>,
        ): Promise<unknown>;
      };
    };
    const mountedKey = "e2e-workspace-mounted";
    const retainedKey = "e2e-workspace-retained";
    if (localStorage.getItem(mountedKey) === null) {
      localStorage.setItem(mountedKey, String(initiallyMounted));
      localStorage.setItem(retainedKey, String(initiallyMounted));
    }
    let mounted = localStorage.getItem(mountedKey) === "true";
    let retained = localStorage.getItem(retainedKey) === "true";
    let files = ["drawing.excalidraw", "second.excalidraw"];
    browser.__TAURI_INTERNALS__ = {
      async invoke(command, args = {}) {
        if (command === "plugin:dialog|open") return "/workspace";
        if (command === "workspace_list")
          return mounted
            ? [
                {
                  id: "workspace-1",
                  name: "Workspace",
                  rootPath: "/workspace",
                  createdAt: 1,
                },
              ]
            : [];
        if (command === "workspace_recent_list")
          return retained
            ? [
                {
                  id: "workspace-1",
                  name: "Workspace",
                  rootPath: "/workspace",
                  createdAt: 1,
                },
              ]
            : [];
        if (command === "workspace_add") {
          mounted = true;
          retained = true;
          localStorage.setItem(mountedKey, "true");
          localStorage.setItem(retainedKey, "true");
          return {
            id: "workspace-1",
            name: "Workspace",
            rootPath: "/workspace",
            createdAt: 1,
          };
        }
        if (command === "workspace_remove") {
          mounted = false;
          localStorage.setItem(mountedKey, "false");
          return {};
        }
        if (command === "workspace_remount") {
          mounted = true;
          localStorage.setItem(mountedKey, "true");
          return {
            id: "workspace-1",
            name: "Workspace",
            rootPath: "/workspace",
            createdAt: 1,
          };
        }
        if (command === "workspace_recent_remove") {
          if (mounted) throw new Error("Workspace is still mounted.");
          retained = false;
          localStorage.setItem(retainedKey, "false");
          return {};
        }
        if (command === "workspace_entry_list") {
          const parentRelativePath = String(args.parentRelativePath ?? "");
          if (parentRelativePath !== "") {
            return [];
          }
          return files.map((name) => ({
            workspaceId: "workspace-1",
            kind: "drawing",
            canonicalPath: `/workspace/${name}`,
            relativePath: name,
            parentRelativePath: "",
            name,
            displayName: name.replace(/\.excalidraw(\.json)?$/i, ""),
            mtime: 1,
            fileSize: 100,
          }));
        }
        if (command === "workspace_entry_rename") {
          const oldName = String(args.relativePath ?? "")
            .split("/")
            .pop();
          const next = `${String(args.baseName ?? "renamed")}.excalidraw`;
          files = files.map((name) => (name === oldName ? next : name));
          return {
            operationId: "rename-1",
            entry: {
              workspaceId: "workspace-1",
              kind: "drawing",
              canonicalPath: `/workspace/${next}`,
              relativePath: next,
              parentRelativePath: "",
              name: next,
              displayName: String(args.baseName ?? "renamed"),
              mtime: 1,
              fileSize: 100,
            },
            oldRelativePath: oldName,
            newRelativePath: next,
            pathMigrations: [],
          };
        }
        if (command === "workspace_entry_delete_preflight") {
          const name = String(args.relativePath ?? "");
          return {
            status: "confirmable",
            entry: {
              workspaceId: "workspace-1",
              kind: "drawing",
              canonicalPath: `/workspace/${name}`,
              relativePath: name,
              parentRelativePath: "",
              name,
              displayName: name.replace(/\.excalidraw(\.json)?$/i, ""),
              mtime: 1,
              fileSize: 100,
            },
          };
        }
        if (command === "workspace_entry_delete") {
          const oldName = String(args.relativePath ?? "")
            .split("/")
            .pop();
          files = files.filter((name) => name !== oldName);
          return {
            operationId: "delete-1",
            kind: "drawing",
            oldRelativePath: oldName,
          };
        }
        if (command === "doc_open") {
          const name =
            String(args.path ?? "")
              .split("/")
              .pop() ?? "drawing.excalidraw";
          return {
            scene: {
              type: "excalidraw",
              version: 2,
              elements: [],
              appState: { name },
              files: {},
            },
            baseHash: `base-${name}`,
            hasNewerDraft: false,
          };
        }
        if (command === "doc_checkpoint")
          return { newBaseHash: "checkpointed", mtime: 2 };
        if (command === "doc_save_draft")
          return { contentHash: "draft", savedAt: 2 };
        if (command === "doc_close") {
          if (!mounted) {
            throw new Error("Path is outside the mounted workspaces.");
          }
          return {};
        }
        throw new Error(`Unexpected workspace command ${command}`);
      },
    };
  }, initiallyMounted);
}

async function installMissingRecentHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const browser = globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: {
        invoke(
          command: string,
          args?: Record<string, unknown>,
        ): Promise<unknown>;
      };
    };
    const workspace = {
      id: "workspace-missing",
      name: "Missing Workspace",
      rootPath: "/missing/workspace",
      createdAt: 1,
    };
    let retained = true;
    browser.__TAURI_INTERNALS__ = {
      async invoke(command) {
        if (command === "workspace_list") return [];
        if (command === "workspace_recent_list")
          return retained ? [workspace] : [];
        if (command === "workspace_remount") {
          throw new Error("Workspace is no longer accessible.");
        }
        if (command === "workspace_recent_remove") {
          retained = false;
          return {};
        }
        throw new Error(`Unexpected workspace command ${command}`);
      },
    };
  });
}
