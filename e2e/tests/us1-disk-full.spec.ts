import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { runTauriReliabilityScenario } from "../helpers/reliability";
import {
  installBrowserTauriHarness,
  readHarnessDraft,
  readHarnessFile,
} from "./browserTauriHarness";

test("disk-full checkpoint preserves the file and recoverable draft", async () => {
  const testInfo = test.info();
  const run = await runTauriReliabilityScenario("disk-full-checkpoint");

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
    const { evidence } = run;
    expect(evidence.scenario).toBe("disk-full-checkpoint");
    expect(evidence.error).toMatchObject({
      code: "DISK_FULL",
      retriable: true,
    });
    expect(evidence.originalSha256).toBe(evidence.persistedSha256);
    expect(evidence.draftSha256).toBe(evidence.attemptedSha256);
    expect(evidence.draftDirty).toBe(true);
    expect(evidence.openReportsNewerDraft).toBe(true);
    expect(evidence.temporaryFiles).toEqual([]);
    expect(evidence.path.startsWith(`${run.paths.workspace}/`)).toBe(true);

    const persisted = await readFile(evidence.path, "utf8");
    expect(persisted).toBe(evidence.originalSceneJson);
    expect(JSON.parse(persisted)).toEqual(
      JSON.parse(evidence.originalSceneJson),
    );
    expect(persisted).not.toBe(evidence.attemptedSceneJson);
  } finally {
    await run.cleanup();
  }
});

test("disk-full IPC feedback keeps the editor open with its recovery draft", async ({
  page,
}) => {
  await installBrowserTauriHarness(page, undefined, undefined, undefined, 1);
  await page.goto("/");
  await page.getByRole("button", { name: "New drawing" }).click();
  const original = await readHarnessFile(page);

  const canvas = page.locator(".excalidraw__canvas.interactive");
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error("The disk-full canvas was not measurable.");
  }
  await page.getByTitle(/^Rectangle/).click();
  await page.mouse.move(box.x + 500, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 620, box.y + 290, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => sceneHasRectangle(await readHarnessDraft(page)))
    .toBe(true);

  await page.getByRole("button", { name: /^Save/ }).click();
  await expect(page.getByRole("status")).toHaveText(
    "The disk is full. Your recovery draft is still available.",
  );
  await expect(page.locator(".excalidraw-editor")).toBeVisible();
  expect(await readHarnessFile(page)).toBe(original);
  expect(sceneHasRectangle(await readHarnessDraft(page))).toBe(true);
});

function sceneHasRectangle(sceneJson: string | null): boolean {
  if (sceneJson === null) {
    return false;
  }
  const scene = JSON.parse(sceneJson) as {
    elements?: Array<{ type?: string }>;
  };
  return (
    scene.elements?.some((element) => element.type === "rectangle") ?? false
  );
}
