import { useRef, type KeyboardEvent } from "react";
import { documentManager } from "../documents/documentStore";
import { useAppStore } from "./store";

export function TabBar() {
  const tabsById = useAppStore((state) => state.tabsById);
  const tabOrder = useAppStore((state) => state.tabOrder);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const setActiveTab = useAppStore((state) => state.setActiveTab);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const moveFocus = (index: number) => {
    const tabId = tabOrder[index];
    if (tabId !== undefined) {
      activateTab(tabId);
      tabRefs.current[index]?.focus();
    }
  };

  const activateTab = (tabId: string) => {
    if (documentManager.store.getState().sessionsById[tabId] === undefined) {
      setActiveTab(tabId);
    } else {
      void documentManager.activate(tabId);
    }
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
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
      moveFocus(nextIndex);
    }
  };

  return (
    <nav className="tab-bar" aria-label="Open drawings">
      <div className="tab-list" role="tablist" aria-label="Drawing tabs">
        {tabOrder.map((tabId, index) => {
          const tab = tabsById[tabId];
          if (tab === undefined) {
            return null;
          }

          const isActive = activeTabId === tab.id;
          return (
            <button
              className="tab"
              id={`tab-${tab.id}`}
              key={tab.id}
              onClick={() => activateTab(tab.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              role="tab"
              type="button"
              aria-controls={`document-${tab.id}`}
              aria-label={`${tab.title}${tab.isDirty ? ", unsaved changes" : ""}${tab.isOrphaned ? ", file unavailable" : ""}`}
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
            >
              <span className="tab-title">{tab.title}</span>
              {tab.isDirty ? (
                <span className="dirty-indicator" title="Unsaved changes">
                  <span aria-hidden="true">●</span>
                  <span className="visually-hidden">Unsaved changes</span>
                </span>
              ) : null}
              {tab.isOrphaned ? (
                <span className="orphaned-indicator" title="File unavailable">
                  <span aria-hidden="true">!</span>
                  <span className="visually-hidden">File unavailable</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
