import { expect, test, type Page } from "@playwright/test";
import {
  installUiInteractionHarness,
  type UiHarnessWorkspace,
  type UiHarnessWorkspaceEntry,
} from "./uiInteractionHarness";

const WORKSPACES: readonly UiHarnessWorkspace[] = [
  {
    id: "workspace-alpha",
    name: "Alpha",
    rootPath: "/ui-interactions/alpha",
    createdAt: 1,
  },
  {
    id: "workspace-beta",
    name: "Beta",
    rootPath: "/ui-interactions/beta",
    createdAt: 2,
  },
  {
    id: "workspace-gamma",
    name: "Gamma",
    rootPath: "/ui-interactions/gamma",
    createdAt: 3,
  },
];

function entry(
  workspace: UiHarnessWorkspace,
  kind: "directory" | "drawing",
  name: string,
  parentRelativePath = "",
): UiHarnessWorkspaceEntry {
  const relativePath = parentRelativePath
    ? `${parentRelativePath}/${name}`
    : name;
  return {
    workspaceId: workspace.id,
    kind,
    canonicalPath: `${workspace.rootPath}/${relativePath}`,
    relativePath,
    parentRelativePath,
    name,
    displayName:
      kind === "drawing" ? name.replace(/\.excalidraw(?:\.json)?$/, "") : name,
    mtime: 1,
    fileSize: kind === "drawing" ? 100 : 0,
  };
}

const WORKSPACE_ENTRIES = WORKSPACES.flatMap((workspace) => [
  entry(workspace, "directory", "notes"),
  entry(workspace, "drawing", "drawing.excalidraw"),
  entry(workspace, "drawing", "anchor.excalidraw", "notes"),
]);

test("three Workspaces render as one bounded native-scroll tree without overlap", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: WORKSPACES,
    entries: WORKSPACE_ENTRIES,
  });
  await page.goto("/");

  const workspaceRegion = page.getByRole("region", { name: "Workspaces" });
  const tree = workspaceRegion.getByRole("tree");
  await expect(tree).toHaveCount(1);
  await expect(tree).toBeVisible();
  for (const workspace of WORKSPACES) {
    await expect(
      workspaceRegion.getByRole("treeitem", { name: workspace.name }),
    ).toBeVisible();
  }

  const scrollMetrics = await tree.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    };
  });
  expect(["auto", "scroll"]).toContain(scrollMetrics.overflowY);
  expect(scrollMetrics.scrollWidth).toBeLessThanOrEqual(
    scrollMetrics.clientWidth,
  );
  expect(scrollMetrics.overflowX).not.toBe("scroll");
  expect(scrollMetrics.scrollHeight).toBeGreaterThanOrEqual(
    scrollMetrics.clientHeight,
  );

  const rowBoxes = await tree.locator('[role="treeitem"]').evaluateAll((rows) =>
    rows
      .map((row) => {
        const rect = row.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
        };
      })
      .filter((rect) => rect.bottom > rect.top && rect.right > rect.left),
  );
  for (let index = 0; index < rowBoxes.length; index += 1) {
    for (let next = index + 1; next < rowBoxes.length; next += 1) {
      const current = rowBoxes[index];
      const candidate = rowBoxes[next];
      expect(
        current.bottom <= candidate.top || candidate.bottom <= current.top,
        `tree rows ${index} and ${next} overlap`,
      ).toBe(true);
    }
  }
});

test("Workspace and entry menus support keyboard navigation, dismissal, and viewport collision", async ({
  page,
}) => {
  await page.setViewportSize({ width: 420, height: 260 });
  await installUiInteractionHarness(page, {
    workspaces: WORKSPACES,
    entries: WORKSPACE_ENTRIES,
  });
  await page.goto("/");

  const workspaceRegion = page.getByRole("region", { name: "Workspaces" });
  const tree = workspaceRegion.getByRole("tree");
  const entryActions = workspaceRegion.getByRole("button", {
    name: "Actions for notes",
  }).first();
  await expect(entryActions).toBeVisible();
  await entryActions.focus();
  await page.keyboard.press("Enter");

  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitem");
  await expect(items).toHaveCount(4);
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();

  const menuBox = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(menuBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (menuBox !== null && viewport !== null) {
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height);
  }

  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(entryActions).toBeFocused();

  await entryActions.click();
  await expect(menu).toBeVisible();
  await page.mouse.click(3, 3);
  await expect(menu).not.toBeVisible();
  await expect(entryActions).toBeFocused();

  await entryActions.click();
  await expect(menu).toBeVisible();
  await tree.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(menu).not.toBeVisible();

  const workspaceActions = page.getByRole("button", {
    name: "Actions for Alpha",
  });
  await workspaceActions.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("treeitem", { name: "Alpha" }).click();
  await expect(page.getByRole("menu")).not.toBeVisible();
});

