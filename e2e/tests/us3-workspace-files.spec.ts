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

test("keeps Welcome geometry within the narrow-window gutter and preserves wide composition", async ({
  page,
}) => {
  await installMissingRecentHarness(page);

  await page.setViewportSize({ width: 800, height: 600 });
  await page.goto("/");
  await assertWelcomeViewportGeometry(page, {
    viewportWidth: 800,
    expectedScreenLeft: 16,
    expectedScreenWidth: 768,
  });

  await page.setViewportSize({ width: 1280, height: 760 });
  await page.reload();
  await assertWelcomeViewportGeometry(page, {
    viewportWidth: 1280,
    expectedScreenLeft: 160,
    expectedScreenWidth: 960,
  });
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
  await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>(".recent-workspace-row");
    if (row === null) throw new Error("Recent Workspace row not found");
    const state = {
      done: false,
      samples: [] as Array<{
        frame: number;
        rowY: number;
        pathY: number;
        sectionY: number;
        listScrollTop: number;
      }>,
    };
    const section = row.closest<HTMLElement>(".recent-workspaces");
    const list = row.closest<HTMLElement>(".recent-workspace-list");
    const path = row.querySelector<HTMLElement>(".recent-workspace-path");
    state.samples.push({
      frame: -1,
      rowY: row.getBoundingClientRect().y,
      pathY: path?.getBoundingClientRect().y ?? Number.NaN,
      sectionY: section?.getBoundingClientRect().y ?? Number.NaN,
      listScrollTop: list?.scrollTop ?? Number.NaN,
    });
    const browser = globalThis as typeof globalThis & {
      __recentGeometryCapture?: typeof state;
    };
    browser.__recentGeometryCapture = state;
    row.addEventListener(
      "pointerup",
      () => {
        let frame = 0;
        const sample = () => {
          const currentPath = row.querySelector<HTMLElement>(
            ".recent-workspace-path",
          );
          state.samples.push({
            frame,
            rowY: row.getBoundingClientRect().y,
            pathY: currentPath?.getBoundingClientRect().y ?? Number.NaN,
            sectionY: section?.getBoundingClientRect().y ?? Number.NaN,
            listScrollTop: list?.scrollTop ?? Number.NaN,
          });
          frame += 1;
          if (frame >= 30) {
            state.done = true;
            return;
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      },
      { once: true },
    );
  });
  await recent.click();
  await expect(page.getByRole("alert")).toContainText(
    "Workspace is no longer accessible.",
  );
  await expect(page.getByText("Folder unavailable")).toBeVisible();
  await expect(recent).toBeVisible();
  await page.waitForFunction(
    () =>
      (
        globalThis as typeof globalThis & {
          __recentGeometryCapture?: { done: boolean };
        }
      ).__recentGeometryCapture?.done === true,
  );
  const geometrySamples = await page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __recentGeometryCapture?: {
            samples: Array<{
              frame: number;
              rowY: number;
              pathY: number;
              sectionY: number;
              listScrollTop: number;
            }>;
          };
        }
      ).__recentGeometryCapture?.samples ?? [],
  );
  expect(geometrySamples.length).toBeGreaterThan(0);
  const firstSample = geometrySamples[0];
  expect(firstSample).toBeDefined();
  const maximumRowYDelta = Math.max(
    ...geometrySamples.map((sample) =>
      Math.abs(sample.rowY - firstSample.rowY),
    ),
  );
  const maximumPathYDelta = Math.max(
    ...geometrySamples.map((sample) =>
      Math.abs(sample.pathY - firstSample.pathY),
    ),
  );
  expect(maximumRowYDelta, JSON.stringify(geometrySamples)).toBeLessThanOrEqual(
    2,
  );
  expect(
    maximumPathYDelta,
    JSON.stringify(geometrySamples),
  ).toBeLessThanOrEqual(2);

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

