import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../App.css";
import {
  documentManager,
  type DocumentSaveState,
  type DocumentSession,
} from "../documents/documentStore";
import type { CommandInvoker } from "../ipc/client";
import { AppShell } from "./AppShell";
import {
  SHELL_PREFERENCES_STORAGE_KEY,
  SHELL_PREFERENCES_VERSION,
} from "./shellPreferences";
import { useAppStore } from "./store";
import { initializeBrowserThemeController } from "./theme/themeController";

const nativeMenuHarness = vi.hoisted(() => ({
  handler: undefined as
    | ((
        command:
          | "save"
          | "exportImage"
          | "appearanceSystem"
          | "appearanceLight"
          | "appearanceDark",
      ) => void)
    | undefined,
  cleanup: vi.fn(),
}));
const nativeRuntimeHarness = vi.hoisted(() => ({ enabled: false }));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(async () => "/tmp/rescued.excalidraw"),
  open: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
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

vi.mock("../ipc/events", () => ({
  defaultEventListener: vi.fn(async () => () => undefined),
}));

vi.mock("../documents/RecoveryStartup", () => ({
  RecoveryStartup: () => null,
}));

vi.mock("./openFileHandler", () => ({
  registerOpenFileHandler: vi.fn(async () => () => undefined),
}));

vi.mock("./exitCheckpoint", async () => {
  const actual =
    await vi.importActual<typeof import("./exitCheckpoint")>(
      "./exitCheckpoint",
    );
  return {
    ...actual,
    hasNativeWindowRuntime: () => nativeRuntimeHarness.enabled,
    registerExitCheckpoint: vi.fn(async () => () => undefined),
  };
});

vi.mock("./nativeMenu", async () => {
  const actual =
    await vi.importActual<typeof import("./nativeMenu")>("./nativeMenu");
  return {
    ...actual,
    registerNativeMenuCommand: vi.fn(async (handler) => {
      nativeMenuHarness.handler = handler;
      return nativeMenuHarness.cleanup;
    }),
  };
});

