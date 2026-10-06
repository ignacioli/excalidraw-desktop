import { expect, test, type Page } from "@playwright/test";

import {
  installBrowserTauriHarness,
  readHarnessDraft,
  readHarnessFile,
} from "./browserTauriHarness";
import { persistPinnedWorkspaceSidebar } from "./workspaceSidebar";

const DOCUMENT_PATH = "/virtual/history-protected-input.excalidraw";
const EMPTY_SCENE = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "excalidraw-desktop-e2e-history",
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
});

test.describe("Phase 5 protected input keyboard paths", () => {
  test("captures canvas clear and commits one protected replacement", async ({
    page,
  }) => {
    await openSavedDrawing(page);
    await drawRectangle(page);
    await waitForDraftElement(page, "rectangle");

    const canvas = page.locator(".excalidraw-editor:visible");
    await canvas.click({
      position: { x: 320, y: 220 },
    });
    await canvas.dispatchEvent("keydown", {
      key: "Delete",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    await expect
      .poll(async () => {
        const calls = await readHistoryReplaceCalls(page);
        return calls.map((call) => call.target.kind);
      })
      .toEqual(["clear"]);
    await expect
      .poll(async () =>
        sceneElementTypes(await readHarnessFile(page, DOCUMENT_PATH)),
      )
      .toEqual([]);
    await expect(page.locator(".app-commands")).toContainText(
      "已保存操作前版本并清空画布。",
    );
  });

  test("keeps text editing shortcuts inside the editor and does not replace", async ({
    page,
  }) => {
    await openSavedDrawing(page);
    const canvas = page.locator(".excalidraw-editor:visible");
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) throw new Error("The editor canvas was not measurable.");

    await canvas.click({ position: { x: 120, y: 100 } });
    await page.keyboard.press("t");
    await page.mouse.click(box.x + 420, box.y + 180);
    const textbox = page.getByRole("textbox").last();
    await expect(textbox).toBeFocused();
    await textbox.fill("keep this text");
    await page.keyboard.press("Meta+Delete");

    await expect(textbox).toBeFocused();
    expect(await readHistoryReplaceCalls(page)).toEqual([]);
  });

  test("routes the canvas import shortcut to the chooser and preserves cancel", async ({
    page,
  }) => {
    await openSavedDrawing(page);

    await page.locator(".excalidraw-editor:visible").click({
      position: { x: 320, y: 220 },
    });
    const chooserPromise = page.waitForEvent("filechooser");
    await page.keyboard.press("Meta+O");
    const chooser = await chooserPromise;
    await chooser.setFiles([]);
    expect(await readHistoryReplaceCalls(page)).toEqual([]);
    await expect(page.getByRole("status")).not.toHaveText(
      /unexpected|failed|error/i,
    );
  });

  test("does not apply a chosen import after focus moves to another document", async ({
    page,
  }) => {
    await openSavedDrawing(page);
    await page.locator(".excalidraw-editor:visible").click({
      position: { x: 320, y: 220 },
    });
    const chooserPromise = page.waitForEvent("filechooser");
    await page.keyboard.press("Meta+O");
    const chooser = await chooserPromise;
    await page.evaluate(async () => {
      const modulePath = "/src/documents/documentStore.ts";
      const { documentManager } = await import(/* @vite-ignore */ modulePath);
      await documentManager.createUntitled();
    });
    await chooser.setFiles({
      name: "other.excalidraw",
      mimeType: "application/json",
      buffer: Buffer.from(EMPTY_SCENE),
    });

    await expect(page.getByRole("tab", { name: "Untitled" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await readHistoryReplaceCalls(page)).toEqual([]);
  });

  test("records the current command palette as unreachable", async ({
    page,
  }) => {
    await openSavedDrawing(page);
    const editor = page.locator(".excalidraw-editor:visible");
    await editor.click({ position: { x: 320, y: 220 } });
    await page.keyboard.press("Meta+Shift+P");
    await page.keyboard.press("Meta+/");

    await expect(
      page.getByRole("dialog", { name: /command palette/i }),
    ).toHaveCount(0);
    expect(await readHistoryReplaceCalls(page)).toEqual([]);
  });

  for (const operation of ["clear", "import"] as const) {
    test(`${operation} keeps an untitled scene when first save is cancelled`, async ({
      page,
    }) => {
      await openUntitledDrawing(page);
      await drawRectangle(page);
      await expect.poll(async () => readActiveElementCount(page)).toBe(1);
      const editor = page.locator(".excalidraw-editor:visible");
      await editor.click({ position: { x: 320, y: 220 } });
      if (operation === "clear") {
        await editor.dispatchEvent("keydown", {
          key: "Delete",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        });
      } else {
        const chooserPromise = page.waitForEvent("filechooser");
        await page.keyboard.press("Meta+O");
        const chooser = await chooserPromise;
        await chooser.setFiles({
          name: "replacement.excalidraw",
          mimeType: "application/json",
          buffer: Buffer.from(EMPTY_SCENE),
        });
      }

      await expect.poll(async () => readSaveDialogCount(page)).toBe(1);
      await expect.poll(async () => readActiveElementCount(page)).toBe(1);
      expect(await readHistoryReplaceCalls(page)).toEqual([]);
    });
  }
});

async function openSavedDrawing(page: Page): Promise<void> {
  await installBrowserTauriHarness(page, DOCUMENT_PATH, EMPTY_SCENE, [
    DOCUMENT_PATH,
  ]);
  await installHistoryProbe(page);
  await persistPinnedWorkspaceSidebar(page);
  await page.goto("/");
  await expect(page.locator(".excalidraw-editor")).not.toHaveCount(0);
  await expect(page.locator(".excalidraw-editor:visible")).toHaveCount(1);
  await expect(
    page.getByRole("main", { name: "Drawing canvas" }),
  ).toBeVisible();
}

async function openUntitledDrawing(page: Page): Promise<void> {
  await installBrowserTauriHarness(page, DOCUMENT_PATH, EMPTY_SCENE, []);
  await installHistoryProbe(page, null);
  await persistPinnedWorkspaceSidebar(page);
  await page.goto("/");
  await page.evaluate(async () => {
    const modulePath = "/src/documents/documentStore.ts";
    const { documentManager } = await import(/* @vite-ignore */ modulePath);
    await documentManager.createUntitled();
  });
  await expect(page.locator(".excalidraw-editor:visible")).toHaveCount(1);
}

async function readActiveElementCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const modulePath = "/src/documents/documentStore.ts";
    const { documentManager } = await import(/* @vite-ignore */ modulePath);
    const { activeDocumentId, sessionsById } = documentManager.store.getState();
    return activeDocumentId === null
      ? 0
      : (sessionsById[activeDocumentId]?.scene.elements.length ?? 0);
  });
}

