import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../App.css";
import {
  documentManager,
  type DocumentSaveState,
  type DocumentSession,
} from "../documents/documentStore";
import { AppShell } from "./AppShell";
import {
  SHELL_PREFERENCES_STORAGE_KEY,
  SHELL_PREFERENCES_VERSION,
} from "./shellPreferences";
import { useAppStore } from "./store";
import { initializeBrowserThemeController } from "./theme/themeController";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(async () => "/tmp/rescued.excalidraw"),
  open: vi.fn(async () => null),
}));

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
    documentManager.store.setState({
      sessionsById: {},
      tabOrder: [],
      activeDocumentId: null,
    });
    useAppStore.setState({ hasMountedWorkspace: false });
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
      screen.getByRole("main", { name: "Drawing canvas" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: "Files" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /workspace sidebar/i }),
    );
    expect(
      screen.getByRole("complementary", { name: "Files" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New drawing" }));
    await user.click(screen.getByRole("button", { name: "Open drawing…" }));
    expect(onCreateDocument).toHaveBeenCalledOnce();
    expect(onOpenDocument).toHaveBeenCalledOnce();
  });

  it("exposes active and dirty tab state without relying on color", async () => {
    const user = userEvent.setup();
    setDocumentSessions([
      createSession("one", "One", "/tmp/one.excalidraw", "clean"),
      createSession("two", "Two", "/tmp/two.excalidraw", "orphaned"),
    ]);
    render(<AppShell />);

    const firstTab = screen.getByRole("tab", { name: "One" });
    const secondTab = screen.getByRole("tab", {
      name: "Two, unsaved changes, file unavailable",
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
          revision: 0,
          baseHash: "base",
          saveState: "dirty",
          errorMessage: null,
          conflictInfo: null,
          lastReloadedAt: null,
        },
      },
      tabOrder: ["drawing"],
      activeDocumentId: "drawing",
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

  it("keeps each document editor mounted when switching tabs", async () => {
    const user = userEvent.setup();
    documentManager.store.setState({
      sessionsById: {
        first: {
          id: "first",
          path: "/tmp/first.excalidraw",
          title: "first.excalidraw",
          scene: { elements: [], appState: {}, files: {} },
          sceneVersion: 0,
          revision: 0,
          baseHash: "first-base",
          saveState: "clean",
          errorMessage: null,
          conflictInfo: null,
          lastReloadedAt: null,
        },
        second: {
          id: "second",
          path: "/tmp/second.excalidraw",
          title: "second.excalidraw",
          scene: { elements: [], appState: {}, files: {} },
          sceneVersion: 0,
          revision: 0,
          baseHash: "second-base",
          saveState: "clean",
          errorMessage: null,
          conflictInfo: null,
          lastReloadedAt: null,
        },
      },
      tabOrder: ["first", "second"],
      activeDocumentId: "second",
    });

    render(<AppShell />);
    expect(screen.getAllByTestId("excalidraw-editor")).toHaveLength(2);

    await user.click(screen.getByRole("tab", { name: "first.excalidraw" }));

    const editors = screen.getAllByTestId("excalidraw-editor");
    const firstEditor = editors.find(
      (editor) => editor.getAttribute("data-document-id") === "first",
    );
    const secondEditor = editors.find(
      (editor) => editor.getAttribute("data-document-id") === "second",
    );
    expect(firstEditor?.closest("section")).not.toHaveAttribute("hidden");
    expect(secondEditor?.closest("section")).toHaveAttribute("hidden");
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
          revision: 0,
          baseHash: "base",
          saveState: "dirty",
          errorMessage: null,
          conflictInfo: null,
          lastReloadedAt: null,
        },
      },
      tabOrder: ["drawing"],
      activeDocumentId: "drawing",
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

  it("opens the next orphan dialog after discarding the first batch orphan", async () => {
    const user = userEvent.setup();
    setDocumentSessions([
      createSession("keep", "Keep", "/tmp/keep.excalidraw", "clean"),
      createSession("gone-a", "Gone A", "/tmp/gone-a.excalidraw", "orphaned"),
      createSession("gone-b", "Gone B", "/tmp/gone-b.excalidraw", "orphaned"),
    ]);
    vi.spyOn(documentManager, "close").mockImplementation(
      async (documentId) => {
        if (documentId === "gone-a" || documentId === "gone-b") {
          return { status: "orphaned", documentId };
        }
        return { status: "closed" };
      },
    );
    vi.spyOn(documentManager, "confirmOrphanClose").mockImplementation(
      async (documentId, decision) => {
        if (decision === "discard" && documentId === "gone-a") {
          return { status: "orphaned", documentId: "gone-b" };
        }
        return { status: "cancelled" };
      },
    );

    render(<AppShell />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Keep" }));
    await user.click(screen.getByRole("menuitem", { name: "Close Others" }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toHaveTextContent("Gone A");
    });
    await user.click(
      screen.getByRole("button", { name: "Close Without Saving" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toHaveTextContent("Gone B");
    });
  });

  it("keeps the orphan dialog open and reports a failed Save As", async () => {
    const user = userEvent.setup();
    setDocumentSessions([
      createSession("keep", "Keep", "/tmp/keep.excalidraw", "clean"),
      createSession("gone", "Gone", "/tmp/gone.excalidraw", "orphaned"),
    ]);
    vi.spyOn(documentManager, "close").mockResolvedValue({
      status: "orphaned",
      documentId: "gone",
    });
    vi.spyOn(documentManager, "confirmOrphanClose").mockResolvedValue({
      status: "failed",
      documentId: "gone",
      message: "The drawing could not be saved.",
    });

    render(<AppShell />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: "Keep" }));
    await user.click(screen.getByRole("menuitem", { name: "Close Others" }));
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toHaveTextContent("Gone");
    });
    await user.click(screen.getByRole("button", { name: "Save As" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "The drawing could not be saved.",
      );
    });
    expect(screen.getByRole("dialog")).toHaveTextContent("Gone");
  });

  describe("canvas-first workspace sidebar", () => {
    const testLocalStorage = new Map<string, string>();

    beforeEach(() => {
      testLocalStorage.clear();
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: {
          getItem: (key: string) => testLocalStorage.get(key) ?? null,
          setItem: (key: string, value: string) =>
            testLocalStorage.set(key, value),
          removeItem: (key: string) => {
            testLocalStorage.delete(key);
          },
          clear: () => testLocalStorage.clear(),
        },
      });
    });

    afterEach(() => {
      testLocalStorage.clear();
    });

    it("hides the Files sidebar on first launch and exposes an accessible open control", () => {
      render(<AppShell />);

      const body = getShellBody();
      expect(body).toHaveAttribute("data-sidebar-mode", "hidden");
      expect(
        screen.queryByRole("complementary", { name: "Files" }),
      ).not.toBeInTheDocument();
      expect(document.getElementById("workspace-sidebar")).toHaveAttribute(
        "hidden",
      );
      expect(
        screen.getByRole("main", { name: "Drawing canvas" }),
      ).toBeInTheDocument();

      const openControl = getWorkspaceSidebarOpenControl();
      expect(openControl).toBeEnabled();
      expect(openControl).toHaveAttribute("aria-expanded", "false");
      assertNoRightSidebar();
      assertRetainedChrome();
    });

    it("places a pinned sidebar in layout and keeps the canvas as the remaining column", () => {
      seedShellPreferences({ sidebarPinned: true });
      render(<AppShell />);

      const body = getShellBody();
      expect(body).toHaveAttribute("data-sidebar-mode", "pinned");
      expect(body).toHaveClass("app-shell-body--pinned");
      expect(
        screen.getByRole("complementary", { name: "Files" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("main", { name: "Drawing canvas" }),
      ).toBeInTheDocument();

      const sidebar = screen.getByRole("complementary", { name: "Files" });
      expect(["fixed", "absolute"]).not.toContain(
        getComputedStyle(sidebar).position,
      );
      assertPinnedCanvasContract(body);
      assertNoRightSidebar();
      assertRetainedChrome();
    });

    it("opens an overlay sidebar without changing the canvas content box", async () => {
      const user = userEvent.setup();
      render(<AppShell />);

      const canvas = screen.getByRole("main", { name: "Drawing canvas" });
      const widthBefore = canvas.getBoundingClientRect().width;

      await user.click(getWorkspaceSidebarOpenControl());

      const body = getShellBody();
      expect(body).toHaveAttribute("data-sidebar-mode", "overlay");
      expect(body).not.toHaveClass("app-shell-body--pinned");

      const sidebar = screen.getByRole("complementary", { name: "Files" });
      expect(["fixed", "absolute"]).toContain(
        getComputedStyle(sidebar).position,
      );

      const widthAfter = canvas.getBoundingClientRect().width;
      if (widthBefore > 0 || widthAfter > 0) {
        expect(widthAfter).toBe(widthBefore);
      }

      const inFlowColumns = [...body.children].filter((child) => {
        const position = getComputedStyle(child).position;
        return position !== "fixed" && position !== "absolute";
      });
      expect(inFlowColumns).toHaveLength(1);
      expect(inFlowColumns[0]).toHaveClass("canvas-region");
      assertNoRightSidebar();
      assertRetainedChrome();
    });

    it("keeps Save, Export…, Save as…, save status, and Appearance operable", async () => {
      const user = userEvent.setup();
      setDocumentSessions([
        createSession(
          "drawing",
          "drawing.excalidraw",
          "/tmp/missing.excalidraw",
          "orphaned",
        ),
      ]);
      const first = render(<AppShell />);
      expect(getShellBody()).toHaveAttribute("data-sidebar-mode", "hidden");
      assertRetainedChrome({ includeSaveAs: true });
      await user.click(screen.getByRole("radio", { name: "Dark" }));
      expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();

      await user.click(getWorkspaceSidebarOpenControl());
      expect(getShellBody()).toHaveAttribute("data-sidebar-mode", "overlay");
      assertRetainedChrome({ includeSaveAs: true });

      first.unmount();
      seedShellPreferences({ sidebarPinned: true });
      render(<AppShell />);
      expect(getShellBody()).toHaveAttribute("data-sidebar-mode", "pinned");
      assertRetainedChrome({ includeSaveAs: true });
    });

    it("does not hide overlay when Escape was already handled", async () => {
      const user = userEvent.setup();
      render(<AppShell />);
      await user.click(getWorkspaceSidebarOpenControl());
      expect(getShellBody()).toHaveAttribute("data-sidebar-mode", "overlay");

      const ignored = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      ignored.preventDefault();
      window.dispatchEvent(ignored);
      expect(getShellBody()).toHaveAttribute("data-sidebar-mode", "overlay");

      await user.keyboard("{Escape}");
      expect(getShellBody()).toHaveAttribute("data-sidebar-mode", "hidden");
    });

    it("does not render an empty right sidebar", () => {
      render(<AppShell />);

      expect(getShellBody()).toHaveAttribute("data-sidebar-mode", "hidden");
      assertNoRightSidebar();

      const inFlowColumns = [...getShellBody().children].filter((child) => {
        if (child instanceof HTMLElement && child.hidden) return false;
        const position = getComputedStyle(child).position;
        return position !== "fixed" && position !== "absolute";
      });
      expect(inFlowColumns).toHaveLength(1);
      expect(inFlowColumns[0]).toHaveClass("canvas-region");
    });
  });
});