describe("AppShell", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(invoke).mockResolvedValue([]);
    documentManager.store.setState({
      sessionsById: {},
      tabOrder: [],
      activeDocumentId: null,
    });
    useAppStore.setState({ hasMountedWorkspace: false });
    initializeBrowserThemeController().setModePreference("system");
    nativeRuntimeHarness.enabled = false;
    nativeMenuHarness.handler = undefined;
    nativeMenuHarness.cleanup.mockReset();
  });

  it("renders the desktop shell and actionable workspace empty state", async () => {
    const user = userEvent.setup();
    const onCreateDocument = vi.fn();
    render(<AppShell onCreateDocument={onCreateDocument} />);

    expect(
      screen.getByRole("navigation", { name: "Open drawings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("main", { name: "Drawing canvas" }),
    ).toBeInTheDocument();
    expect(
      [
        ...screen
          .getByRole("group", { name: "Shell navigation" })
          .querySelectorAll("button"),
      ].map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Toggle workspace sidebar", "Back"]);
    expect(
      screen.queryByRole("complementary", { name: "Files" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New Drawing" }));
    expect(onCreateDocument).toHaveBeenCalledOnce();

    await user.click(
      screen.getByRole("button", { name: /workspace sidebar/i }),
    );
    expect(
      screen.getByRole("complementary", { name: "Files" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New drawing" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open drawing…" }),
    ).not.toBeInTheDocument();
  });

  it("renders Welcome as a non-tab document state when the session is empty", async () => {
    const user = userEvent.setup();
    const onCreateDocument = vi.fn();
    render(<AppShell onCreateDocument={onCreateDocument} />);

    expect(screen.getByTestId("welcome-screen")).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: /Welcome/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "New Drawing" }));
    expect(onCreateDocument).toHaveBeenCalledOnce();
  });

  it("synchronizes an Open Workspace selection into the visible sidebar", async () => {
    const user = userEvent.setup();
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
      },
    });
    const workspace = {
      id: "workspace-opened",
      name: "Opened workspace",
      rootPath: "/workspace/opened",
      createdAt: 1,
    };
    let opened = false;
    const invoke = vi.fn(async (command: string) => {
      if (command === "workspace_list") return opened ? [workspace] : [];
      if (command === "workspace_recent_list") return opened ? [workspace] : [];
      if (command === "workspace_add") {
        opened = true;
        return workspace;
      }
      if (command === "workspace_entry_list") return [];
      throw new Error(`Unexpected command ${command}`);
    }) as CommandInvoker["invoke"];
    vi.stubGlobal("__TAURI_INTERNALS__", {
      invoke: vi.fn(async () => []),
    });

    render(
      <AppShell
        workspaceInvoker={{ invoke }}
        selectWorkspaceDirectory={async () => workspace.rootPath}
      />,
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("workspace_list", {});
    });
    await user.click(
      await screen.findByRole("button", { name: "Open Workspace" }),
    );

    await user.click(
      screen.getByRole("button", { name: /workspace sidebar/i }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: workspace.name }),
      ).toBeInTheDocument();
    });
    expect(
      await screen.findByRole("treeitem", { name: workspace.name }),
    ).toBeInTheDocument();
  });

  it("keeps New Drawing memory-only and avoids workspace persistence", async () => {
    const user = userEvent.setup();
    const invoke = vi.fn(async (command: string) => {
      if (command === "workspace_list") return [];
      if (command === "workspace_recent_list") return [];
      throw new Error(`Unexpected command ${command}`);
    }) as CommandInvoker["invoke"];
    vi.stubGlobal("__TAURI_INTERNALS__", {
      invoke: vi.fn(async () => []),
    });

    render(<AppShell workspaceInvoker={{ invoke }} />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("workspace_list", {}),
    );
    await user.click(screen.getByRole("button", { name: "New Drawing" }));

    const activeDocumentId = documentManager.store.getState().activeDocumentId;
    expect(activeDocumentId).not.toBeNull();
    expect(
      documentManager.store.getState().sessionsById[activeDocumentId ?? ""],
    ).toMatchObject({ path: "", title: "Untitled", saveState: "dirty" });
    expect(invoke).not.toHaveBeenCalledWith("workspace_add", expect.anything());
  });

  it("keeps Welcome and workspace records unchanged when Open Workspace is cancelled", async () => {
    const user = userEvent.setup();
    const invoke = vi.fn(async (command: string) => {
      if (command === "workspace_list") return [];
      if (command === "workspace_recent_list") return [];
      throw new Error(`Unexpected command ${command}`);
    }) as CommandInvoker["invoke"];
    vi.stubGlobal("__TAURI_INTERNALS__", {
      invoke: vi.fn(async () => []),
    });

    render(
      <AppShell
        selectWorkspaceDirectory={async () => null}
        workspaceInvoker={{ invoke }}
      />,
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("workspace_list", {}),
    );
    await user.click(screen.getByRole("button", { name: "Open Workspace" }));

    expect(screen.getByTestId("welcome-screen")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("workspace_add", expect.anything());
    expect(documentManager.store.getState().sessionsById).toEqual({});
  });

  it("keeps an inaccessible Recent Workspace and exposes a readable error", async () => {
    const user = userEvent.setup();
    const workspace = {
      id: "workspace-missing",
      name: "Missing workspace",
      rootPath: "/workspace/missing",
      createdAt: 1,
    };
    const invoke = vi.fn(async (command: string) => {
      if (command === "workspace_list") return [];
      if (command === "workspace_recent_list") return [workspace];
      if (command === "workspace_remount") {
        throw new Error("Workspace is no longer accessible.");
      }
      throw new Error(`Unexpected command ${command}`);
    }) as CommandInvoker["invoke"];
    vi.stubGlobal("__TAURI_INTERNALS__", {
      invoke: vi.fn(async () => []),
    });

    render(<AppShell workspaceInvoker={{ invoke }} />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("workspace_list", {}),
    );
    const recent = await screen.findByRole("button", {
      name: "Open workspace Missing workspace",
    });
    await user.click(recent);

    expect(invoke).toHaveBeenCalledWith("workspace_remount", {
      workspaceId: workspace.id,
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Workspace is no longer accessible.",
    );
    expect(
      screen.getByRole("button", { name: "Open workspace Missing workspace" }),
    ).toBeInTheDocument();
    expect(documentManager.store.getState().sessionsById).toEqual({});
  });

  it("removes an unmounted Workspace from Recent history only on request", async () => {
    const user = userEvent.setup();
    const workspace = {
      id: "workspace-old",
      name: "Old workspace",
      rootPath: "/workspace/old",
      createdAt: 1,
    };
    let removed = false;
    const invoke = vi.fn(async (command: string) => {
      if (command === "workspace_list") return [];
      if (command === "workspace_recent_list") return removed ? [] : [workspace];
      if (command === "workspace_recent_remove") {
        removed = true;
        return {};
      }
      throw new Error(`Unexpected command ${command}`);
    }) as CommandInvoker["invoke"];
    vi.stubGlobal("__TAURI_INTERNALS__", {
      invoke: vi.fn(async () => []),
    });

    render(<AppShell workspaceInvoker={{ invoke }} />);
    await user.click(
      await screen.findByRole("button", {
        name: "Remove Old workspace from Recents",
      }),
    );

    expect(invoke).toHaveBeenCalledWith("workspace_recent_remove", {
      workspaceId: workspace.id,
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Open workspace Old workspace" }),
      ).not.toBeInTheDocument(),
    );
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
    controller.setModePreference("light");
    await waitFor(() =>
      expect(screen.getByTestId("excalidraw-editor")).toHaveAttribute(
        "data-theme",
        "light",
      ),
    );

    await user.keyboard("{Meta>}s{/Meta}");
    expect(save).toHaveBeenCalledWith("manualSave");
  });

  it("renders the first Welcome frame in the restored Dark scheme without a Light mutation", () => {
    const controller = initializeBrowserThemeController();
    controller.setModePreference("dark");
    const observedSchemes: Array<string | undefined> = [];
    const observer = new MutationObserver(() => {
      observedSchemes.push(document.documentElement.dataset.colorScheme);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-color-scheme"],
    });

    render(<AppShell themeController={controller} />);
    observer.takeRecords().forEach(() => {
      observedSchemes.push(document.documentElement.dataset.colorScheme);
    });
    observer.disconnect();

    expect(screen.getByTestId("welcome-screen")).toBeInTheDocument();
    expect(document.documentElement.dataset.colorScheme).toBe("dark");
    expect(observedSchemes).not.toContain("light");
  });

  it("routes native Save through DocumentManager and exposes rejected saves", async () => {
    nativeRuntimeHarness.enabled = true;
    setDocumentSessions([
      createSession("drawing", "Drawing", "/tmp/drawing.excalidraw", "dirty"),
    ]);
    const checkpoint = vi
      .spyOn(documentManager, "checkpointActive")
      .mockRejectedValue(new Error("native save failed"));

    const view = render(<AppShell />);
    await waitFor(() => expect(nativeMenuHarness.handler).toBeDefined());
    nativeMenuHarness.handler?.("save");

    expect(checkpoint).toHaveBeenCalledWith("manualSave");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "native save failed",
    );
    expect(
      screen.queryByRole("button", { name: /^Save/ }),
    ).not.toBeInTheDocument();
    view.unmount();
    expect(nativeMenuHarness.cleanup).toHaveBeenCalledOnce();
  });

  it("reports native export as unavailable until an active editor is ready", async () => {
    nativeRuntimeHarness.enabled = true;
    setDocumentSessions([
      createSession("drawing", "Drawing", "/tmp/drawing.excalidraw", "clean"),
    ]);
    const invoke = vi.fn(async () => []);

    render(<AppShell workspaceInvoker={{ invoke }} />);
    await waitFor(() => expect(nativeMenuHarness.handler).toBeDefined());
    nativeMenuHarness.handler?.("exportImage");

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Export is unavailable until the active drawing is ready.",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith("doc_export", expect.anything());
  });

  it("routes native appearance commands through the injected theme controller", async () => {
    nativeRuntimeHarness.enabled = true;
    setDocumentSessions([
      createSession("drawing", "Drawing", "/tmp/drawing.excalidraw", "clean"),
    ]);
    const controller = initializeBrowserThemeController();
    render(<AppShell themeController={controller} />);
    await waitFor(() => expect(nativeMenuHarness.handler).toBeDefined());

    for (const [command, mode] of [
      ["appearanceSystem", "system"],
      ["appearanceLight", "light"],
      ["appearanceDark", "dark"],
    ] as const) {
      nativeMenuHarness.handler?.(command);
      await waitFor(() =>
        expect(controller.getSnapshot().preference.modePreference).toBe(mode),
      );
      await waitFor(() =>
        expect(screen.getByTestId("excalidraw-editor")).toHaveAttribute(
          "data-theme",
          mode === "system" ? "light" : mode,
        ),
      );
    }
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
    await user.keyboard("{Meta>}s{/Meta}");

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
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 1280,
      });
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

    it("uses one Sidebar button for overlay, pinned, and hidden transitions", async () => {
      const user = userEvent.setup();
      render(<AppShell />);
      const toggle = getWorkspaceSidebarOpenControl();

      await user.click(toggle);
      expect(getShellBody()).toHaveAttribute("data-sidebar-mode", "overlay");
      expect(
        screen.queryByRole("button", { name: /pin workspace sidebar/i }),
      ).not.toBeInTheDocument();

      await user.click(toggle);
      expect(getShellBody()).toHaveAttribute("data-sidebar-mode", "pinned");

      await user.click(toggle);
      expect(getShellBody()).toHaveAttribute("data-sidebar-mode", "hidden");
    });

    it("reveals the hidden Sidebar from the left edge", () => {
      render(<AppShell />);

      fireEvent.pointerEnter(screen.getByTestId("sidebar-reveal-zone"));

      expect(getShellBody()).toHaveAttribute("data-sidebar-mode", "overlay");
    });

    it("resizes a pinned Sidebar with the keyboard and persists the width", async () => {
      seedShellPreferences({ sidebarPinned: true });
      const user = userEvent.setup();
      render(<AppShell />);
      const separator = screen.getByRole("separator", {
        name: "Resize workspace sidebar",
      });

      expect(separator).toHaveAttribute("aria-valuenow", "360");
      await user.click(separator);
      await user.keyboard("{ArrowRight}");
      expect(separator).toHaveAttribute("aria-valuenow", "368");
      expect(
        JSON.parse(
          globalThis.localStorage.getItem(SHELL_PREFERENCES_STORAGE_KEY) ??
            "{}",
        ).sidebarWidth,
      ).toBe(368);
    });

    it("resizes a pinned Sidebar with the pointer and persists the width", () => {
      seedShellPreferences({ sidebarPinned: true });
      render(<AppShell />);
      const separator = screen.getByRole("separator", {
        name: "Resize workspace sidebar",
      });

      fireEvent.pointerDown(separator, { clientX: 360, pointerId: 7 });
      fireEvent.pointerMove(separator, { clientX: 376, pointerId: 7 });
      fireEvent.pointerUp(separator, { clientX: 376, pointerId: 7 });

      expect(separator).toHaveAttribute("aria-valuenow", "376");
      expect(
        JSON.parse(
          globalThis.localStorage.getItem(SHELL_PREFERENCES_STORAGE_KEY) ??
            "{}",
        ).sidebarWidth,
      ).toBe(376);
    });

    it("caps Sidebar resizing so the canvas retains at least 70 percent at 1280px", async () => {
      seedShellPreferences({ sidebarPinned: true });
      const user = userEvent.setup();
      render(<AppShell />);
      const separator = screen.getByRole("separator", {
        name: "Resize workspace sidebar",
      });

      expect(separator).toHaveAttribute("aria-valuemax", "384");
      await user.click(separator);
      await user.keyboard("{End}");

      const cappedWidth = Number(separator.getAttribute("aria-valuenow"));
      expect(cappedWidth).toBe(384);
      expect((1280 - cappedWidth) / 1280).toBeGreaterThanOrEqual(0.7);
    });

    it("restores the pinned mode and chosen width after an AppShell restart", () => {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 1600,
      });
      seedShellPreferences({ sidebarPinned: true, sidebarWidth: 416 });
      const first = render(<AppShell />);
      expect(getShellBody()).toHaveAttribute("data-sidebar-mode", "pinned");
      expect(
        screen.getByRole("separator", { name: "Resize workspace sidebar" }),
      ).toHaveAttribute("aria-valuenow", "416");

      first.unmount();
      render(<AppShell />);

      expect(getShellBody()).toHaveAttribute("data-sidebar-mode", "pinned");
      expect(
        screen.getByRole("separator", { name: "Resize workspace sidebar" }),
      ).toHaveAttribute("aria-valuenow", "416");
    });

    it("keeps legacy command chrome out of the shell header", () => {
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
      assertRetainedChrome();

      fireEvent.click(getWorkspaceSidebarOpenControl());
      expect(getShellBody()).toHaveAttribute("data-sidebar-mode", "overlay");
      assertRetainedChrome();

      first.unmount();
      seedShellPreferences({ sidebarPinned: true });
      render(<AppShell />);
      expect(getShellBody()).toHaveAttribute("data-sidebar-mode", "pinned");
      assertRetainedChrome();
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

function seedShellPreferences(snapshot: {
  sidebarPinned: boolean;
  sidebarWidth?: number;
}): void {
  globalThis.localStorage.setItem(
    SHELL_PREFERENCES_STORAGE_KEY,
    JSON.stringify({
      version: SHELL_PREFERENCES_VERSION,
      sidebarPinned: snapshot.sidebarPinned,
      sidebarWidth: snapshot.sidebarWidth,
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

function assertRetainedChrome(): void {
  expect(
    screen.queryByRole("button", { name: /^Save$/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Export…" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Appearance" }),
  ).not.toBeInTheDocument();
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
