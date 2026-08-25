import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type WheelEvent,
} from "react";
import { documentManager, useDocumentStore } from "../documents/documentStore";
import { ingestWheel } from "../documents/tabActivationQueue";
import { ContextMenu } from "./interaction/ContextMenu";
import type { CloseOutcome } from "../documents/documentStore";

interface TabBarProps {
  onCloseOutcome?: (documentId: string, outcome: CloseOutcome) => void;
}

interface TabMenuState {
  documentId: string;
  x: number;
  y: number;
}

export function TabBar({ onCloseOutcome }: TabBarProps = {}) {
  const sessionsById = useDocumentStore((state) => state.sessionsById);
  const tabOrder = useDocumentStore((state) => state.tabOrder);
  const activeDocumentId = useDocumentStore((state) => state.activeDocumentId);
  const clusterRefs = useRef<Array<HTMLDivElement | null>>([]);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<TabMenuState | null>(null);
  const ownedTabIds = tabOrder
    .filter((tabId) => sessionsById[tabId] !== undefined)
    .map((tabId) => `tab-${tabId}`)
    .join(" ");

  const activateTab = (tabId: string) => {
    void documentManager.activate(tabId);
    scrollTabNearest(tabId);
  };

  const scrollTabNearest = (tabId: string) => {
    const index = tabOrder.indexOf(tabId);
    const cluster = clusterRefs.current[index];
    if (cluster === undefined || cluster === null) return;
    const reducedMotion =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;
    const tabList = cluster.closest(".tab-list");
    if (tabList !== null) {
      const listBox = tabList.getBoundingClientRect();
      const clusterBox = cluster.getBoundingClientRect();
      const fullyVisible =
        clusterBox.left >= listBox.left && clusterBox.right <= listBox.right;
      if (fullyVisible) return;
    }
    cluster.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: reducedMotion ? "auto" : "smooth",
    });
  };

  const closeTab = (tabId: string) => {
    const currentOrder = documentManager.store.getState().tabOrder;
    const closedIndex = currentOrder.indexOf(tabId);
    void documentManager.close(tabId).then((outcome) => {
      onCloseOutcome?.(tabId, outcome);
      if (outcome.status !== "closed") return;
      const nextOrder = documentManager.store.getState().tabOrder;
      const survivor =
        nextOrder[Math.min(closedIndex, nextOrder.length - 1)] ?? null;
      if (survivor === null) return;
      requestAnimationFrame(() => {
        const index = documentManager.store
          .getState()
          .tabOrder.indexOf(survivor);
        const cluster = clusterRefs.current[index];
        const closeButton =
          cluster?.querySelector<HTMLButtonElement>("button.tab-close") ?? null;
        const tab = cluster?.querySelector<HTMLElement>('[role="tab"]') ?? null;
        (closeButton ?? tab)?.focus();
      });
    });
  };

  const closeMany = (documentIds: readonly string[]) => {
    void documentManager.closeMany(documentIds).then((outcome) => {
      if (outcome.status === "failed" || outcome.status === "orphaned") {
        onCloseOutcome?.(outcome.documentId, outcome);
      }
    });
  };

  const closeTabRef = useRef(closeTab);

  useEffect(() => {
    closeTabRef.current = closeTab;
  });

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== "w") return;
      const isMac = /Mac|iPhone|iPad/.test(window.navigator.platform);
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey || event.shiftKey) return;
      if (isMac && event.ctrlKey) return;
      if (!isMac && event.metaKey) return;
      const activeId = documentManager.store.getState().activeDocumentId;
      if (activeId === null) return;
      event.preventDefault();
      closeTabRef.current(activeId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    index: number,
  ) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % tabOrder.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + tabOrder.length) % tabOrder.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabOrder.length - 1;
    }
    if (nextIndex !== undefined) {
      event.preventDefault();
      const tabId = tabOrder[nextIndex];
      if (tabId !== undefined) {
        activateTab(tabId);
        clusterRefs.current[nextIndex]
          ?.querySelector<HTMLElement>('[role="tab"]')
          ?.focus();
      }
    }
  };

  const handleWheel = (event: WheelEvent<HTMLElement>) => {
    const nextIndex = ingestWheel({
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      tabCount: tabOrder.length,
      activeIndex: Math.max(0, tabOrder.indexOf(activeDocumentId ?? "")),
    });
    if (nextIndex === null) return;
    event.preventDefault();
    const tabId = tabOrder[nextIndex];
    if (tabId !== undefined) {
      activateTab(tabId);
    }
  };

  const handleAuxClick = (
    event: MouseEvent<HTMLDivElement>,
    documentId: string,
  ) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    closeTab(documentId);
  };

  const handleContextMenu = (
    event: MouseEvent<HTMLDivElement>,
    documentId: string,
  ) => {
    event.preventDefault();
    const trigger = event.currentTarget.querySelector('[role="tab"]');
    menuTriggerRef.current =
      trigger instanceof HTMLElement ? trigger : event.currentTarget;
    setMenu({ documentId, x: event.clientX, y: event.clientY });
  };

  const menuItems = (() => {
    if (menu === null) return [];
    const index = tabOrder.indexOf(menu.documentId);
    const others = tabOrder.filter((id) => id !== menu.documentId);
    const toTheRight = tabOrder.slice(index + 1);
    return [
      {
        id: "close",
        label: "Close",
        onSelect: () => closeTab(menu.documentId),
      },
      {
        id: "close-others",
        label: "Close Others",
        onSelect: () => closeMany(others),
      },
      {
        id: "close-right",
        label: "Close Tabs to the Right",
        onSelect: () => closeMany(toTheRight),
      },
    ];
  })();

  return (
    <nav className="tab-bar" aria-label="Open drawings" onWheel={handleWheel}>
      <div className="tab-list">
        <div
          aria-label="Drawing tabs"
          aria-owns={ownedTabIds.length > 0 ? ownedTabIds : undefined}
          className="tab-list-tablist"
          role="tablist"
        />
        {tabOrder.map((tabId, index) => {
          const session = sessionsById[tabId];
          if (session === undefined) {
            return null;
          }
          const isActive = activeDocumentId === session.id;
          const isDirty = session.saveState !== "clean";
          const isOrphaned = session.saveState === "orphaned";
          const closeVisible =
            isActive || hoveredId === session.id || focusedId === session.id;
          return (
            <div
              className="tab-cluster"
              data-tab-id={session.id}
              key={session.id}
              onBlur={(event) => {
                const next = event.relatedTarget;
                if (
                  next instanceof Node &&
                  event.currentTarget.contains(next)
                ) {
                  return;
                }
                setFocusedId((current) =>
                  current === session.id ? null : current,
                );
              }}
              onFocus={() => setFocusedId(session.id)}
              onMouseEnter={() => setHoveredId(session.id)}
              onMouseLeave={(event) => {
                const next = event.relatedTarget;
                if (
                  next instanceof Node &&
                  event.currentTarget.contains(next)
                ) {
                  return;
                }
                setHoveredId((current) =>
                  current === session.id ? null : current,
                );
              }}
              onAuxClick={(event) => handleAuxClick(event, session.id)}
              onClick={() => activateTab(session.id)}
              onContextMenu={(event) => handleContextMenu(event, session.id)}
              ref={(element) => {
                clusterRefs.current[index] = element;
              }}
            >
              <div
                aria-controls={`document-${session.id}`}
                aria-label={`${session.title}${isDirty ? ", unsaved changes" : ""}${isOrphaned ? ", file unavailable" : ""}`}
                aria-selected={isActive}
                className={isActive ? "tab is-selected" : "tab"}
                id={`tab-${session.id}`}
                onKeyDown={(event) => handleKeyDown(event, index)}
                role="tab"
                tabIndex={isActive ? 0 : -1}
              >
                <span className="tab-title">{session.title}</span>
                {isDirty ? (
                  <span className="dirty-indicator" title="Unsaved changes">
                    <span aria-hidden="true">●</span>
                    <span className="visually-hidden">Unsaved changes</span>
                  </span>
                ) : null}
                {isOrphaned ? (
                  <span className="orphaned-indicator" title="File unavailable">
                    <span aria-hidden="true">!</span>
                    <span className="visually-hidden">File unavailable</span>
                  </span>
                ) : null}
              </div>
              <span
                data-close-visible={closeVisible ? "true" : "false"}
                data-slot="tab-close"
                data-tab-id={session.id}
              >
                {closeVisible ? (
                  <button
                    aria-label={`Close ${session.title}`}
                    className="tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(session.id);
                    }}
                    type="button"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
      {menu !== null ? (
        <ContextMenu
          label="Tab actions"
          items={menuItems}
          anchor={{ x: menu.x, y: menu.y }}
          onDismiss={() => setMenu(null)}
          triggerRef={menuTriggerRef}
        />
      ) : null}
    </nav>
  );
}
