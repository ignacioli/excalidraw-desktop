import { useRef, type KeyboardEvent } from "react";
import { documentManager, useDocumentStore } from "../documents/documentStore";

export function TabBar() {
  const sessionsById = useDocumentStore((state) => state.sessionsById);
  const tabOrder = useDocumentStore((state) => state.tabOrder);
  const activeDocumentId = useDocumentStore((state) => state.activeDocumentId);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const moveFocus = (index: number) => {
    const tabId = tabOrder[index];
    if (tabId !== undefined) {
      activateTab(tabId);
      tabRefs.current[index]?.focus();
    }
  };

  const activateTab = (tabId: string) => {
    void documentManager.activate(tabId);
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
          const session = sessionsById[tabId];
          if (session === undefined) {
            return null;
          }

          const isActive = activeDocumentId === session.id;
          const isDirty = session.saveState !== "clean";
          const isOrphaned = session.saveState === "orphaned";
          return (
            <button
              className="tab"
              id={`tab-${session.id}`}
              key={session.id}
              onClick={() => activateTab(session.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              role="tab"
              type="button"
              aria-controls={`document-${session.id}`}
              aria-label={`${session.title}${isDirty ? ", unsaved changes" : ""}${isOrphaned ? ", file unavailable" : ""}`}
              aria-selected={isActive}
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
            </button>
          );
        })}
      </div>
    </nav>
  );
}