test("refresh keeps the first surviving scroll anchor and restart restores tree focus at the top", async ({
  page,
}) => {
  const rows = Array.from({ length: 80 }, (_, index) =>
    entry(
      WORKSPACES[0],
      "drawing",
      `drawing-${String(index).padStart(3, "0")}.excalidraw`,
    ),
  );
  await installUiInteractionHarness(page, {
    workspaces: [WORKSPACES[0]],
    entries: rows,
  });
  await installWorkspaceEventHarness(page);
  await page.goto("/");

  const tree = page.getByRole("tree");
  await expect(tree).toBeVisible();
  await tree.evaluate((element) => {
    element.scrollTop = Math.min(768, element.scrollHeight / 2);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const anchor = page.getByRole("treeitem", {
    name: "drawing-040",
  });
  await expect(anchor).toBeVisible();
  const before = await anchor.boundingBox();
  expect(before).not.toBeNull();

  await page.evaluate(() => {
    const browser = globalThis as typeof globalThis & {
      __uiInteractionHarness?: {
        state: {
          entries: Array<{ name: string }>;
        };
      };
      __emitWorkspaceEvent?: (payload: unknown) => void;
    };
    const state = browser.__uiInteractionHarness?.state;
    if (state === undefined) throw new Error("UI harness is not installed");
    state.entries = state.entries.filter(
      (entry) => !entry.name.startsWith("drawing-000"),
    );
    browser.__emitWorkspaceEvent?.({
      workspaceId: "workspace-alpha",
      change: "invalidated",
      relativePath: "",
    });
  });

  await expect(
    page.getByRole("treeitem", { name: "drawing-000" }),
  ).not.toBeVisible();
  await expect(anchor).toBeVisible();
  const after = await anchor.boundingBox();
  expect(after).not.toBeNull();
  if (before !== null && after !== null) {
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(32);
  }
  expect(await tree.evaluate((element) => element.scrollTop)).toBeGreaterThan(
    0,
  );

  await page.reload();
  const restartedTree = page.getByRole("tree");
  await expect(restartedTree).toBeVisible();
  await expect(restartedTree).toBeFocused();
  expect(await restartedTree.evaluate((element) => element.scrollTop)).toBe(0);
});

async function installWorkspaceEventHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type EventCallback = (event: {
      event: string;
      id: number;
      payload: unknown;
    }) => void;
    type EventInternals = {
      invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
      transformCallback?: (callback: EventCallback) => number;
    };
    const browser = globalThis as typeof globalThis & {
      __TAURI_INTERNALS__?: EventInternals;
      __TAURI_EVENT_PLUGIN_INTERNALS__?: {
        unregisterListener(event: string, eventId: number): void;
      };
      __emitWorkspaceEvent?: (payload: unknown) => void;
    };
    const internals = browser.__TAURI_INTERNALS__;
    if (internals === undefined) return;
    const invoke = internals.invoke.bind(internals);
    const callbacks = new Map<number, EventCallback>();
    const listeners = new Map<string, Set<number>>();
    let nextCallbackId = 1;
    internals.transformCallback = (callback) => {
      const id = nextCallbackId++;
      callbacks.set(id, callback);
      return id;
    };
    browser.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(event, eventId) {
        listeners.get(event)?.delete(eventId);
        callbacks.delete(eventId);
      },
    };
    internals.invoke = async (command, args = {}) => {
      if (command === "plugin:event|listen") {
        const event = String(args.event ?? "");
        const eventId = Number(args.handler);
        const eventListeners = listeners.get(event) ?? new Set<number>();
        eventListeners.add(eventId);
        listeners.set(event, eventListeners);
        return eventId;
      }
      if (command === "plugin:event|unlisten") {
        const event = String(args.event ?? "");
        const eventId = Number(args.eventId);
        listeners.get(event)?.delete(eventId);
        callbacks.delete(eventId);
        return null;
      }
      return invoke(command, args);
    };
    browser.__emitWorkspaceEvent = (payload) => {
      const event = "workspace-entries-changed";
      for (const eventId of listeners.get(event) ?? []) {
        callbacks.get(eventId)?.({ event, id: eventId, payload });
      }
    };
  });
}
