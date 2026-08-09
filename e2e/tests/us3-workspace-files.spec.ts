import { expect, test, type Page } from "@playwright/test";

test("workspace file management closes the mount/create/rename/trash loop", async ({
  page,
}) => {
  await installWorkspaceHarness(page);
  await page.goto("/");
  const mount = page.getByRole("button", { name: /Mount folder/i });
  await expect(mount).toBeVisible();
  await mount.click();
  await expect(page.getByRole("tree")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Open drawing\.excalidraw/i }),
  ).toBeVisible();

  await page.getByRole("button", { name: /Open drawing\.excalidraw/i }).click();
  await expect(
    page.getByRole("tab", { name: "drawing.excalidraw" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Open second\.excalidraw/i }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByRole("tab", { name: "drawing.excalidraw" }).click();
  await expect(
    page.getByRole("tab", { name: "drawing.excalidraw" }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: /Open drawing\.excalidraw/i }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);

  await page
    .getByRole("button", { name: /Actions for drawing\.excalidraw/i })
    .first()
    .click();
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  page.once("dialog", (dialog) => void dialog.accept("renamed.excalidraw"));
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await expect(page.getByText("renamed.excalidraw")).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("button", { name: /Actions for renamed\.excalidraw/i })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "Move to Trash" }).click();
  await expect(page.getByText("renamed.excalidraw")).toHaveCount(0);
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
        if (command === "dir_list")
          return files.map((name) => ({
            name,
            relativePath: name,
            kind: "file",
            mtime: 1,
            fileSize: 100,
          }));
        if (command === "file_create") {
          const name =
            String(args.relativePath ?? "drawing.excalidraw")
              .split("/")
              .pop() ?? "drawing.excalidraw";
          files = [...files, name];
          return {
            canonicalPath: `/workspace/${name}`,
            workspaceId: "workspace-1",
            displayName: name,
            relativePath: name,
            mtime: 1,
            fileSize: 100,
          };
        }
        if (command === "file_rename") {
          const oldName = String(args.path ?? "")
            .split("/")
            .pop();
          const next = String(args.newName ?? "");
          files = files.map((name) => (name === oldName ? next : name));
          return {};
        }
        if (command === "file_delete") {
          const oldName = String(args.path ?? "")
            .split("/")
            .pop();
          files = files.filter((name) => name !== oldName);
          return {};
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
