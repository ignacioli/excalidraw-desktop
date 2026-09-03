import { expect, test } from "@playwright/test";
import {
  SHELL_PREFERENCES_STORAGE_KEY,
  SHELL_PREFERENCES_VERSION,
} from "../../src/app/shellPreferences";
import {
  installUiInteractionHarness,
  getUiInteractionHarnessState,
  type UiHarnessWorkspace,
} from "./uiInteractionHarness";

const workspace: UiHarnessWorkspace = {
  id: "workspace-1",
  name: "Design Workspace",
  rootPath: "/ui-interactions/design-workspace",
  createdAt: 1,
};

const recoveryCandidate = {
  documentId: "document-recovery-1",
  originalPath: "/ui-interactions/design-workspace/untitled.excalidraw",
  displayName: "untitled.excalidraw",
  snapshotSavedAt: 1_720_000_000,
  coldFileMtime: 1_719_999_000,
  snapshotNewer: true,
};

test("empty startup routes to Welcome", async ({ page }) => {
  await installUiInteractionHarness(page, {
    workspaces: [],
    startup: { nativeWindowRuntime: true },
  });
  await page.goto("/");

  await expect(page.getByTestId("welcome-screen")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Recover unsaved drawings" }),
  ).not.toBeAttached();
  await expect(page.getByRole("button", { name: "New Drawing" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open Workspace" }),
  ).toBeVisible();
  await expect
    .poll(async () => (await getUiInteractionHarnessState(page)).errors)
    .toEqual([]);
});

test("clean startup with a current Workspace routes to Restored", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [workspace],
    startup: { nativeWindowRuntime: true },
  });
  await page.addInitScript(
    ({ key, snapshot }) => {
      globalThis.localStorage.setItem(key, JSON.stringify(snapshot));
    },
    {
      key: SHELL_PREFERENCES_STORAGE_KEY,
      snapshot: {
        version: SHELL_PREFERENCES_VERSION,
        sidebarPinned: false,
        expandedWorkspaceIds: [],
        currentWorkspaceId: workspace.id,
      },
    },
  );
  await page.goto("/");

  await expect(page.locator(".canvas-empty-state")).toBeVisible();
  await expect
    .poll(async () => {
      const state = await getUiInteractionHarnessState(page);
      return {
        errors: state.errors,
        commands: state.invocations.map((invocation) => invocation.command),
      };
    })
    .toEqual(
      expect.objectContaining({
        errors: [],
        commands: expect.arrayContaining(["app_handshake", "workspace_list"]),
      }),
    );
  await page.getByRole("button", { name: "Workspace sidebar" }).click();
  await expect(
    page.getByRole("treeitem", { name: "Design Workspace" }),
  ).toBeVisible();
  await expect(page.getByTestId("welcome-screen")).not.toBeAttached();
  await expect(
    page.getByRole("heading", { name: "Recover unsaved drawings" }),
  ).not.toBeAttached();
});

test("abnormal startup shows recovery dialog before Restored or Welcome", async ({
  page,
}) => {
  await installUiInteractionHarness(page, {
    workspaces: [],
    startup: {
      abnormalExit: true,
      nativeWindowRuntime: true,
      recoveryCandidates: [recoveryCandidate],
    },
  });
  await page.goto("/");

  const dialog = page.getByRole("dialog", {
    name: "Recover unsaved drawings",
  });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("welcome-screen")).not.toBeAttached();
  await expect
    .poll(async () => {
      const state = await getUiInteractionHarnessState(page);
      const commands = state.invocations.map(
        (invocation) => invocation.command,
      );
      return {
        errors: state.errors,
        commands,
        recoveryApplyCount: commands.filter(
          (command) => command === "recovery_apply",
        ).length,
      };
    })
    .toEqual(
      expect.objectContaining({
        errors: [],
        recoveryApplyCount: 0,
        commands: expect.arrayContaining(["app_handshake", "recovery_list"]),
      }),
    );
  const commands = (await getUiInteractionHarnessState(page)).invocations.map(
    (invocation) => invocation.command,
  );
  expect(commands.indexOf("app_handshake")).toBeGreaterThanOrEqual(0);
  expect(commands.indexOf("recovery_list")).toBeGreaterThan(
    commands.indexOf("app_handshake"),
  );
  await expect(
    dialog.getByRole("button", { name: "Restore untitled.excalidraw" }),
  ).toBeVisible();
});