function createSession(
  id: string,
  title: string,
  path: string,
  saveState: DocumentSaveState,
): DocumentSession {
  return {
    id,
    title,
    path,
    scene: { elements: [], appState: {}, files: {} },
    sceneVersion: 0,
    revision: 0,
    baseHash: `${id}-base`,
    saveState,
    errorMessage: null,
    conflictInfo: null,
    lastReloadedAt: null,
  };
}

function setDocumentSessions(sessions: readonly DocumentSession[]): void {
  const tabOrder = sessions.map((session) => session.id);
  documentManager.store.setState({
    sessionsById: Object.fromEntries(
      sessions.map((session) => [session.id, session]),
    ),
    tabOrder,
    activeDocumentId: tabOrder.at(-1) ?? null,
  });
}

function seedShellPreferences(snapshot: { sidebarPinned: boolean }): void {
  globalThis.localStorage.setItem(
    SHELL_PREFERENCES_STORAGE_KEY,
    JSON.stringify({
      version: SHELL_PREFERENCES_VERSION,
      sidebarPinned: snapshot.sidebarPinned,
      expandedWorkspaceIds: [],
    }),
  );
}

function getShellBody(): HTMLElement {
  const body = document.querySelector(".app-shell-body");
  expect(body).toBeInstanceOf(HTMLElement);
  return body as HTMLElement;
}

