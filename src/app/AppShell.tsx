import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  documentManager,
  registerDocumentFileChangeEvents,
  useDocumentStore,
  type DocumentSaveState,
} from "../documents/documentStore";
import { RecoveryStartup } from "../documents/RecoveryStartup";
import { ExcalidrawEditor } from "../editor/ExcalidrawEditor";
import type { ExcalidrawAdapter } from "../editor/ExcalidrawAdapter";
import { hasTauriCommandRuntime } from "../ipc/client";
import { WorkspacePanel } from "../workspaces/WorkspacePanel";
import { AppearanceControl } from "./AppearanceControl";
import {
  hasNativeWindowRuntime,
  registerExitCheckpoint,
} from "./exitCheckpoint";
import { fileDialogActions, type FileDialogActions } from "./fileDialogs";
import { TabBar } from "./TabBar";
import { useAppStore } from "./store";
import {
  initializeBrowserThemeController,
  type ThemeController,
} from "./theme/themeController";

interface AppShellProps {
  onCreateDocument?: () => void | Promise<void>;
  onOpenDocument?: () => void | Promise<void>;
  dialogs?: FileDialogActions;
  themeController?: ThemeController;
}

export function AppShell({
  onCreateDocument,
  onOpenDocument,
  dialogs = fileDialogActions,
  themeController = initializeBrowserThemeController(),
}: AppShellProps) {
  const [interactionError, setInteractionError] = useState<string | null>(null);
  const performanceDriverRef = useRef<
    | {
        attachEditor(
          documentId: string,
          adapter: ExcalidrawAdapter,
          container: HTMLDivElement,
        ): void;
        start(): void;
      }
    | undefined
  >(undefined);
  const readyEditorRef = useRef<
    | {
        documentId: string;
        adapter: ExcalidrawAdapter;
        container: HTMLDivElement;
      }
    | undefined
  >(undefined);
  const hasMountedWorkspace = useAppStore((state) => state.hasMountedWorkspace);
  const setHasMountedWorkspace = useAppStore(
    (state) => state.setHasMountedWorkspace,
  );
  const activeTabId = useAppStore((state) => state.activeTabId);
  const activeTab = useAppStore((state) =>
    state.activeTabId === null ? undefined : state.tabsById[state.activeTabId],
  );
  const sessionsById = useDocumentStore((state) => state.sessionsById);
  const activeSession =
    activeTabId === null ? undefined : sessionsById[activeTabId];
  const documentSessions = Object.values(sessionsById);
  const themeSnapshot = useSyncExternalStore(
    themeController.subscribe,
    themeController.getSnapshot,
    themeController.getSnapshot,
  );
  const saveShortcutLabel = /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘S"
    : "Ctrl+S";

  const runAction = async (action: () => void | Promise<unknown>) => {
    setInteractionError(null);
    try {
      await action();
    } catch (error) {
      setInteractionError(getErrorMessage(error));
    }
  };

  const createDocument = () =>
    runAction(onCreateDocument ?? dialogs.createDocument);
  const openDocument = () => runAction(onOpenDocument ?? dialogs.openDocument);
  const saveDocument = () =>
    runAction(() => documentManager.checkpointActive("manualSave"));
  const handleEditorReady = useCallback(
    (
      documentId: string,
      adapter: ExcalidrawAdapter,
      container: HTMLDivElement,
    ) => {
      attachPerformanceEditor(
        readyEditorRef,
        performanceDriverRef.current,
        documentId,
        adapter,
        container,
      );
    },
    [],
  );

  useEffect(() => {
    if (import.meta.env.VITE_E2E_HARNESS !== "1") {
      return;
    }
    let disposed = false;
    void import("../e2e/performanceDriver")
      .then(({ nativePerformanceDriver }) => {
        if (disposed) {
          return;
        }
        performanceDriverRef.current = nativePerformanceDriver;
        nativePerformanceDriver.start();
        const readyEditor = readyEditorRef.current;
        if (readyEditor !== undefined) {
          nativePerformanceDriver.attachEditor(
            readyEditor.documentId,
            readyEditor.adapter,
            readyEditor.container,
          );
        }
      })
      .catch((error: unknown) => setInteractionError(getErrorMessage(error)));
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!hasNativeWindowRuntime()) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void registerExitCheckpoint(documentManager, (error) =>
      setInteractionError(getErrorMessage(error)),
    )
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
        } else {
          unlisten = nextUnlisten;
        }
      })
      .catch((error: unknown) => setInteractionError(getErrorMessage(error)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!hasNativeWindowRuntime()) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void registerDocumentFileChangeEvents(documentManager)
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
        } else {
          unlisten = nextUnlisten;
        }
      })
      .catch((error: unknown) => setInteractionError(getErrorMessage(error)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "s" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey
      ) {
        event.preventDefault();
        void saveDocument();
      }
    };
    window.addEventListener("keydown", handleSaveShortcut);
    return () => window.removeEventListener("keydown", handleSaveShortcut);
  });

  return (
    <div className="app-shell">
      <RecoveryStartup enabled={hasNativeWindowRuntime()} />
      <header className="app-shell-tabs">
        <TabBar />
        <div
          className="app-commands"
          role="toolbar"
          aria-label="Drawing commands"
        >
          <p className="save-status" role="status" aria-live="polite">
            {interactionError ?? getSaveStatus(activeSession?.saveState)}
          </p>
          <button
            aria-keyshortcuts="Meta+S Control+S"
            disabled={activeSession === undefined}
            onClick={() => void saveDocument()}
            type="button"
          >
            Save
            <span className="shortcut-hint" aria-hidden="true">
              {saveShortcutLabel}
            </span>
          </button>
          <AppearanceControl controller={themeController} />
        </div>
      </header>

      <div className="app-shell-body">
        <aside className="file-sidebar" aria-label="Files">
          {hasTauriCommandRuntime() ? (
            <WorkspacePanel
              onOpenFile={(entry) => {
                void runAction(() => documentManager.open(entry.canonicalPath));
              }}
              onWorkspacePresenceChange={setHasMountedWorkspace}
            />
          ) : null}
          {!hasMountedWorkspace ? (
            <div className="workspace-empty-state">
              <h2>No workspace mounted</h2>
              <p>Open a drawing directly, or create a new local drawing.</p>
              <div className="empty-state-actions">
                <button
                  className="primary-action"
                  type="button"
                  onClick={() => void createDocument()}
                >
                  New drawing
                </button>
                <button type="button" onClick={() => void openDocument()}>
                  Open drawing…
                </button>
              </div>
            </div>
          ) : null}
        </aside>

        <main className="canvas-region" aria-label="Drawing canvas">
          {documentSessions.length > 0 ? (
            documentSessions.map((session) => (
              <section
                aria-labelledby={`tab-${session.id}`}
                className="canvas-document"
                hidden={session.id !== activeTabId}
                id={`document-${session.id}`}
                key={session.id}
                role="tabpanel"
              >
                <ExcalidrawEditor
                  documentId={session.id}
                  initialScene={session.scene}
                  onSceneChange={(scene) =>
                    documentManager.updateScene(session.id, scene)
                  }
                  onReady={handleEditorReady}
                  readOnly={session.saveState === "conflicted"}
                  theme={themeSnapshot.resolvedColorScheme}
                />
              </section>
            ))
          ) : activeTab === undefined ? (
            <div className="canvas-empty-state">
              <p>Select a drawing to begin.</p>
            </div>
          ) : (
            <section
              aria-labelledby={`tab-${activeTab.id}`}
              className="canvas-document"
              id={`document-${activeTab.id}`}
              role="tabpanel"
            >
              <div
                className="canvas-placeholder"
                data-document-id={activeTab.id}
              >
                <p>{activeTab.title}</p>
                <span>The editor is not loaded yet.</span>
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

function attachPerformanceEditor(
  readyEditorRef: React.MutableRefObject<
    | {
        documentId: string;
        adapter: ExcalidrawAdapter;
        container: HTMLDivElement;
      }
    | undefined
  >,
  driver:
    | {
        attachEditor(
          documentId: string,
          adapter: ExcalidrawAdapter,
          container: HTMLDivElement,
        ): void;
      }
    | undefined,
  documentId: string,
  adapter: ExcalidrawAdapter,
  container: HTMLDivElement,
): void {
  readyEditorRef.current = { documentId, adapter, container };
  driver?.attachEditor(documentId, adapter, container);
}

function getSaveStatus(saveState: DocumentSaveState | undefined): string {
  switch (saveState) {
    case "dirty":
      return "Unsaved changes";
    case "savingDraft":
      return "Saving recovery draft…";
    case "draftSaved":
      return "Recovery draft saved; file has unsaved changes";
    case "checkpointing":
      return "Saving drawing…";
    case "conflicted":
      return "Save paused because the file changed elsewhere";
    case "orphaned":
      return "The file is unavailable. Save the drawing to a new location.";
    case "error":
      return "The drawing could not be saved";
    case "clean":
      return "All changes saved";
    default:
      return "No drawing open";
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    const code = "code" in error ? error.code : undefined;
    if (code === "DISK_FULL") {
      return "The disk is full. Your recovery draft is still available.";
    }
    if ("message" in error && typeof error.message === "string") {
      return error.message;
    }
  }
  return "The requested file operation could not be completed.";
}
