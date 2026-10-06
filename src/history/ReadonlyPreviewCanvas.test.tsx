import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "../editor/sceneSerializer";
import { ReadonlyPreviewCanvas } from "./ReadonlyPreviewCanvas";

const { exportToSvg } = vi.hoisted(() => ({ exportToSvg: vi.fn() }));

vi.mock("@excalidraw/excalidraw", () => ({ exportToSvg }));

describe("ReadonlyPreviewCanvas", () => {
  beforeEach(() => {
    exportToSvg.mockReset();
    exportToSvg.mockImplementation(async () => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 120 100");
      return svg;
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:history-preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });

  it("renders a static read-only image without mounting an interactive SDK editor", async () => {
    const onRendered = vi.fn();
    const source = scene();

    const view = render(
      <ReadonlyPreviewCanvas
        onRendered={onRendered}
        scene={source}
        theme="dark"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Preparing version preview",
    );
    const image = await screen.findByRole("img", {
      name: "Read-only version canvas",
    });
    expect(image).toHaveAttribute("src", "blob:history-preview");
    expect(view.container.querySelector(".excalidraw")).not.toBeInTheDocument();
    expect(view.container.querySelector("[role=menu]")).not.toBeInTheDocument();
    expect(exportToSvg).toHaveBeenCalledWith(
      expect.objectContaining({
        elements: source.elements,
        appState: expect.objectContaining({ theme: "dark" }),
        files: {},
        renderEmbeddables: false,
        exportPadding: 0,
      }),
    );

    fireEvent.load(image);
    await waitFor(() => expect(onRendered).toHaveBeenCalledTimes(1));
    expect(image.parentElement).toHaveAttribute(
      "data-preview-rendered",
      "true",
    );
  });

  it("ignores a stale preparation when the selected version changes", async () => {
    const onRendered = vi.fn();
    const first = scene();
    const second: SceneSnapshot = { ...scene(), elements: [] };
    const view = render(
      <ReadonlyPreviewCanvas
        onRendered={onRendered}
        scene={first}
        theme="light"
      />,
    );

    view.rerender(
      <ReadonlyPreviewCanvas
        onRendered={onRendered}
        scene={second}
        theme="light"
      />,
    );

    const image = await screen.findByRole("img", {
      name: "Read-only version canvas",
    });
    fireEvent.load(image);
    await waitFor(() => expect(onRendered).toHaveBeenCalledTimes(1));
    expect(exportToSvg).toHaveBeenLastCalledWith(
      expect.objectContaining({ elements: second.elements }),
    );
  });

  it("fails closed when an asset cannot be hydrated", async () => {
    const onError = vi.fn();
    const invalid: SceneSnapshot = {
      ...scene(),
      files: {
        "broken-file": {
          id: "broken-file" as BinaryFileData["id"],
          mimeType: "image/png",
          dataURL:
            "data:image/png;base64,not-valid-base64!!!" as BinaryFileData["dataURL"],
          created: 1,
        },
      },
    };

    render(
      <ReadonlyPreviewCanvas onError={onError} scene={invalid} theme="light" />,
    );

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This version could not be rendered safely",
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(exportToSvg).not.toHaveBeenCalled();
  });

  it("reports export failures without leaving a partial preview", async () => {
    const onError = vi.fn();
    const error = new Error("export failed");
    exportToSvg.mockRejectedValueOnce(error);

    render(
      <ReadonlyPreviewCanvas onError={onError} scene={scene()} theme="light" />,
    );

    await waitFor(() => expect(onError).toHaveBeenCalledWith(error));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This version could not be rendered safely",
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});

function scene(): SceneSnapshot {
  return {
    elements: [
      {
        type: "rectangle",
        id: "history-rectangle",
        x: 10,
        y: 10,
        width: 100,
        height: 80,
        isDeleted: false,
      } as ExcalidrawElement,
    ],
    appState: {},
    files: {},
  };
}
