import { expect, test, type Page } from "@playwright/test";

import {
  emitBrowserTauriEvent,
  installBrowserTauriHarness,
  readHarnessDraft,
} from "./browserTauriHarness";
import { persistPinnedWorkspaceSidebar } from "./workspaceSidebar";

const DOCUMENT_A = "/virtual/history-preview-a.excalidraw";
const DOCUMENT_B = "/virtual/history-preview-b.excalidraw";
const EMPTY_SCENE = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "excalidraw-desktop-e2e-history-preview",
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
});

test.describe("production HistoryPanel preview", () => {
  test("opens from the saved active document and keeps the current draft unchanged", async ({
    page,
  }, testInfo) => {
    await openSavedDrawing(page, DOCUMENT_A, 500);
    await drawRectangle(page);
    const draftBeforePreview = await waitForDraft(page, DOCUMENT_A);

    await emitBrowserTauriEvent(page, "native-menu-command", {
      command: "versionHistory",
    });

    const panel = page.getByRole("complementary", {
      name: "Version History",
    });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("option").first()).toBeVisible();

    const restore = panel.getByRole("button", {
      name: "Restore this version",
    });
    await panel.getByRole("option").first().press("Enter");
    await expect(
      page.getByRole("region", { name: "Read-only canvas preview" }),
    ).toBeVisible();
    await expect(restore).toBeDisabled();

    await expect(
      page
        .getByRole("region", { name: "Read-only canvas preview" })
        .locator("[data-preview-rendered]"),
    ).toHaveAttribute("data-preview-rendered", "true", { timeout: 15_000 });
    await expect(restore).toBeEnabled();
    await expect(
      page.getByRole("region", { name: "Version preview", exact: true }),
    ).toContainText("The current drawing remains separate and unchanged.");
    await expect
      .poll(async () => readHarnessDraft(page, DOCUMENT_A))
      .toBe(draftBeforePreview);
    await expect(page.locator(".excalidraw-editor:visible")).toHaveCount(1);

    const state = await readProductionHistoryState(page);
    expect(state.historyPreview).toEqual([
      { documentPath: DOCUMENT_A, versionId: "version-a" },
    ]);
    expect(state.writeCommands).toEqual([]);
    await expect(page.locator(".history-preview-header")).toHaveCSS(
      "height",
      "56px",
    );
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: testInfo.outputPath("history-preview-canvas.png"),
    });
  });

  test("ignores a stale preview response after switching the active document", async ({
    page,
  }) => {
    await openSavedDrawing(page, DOCUMENT_A, 700);

    await emitBrowserTauriEvent(page, "native-menu-command", {
      command: "versionHistory",
    });
    const panel = page.getByRole("complementary", {
      name: "Version History",
    });
    await expect(panel).toBeVisible();
    await panel.getByRole("option").first().press("Enter");
    await expect(
      page.getByRole("region", { name: "Read-only canvas preview" }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Restore this version" }),
    ).toBeDisabled();

    await page.evaluate(async (path) => {
      const modulePath = "/src/documents/documentStore.ts";
      const { documentManager } = await import(/* @vite-ignore */ modulePath);
      await documentManager.open(path);
    }, DOCUMENT_B);

    await expect(panel).toContainText("history-preview-b.excalidraw");
    await expect(panel.getByRole("option").first()).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Version preview" }),
    ).toHaveCount(0);
    await page.waitForTimeout(900);
    await expect(
      page.getByRole("region", { name: "Version preview" }),
    ).toHaveCount(0);

    const state = await readProductionHistoryState(page);
    expect(state.historyPreview).toEqual([
      { documentPath: DOCUMENT_A, versionId: "version-a" },
    ]);
    expect(state.historyList).toEqual(
      expect.arrayContaining([
        { documentPath: DOCUMENT_A },
        { documentPath: DOCUMENT_B },
      ]),
    );
    expect(state.writeCommands).toEqual(["doc_checkpoint"]);
  });
});

async function openSavedDrawing(
  page: Page,
  documentPath: string,
  previewDelayMs = 0,
): Promise<void> {
  await installBrowserTauriHarness(page, documentPath, EMPTY_SCENE, [
    documentPath,
  ]);
  await installProductionHistoryHarness(page, documentPath, previewDelayMs);
  await persistPinnedWorkspaceSidebar(page);
  await page.goto("/");
  await expect(page.locator(".excalidraw-editor:visible")).toHaveCount(1);
}

