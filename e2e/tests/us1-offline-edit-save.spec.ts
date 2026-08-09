import { expect, test } from "@playwright/test";
import {
  installBrowserTauriHarness,
  readHarnessDraft,
  readHarnessFile,
} from "./browserTauriHarness";

test("creates, checkpoints, and reopens a drawing with every asset local", async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") {
      externalRequests.push(request.url());
    }
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "127.0.0.1") {
      await route.abort("internetdisconnected");
      return;
    }
    await route.continue();
  });
  await installBrowserTauriHarness(page);
  await page.goto("/");

  await page.getByRole("button", { name: "New drawing" }).click();
  await expect(
    page.getByRole("tab", { name: "us1-drawing.excalidraw" }),
  ).toBeVisible();
  await expect(page.locator(".excalidraw-editor")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Save/ })).toBeEnabled();
  await expect(page.getByRole("status")).toHaveText("All changes saved");

  const canvas = page.locator(".excalidraw__canvas.interactive");
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  if (canvasBox === null) {
    throw new Error("The Excalidraw canvas did not expose a bounding box.");
  }

  await page.getByTitle(/^Rectangle/).click();
  await page.mouse.move(canvasBox.x + 400, canvasBox.y + 140);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 560, canvasBox.y + 250, { steps: 10 });
  await page.mouse.up();

  await page.keyboard.press("8");
  await page.mouse.click(canvasBox.x + 650, canvasBox.y + 210);
  await page.keyboard.type("中文离线绘图");
  await page.keyboard.press("Meta+Enter");

  await page.evaluate((encodedPng) => {
    const bytes = Uint8Array.from(atob(encodedPng), (character) =>
      character.charCodeAt(0),
    );
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([bytes], "offline-pixel.png", { type: "image/png" }),
    );
    document.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }),
    );
  }, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3OQAAAAASUVORK5CYII=");

  await expect
    .poll(async () => {
      const draft = await readHarnessDraft(page);
      if (draft === null) {
        return 0;
      }
      const scene = JSON.parse(draft) as { files?: Record<string, unknown> };
      return Object.keys(scene.files ?? {}).length;
    })
    .toBe(1);

  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(page.getByRole("status")).toHaveText("All changes saved");
  const savedScene = JSON.parse((await readHarnessFile(page)) ?? "null") as {
    elements?: Array<{ type?: string; text?: string }>;
    files?: Record<string, unknown>;
  } | null;
  expect(savedScene?.elements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "rectangle" }),
      expect.objectContaining({ type: "text", text: "中文离线绘图" }),
      expect.objectContaining({ type: "image" }),
    ]),
  );
  expect(Object.keys(savedScene?.files ?? {})).toHaveLength(1);

  await page.reload();
  await page.getByRole("button", { name: "Open drawing…" }).click();
  await expect(
    page.getByRole("tab", { name: "us1-drawing.excalidraw" }),
  ).toBeVisible();
  await expect(page.locator(".excalidraw-editor")).toBeVisible();

  const reopenedCanvas = page.locator(".excalidraw__canvas.interactive");
  const reopenedBox = await reopenedCanvas.boundingBox();
  expect(reopenedBox).not.toBeNull();
  if (reopenedBox === null) {
    throw new Error("The reopened Excalidraw canvas was not measurable.");
  }
  await page.getByTitle(/^Ellipse/).click();
  await page.mouse.move(reopenedBox.x + 500, reopenedBox.y + 360);
  await page.mouse.down();
  await page.mouse.move(reopenedBox.x + 580, reopenedBox.y + 430, {
    steps: 8,
  });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const draft = await readHarnessDraft(page);
      if (draft === null) {
        return false;
      }
      const scene = JSON.parse(draft) as {
        elements?: Array<{ type?: string }>;
      };
      return (
        scene.elements?.some((element) => element.type === "ellipse") ?? false
      );
    })
    .toBe(true);
  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(page.getByRole("status")).toHaveText("All changes saved");

  const reopenedScene = JSON.parse((await readHarnessFile(page)) ?? "null") as {
    elements?: Array<{ type?: string; text?: string }>;
    files?: Record<string, unknown>;
  } | null;
  expect(reopenedScene?.elements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "rectangle" }),
      expect.objectContaining({ type: "text", text: "中文离线绘图" }),
      expect.objectContaining({ type: "image" }),
      expect.objectContaining({ type: "ellipse" }),
    ]),
  );
  expect(Object.keys(reopenedScene?.files ?? {})).toHaveLength(1);
  expect(externalRequests).toEqual([]);
});
