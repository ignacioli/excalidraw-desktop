import { expect, test, type Page } from "@playwright/test";
import {
  answerBrowserTauriPeerClose,
  emitBrowserTauriEvent,
  installBrowserTauriHarness,
  readBrowserTauriCommands,
  readBrowserTauriPeerClose,
  setBrowserTauriClaimOutcome,
  setBrowserTauriExtraEntries,
  setBrowserTauriOwnedElsewhere,
  setBrowserTauriRecentExtra,
} from "./browserTauriHarness";

/** The harness Workspace, as the folder dialog returns it. */
const VIRTUAL = {
  id: "workspace-1",
  name: "Virtual Workspace",
  rootPath: "/virtual",
  createdAt: 1,
};

/** A Workspace inside it, open in another window. */
const CHILD = {
  id: "workspace-child",
  name: "Child",
  rootPath: "/virtual/child",
  createdAt: 2,
};

const CONTAINS_OPEN = {
  kind: "containsOpen",
  label: "window-2",
  workspaceId: CHILD.id,
} as const;

const OUTSIDE = "/elsewhere/outside.excalidraw";

function directory(relativePath: string) {
  const slash = relativePath.lastIndexOf("/");
  const name = relativePath.slice(slash + 1);
  return {
    workspaceId: VIRTUAL.id,
    kind: "directory",
    canonicalPath: `${VIRTUAL.rootPath}/${relativePath}`,
    relativePath,
    parentRelativePath: slash < 0 ? "" : relativePath.slice(0, slash),
    name,
    displayName: name,
    mtime: 1,
    fileSize: 0,
  };
}

test.beforeEach(async ({ page }) => {
  await installBrowserTauriHarness(page);
  await page.goto("/");
});

function welcome(page: Page) {
  return page.getByTestId("welcome-screen");
}

/** Welcome New Drawing: this window opens the harness Workspace. */
async function openUntitled(page: Page): Promise<void> {
  await welcome(page)
    .getByRole("button", { name: "New Drawing", exact: true })
    .click();
  await expect(page.locator(".excalidraw-editor")).toBeVisible();
}

function nestedDialog(page: Page) {
  return page.getByRole("dialog", {
    name: "“virtual” contains an open Workspace",
  });
}

