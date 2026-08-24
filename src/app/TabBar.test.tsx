import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  documentManager,
  type DocumentSaveState,
  type DocumentSession,
} from "../documents/documentStore";
import { TabBar } from "./TabBar";

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

const originalPlatform = window.navigator.platform;

describe("TabBar", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    documentManager.store.setState({
      sessionsById: {},
      tabOrder: [],
      activeDocumentId: null,
    });
    vi.spyOn(documentManager, "close").mockImplementation(
      async (documentId) => {
        applyStoreClose(documentId);
        return { status: "closed" };
      },
    );
    vi.spyOn(documentManager, "activate").mockImplementation(
      async (documentId) => {
        documentManager.store.setState({ activeDocumentId: documentId });
      },
    );
  });

  afterEach(() => {
    stubPlatform(originalPlatform);
    vi.useRealTimers();
  });

  it("reserves a close slot so title layout does not shift and shows the icon for active or hovered tabs", async () => {
    const user = userEvent.setup();
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
    ]);
    render(<TabBar />);

    const alphaTab = screen.getByRole("tab", { name: "Alpha" });
    const tabBar = alphaTab.closest(".tab-bar");
    const alphaSlot = tabBar?.querySelector(
      "[data-slot='tab-close'][data-tab-id='alpha']",
    );
    const betaSlot = tabBar?.querySelector(
      "[data-slot='tab-close'][data-tab-id='beta']",
    );
    expect(alphaSlot).not.toBeNull();
    expect(betaSlot).not.toBeNull();
    expect(betaSlot).toHaveAttribute("data-close-visible", "true");
    expect(alphaSlot).toHaveAttribute("data-close-visible", "false");
    expect(
      screen.getByRole("button", { name: "Close Beta" }),
    ).toBeInTheDocument();

    await user.hover(alphaTab);
    expect(
      tabBar?.querySelector("[data-slot='tab-close'][data-tab-id='alpha']"),
    ).toBe(alphaSlot);
    expect(alphaSlot).toHaveAttribute("data-close-visible", "true");
    expect(
      screen.getByRole("button", { name: "Close Alpha" }),
    ).toBeInTheDocument();
  });

  it("names each close control after its document", () => {
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
    ]);
    render(<TabBar />);

    expect(
      screen.getByRole("button", { name: "Close Beta" }),
    ).toHaveAccessibleName("Close Beta");
  });

  it("offers Close, Close Others, and Close Tabs to the Right from the tab context menu", async () => {
    const user = userEvent.setup();
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
      createSession("gamma", "Gamma", "/tmp/gamma.excalidraw", "clean"),
    ]);
    render(<TabBar />);

    fireEvent.contextMenu(screen.getByRole("tab", { name: "Beta" }));
    const menu = screen.getByRole("menu");
    expect(
      within(menu).getByRole("menuitem", { name: "Close" }),
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole("menuitem", { name: "Close Others" }),
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole("menuitem", { name: "Close Tabs to the Right" }),
    ).toBeInTheDocument();

    await user.click(within(menu).getByRole("menuitem", { name: "Close" }));
    expect(documentManager.close).toHaveBeenCalledWith("beta");
  });

  it("closes every other tab in visual order from Close Others", async () => {
    const user = userEvent.setup();
    const closeMany = stubCloseMany();
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
      createSession("gamma", "Gamma", "/tmp/gamma.excalidraw", "clean"),
    ]);
    render(<TabBar />);

    fireEvent.contextMenu(screen.getByRole("tab", { name: "Beta" }));
    await user.click(screen.getByRole("menuitem", { name: "Close Others" }));
    expect(closeMany).toHaveBeenCalledWith(["alpha", "gamma"]);
  });

  it("closes tabs to the right in visual order", async () => {
    const user = userEvent.setup();
    const closeMany = stubCloseMany();
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
      createSession("gamma", "Gamma", "/tmp/gamma.excalidraw", "clean"),
    ]);
    render(<TabBar />);

    fireEvent.contextMenu(screen.getByRole("tab", { name: "Beta" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Close Tabs to the Right" }),
    );
    expect(closeMany).toHaveBeenCalledWith(["gamma"]);
  });

  it("closes a tab on middle-click without activating it first", () => {
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
    ]);
    render(<TabBar />);

    fireEvent(
      screen.getByRole("tab", { name: "Alpha" }),
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
    expect(documentManager.close).toHaveBeenCalledWith("alpha");
    expect(documentManager.activate).not.toHaveBeenCalled();
  });

  it("closes from a middle-click on the close control without activating", () => {
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
    ]);
    render(<TabBar />);

    fireEvent(
      screen.getByRole("button", { name: "Close Beta" }),
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
    expect(documentManager.close).toHaveBeenCalledWith("beta");
    expect(documentManager.activate).not.toHaveBeenCalled();
  });

  it("opens the tab menu from a context menu on the close control", () => {
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
    ]);
    render(<TabBar />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Close Beta" }));
    expect(
      screen.getByRole("menu", { name: "Tab actions" }),
    ).toBeInTheDocument();
  });

  it("activates an inactive tab from its empty close slot", () => {
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
    ]);
    render(<TabBar />);

    const slot = screen
      .getByRole("tab", { name: "Alpha" })
      .closest(".tab-cluster")
      ?.querySelector("[data-slot='tab-close']");
    if (!(slot instanceof HTMLElement)) {
      throw new Error("Expected the Alpha close slot.");
    }
    fireEvent.click(slot);
    expect(documentManager.activate).toHaveBeenCalledWith("alpha");
  });

  it("closes the active tab with Cmd+W on macOS and Ctrl+W elsewhere", async () => {
    const user = userEvent.setup();
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
    ]);
    stubPlatform("MacIntel");
    render(<TabBar />);

    await user.keyboard("{Meta>}w{/Meta}");
    expect(documentManager.close).toHaveBeenCalledWith("beta");

    vi.mocked(documentManager.close).mockClear();
    await user.keyboard("{Control>}w{/Control}");
    expect(documentManager.close).not.toHaveBeenCalled();

    vi.mocked(documentManager.close).mockClear();
    stubPlatform("Linux x86_64");
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
    ]);
    await user.keyboard("{Control>}w{/Control}");
    expect(documentManager.close).toHaveBeenCalledWith("beta");
  });

  it("cycles and wraps tabs on unmodified vertical wheel input", () => {
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
      createSession("gamma", "Gamma", "/tmp/gamma.excalidraw", "clean"),
    ]);
    render(<TabBar />);
    const tablist = screen.getByRole("tablist");

    fireEvent.wheel(tablist, { deltaX: 0, deltaY: 120, deltaMode: 0 });
    expect(documentManager.activate).toHaveBeenCalledWith("alpha");

    vi.mocked(documentManager.activate).mockClear();
    documentManager.store.setState({ activeDocumentId: "alpha" });
    fireEvent.wheel(tablist, { deltaX: 0, deltaY: -120, deltaMode: 0 });
    expect(documentManager.activate).toHaveBeenCalledWith("gamma");

    vi.mocked(documentManager.activate).mockClear();
    fireEvent.wheel(tablist, { deltaX: 80, deltaY: 10, deltaMode: 0 });
    fireEvent.wheel(tablist, {
      deltaX: 0,
      deltaY: 120,
      deltaMode: 0,
      shiftKey: true,
    });
    fireEvent.wheel(tablist, {
      deltaX: 0,
      deltaY: 120,
      deltaMode: 0,
      altKey: true,
    });
    fireEvent.wheel(tablist, {
      deltaX: 0,
      deltaY: 120,
      deltaMode: 0,
      ctrlKey: true,
    });
    fireEvent.wheel(tablist, {
      deltaX: 0,
      deltaY: 120,
      deltaMode: 0,
      metaKey: true,
    });
    expect(documentManager.activate).not.toHaveBeenCalled();
  });

  it("treats one physical wheel notch as a single tab step even when delta is large or repeated", () => {
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
      createSession("gamma", "Gamma", "/tmp/gamma.excalidraw", "clean"),
    ]);
    render(<TabBar />);
    const tablist = screen.getByRole("tablist");

    fireEvent.wheel(tablist, { deltaX: 0, deltaY: 800, deltaMode: 0 });
    fireEvent.wheel(tablist, { deltaX: 0, deltaY: 120, deltaMode: 0 });
    expect(documentManager.activate).toHaveBeenCalledOnce();
    expect(documentManager.activate).toHaveBeenCalledWith("alpha");
  });

  it("moves focus to the surviving tab or its close control after a close", async () => {
    const user = userEvent.setup();
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
      createSession("gamma", "Gamma", "/tmp/gamma.excalidraw", "clean"),
    ]);
    documentManager.store.setState({ activeDocumentId: "beta" });
    render(<TabBar />);

    await user.click(screen.getByRole("button", { name: "Close Beta" }));
    await waitFor(() => {
      const focused = document.activeElement;
      expect(
        focused === screen.getByRole("tab", { name: "Gamma" }) ||
          focused === screen.getByRole("button", { name: "Close Gamma" }),
      ).toBe(true);
    });
  });

  it("scrolls a newly activated overflow tab only to the nearest visible edge", async () => {
    const user = userEvent.setup();
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
      createSession("gamma", "Gamma", "/tmp/gamma.excalidraw", "clean"),
    ]);
    render(<TabBar />);
    const gamma = screen.getByRole("tab", { name: "Gamma" });
    const cluster = gamma.closest(".tab-cluster");
    const strip = gamma.closest(".tab-list");
    if (!(cluster instanceof HTMLElement) || !(strip instanceof HTMLElement)) {
      throw new Error("Expected the Gamma tab cluster.");
    }
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(
      domRect(0, 0, 200, 32),
    );
    vi.spyOn(cluster, "getBoundingClientRect").mockReturnValue(
      domRect(240, 0, 144, 32),
    );
    const scrollIntoView = stubScrollIntoView(cluster);

    await user.click(gamma);
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ inline: "nearest", block: "nearest" }),
    );
  });

  it("scrolls when the close control would stay clipped even if the tab label is in view", async () => {
    const user = userEvent.setup();
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
      createSession("gamma", "Gamma", "/tmp/gamma.excalidraw", "clean"),
    ]);
    render(<TabBar />);
    const gamma = screen.getByRole("tab", { name: "Gamma" });
    const cluster = gamma.closest(".tab-cluster");
    const strip = gamma.closest(".tab-list");
    if (!(cluster instanceof HTMLElement) || !(strip instanceof HTMLElement)) {
      throw new Error("Expected the Gamma tab cluster.");
    }
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(
      domRect(0, 0, 200, 32),
    );
    vi.spyOn(gamma, "getBoundingClientRect").mockReturnValue(
      domRect(80, 0, 120, 32),
    );
    vi.spyOn(cluster, "getBoundingClientRect").mockReturnValue(
      domRect(80, 0, 144, 32),
    );
    const scrollIntoView = stubScrollIntoView(cluster);

    await user.click(gamma);
    expect(scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ inline: "nearest", block: "nearest" }),
    );
  });

  it("uses instant scrolling under reduced motion and does not move an already visible tab", async () => {
    const user = userEvent.setup();
    stubMatchMedia(true);
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
      createSession("gamma", "Gamma", "/tmp/gamma.excalidraw", "clean"),
    ]);
    render(<TabBar />);
    const alpha = screen.getByRole("tab", { name: "Alpha" });
    const gamma = screen.getByRole("tab", { name: "Gamma" });
    const alphaCluster = alpha.closest(".tab-cluster");
    const gammaCluster = gamma.closest(".tab-cluster");
    const strip = gamma.closest(".tab-list");
    if (
      !(alphaCluster instanceof HTMLElement) ||
      !(gammaCluster instanceof HTMLElement) ||
      !(strip instanceof HTMLElement)
    ) {
      throw new Error("Expected Alpha and Gamma tab clusters.");
    }
    vi.spyOn(strip, "getBoundingClientRect").mockReturnValue(
      domRect(0, 0, 200, 32),
    );
    vi.spyOn(gammaCluster, "getBoundingClientRect").mockReturnValue(
      domRect(240, 0, 144, 32),
    );
    vi.spyOn(alphaCluster, "getBoundingClientRect").mockReturnValue(
      domRect(8, 0, 144, 32),
    );
    const scrollGamma = stubScrollIntoView(gammaCluster);
    const scrollAlpha = stubScrollIntoView(alphaCluster);

    await user.click(gamma);
    expect(scrollGamma).toHaveBeenCalledWith(
      expect.objectContaining({
        behavior: "auto",
        inline: "nearest",
        block: "nearest",
      }),
    );

    scrollAlpha.mockClear();
    await user.click(alpha);
    expect(scrollAlpha).not.toHaveBeenCalled();
  });

  it("keeps the tab bar mounted after the last drawing tab is closed", async () => {
    const user = userEvent.setup();
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
    ]);
    render(<TabBar />);

    await user.click(screen.getByRole("button", { name: "Close Alpha" }));
    expect(
      screen.getByRole("navigation", { name: "Open drawings" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("keeps an inactive close control mounted while it holds focus", async () => {
    const user = userEvent.setup();
    setDocumentSessions([
      createSession("alpha", "Alpha", "/tmp/alpha.excalidraw", "clean"),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
    ]);
    render(<TabBar />);

    const alphaTab = screen.getByRole("tab", { name: "Alpha" });
    const cluster = alphaTab.closest(".tab-cluster");
    if (!(cluster instanceof HTMLElement)) {
      throw new Error("Expected the Alpha tab cluster.");
    }
    await user.hover(alphaTab);
    const close = screen.getByRole("button", { name: "Close Alpha" });
    close.focus();
    fireEvent.mouseLeave(cluster, { relatedTarget: document.body });

    expect(close).toBeInTheDocument();
    expect(close).toHaveFocus();
    expect(cluster.querySelector("[data-slot='tab-close']")).toHaveAttribute(
      "data-close-visible",
      "true",
    );
  });

  it("focuses the surviving tab after closing a title that contains quotes", async () => {
    const user = userEvent.setup();
    setDocumentSessions([
      createSession(
        "quoted",
        'Quote "file"',
        "/tmp/quoted.excalidraw",
        "clean",
      ),
      createSession("beta", "Beta", "/tmp/beta.excalidraw", "clean"),
    ]);
    documentManager.store.setState({ activeDocumentId: "quoted" });
    render(<TabBar />);

    await user.click(
      screen.getByRole("button", { name: 'Close Quote "file"' }),
    );
    await waitFor(() => {
      const focused = document.activeElement;
      expect(
        focused === screen.getByRole("tab", { name: "Beta" }) ||
          focused === screen.getByRole("button", { name: "Close Beta" }),
      ).toBe(true);
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

function applyStoreClose(documentId: string): void {
  const state = documentManager.store.getState();
  const closedIndex = state.tabOrder.indexOf(documentId);
  const tabOrder = state.tabOrder.filter((id) => id !== documentId);
  const sessionsById = { ...state.sessionsById };
  delete sessionsById[documentId];
  documentManager.store.setState({
    sessionsById,
    tabOrder,
    activeDocumentId:
      state.activeDocumentId === documentId
        ? (tabOrder[closedIndex] ?? tabOrder[closedIndex - 1] ?? null)
        : state.activeDocumentId,
  });
}

function stubCloseMany(): ReturnType<typeof vi.fn> {
  const closeMany = vi.fn(async () => ({ status: "closed" as const }));
  Object.assign(documentManager, { closeMany });
  return closeMany;
}

function stubPlatform(platform: string): void {
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: platform,
  });
}

function stubScrollIntoView(element: Element): ReturnType<typeof vi.fn> {
  const scrollIntoView = vi.fn();
  Object.defineProperty(element, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  return scrollIntoView;
}

function stubMatchMedia(reducedMotion: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: reducedMotion && query.includes("prefers-reduced-motion"),
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  });
}

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    bottom: y + height,
    right: x + width,
    toJSON: () => ({}),
  } as DOMRect;
}
