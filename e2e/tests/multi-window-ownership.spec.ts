import { expect, test, type Page } from "@playwright/test";
import {
  emitBrowserTauriEvent,
  installBrowserTauriHarness,
  readBrowserTauriCommands,
  setBrowserTauriClaimOutcome,
} from "./browserTauriHarness";

const DECLINED = [
  {
    kind: "ownedBy",
    label: "window-2",
    workspaceId: "workspace-virtual",
  },
  {
    kind: "insideOpen",
    label: "window-2",
    workspaceId: "workspace-parent",
    relativePath: "virtual",
  },
] as const;

const CONTAINS_OPEN = {
  kind: "containsOpen",
  label: "window-2",
  workspaceId: "workspace-child",
} as const;

const OVERLAP_MESSAGE =
  "This folder overlaps a workspace that is already mounted.";

test.beforeEach(async ({ page }) => {
  await installBrowserTauriHarness(page);
  await page.goto("/");
});

function welcome(page: Page) {
  return page.getByTestId("welcome-screen");
}

async function newWelcomeDrawing(page: Page): Promise<void> {
  await welcome(page)
    .getByRole("button", { name: "New Drawing", exact: true })
    .click();
}

async function openWorkspaceFromMenu(page: Page): Promise<void> {
  await emitBrowserTauriEvent(page, "native-menu-command", {
    command: "openWorkspace",
  });
}

test.describe("Welcome New Drawing", () => {
  test("creates Untitled in the claimed folder", async ({ page }) => {
    await newWelcomeDrawing(page);

    await expect(page.locator(".excalidraw-editor")).toBeVisible();
    const commands = await readBrowserTauriCommands(page);
    expect(commands).toContain("window_claim_workspace");
    expect(commands).toContain("workspace_entry_create");
  });

  for (const outcome of DECLINED) {
    test(`keeps Welcome when another window holds the folder (${outcome.kind})`, async ({
      page,
    }) => {
      await setBrowserTauriClaimOutcome(page, outcome);

      await newWelcomeDrawing(page);

      await expect
        .poll(() => readBrowserTauriCommands(page))
        .toContain("window_claim_workspace");
      await expect(welcome(page)).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect(await readBrowserTauriCommands(page)).not.toContain(
        "workspace_entry_create",
      );
    });
  }

  test("reports a folder that contains another window's Workspace", async ({
    page,
  }) => {
    await setBrowserTauriClaimOutcome(page, CONTAINS_OPEN);

    await newWelcomeDrawing(page);

    await expect(welcome(page).getByRole("alert")).toContainText(
      OVERLAP_MESSAGE,
    );
    expect(await readBrowserTauriCommands(page)).not.toContain(
      "workspace_entry_create",
    );
  });
});

test.describe("Open Workspace in a window with tabs", () => {
  test.beforeEach(async ({ page }) => {
    await newWelcomeDrawing(page);
    await expect(page.locator(".excalidraw-editor")).toBeVisible();
  });

  test("closes every tab before replacing the Workspace", async ({ page }) => {
    await openWorkspaceFromMenu(page);

    await expect(page.locator(".excalidraw-editor")).toHaveCount(0);
    const commands = await readBrowserTauriCommands(page);
    const probe = commands.lastIndexOf("window_probe_workspace");
    const close = commands.lastIndexOf("doc_close");
    const claim = commands.lastIndexOf("window_claim_workspace");
    expect(probe).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(probe);
    expect(claim).toBeGreaterThan(close);
  });

  for (const outcome of DECLINED) {
    test(`keeps the tabs when another window holds the folder (${outcome.kind})`, async ({
      page,
    }) => {
      await setBrowserTauriClaimOutcome(page, outcome);
      const before = (await readBrowserTauriCommands(page)).length;

      await openWorkspaceFromMenu(page);

      await expect
        .poll(async () => (await readBrowserTauriCommands(page)).slice(before))
        .toContain("window_claim_workspace");
      await expect(page.locator(".excalidraw-editor")).toBeVisible();
      expect(
        (await readBrowserTauriCommands(page)).slice(before),
      ).not.toContain("doc_close");
    });
  }

  test("keeps the tabs and reports a folder that contains another window's Workspace", async ({
    page,
  }) => {
    await setBrowserTauriClaimOutcome(page, CONTAINS_OPEN);
    const before = (await readBrowserTauriCommands(page)).length;

    await openWorkspaceFromMenu(page);

    await expect(page.getByRole("banner").getByRole("status")).toContainText(
      OVERLAP_MESSAGE,
    );
    await expect(page.locator(".excalidraw-editor")).toBeVisible();
    const after = (await readBrowserTauriCommands(page)).slice(before);
    expect(after).toContain("window_probe_workspace");
    expect(after).not.toContain("doc_close");
    expect(after).not.toContain("window_claim_workspace");
  });
});

test.describe("window title", () => {
  const notes = {
    id: "workspace-notes",
    name: "notes",
    rootPath: "/Users/me/work/notes",
    createdAt: 1,
  };

  test("names the Workspace and tells same-name Workspaces apart", async ({
    page,
  }) => {
    await expect(page).toHaveTitle("Excalidraw");
    await setBrowserTauriClaimOutcome(page, {
      kind: "claimed",
      workspace: notes,
      replaced: null,
      shell: null,
    });

    await welcome(page)
      .getByRole("button", { name: "Open Workspace", exact: true })
      .click();
    await expect(page).toHaveTitle("notes");

    await emitBrowserTauriEvent(page, "open-workspaces-changed", {
      workspaces: [
        { workspaceId: notes.id, name: "notes", rootPath: notes.rootPath },
        {
          workspaceId: "workspace-home-notes",
          name: "notes",
          rootPath: "/Users/me/home/notes",
        },
      ],
    });
    await expect(page).toHaveTitle("notes (work)");
  });
});

test.describe("preferences changed in another window", () => {
  test("applies appearance and language within one second without sharing them back", async ({
    page,
  }) => {
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const before = (await readBrowserTauriCommands(page)).length;

    const elapsed = await page.evaluate(async () => {
      const root = document.documentElement;
      const emit = (
        globalThis as typeof globalThis & {
          __browserTauriEmit?: (name: string, value: unknown) => void;
        }
      ).__browserTauriEmit;
      if (emit === undefined) throw new Error("events are not installed");
      const started = performance.now();
      emit("app-preferences-changed", {
        appearance: "dark",
        language: "zh-CN",
      });
      while (root.dataset.colorScheme !== "dark" || root.lang !== "zh-CN") {
        if (performance.now() - started > 5000) break;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return performance.now() - started;
    });

    expect(elapsed).toBeLessThan(1000);
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-scheme",
      "dark",
    );
    await expect(
      welcome(page).getByRole("button", { name: "新建绘图", exact: true }),
    ).toBeVisible();
    expect((await readBrowserTauriCommands(page)).slice(before)).not.toContain(
      "app_preferences_broadcast",
    );
  });
});