test.describe("a folder inside this window's Workspace", () => {
  test("shows the sidebar with the folder selected and a toast", async ({
    page,
  }) => {
    await setBrowserTauriExtraEntries(page, [
      directory("notes"),
      directory("notes/deep"),
    ]);
    await openUntitled(page);

    await emitBrowserTauriEvent(page, "workspace-reveal-entry", {
      relativePath: "notes/deep",
      name: "deep",
    });

    const sidebar = page.getByRole("complementary", { name: "Files" });
    await expect(sidebar).toBeVisible();
    await expect(
      sidebar.getByRole("treeitem", { name: "notes" }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(sidebar.getByRole("treeitem", { name: "deep" })).toBeFocused();
    await expect(
      page.getByRole("status").filter({
        hasText:
          "“deep” is inside Virtual Workspace, already open in this window",
      }),
    ).toBeVisible();
    // The toast shows no path.
    await expect(page.locator(".feedback-toast-path")).toHaveCount(0);
  });
});

test.describe("a folder that contains another window's Workspace", () => {
  test.beforeEach(async ({ page }) => {
    await setBrowserTauriRecentExtra(page, [CHILD]);
    await setBrowserTauriClaimOutcome(page, CONTAINS_OPEN);
  });

  async function openFromWelcome(page: Page) {
    await welcome(page)
      .getByRole("button", { name: "Open Workspace", exact: true })
      .click();
    const dialog = nestedDialog(page);
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test("names both folders and focuses Switch to that window", async ({
    page,
  }) => {
    const dialog = await openFromWelcome(page);

    await expect(dialog).toContainText("/virtual ⊃ /virtual/child");
    await expect(
      dialog.getByRole("button", { name: "Switch to that window" }),
    ).toBeFocused();
    await expect(dialog.getByRole("button")).toHaveText([
      "Close it and open here",
      "Cancel",
      "Switch to that window",
    ]);
  });

  test("Cancel leaves the window as it was", async ({ page }) => {
    const dialog = await openFromWelcome(page);
    const before = (await readBrowserTauriCommands(page)).length;

    await dialog.getByRole("button", { name: "Cancel" }).click();

    await expect(dialog).toHaveCount(0);
    await expect(welcome(page)).toBeVisible();
    const after = (await readBrowserTauriCommands(page)).slice(before);
    expect(after).not.toContain("window_claim_workspace");
    expect(after).not.toContain("window_close_other_and_claim");
  });

  test("Switch to that window brings it forward and opens nothing here", async ({
    page,
  }) => {
    const dialog = await openFromWelcome(page);
    const before = (await readBrowserTauriCommands(page)).length;

    await dialog.getByRole("button", { name: "Switch to that window" }).click();

    await expect(dialog).toHaveCount(0);
    await expect(welcome(page)).toBeVisible();
    const after = (await readBrowserTauriCommands(page)).slice(before);
    expect(after).toContain("window_claim_workspace");
    expect(after).not.toContain("window_close_other_and_claim");
    await expect(page).toHaveTitle("Excalidraw");
  });

  test("Close it and open here opens the folder once that window closed", async ({
    page,
  }) => {
    const dialog = await openFromWelcome(page);

    await dialog
      .getByRole("button", { name: "Close it and open here" })
      .click();

    await expect(dialog).toHaveAttribute("aria-busy", "true");
    await expect(
      dialog.getByRole("button", { name: "Closing that window…" }),
    ).toBeDisabled();
    await expect
      .poll(() => readBrowserTauriPeerClose(page))
      .toEqual({
        targetLabel: "window-2",
        rootPath: "/virtual",
      });

    await answerBrowserTauriPeerClose(page, {
      kind: "claimed",
      workspace: VIRTUAL,
      replaced: null,
      shell: null,
    });

    await expect(dialog).toHaveCount(0);
    await expect(welcome(page)).toHaveCount(0);
    await expect(page).toHaveTitle("Virtual Workspace");
  });

  test("Close it and open here opens nothing when that window stays open", async ({
    page,
  }) => {
    const dialog = await openFromWelcome(page);

    await dialog
      .getByRole("button", { name: "Close it and open here" })
      .click();
    await expect.poll(() => readBrowserTauriPeerClose(page)).not.toBeNull();
    await answerBrowserTauriPeerClose(page, { kind: "cancelled" });

    await expect(dialog.getByRole("alert")).toHaveText(
      "“Child” was not closed, so “virtual” was not opened.",
    );
    await expect(
      dialog.getByRole("button", { name: "Close it and open here" }),
    ).toBeEnabled();
    await expect(welcome(page)).toBeVisible();
    await expect(page).toHaveTitle("Excalidraw");
  });

  test("Close it and open here closes this window's tabs first", async ({
    page,
  }) => {
    await setBrowserTauriClaimOutcome(page, {
      kind: "claimed",
      workspace: VIRTUAL,
      replaced: null,
      shell: null,
    });
    await openUntitled(page);
    await setBrowserTauriClaimOutcome(page, CONTAINS_OPEN);
    const before = (await readBrowserTauriCommands(page)).length;

    await emitBrowserTauriEvent(page, "native-menu-command", {
      command: "openWorkspace",
    });
    const dialog = nestedDialog(page);
    await expect(dialog).toBeVisible();
    await expect(page.locator(".excalidraw-editor")).toBeVisible();
    await dialog
      .getByRole("button", { name: "Close it and open here" })
      .click();

    await expect(page.locator(".excalidraw-editor")).toHaveCount(0);
    const after = (await readBrowserTauriCommands(page)).slice(before);
    const close = after.indexOf("doc_close");
    const ask = after.indexOf("window_close_other_and_claim");
    expect(close).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(close);
  });
});

test.describe("a drawing another window asks this one to show", () => {
  test.beforeEach(async ({ page }) => {
    await openUntitled(page);
  });

  test("switches to its tab without reading it again", async ({ page }) => {
    await emitBrowserTauriEvent(page, "open-file-request", {
      paths: [OUTSIDE],
    });
    const outside = page.getByRole("tab", { name: /outside/ });
    await expect(outside).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: /Untitled/ }).click();
    await expect(outside).toHaveAttribute("aria-selected", "false");
    const opens = (await readBrowserTauriCommands(page)).filter(
      (command) => command === "doc_open",
    ).length;

    await emitBrowserTauriEvent(page, "window-activate-document", {
      path: OUTSIDE,
    });

    await expect(outside).toHaveAttribute("aria-selected", "true");
    expect(
      (await readBrowserTauriCommands(page)).filter(
        (command) => command === "doc_open",
      ),
    ).toHaveLength(opens);
  });

  test("a drawing open in another window stays there", async ({ page }) => {
    await setBrowserTauriOwnedElsewhere(page, { [OUTSIDE]: "window-2" });
    const before = (await readBrowserTauriCommands(page)).length;

    await emitBrowserTauriEvent(page, "open-file-request", {
      paths: [OUTSIDE],
    });

    await expect
      .poll(async () => (await readBrowserTauriCommands(page)).slice(before))
      .toContain("doc_open");
    await expect(page.getByRole("tab", { name: /outside/ })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /Untitled/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
