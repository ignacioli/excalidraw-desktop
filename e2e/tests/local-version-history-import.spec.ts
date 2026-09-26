import { expect, test, type Page } from "@playwright/test";
import type { SceneSnapshot } from "../../src/editor/sceneSerializer";

import {
  installBrowserTauriHarness,
  readHarnessDraft,
  readHarnessFile,
} from "./browserTauriHarness";
import { persistPinnedWorkspaceSidebar } from "./workspaceSidebar";

const DOCUMENT_PATH = "/virtual/history-import.excalidraw";
const EMPTY_SCENE = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "excalidraw-desktop-e2e-history",
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
});
const ORDINARY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3OQAAAAASUVORK5CYII=";

test.describe("Phase 5 protected import paths", () => {
  for (const format of ["png", "svg"] as const) {
    test(`forwards an ordinary ${format.toUpperCase()} to the SDK exactly once`, async ({
      page,
    }) => {
      await openSavedDrawing(page);
      await dropFile(
        page,
        `photo.${format}`,
        format === "png" ? "image/png" : "image/svg+xml",
        format === "png"
          ? decodeBase64(ORDINARY_PNG)
          : new TextEncoder().encode(
              '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="green"/></svg>',
            ),
      );

      await expect
        .poll(async () =>
          sceneSummary(await readHarnessDraft(page, DOCUMENT_PATH)),
        )
        .toMatchObject({ imageCount: 1, fileCount: 1 });
      expect(await readHistoryReplaceCalls(page)).toEqual([]);
    });
  }

  for (const format of ["png", "svg"] as const) {
    test(`protects an embedded ${format.toUpperCase()} scene before SDK insertion`, async ({
      page,
    }) => {
      await openSavedDrawing(page);
      await drawRectangle(page);
      await expect
        .poll(async () =>
          sceneSummary(await readHarnessDraft(page, DOCUMENT_PATH)),
        )
        .toMatchObject({ rectangleCount: 1, imageCount: 0 });
      const exported = await exportCurrentScene(page, format);
      await dropFile(
        page,
        `embedded.${format}`,
        exported.type,
        new Uint8Array(exported.bytes),
      );

      await expect
        .poll(async () =>
          (await readHistoryReplaceCalls(page)).map((call) => call.target.kind),
        )
        .toEqual(["import"]);
      await expect(page.locator(".app-commands")).toContainText(
        "已保存操作前版本并导入绘图。",
      );
      await expect
        .poll(async () =>
          sceneSummary(await readHarnessDraft(page, DOCUMENT_PATH)),
        )
        .toMatchObject({ rectangleCount: 1, imageCount: 0 });
    });
  }

  test("rejects a multi-file drop before parsing or replacing the drawing", async ({
    page,
  }) => {
    await openSavedDrawing(page);
    await dropFiles(page, [
      {
        name: "first.excalidraw",
        type: "application/json",
        bytes: new TextEncoder().encode(EMPTY_SCENE),
      },
      {
        name: "second.excalidraw",
        type: "application/json",
        bytes: new TextEncoder().encode(EMPTY_SCENE),
      },
    ]);

    await expect.poll(async () => readHistoryReplaceCalls(page)).toEqual([]);
    await expect
      .poll(async () =>
        sceneSummary(await readHarnessDraft(page, DOCUMENT_PATH)),
      )
      .toMatchObject({ elementCount: 0, fileCount: 0 });
    await expect(page.getByRole("status")).not.toHaveText(
      /unexpected|failed|error/i,
    );
  });

  test("reports malformed drawing data without replacing the current scene", async ({
    page,
  }) => {
    await openSavedDrawing(page);
    await dropFile(
      page,
      "broken.excalidraw",
      "application/json",
      new TextEncoder().encode("{broken"),
    );

    await expect(page.locator(".app-commands [role=status]")).toContainText(
      /invalid/i,
    );
    expect(await readHistoryReplaceCalls(page)).toEqual([]);
    expect(
      sceneSummary(await readHarnessFile(page, DOCUMENT_PATH)),
    ).toMatchObject({
      elementCount: 0,
    });
  });

  test("keeps library MIME insertion on the SDK path once", async ({
    page,
  }) => {
    await openSavedDrawing(page);
    await drawRectangle(page);
    await expect
      .poll(async () => readHarnessDraft(page, DOCUMENT_PATH))
      .not.toBeNull();
    const transfer = await page.evaluateHandle(async () => {
      const modulePath = "/src/e2e/embeddedSceneFixture.ts";
      const { libraryRectangleFixture } = await import(
        /* @vite-ignore */ modulePath
      );
      const data = new DataTransfer();
      data.setData(
        "application/vnd.excalidrawlib+json",
        JSON.stringify({
          type: "excalidrawlib",
          version: 2,
          libraryItems: [
            {
              id: "history-library",
              status: "published",
              created: 1,
              elements: libraryRectangleFixture(),
            },
          ],
        }),
      );
      return data;
    });
    try {
      await page
        .getByRole("radio", { name: "Rectangle" })
        .last()
        .dispatchEvent("drop", {
          dataTransfer: transfer,
          clientX: 520,
          clientY: 360,
        });
    } finally {
      await transfer.dispose();
    }

    await expect
      .poll(
        async () =>
          sceneSummary(await readHarnessDraft(page, DOCUMENT_PATH))
            .elementCount,
      )
      .toBe(2);
    expect(await readHistoryReplaceCalls(page)).toEqual([]);
  });
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

async function dropFile(
  page: Page,
  name: string,
  type: string,
  bytes: Uint8Array,
): Promise<void> {
  await dropFiles(page, [{ name, type, bytes }]);
}

async function dropFiles(
  page: Page,
  files: readonly { name: string; type: string; bytes: Uint8Array }[],
): Promise<void> {
  const transfer = await page.evaluateHandle(
    ({ fileEntries }) => {
      const browser = globalThis as unknown as {
        DataTransfer: new () => {
          items: { add(file: unknown): void };
        };
        File: new (
          bits: unknown[],
          name: string,
          options?: Record<string, unknown>,
        ) => unknown;
      };
      const transfer = new browser.DataTransfer();
      for (const entry of fileEntries) {
        transfer.items.add(
          new browser.File([new Uint8Array(entry.bytes)], entry.name, {
            type: entry.type,
          }),
        );
      }
      return transfer;
    },
    {
      fileEntries: files.map((file) => ({
        name: file.name,
        type: file.type,
        bytes: Array.from(file.bytes),
      })),
    },
  );
  try {
    await page
      .getByRole("radio", { name: "Rectangle" })
      .last()
      .dispatchEvent("drop", {
        dataTransfer: transfer,
        clientX: 520,
        clientY: 360,
      });
  } finally {
    await transfer.dispose();
  }
}

async function exportCurrentScene(
  page: Page,
  format: "png" | "svg",
): Promise<{ type: string; bytes: number[] }> {
  const draft = await readHarnessDraft(page, DOCUMENT_PATH);
  expect(draft).not.toBeNull();
  if (draft === null) throw new Error("The scene draft was not written.");
  return page.evaluate(
    async ({ serialized, exportFormat }) => {
      const scene = JSON.parse(serialized) as SceneSnapshot;
      const modulePath = "/src/e2e/embeddedSceneFixture.ts";
      const { exportEmbeddedSceneFixture } = await import(
        /* @vite-ignore */ modulePath
      );
      const blob = await exportEmbeddedSceneFixture(scene, exportFormat);
      return {
        type: blob.type,
        bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      };
    },
    { serialized: draft, exportFormat: format },
  );
}

function decodeBase64(encoded: string): Uint8Array {
  return Uint8Array.from(Buffer.from(encoded, "base64"));
}

function sceneSummary(sceneJson: string | null): {
  elementCount: number;
  rectangleCount: number;
  imageCount: number;
  fileCount: number;
} {
  if (sceneJson === null) {
    return { elementCount: 0, rectangleCount: 0, imageCount: 0, fileCount: 0 };
  }
  const scene = JSON.parse(sceneJson) as {
    elements?: Array<{ type?: unknown }>;
    files?: Record<string, unknown>;
  };
  const elements = scene.elements ?? [];
  return {
    elementCount: elements.length,
    rectangleCount: elements.filter((element) => element.type === "rectangle")
      .length,
    imageCount: elements.filter((element) => element.type === "image").length,
    fileCount: Object.keys(scene.files ?? {}).length,
  };
}

type HistoryReplaceCall = {
  target: { kind: string; candidateSceneJson?: string };
};

async function installHistoryProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Internals = {
      invoke: (
        command: string,
        args?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
    type ProbeWindow = Window & {
      __TAURI_INTERNALS__?: Internals;
      __historyImportProbe?: { historyReplace: HistoryReplaceCall[] };
    };
    const browser = globalThis as unknown as ProbeWindow;
    const internals = browser.__TAURI_INTERNALS__;
    if (internals === undefined) {
      throw new Error("The browser Tauri harness was not installed first.");
    }
    const probe = { historyReplace: [] as HistoryReplaceCall[] };
    browser.__historyImportProbe = probe;
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
          pendingOpenPaths: ["/virtual/history-import.excalidraw"],
        };
      }
      if (command === "history_replace") {
        const request = args.request as Record<string, unknown>;
        const target = request.target as HistoryReplaceCall["target"];
        probe.historyReplace.push({ target });
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
          "excalidraw-e2e:file:/virtual/history-import.excalidraw",
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
          protectionVersionId: "browser-protected-import-version",
          adoptedScene,
          newBaseHash: Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, "0"),
          ).join(""),
          newSessionGeneration: 1,
        };
      }
      return originalInvoke(command, args);
    };
  });
}

async function readHistoryReplaceCalls(
  page: Page,
): Promise<HistoryReplaceCall[]> {
  return page.evaluate(() => {
    const probe = (
      globalThis as typeof globalThis & {
        __historyImportProbe?: { historyReplace: HistoryReplaceCall[] };
      }
    ).__historyImportProbe;
    return probe?.historyReplace ?? [];
  });
}
