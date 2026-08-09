import { expect, test } from "@playwright/test";
import {
  installBrowserTauriHarness,
  readHarnessDraft,
  readHarnessFile,
} from "./browserTauriHarness";

const OFFICIAL_FIXTURE = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "https://excalidraw.com",
  elements: [
    {
      id: "official-rectangle",
      type: "rectangle",
      x: 120,
      y: 100,
      width: 180,
      height: 100,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "#a5d8ff",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: "a0",
      roundness: { type: 3 },
      seed: 12345,
      version: 1,
      versionNonce: 67890,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
    },
  ],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
});

test("round-trips an official scene through the locked official loader", async ({
  page,
}) => {
  await installBrowserTauriHarness(page, undefined, OFFICIAL_FIXTURE);
  await page.goto("/");
  await page.getByRole("button", { name: "Open drawing…" }).click();
  await expect(page.locator(".excalidraw-editor")).toBeVisible();

  const canvas = page.locator(".excalidraw__canvas.interactive");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) {
    throw new Error("The format-compatibility canvas was not measurable.");
  }
  await page.getByTitle(/^Ellipse/).click();
  await page.mouse.move(box.x + 500, box.y + 260);
  await page.mouse.down();
  await page.mouse.move(box.x + 580, box.y + 330, { steps: 8 });
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

  await expect
    .poll(async () => {
      const saved = await readHarnessFile(page);
      if (saved === null) {
        return false;
      }
      const scene = JSON.parse(saved) as {
        elements?: Array<{ type?: string }>;
      };
      return (
        scene.elements?.some((element) => element.type === "ellipse") ?? false
      );
    })
    .toBe(true);

  const sceneJson = await readHarnessFile(page);
  expect(sceneJson).not.toBeNull();
  const scene: unknown = JSON.parse(sceneJson ?? "null");
  expect(scene).toEqual(
    expect.objectContaining({
      type: "excalidraw",
      version: expect.any(Number),
      elements: expect.any(Array),
    }),
  );

  const officialResult = await page.evaluate(async (serialized) => {
    const { parseWithOfficialLoader } =
      await import("/src/e2e/officialFormatProbe.ts");
    return parseWithOfficialLoader(serialized);
  }, sceneJson ?? "");
  expect(officialResult.elementTypes).toEqual(
    expect.arrayContaining(["rectangle", "ellipse"]),
  );
});
