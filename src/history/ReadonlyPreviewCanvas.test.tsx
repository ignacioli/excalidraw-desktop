import { render, screen, waitFor } from "@testing-library/react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import { describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "../editor/sceneSerializer";
import { ReadonlyPreviewCanvas } from "./ReadonlyPreviewCanvas";

vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: (props: {
    initialData: { appState?: { viewModeEnabled?: boolean } };
    viewModeEnabled?: boolean;
    onChange?: unknown;
    excalidrawAPI?: (api: ExcalidrawImperativeAPI) => void;
    UIOptions?: {
      canvasActions?: Record<string, unknown>;
      tools?: Record<string, unknown>;
    };
  }) => {
    props.excalidrawAPI?.({} as ExcalidrawImperativeAPI);
    return (
      <div
        data-testid="readonly-excalidraw"
        data-clear={String(props.UIOptions?.canvasActions?.clearCanvas)}
        data-export={String(props.UIOptions?.canvasActions?.export)}
        data-load={String(props.UIOptions?.canvasActions?.loadScene)}
        data-on-change={String(props.onChange !== undefined)}
        data-save={String(props.UIOptions?.canvasActions?.saveToActiveFile)}
        data-view-mode={String(
          props.viewModeEnabled && props.initialData.appState?.viewModeEnabled,
        )}
      />
    );
  },
}));

describe("ReadonlyPreviewCanvas", () => {
  it("hydrates assets before mounting a separate read-only Excalidraw instance", async () => {
    const onRendered = vi.fn();

    render(
      <ReadonlyPreviewCanvas
        onRendered={onRendered}
        scene={scene()}
        theme="light"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Preparing version preview",
    );
    await waitFor(() =>
      expect(screen.getByTestId("readonly-excalidraw")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("readonly-excalidraw")).toHaveAttribute(
      "data-view-mode",
      "true",
    );
    expect(screen.getByTestId("readonly-excalidraw")).toHaveAttribute(
      "data-on-change",
      "false",
    );
    expect(screen.getByTestId("readonly-excalidraw")).toHaveAttribute(
      "data-clear",
      "false",
    );
    expect(screen.getByTestId("readonly-excalidraw")).toHaveAttribute(
      "data-export",
      "false",
    );
    expect(screen.getByTestId("readonly-excalidraw")).toHaveAttribute(
      "data-load",
      "false",
    );
    expect(screen.getByTestId("readonly-excalidraw")).toHaveAttribute(
      "data-save",
      "false",
    );
    await waitFor(() => expect(onRendered).toHaveBeenCalled());
    expect(
      screen.getByTestId("readonly-excalidraw").parentElement,
    ).toHaveAttribute("data-preview-rendered", "true");
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

    await waitFor(() =>
      expect(screen.getByTestId("readonly-excalidraw")).toBeInTheDocument(),
    );
    await waitFor(() => expect(onRendered).toHaveBeenCalledTimes(1));
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
    expect(screen.queryByTestId("readonly-excalidraw")).not.toBeInTheDocument();
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
      } as SceneSnapshot["elements"][number],
    ],
    appState: {},
    files: {},
  };
}
