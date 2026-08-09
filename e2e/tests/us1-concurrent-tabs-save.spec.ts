import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { runTauriReliabilityScenario } from "../helpers/reliability";
import {
  installBrowserTauriHarness,
  readHarnessDraft,
  readHarnessFile,
} from "./browserTauriHarness";

test("two concurrent document checkpoints remain independent", async () => {
  const testInfo = test.info();
  const run = await runTauriReliabilityScenario("concurrent-checkpoints");

  try {
    await testInfo.attach("native-reliability-evidence", {
      body: Buffer.from(
        JSON.stringify(
          { environment: run.environment, evidence: run.evidence },
          null,
          2,
        ),
      ),
      contentType: "application/json",
    });
    expect(run.evidence.scenario).toBe("concurrent-checkpoints");
    expect(run.evidence.concurrentBarrierReached).toBe(true);
    expect(run.evidence.checkpoints).toHaveLength(2);

    const [first, second] = run.evidence.checkpoints;
    expect(first.path).not.toBe(second.path);
    expect(first.expectedSha256).not.toBe(second.expectedSha256);

    for (const checkpoint of run.evidence.checkpoints) {
      expect(checkpoint.path.startsWith(`${run.paths.workspace}/`)).toBe(true);
      expect(checkpoint.returnedBaseHash).toBe(checkpoint.expectedSha256);
      expect(checkpoint.persistedSha256).toBe(checkpoint.expectedSha256);
      expect(checkpoint.draftSha256).toBe(checkpoint.expectedSha256);
      expect(checkpoint.draftDirty).toBe(false);
      expect(checkpoint.temporaryFiles).toEqual([]);

      const persisted = await readFile(checkpoint.path, "utf8");
      expect(persisted).toBe(checkpoint.expectedSceneJson);
      expect(JSON.parse(persisted)).toEqual(
        JSON.parse(checkpoint.expectedSceneJson),
      );
    }

    expect(first.expectedSceneJson).not.toContain("document-b");
    expect(second.expectedSceneJson).not.toContain("document-a");
  } finally {
    await run.cleanup();
  }
});

test("two visible tabs checkpoint independently without blocking the shell", async ({
  page,
}) => {
  const firstPath = "/virtual/first.excalidraw";
  const secondPath = "/virtual/second.excalidraw";
  await installBrowserTauriHarness(page, firstPath, undefined, [
    firstPath,
    secondPath,
  ]);
  await page.goto("/");

  await page.getByRole("button", { name: "New drawing" }).click();
  await expect(
    page.getByRole("tab", { name: "first.excalidraw" }),
  ).toBeVisible();
  let canvas = page.locator(".excalidraw__canvas.interactive");
  let box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("The first tab canvas was not measurable.");
  }
  await page.getByTitle(/^Rectangle/).click();
  await page.mouse.move(box.x + 500, box.y + 180);
  await page.mouse.down();
  await page.mouse.move(box.x + 620, box.y + 260, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () =>
      sceneHasElement(await readHarnessDraft(page, firstPath), "rectangle"),
    )
    .toBe(true);

  await page.getByRole("button", { name: "New drawing" }).click();
  await expect(
    page.getByRole("tab", { name: "second.excalidraw" }),
  ).toBeVisible();
  await expect
    .poll(async () =>
      sceneHasElement(await readHarnessFile(page, firstPath), "rectangle"),
    )
    .toBe(true);

  canvas = page.locator(".excalidraw__canvas.interactive");
  box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("The second tab canvas was not measurable.");
  }
  await page.getByTitle(/^Ellipse/).click();
  await page.mouse.move(box.x + 500, box.y + 320);
  await page.mouse.down();
  await page.mouse.move(box.x + 600, box.y + 390, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () =>
      sceneHasElement(await readHarnessDraft(page, secondPath), "ellipse"),
    )
    .toBe(true);

  await page.getByRole("tab", { name: "first.excalidraw" }).click();
  await expect(
    page.getByRole("tab", { name: "first.excalidraw" }),
  ).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(async () =>
      sceneHasElement(await readHarnessFile(page, secondPath), "ellipse"),
    )
    .toBe(true);

  expect(sceneElementTypes(await readHarnessFile(page, firstPath))).toEqual([
    "rectangle",
  ]);
  expect(sceneElementTypes(await readHarnessFile(page, secondPath))).toEqual([
    "ellipse",
  ]);
});

function sceneHasElement(sceneJson: string | null, type: string): boolean {
  return sceneElementTypes(sceneJson).includes(type);
}

function sceneElementTypes(sceneJson: string | null): string[] {
  if (sceneJson === null) {
    return [];
  }
  const scene = JSON.parse(sceneJson) as {
    elements?: Array<{ type?: string }>;
  };
  return (scene.elements ?? []).flatMap((element) =>
    typeof element.type === "string" ? [element.type] : [],
  );
}
