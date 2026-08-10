import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  exportBytes,
  installExportHarness,
  pngDimensions,
  waitForDrawingFonts,
} from "./us5-exportHarness";

const EXPORT_PATHS = {
  png1xTransparent: "/exports/drawing-1x-transparent.png",
  png2xTransparent: "/exports/drawing-2x-transparent.png",
  png3xTransparent: "/exports/drawing-3x-transparent.png",
  png1xSolid: "/exports/drawing-1x-solid.png",
  png2xSolid: "/exports/drawing-2x-solid.png",
  svg: "/exports/drawing.svg",
};

test("exports deterministic PNGs across scales and backgrounds against fixed baselines", async ({
  page,
}) => {
  await installExportHarness(page, {
    exportPaths: [
      EXPORT_PATHS.png1xTransparent,
      EXPORT_PATHS.png2xTransparent,
      EXPORT_PATHS.png3xTransparent,
      EXPORT_PATHS.png1xSolid,
      EXPORT_PATHS.png2xSolid,
    ],
    openScene: FIXED_EXPORT_SCENE,
  });
  await openFixedDrawing(page);
  const dialog = page.getByRole("dialog", { name: "Export drawing" });
  await page.getByRole("button", { name: "Export…" }).click();
  await expect(dialog).toBeVisible();

  await submitPngExport(dialog, 1, "Transparent");
  await submitPngExport(dialog, 2, "Transparent");
  await submitPngExport(dialog, 3, "Transparent");
  const png1x = await pngDimensions(
    await exportBytes(page, EXPORT_PATHS.png1xTransparent),
  );
  const png2x = await pngDimensions(
    await exportBytes(page, EXPORT_PATHS.png2xTransparent),
  );
  const png3x = await pngDimensions(
    await exportBytes(page, EXPORT_PATHS.png3xTransparent),
  );
  expect(png1x.width).toBeGreaterThan(0);
  expect(png1x.height).toBeGreaterThan(0);
  expect(Math.abs(png2x.width - png1x.width * 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(png2x.height - png1x.height * 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(png3x.width - png1x.width * 3)).toBeLessThanOrEqual(3);
  expect(Math.abs(png3x.height - png1x.height * 3)).toBeLessThanOrEqual(3);
  expect(png2x.width).toBeGreaterThan(png1x.width);
  expect(png3x.width).toBeGreaterThan(png2x.width);

  await submitPngExport(dialog, 1, "Solid");
  const transparentCorner = await cornerPixel(
    page,
    EXPORT_PATHS.png1xTransparent,
  );
  const solidCorner = await cornerPixel(page, EXPORT_PATHS.png1xSolid);
  expect(transparentCorner.alpha).toBe(0);
  expect(solidCorner.alpha).toBe(255);
  expect(solidCorner.rgb).toEqual([255, 255, 255]);

  await submitPngExport(dialog, 2, "Solid");
  await renderExportImage(
    page,
    EXPORT_PATHS.png2xSolid,
    "image/png",
    "#ffffff",
    "export-preview-png",
  );
  await expect(page.locator("#export-preview-png")).toHaveScreenshot(
    "us5-export-png-2x-solid.png",
    {
      animations: "disabled",
      maxDiffPixelRatio: 0.001,
    },
  );
});

test("exports an SVG with embedded WOFF2 fonts and matches its baseline", async ({
  page,
}) => {
  await installExportHarness(page, {
    exportPaths: [EXPORT_PATHS.svg],
    openScene: FIXED_EXPORT_SCENE,
  });
  await openFixedDrawing(page);
  const dialog = page.getByRole("dialog", { name: "Export drawing" });
  await page.getByRole("button", { name: "Export…" }).click();
  await expect(dialog).toBeVisible();

  await dialog.getByRole("radio", { name: "SVG image" }).check();
  await dialog.getByRole("radio", { name: "Transparent" }).check();
  await dialog.getByRole("button", { name: "Export…" }).click();
  await expect(dialog.getByRole("status")).toContainText(
    `Exported to ${EXPORT_PATHS.svg}`,
  );

  const svgMarkup = new TextDecoder().decode(
    await exportBytes(page, EXPORT_PATHS.svg),
  );
  expect(svgMarkup).toContain("<svg");
  expect(svgMarkup).toContain("@font-face");
  expect(svgMarkup).toContain("data:font/woff2");

  const textElements = svgMarkup.match(/<text\b[^>]*>/g) ?? [];
  expect(textElements.length).toBeGreaterThan(0);
  const declaredFamilies = new Set(
    [...svgMarkup.matchAll(/@font-face\s*{[^}]*font-family:\s*([^;]+);/g)].map(
      (match) => normalizeFamily(match[1]),
    ),
  );
  const usedFamilies = new Set(
    [...svgMarkup.matchAll(/font-family:\s*([^;"<]+)/g)].map((match) =>
      normalizeFamily(match[1]),
    ),
  );
  expect(declaredFamilies.size).toBeGreaterThan(0);
  for (const family of usedFamilies) {
    expect(declaredFamilies.has(family), `missing @font-face for ${family}`).toBe(
      true,
    );
  }

  const fontSrcs = [...svgMarkup.matchAll(/url\(([^)]+)\)/g)].map(
    (match) => match[1],
  );
  expect(fontSrcs.length).toBeGreaterThan(0);
  for (const src of fontSrcs) {
    expect(src.startsWith("data:font/woff2")).toBe(true);
  }

  await renderExportImage(
    page,
    EXPORT_PATHS.svg,
    "image/svg+xml",
    "#ffffff",
    "export-preview-svg",
  );
  await expect(page.locator("#export-preview-svg")).toHaveScreenshot(
    "us5-export-svg.png",
    {
      animations: "disabled",
      maxDiffPixelRatio: 0.001,
    },
  );
});

async function openFixedDrawing(page: Page): Promise<void> {
  await page.goto("/");
  await waitForDrawingFonts(page);
  await page.getByRole("button", { name: "Open drawing…" }).click();
  await expect(page.locator(".excalidraw-editor")).toBeVisible();
  await expect(page.getByRole("button", { name: "Export…" })).toBeEnabled();
}

async function submitPngExport(
  dialog: Locator,
  scale: 1 | 2 | 3,
  background: "Transparent" | "Solid",
): Promise<void> {
  await dialog.getByRole("radio", { name: "PNG image" }).check();
  await dialog.getByRole("radio", { name: `${scale}x` }).check();
  await dialog.getByRole("radio", { name: background }).check();
  await dialog.getByRole("button", { name: "Export…" }).click();
  await expect(dialog.getByRole("status")).toContainText("Exported to");
}

async function cornerPixel(
  page: Page,
  targetPath: string,
): Promise<{ alpha: number; rgb: [number, number, number] }> {
  return page.evaluate(async (target) => {
    const windowWithExports = globalThis as unknown as {
      __exportCalls: Array<{
        targetPath: string;
        bytes: number[];
      }>;
    };
    const capture = windowWithExports.__exportCalls.find(
      (call) => call.targetPath === target,
    );
    if (capture === undefined) {
      throw new Error(`No export captured for ${target}`);
    }
    const image = new Image();
    image.src = URL.createObjectURL(
      new Blob([Uint8Array.from(capture.bytes)], { type: "image/png" }),
    );
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("Canvas 2D context is unavailable");
    }
    context.drawImage(image, 0, 0);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    return {
      alpha: pixel[3],
      rgb: [pixel[0], pixel[1], pixel[2]] as [number, number, number],
    };
  }, targetPath);
}

async function renderExportImage(
  page: Page,
  targetPath: string,
  type: string,
  backdrop: string,
  elementId: string,
): Promise<void> {
  await page.evaluate(
    async ({ target, mimeType, background, id }) => {
      const windowWithExports = globalThis as unknown as {
        __exportCalls: Array<{
          targetPath: string;
          bytes: number[];
        }>;
      };
      const capture = windowWithExports.__exportCalls.find(
        (call) => call.targetPath === target,
      );
      if (capture === undefined) {
        throw new Error(`No export captured for ${target}`);
      }
      const image = document.createElement("img");
      image.id = id;
      image.src = URL.createObjectURL(
        new Blob([Uint8Array.from(capture.bytes)], { type: mimeType }),
      );
      image.style.background = background;
      image.style.display = "block";
      await image.decode();
      document.body.append(image);
    },
    {
      target: targetPath,
      mimeType: type,
      background: backdrop,
      id: elementId,
    },
  );
  await expect(page.locator(`#${elementId}`)).toBeVisible();
}

function normalizeFamily(value: string): string {
  return value.trim().replace(/^"|"$/g, "");
}

const FIXED_EXPORT_SCENE: Record<string, unknown> = {
  type: "excalidraw",
  version: 2,
  source: "excalidraw-desktop-e2e-us5",
  elements: [
    {
      id: "export-rectangle",
      type: "rectangle",
      x: 100,
      y: 80,
      width: 220,
      height: 160,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "hachure",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 3 },
      seed: 111111,
      version: 1,
      versionNonce: 111111,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
    },
    {
      id: "export-text",
      type: "text",
      x: 360,
      y: 120,
      width: 210,
      height: 28,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 222222,
      version: 1,
      versionNonce: 222222,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      fontSize: 20,
      fontFamily: 1,
      text: "中英混排 Export",
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      originalText: "中英混排 Export",
      autoResize: true,
      lineHeight: 1.25,
    },
  ],
  appState: {},
  files: {},
};