test("keeps Welcome actions visually stable while an inaccessible remount is pending", async ({
  page,
}) => {
  await installMissingRecentHarness(page, { deferRemount: true });
  await page.goto("/");

  const recent = page.getByRole("button", {
    name: "Open workspace Missing Workspace",
  });
  const welcomeActions = page.locator(".welcome-actions");
  const newDrawing = page.getByRole("button", { name: "New Drawing" });
  const openWorkspace = page.getByRole("button", {
    name: "Open Workspace",
    exact: true,
  });
  const before = await readWelcomeActionStyle(page);
  const recentBefore = await readRecentButtonStyle(recent);

  await recent.click();
  await page.waitForFunction(
    () =>
      (
        globalThis as typeof globalThis & {
          __recentRemountStarted?: boolean;
        }
      ).__recentRemountStarted === true,
  );
  await expect(welcomeActions).toHaveAttribute("aria-busy", "true");
  await expect(newDrawing).toBeDisabled();
  await expect(openWorkspace).toBeDisabled();
  await expect(recent).toBeDisabled();
  const during = await readWelcomeActionStyle(page);
  expect(during).toEqual(before);
  expect(await readRecentButtonStyle(recent)).toEqual(recentBefore);

  await page.evaluate(() => {
    const browser = globalThis as typeof globalThis & {
      __releaseRecentRemount?: () => void;
    };
    browser.__releaseRecentRemount?.();
  });
  await expect(page.getByRole("alert")).toContainText(
    "Workspace is no longer accessible.",
  );
  await expect(welcomeActions).not.toHaveAttribute("aria-busy", "true");
  const after = await readWelcomeActionStyle(page);
  expect(after).toEqual(before);
  expect(await readRecentButtonStyle(recent)).toEqual(recentBefore);
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

async function assertWelcomeViewportGeometry(
  page: Page,
  expected: {
    viewportWidth: number;
    expectedScreenLeft: number;
    expectedScreenWidth: number;
  },
): Promise<void> {
  const screenBox = await page.getByTestId("welcome-screen").boundingBox();
  const contentBox = await page.locator(".welcome-content").boundingBox();
  const headingBox = await page.locator("#welcome-title").boundingBox();
  const actionsBox = await page.locator(".welcome-actions").boundingBox();
  const recentBox = await page.locator(".recent-workspaces").boundingBox();
  const rowBox = await page
    .locator(".recent-workspace-row")
    .first()
    .boundingBox();
  for (const [name, box] of [
    ["screen", screenBox],
    ["content", contentBox],
    ["heading", headingBox],
    ["actions", actionsBox],
    ["recent", recentBox],
    ["row", rowBox],
  ] as const) {
    expect(box, `${name} geometry missing`).not.toBeNull();
    expect(box?.x, `${name} left edge`).toBe(expected.expectedScreenLeft);
    expect(
      expected.viewportWidth - (box?.x ?? 0) - (box?.width ?? 0),
      `${name} right gutter`,
    ).toBeGreaterThanOrEqual(16);
  }
  expect(screenBox?.width, "screen width").toBe(expected.expectedScreenWidth);
}

async function readWelcomeActionStyle(page: Page): Promise<
  Array<{
    backgroundColor: string;
    color: string;
    opacity: string;
  }>
> {
  return page.locator(".welcome-action").evaluateAll((elements) =>
    elements.map((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        color: style.color,
        opacity: style.opacity,
      };
    }),
  );
}

async function readRecentButtonStyle(
  recent: ReturnType<Page["getByRole"]>,
): Promise<{ color: string; opacity: string }> {
  return recent.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, opacity: style.opacity };
  });
}

interface MissingRecentHarnessOptions {
  deferRemount?: boolean;
}

async function installMissingRecentHarness(
  page: Page,
  options: MissingRecentHarnessOptions = {},
): Promise<void> {
  await page.addInitScript((harnessOptions) => {
    const browser = globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: {
        invoke(
          command: string,
          args?: Record<string, unknown>,
        ): Promise<unknown>;
      };
      __releaseRecentRemount?: () => void;
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
          (
            globalThis as typeof globalThis & {
              __recentRemountStarted?: boolean;
            }
          ).__recentRemountStarted = true;
          if (harnessOptions.deferRemount) {
            await new Promise<void>((resolve) => {
              browser.__releaseRecentRemount = resolve;
            });
          }
          throw new Error("Workspace is no longer accessible.");
        }
        if (command === "workspace_recent_remove") {
          retained = false;
          return {};
        }
        throw new Error(`Unexpected workspace command ${command}`);
      },
    };
  }, options);
}
