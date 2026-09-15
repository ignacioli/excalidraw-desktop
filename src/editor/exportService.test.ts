import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "./sceneSerializer";
import { exportToSvg } from "./exportService";

const { exportSceneToSvg } = vi.hoisted(() => ({
  exportSceneToSvg: vi.fn(),
}));

vi.mock("@excalidraw/excalidraw", () => ({
  exportToBlob: vi.fn(),
  exportToSvg: exportSceneToSvg,
}));

describe("exportToSvg", () => {
  beforeEach(() => {
    exportSceneToSvg.mockReset();
  });

  it("does not require an embedded font when the SVG renders no text", async () => {
    exportSceneToSvg.mockResolvedValue(
      svgElement('<rect width="10" height="10" />'),
    );

    const blob = await exportToSvg(sceneWithDeletedText(), {
      background: "transparent",
      scale: 1,
      theme: "light",
    });

    await expect(blob.text()).resolves.toContain("<rect");
  });

  it("still rejects rendered text when its font was not embedded", async () => {
    exportSceneToSvg.mockResolvedValue(svgElement("<text>Visible</text>"));

    await expect(
      exportToSvg(emptyScene(), {
        background: "transparent",
        scale: 1,
        theme: "light",
      }),
    ).rejects.toThrow("did not embed the drawing fonts");
  });
});

function svgElement(contents: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.innerHTML = contents;
  return svg;
}

function emptyScene(): SceneSnapshot {
  return {
    elements: [],
    appState: {},
    files: {},
  };
}

function sceneWithDeletedText(): SceneSnapshot {
  return {
    ...emptyScene(),
    elements: [
      {
        type: "text",
        isDeleted: true,
      } as SceneSnapshot["elements"][number],
    ],
  };
}
