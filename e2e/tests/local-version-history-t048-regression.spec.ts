import { expect, test, type Page } from "@playwright/test";
import {
  emitBrowserTauriEvent,
  installBrowserTauriHarness,
} from "./browserTauriHarness";
import {
  openWorkspaceSidebar,
  persistPinnedWorkspaceSidebar,
} from "./workspaceSidebar";

const DOCUMENT_PATH = "/virtual/t048-regression.excalidraw";
const HISTORY_VERSION = {
  versionId: "v-001",
  source: "manual",
  recordedAt: Date.UTC(2026, 8, 29, 12, 0) / 1_000,
  sequence: 1,
  contentHash: "1".repeat(64),
  summary: "Canvas changed",
  availability: { status: "available" },
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 760 });
  await installBrowserTauriHarness(
    page,
    DOCUMENT_PATH,
    undefined,
    [DOCUMENT_PATH],
    undefined,
    true,
  );
  await installHistoryPreviewFixture(page);
  await persistPinnedWorkspaceSidebar(page, ["workspace-1"], "workspace-1");
  await page.goto("/");
  await openWorkspaceSidebar(page);
  await page.getByRole("treeitem", { name: "t048-regression" }).click();
  await expect(
    page.getByRole("tab", { name: "t048-regression.excalidraw" }),
  ).toBeVisible();
  await emitBrowserTauriEvent(page, "native-menu-command", {
    command: "versionHistory",
  });
  await expect(historyPanel(page)).toBeVisible();
});

test("workspace sidebar toggle remains effective while History is open", async ({
  page,
}) => {
  const panel = historyPanel(page);
  const fileSidebar = page.getByRole("complementary", { name: "Files" });
  const sidebarToggle = page.getByRole("button", {
    name: "Toggle workspace sidebar",
  });

  await expect(panel).toBeVisible();
  await expect(fileSidebar).toBeHidden();
  await expect(sidebarToggle).toHaveAttribute("aria-expanded", "true");

  await sidebarToggle.click();

  // A single shell sidebar remains visible: opening Files closes History.
  await expect(fileSidebar).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(sidebarToggle).toHaveAttribute("aria-expanded", "true");

  await expect(
    page.getByRole("treeitem", { name: "t048-regression" }),
  ).toBeVisible();
  await sidebarToggle.click();
  await expect(fileSidebar).toBeHidden();
  await expect(sidebarToggle).toHaveAttribute("aria-expanded", "false");
  await emitBrowserTauriEvent(page, "native-menu-command", {
    command: "versionHistory",
  });
  await expect(panel).toBeVisible();
});

test("read-only version preview hides the SDK main-menu trigger and actions", async ({
  page,
}) => {
  const panel = historyPanel(page);
  const preview = panel.getByRole("region", {
    name: "Read-only canvas preview",
  });

  await panel.getByRole("button", { name: "Preview" }).click();
  await expect(preview).toBeVisible();
  await expect(preview.locator('[data-preview-rendered="true"]')).toBeVisible();
  await expect(preview.getByRole("button")).toHaveCount(0);

  const previewRestore = panel.locator(
    ".history-preview-actions .primary-action",
  );
  await expect(previewRestore).toBeEnabled();
  const previewRestoreColors = await previewRestore.evaluate((element) => {
    const resolveTokenColor = (token: string) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      element.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    return {
      background: getComputedStyle(element).backgroundColor,
      text: getComputedStyle(element).color,
      accent: resolveTokenColor("--accent"),
      accentContrast: resolveTokenColor("--accent-contrast"),
    };
  });
  expect(previewRestoreColors.background).toBe(previewRestoreColors.accent);
  expect(previewRestoreColors.text).toBe(previewRestoreColors.accentContrast);

  await expect(
    preview.getByRole("button", { name: "More options" }),
  ).toHaveCount(0);
  await expect(
    preview.getByText("Find on canvas", { exact: true }),
  ).toHaveCount(0);
  await expect(
    preview.getByText("Excalidraw links", { exact: true }),
  ).toHaveCount(0);
});

test("production AppShell asks before replacing the selected history version", async ({
  page,
}) => {
  const panel = historyPanel(page);
  const preview = panel.getByRole("button", { name: "Preview" });
  await preview.click();
  await expect(
    panel.getByRole("region", { name: "Read-only canvas preview" }),
  ).toBeVisible();

  await panel.getByRole("button", { name: "Restore this version" }).click();
  const dialog = page.getByRole("dialog", { name: "Restore this version?" });
  await expect(dialog).toContainText("Target: v-001 · Canvas changed");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  expect(await readHistoryRestoreCalls(page)).toEqual([]);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await readHistoryRestoreCalls(page)).toEqual([]);

  await panel.getByRole("button", { name: "Restore this version" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Restore this version?",
  });
  await confirmation.getByRole("button", { name: "Restore version" }).click();
  await expect(confirmation.getByRole("alert")).toHaveText(
    "fixture restore should not commit",
  );
  expect(await readHistoryRestoreCalls(page)).toEqual([
    { documentPath: DOCUMENT_PATH, versionId: "v-001" },
  ]);
});

function historyPanel(page: Page) {
  return page.getByRole("complementary", { name: "Version History" });
}

async function installHistoryPreviewFixture(page: Page): Promise<void> {
  await page.addInitScript((item) => {
    type InvokeArgs = Record<string, unknown>;
    type Invoke = (command: string, args?: InvokeArgs) => Promise<unknown>;
    type HarnessWindow = Window & {
      __TAURI_INTERNALS__?: { invoke: Invoke };
      __historyRestoreCalls?: Array<{
        documentPath: string;
        versionId: string;
      }>;
    };
    const browser = globalThis as HarnessWindow;
    const internals = browser.__TAURI_INTERNALS__;
    if (internals === undefined) {
      throw new Error("Browser Tauri harness was not installed first.");
    }
    browser.__historyRestoreCalls = [];
    const invokeBase = internals.invoke.bind(internals);
    internals.invoke = async (command, args = {}) => {
      const request =
        typeof args.request === "object" && args.request !== null
          ? (args.request as InvokeArgs)
          : args;
      if (command === "history_replace") {
        const document = request.document as { path?: unknown } | undefined;
        const target = request.target as { versionId?: unknown } | undefined;
        browser.__historyRestoreCalls?.push({
          documentPath: String(document?.path ?? ""),
          versionId: String(target?.versionId ?? ""),
        });
        throw new Error("fixture restore should not commit");
      }
      if (command === "history_list") {
        const document = request.document as { path?: unknown } | undefined;
        return {
          documentId: String(document?.path ?? ""),
          items: [item],
          listRevision: 1,
        };
      }
      if (command === "history_preview") {
        return {
          versionId: String(request.versionId ?? ""),
          scene: {
            type: "excalidraw",
            version: 2,
            elements: [],
            appState: {},
            files: {},
          },
        };
      }
      return invokeBase(command, args);
    };
  }, HISTORY_VERSION);
}

async function readHistoryRestoreCalls(
  page: Page,
): Promise<Array<{ documentPath: string; versionId: string }>> {
  return page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __historyRestoreCalls?: Array<{
            documentPath: string;
            versionId: string;
          }>;
        }
      ).__historyRestoreCalls ?? [],
  );
}
