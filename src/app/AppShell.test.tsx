import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { documentManager } from "../documents/documentStore";
import { AppShell } from "./AppShell";
import { useAppStore } from "./store";
import { initializeBrowserThemeController } from "./theme/themeController";

vi.mock("../editor/ExcalidrawEditor", () => ({
  ExcalidrawEditor: ({
    documentId,
    theme,
  }: {
    documentId: string;
    theme: string;
  }) => (
    <div
      data-testid="excalidraw-editor"
      data-document-id={documentId}
      data-theme={theme}
    />
  ),
}));

vi.mock("@excalidraw/excalidraw", () => ({
  getSceneVersion: (elements: ReadonlyArray<{ version?: number }>) =>
    elements.reduce((total, element) => total + (element.version ?? 0), 0),
  restore: (scene: object) => scene,
  serializeAsJSON: (
    elements: readonly object[],
    appState: object,
    files: object,
  ) =>
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements,
      appState,
      files,
    }),
}));

describe("AppShell", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    documentManager.store.setState({ sessionsById: {} });
    useAppStore.setState({
      tabsById: {},
      tabOrder: [],
      activeTabId: null,
      hasMountedWorkspace: false,
    });
    initializeBrowserThemeController().setModePreference("system");
  });

  it("renders the desktop shell and actionable workspace empty state", async () => {
    const user = userEvent.setup();
    const onCreateDocument = vi.fn();
    const onOpenDocument = vi.fn();
    render(
      <AppShell
        onCreateDocument={onCreateDocument}
        onOpenDocument={onOpenDocument}
      />,
    );

    expect(
      screen.getByRole("navigation", { name: "Open drawings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "Files" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("main", { name: "Drawing canvas" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New drawing" }));
    await user.click(screen.getByRole("button", { name: "Open drawing…" }));
    expect(onCreateDocument).toHaveBeenCalledOnce();
    expect(onOpenDocument).toHaveBeenCalledOnce();
  });

  it("exposes active and dirty tab state without relying on color", async () => {
    const user = userEvent.setup();
    useAppStore.getState().registerTab({ id: "one", title: "One", path: null });
    useAppStore.getState().registerTab({
      id: "two",
      title: "Two",
      path: "/tmp/two.excalidraw",
      isDirty: true,
    });
    render(<AppShell />);

    const firstTab = screen.getByRole("tab", { name: "One" });
    const secondTab = screen.getByRole("tab", {
      name: "Two, unsaved changes",
    });
    expect(secondTab).toHaveAttribute("aria-selected", "true");

    secondTab.focus();
    await user.keyboard("{ArrowLeft}");
    expect(firstTab).toHaveFocus();
    expect(firstTab).toHaveAttribute("aria-selected", "true");
  });

  it("keeps the shell and editor theme in sync and handles the save shortcut", async () => {
    const user = userEvent.setup();
    const controller = initializeBrowserThemeController();
    controller.setModePreference("dark");
    documentManager.store.setState({
      sessionsById: {
        drawing: {
          id: "drawing",
          path: "/tmp/drawing.excalidraw",
          title: "drawing.excalidraw",
          scene: { elements: [], appState: {}, files: {} },
          sceneVersion: 0,
          baseHash: "base",
          saveState: "dirty",
          errorMessage: null,
        },
      },
    });
    useAppStore.getState().registerTab({
      id: "drawing",
      title: "drawing.excalidraw",
      path: "/tmp/drawing.excalidraw",
      isDirty: true,
    });
    const save = vi
      .spyOn(documentManager, "checkpointActive")
      .mockResolvedValue();

    render(<AppShell themeController={controller} />);

    expect(screen.getByTestId("excalidraw-editor")).toHaveAttribute(
      "data-theme",
      "dark",
    );
    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(screen.getByTestId("excalidraw-editor")).toHaveAttribute(
      "data-theme",
      "light",
    );

    await user.keyboard("{Meta>}s{/Meta}");
    expect(save).toHaveBeenCalledWith("manualSave");
  });

  it("reports disk-full failures while preserving the recovery expectation", async () => {
    const user = userEvent.setup();
    documentManager.store.setState({
      sessionsById: {
        drawing: {
          id: "drawing",
          path: "/tmp/drawing.excalidraw",
          title: "drawing.excalidraw",
          scene: { elements: [], appState: {}, files: {} },
          sceneVersion: 0,
          baseHash: "base",
          saveState: "dirty",
          errorMessage: null,
        },
      },
    });
    useAppStore.getState().registerTab({
      id: "drawing",
      title: "drawing.excalidraw",
      path: "/tmp/drawing.excalidraw",
      isDirty: true,
    });
    vi.spyOn(documentManager, "checkpointActive").mockRejectedValue({
      code: "DISK_FULL",
      message: "No space left on device",
      retriable: true,
    });

    render(<AppShell />);
    await user.click(screen.getByRole("button", { name: /^Save/ }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "The disk is full. Your recovery draft is still available.",
    );
  });
});
