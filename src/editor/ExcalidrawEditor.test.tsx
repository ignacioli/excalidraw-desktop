import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initializeBrowserLocaleController } from "../i18n";
import { ExcalidrawEditor } from "./ExcalidrawEditor";

vi.mock("@excalidraw/excalidraw", () => ({
  Excalidraw: ({ langCode }: { langCode?: string }) => (
    <div data-testid="sdk-editor" data-lang-code={langCode} />
  ),
}));

vi.mock("./assetResolver", () => ({
  resolveAssetFiles: vi.fn(async (files: object) => files),
}));

describe("ExcalidrawEditor language", () => {
  it("passes the resolved UI language to the SDK and follows changes", async () => {
    const locale = initializeBrowserLocaleController(["zh-Hans-CN"]);
    act(() => locale.setPreference("system"));

    render(
      <ExcalidrawEditor
        documentId="doc-1"
        initialScene={{ elements: [], appState: {}, files: {} }}
        onSceneChange={() => undefined}
        theme="light"
      />,
    );

    const editor = await screen.findByTestId("sdk-editor");
    expect(editor).toHaveAttribute("data-lang-code", "zh-CN");

    act(() => locale.setPreference("en"));
    expect(editor).toHaveAttribute("data-lang-code", "en");
  });
});
