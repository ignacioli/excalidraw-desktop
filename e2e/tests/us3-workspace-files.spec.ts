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

async function installWorkspaceHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const browser = globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: {
        invoke(
          command: string,
          args?: Record<string, unknown>,
        ): Promise<unknown>;
      };
    };
    let mounted = false;
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
        if (command === "workspace_add") {
          mounted = true;
          return {
            id: "workspace-1",
            name: "Workspace",
            rootPath: "/workspace",
            createdAt: 1,
          };
        }
        if (command === "workspace_remove") {
          mounted = false;
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
        throw new Error(`Unexpected workspace command ${command}`);
      },
    };
  });
}