function getWorkspaceSidebarOpenControl(): HTMLElement {
  return screen.getByRole("button", { name: /workspace sidebar/i });
}

function assertRetainedChrome(options?: { includeSaveAs?: boolean }): void {
  expect(screen.getByRole("button", { name: /^Save$/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export…" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Appearance" })).toBeInTheDocument();
  if (options?.includeSaveAs === true) {
    expect(
      screen.getByRole("button", { name: "Save as…" }),
    ).toBeInTheDocument();
  }
}

function assertNoRightSidebar(): void {
  expect(
    document.querySelector(
      ".right-sidebar, [data-sidebar-slot='right'], aside:not(.file-sidebar)",
    ),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("complementary", { name: /library/i }),
  ).not.toBeInTheDocument();
}

function assertPinnedCanvasContract(body: HTMLElement): void {
  expect(body).toHaveClass("app-shell-body--pinned");
  const canvas = screen.getByRole("main", { name: "Drawing canvas" });
  const canvasWidth = canvas.getBoundingClientRect().width;
  const bodyWidth = body.getBoundingClientRect().width;
  if (bodyWidth > 0) {
    expect(canvasWidth / bodyWidth).toBeGreaterThanOrEqual(0.7);
  }
  const template = getComputedStyle(body).gridTemplateColumns;
  if (template.length > 0 && template !== "none") {
    expect(template).toMatch(/minmax\(\s*0\s*,\s*1fr\s*\)/);
  }
}