async function readSaveDialogCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __historyProtectedInputProbe?: { saveDialogCount: number };
        }
      ).__historyProtectedInputProbe?.saveDialogCount ?? 0,
  );
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

async function waitForDraftElement(page: Page, type: string): Promise<void> {
  await expect
    .poll(async () =>
      sceneElementTypes(await readHarnessDraft(page, DOCUMENT_PATH)),
    )
    .toContain(type);
}

function sceneElementTypes(sceneJson: string | null): string[] {
  if (sceneJson === null) return [];
  const parsed = JSON.parse(sceneJson) as {
    elements?: Array<{ type?: unknown }>;
  };
  return (parsed.elements ?? []).flatMap((element) =>
    typeof element.type === "string" ? [element.type] : [],
  );
}

type HistoryReplaceCall = {
  target: { kind: string; candidateSceneJson?: string };
  requestId?: string;
};

async function installHistoryProbe(
  page: Page,
  pendingPath: string | null = DOCUMENT_PATH,
): Promise<void> {
  await page.addInitScript(
    ({ pendingPath }) => {
      type Internals = {
        invoke: (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
      type ProbeWindow = Window & {
        __TAURI_INTERNALS__?: Internals;
        __historyProtectedInputProbe?: {
          historyReplace: HistoryReplaceCall[];
          chooserOpenCount: number;
          saveDialogCount: number;
        };
      };
      const browser = globalThis as unknown as ProbeWindow;
      const internals = browser.__TAURI_INTERNALS__;
      if (internals === undefined) {
        throw new Error("The browser Tauri harness was not installed first.");
      }
      const probe = {
        historyReplace: [] as HistoryReplaceCall[],
        chooserOpenCount: 0,
        saveDialogCount: 0,
      };
      browser.__historyProtectedInputProbe = probe;
      const originalInvoke = internals.invoke.bind(internals);
      internals.invoke = async (command, args = {}) => {
        if (command === "app_handshake") {
          const response = (await originalInvoke(command, args)) as {
            contractVersion: number;
            appVersion: string;
            abnormalExit: boolean;
            pendingOpenPaths: string[];
          };
          return {
            ...response,
            pendingOpenPaths: pendingPath === null ? [] : [pendingPath],
          };
        }
        if (command === "plugin:dialog|open") {
          probe.chooserOpenCount += 1;
        }
        if (command === "plugin:dialog|save") {
          probe.saveDialogCount += 1;
        }
        if (command === "history_replace") {
          const request = args.request as Record<string, unknown>;
          const target = request.target as HistoryReplaceCall["target"];
          probe.historyReplace.push({
            target,
            requestId:
              typeof request.requestId === "string"
                ? request.requestId
                : undefined,
          });
          let adoptedScene: unknown = {
            type: "excalidraw",
            version: 2,
            source: "excalidraw-desktop-e2e-history",
            elements: [],
            appState: { viewBackgroundColor: "#ffffff" },
            files: {},
          };
          if (target.kind === "import") {
            adoptedScene = JSON.parse(target.candidateSceneJson ?? "{}");
          }
          const adoptedSceneJson = JSON.stringify(adoptedScene);
          browser.localStorage.setItem(
            "excalidraw-e2e:file:/virtual/history-protected-input.excalidraw",
            adoptedSceneJson,
          );
          const digest = await browser.crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(adoptedSceneJson),
          );
          return {
            status: "completed",
            requestId: request.requestId,
            replacementCommitted: true,
            protectionVersionId: "browser-protected-version",
            adoptedScene,
            newBaseHash: Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join(""),
            newSessionGeneration: 1,
          };
        }
        return originalInvoke(command, args);
      };
    },
    { pendingPath },
  );
}

async function readHistoryReplaceCalls(
  page: Page,
): Promise<HistoryReplaceCall[]> {
  return page.evaluate(() => {
    const probe = (
      globalThis as typeof globalThis & {
        __historyProtectedInputProbe?: { historyReplace: HistoryReplaceCall[] };
      }
    ).__historyProtectedInputProbe;
    return probe?.historyReplace ?? [];
  });
}