async function drawRectangle(page: Page): Promise<void> {
  const canvas = page.locator(".excalidraw-editor:visible");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) throw new Error("The editor canvas was not measurable.");
  await canvas.click({ position: { x: 120, y: 100 } });
  await page.keyboard.press("r");
  await page.mouse.move(box.x + 360, box.y + 140);
  await page.mouse.down();
  await page.mouse.move(box.x + 520, box.y + 250, { steps: 8 });
  await page.mouse.up();
}

async function waitForDraft(page: Page, documentPath: string): Promise<string> {
  let draft: string | null = null;
  await expect
    .poll(async () => {
      draft = await readHarnessDraft(page, documentPath);
      if (draft === null) return [];
      const parsed = JSON.parse(draft) as {
        elements?: Array<{ type?: unknown }>;
      };
      return (parsed.elements ?? []).flatMap((element) =>
        typeof element.type === "string" ? [element.type] : [],
      );
    })
    .toContain("rectangle");
  if (draft === null) throw new Error("The drawing draft was not created.");
  return draft;
}

async function installProductionHistoryHarness(
  page: Page,
  pendingPath: string,
  previewDelayMs: number,
): Promise<void> {
  await page.addInitScript(
    ({ pendingPath, previewDelayMs }) => {
      type InvokeArgs = Record<string, unknown>;
      type Internals = {
        invoke(command: string, args?: InvokeArgs): Promise<unknown>;
      };
      type ProductionHistoryState = {
        historyList: Array<{ documentPath: string }>;
        historyPreview: Array<{ documentPath: string; versionId: string }>;
        writeCommands: string[];
      };
      type BrowserWindow = Window & {
        __TAURI_INTERNALS__?: Internals;
        __productionHistoryState?: ProductionHistoryState;
      };

      const browser = globalThis as unknown as BrowserWindow;
      const internals = browser.__TAURI_INTERNALS__;
      if (internals === undefined) {
        throw new Error("The browser Tauri harness was not installed first.");
      }
      const originalInvoke = internals.invoke.bind(internals);
      const state: ProductionHistoryState = {
        historyList: [],
        historyPreview: [],
        writeCommands: [],
      };
      browser.__productionHistoryState = state;

      const requestDocumentPath = (args: InvokeArgs): string => {
        const request = args.request as { document?: { path?: unknown } };
        const path = request.document?.path;
        return typeof path === "string" ? path : "";
      };

      internals.invoke = async (command, args = {}) => {
        if (command === "app_handshake") {
          const response = (await originalInvoke(command, args)) as Record<
            string,
            unknown
          >;
          return { ...response, pendingOpenPaths: [pendingPath] };
        }
        if (command === "native_menu_set_enabled") return {};
        if (
          command === "history_replace" ||
          command === "history_mark" ||
          command === "history_delete" ||
          command === "doc_checkpoint"
        ) {
          state.writeCommands.push(command);
        }
        if (command === "history_list") {
          const documentPath = requestDocumentPath(args);
          state.historyList.push({ documentPath });
          const suffix = documentPath.endsWith("-b.excalidraw") ? "b" : "a";
          return {
            documentId: documentPath,
            items: [
              {
                versionId: `version-${suffix}`,
                source: "automatic",
                recordedAt:
                  Date.UTC(2025, 0, suffix === "a" ? 2 : 3, 12) / 1000,
                sequence: 1,
                contentHash: "a".repeat(64),
                availability: { status: "available" },
              },
            ],
            listRevision: 1,
          };
        }
        if (command === "history_preview") {
          const documentPath = requestDocumentPath(args);
          const request = args.request as { versionId?: unknown };
          const versionId = String(request.versionId ?? "");
          state.historyPreview.push({ documentPath, versionId });
          if (previewDelayMs > 0) {
            await new Promise((resolve) =>
              globalThis.setTimeout(resolve, previewDelayMs),
            );
          }
          return {
            versionId,
            scene: {
              type: "excalidraw",
              version: 2,
              source: "excalidraw-desktop-e2e-history-preview",
              elements: [],
              appState: { viewBackgroundColor: "#f4f4f4" },
              files: {},
            },
          };
        }
        return originalInvoke(command, args);
      };
    },
    { pendingPath, previewDelayMs },
  );
}

async function readProductionHistoryState(page: Page): Promise<{
  historyList: Array<{ documentPath: string }>;
  historyPreview: Array<{ documentPath: string; versionId: string }>;
  writeCommands: string[];
}> {
  return page.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        __productionHistoryState?: {
          historyList: Array<{ documentPath: string }>;
          historyPreview: Array<{ documentPath: string; versionId: string }>;
          writeCommands: string[];
        };
      }
    ).__productionHistoryState;
    return {
      historyList: state?.historyList ?? [],
      historyPreview: state?.historyPreview ?? [],
      writeCommands: state?.writeCommands ?? [],
    };
  });
}
