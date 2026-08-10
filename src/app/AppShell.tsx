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
import { conflictDetector } from "../documents/conflictDetector";
import { ConflictDialog } from "../documents/ConflictDialog";
import { RecoveryStartup } from "../documents/RecoveryStartup";
import { ExcalidrawEditor } from "../editor/ExcalidrawEditor";
import type { ExcalidrawAdapter } from "../editor/ExcalidrawAdapter";
import { hasTauriCommandRuntime } from "../ipc/client";
import { WorkspacePanel } from "../workspaces/WorkspacePanel";
import { AppearanceControl } from "./AppearanceControl";
import { ExportDialog } from "./ExportDialog";
import {
  hasNativeWindowRuntime,
  registerExitCheckpoint,
} from "./exitCheckpoint";
import { fileDialogActions, type FileDialogActions } from "./fileDialogs";
import { registerOpenFileHandler } from "./openFileHandler";
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
  const [readyEditor, setReadyEditor] = useState<
    | {
        documentId: string;
        adapter: ExcalidrawAdapter;
      }
    | undefined
  >(undefined);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const [exportDocumentId, setExportDocumentId] = useState<string | null>(null);
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
  const exportReady =
    activeSession !== undefined && readyEditor?.documentId === activeSession.id;

  const openExportDialog = () => {
    if (!exportReady || activeSession === undefined) {
      return;
    }
    setExportDocumentId(activeSession.id);
  };

  const closeExportDialog = () => {
    setExportDocumentId(null);
    exportButtonRef.current?.focus();
  };

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
  const saveOrphanedAs = async (documentId: string) => {
    const session = documentManager.store.getState().sessionsById[documentId];
    if (session === undefined) {
      return;
    }
    const selectedPath = await chooseSavePath(session.title);
    if (selectedPath !== null) {
      await documentManager.saveOrphanedAs(documentId, selectedPath);
    }
  };
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
      setReadyEditor({ documentId, adapter });
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
    void registerOpenFileHandler(documentManager, {
      onError: (error) => setInteractionError(getErrorMessage(error)),
    })
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
    if (!hasNativeWindowRuntime()) {
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void conflictDetector
      .start()
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
          <button
            disabled={!exportReady}
            onClick={openExportDialog}
            ref={exportButtonRef}
            type="button"
          >
            Export…
          </button>
          {activeSession?.saveState === "orphaned" ? (
            <button
              onClick={() =>
                void runAction(() => saveOrphanedAs(activeSession.id))
              }
              type="button"
            >
              Save as…
            </button>
          ) : null}
          <AppearanceControl controller={themeController} />
        </div>
      </header>

      {activeSession !== undefined && activeSession.lastReloadedAt !== null ? (
        <p className="reload-notice" role="status">
          Reloaded from disk
        </p>
      ) : null}

      {activeSession?.saveState === "conflicted" &&
      activeSession.conflictInfo !== null ? (
        <ConflictDialog
          externalMtime={activeSession.conflictInfo.externalMtime}
          localDraftUpdatedAt={activeSession.conflictInfo.localDraftUpdatedAt}
          onDismiss={() => documentManager.dismissConflict(activeSession.id)}
          onResolve={(resolution, saveAsPath) =>
            documentManager.resolveConflict(
              activeSession.id,
              resolution,
              saveAsPath,
            )
          }
          path={activeSession.path}
          title={activeSession.title}
        />
      ) : null}

      <div className="app-shell-body">
        <aside className="file-sidebar" aria-label="Files">
          {hasTauriCommandRuntime() ? (
            <WorkspacePanel
              onOpenFile={(entry) => {
                void runAction(() => documentManager.open(entry.canonicalPath));
              }}
              onWorkspacePresenceChange={setHasMountedWorkspace}
              theme={themeSnapshot.resolvedColorScheme}
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
      {exportDocumentId !== null &&
      readyEditor?.documentId === exportDocumentId &&
      activeSession !== undefined ? (
        <ExportDialog
          adapter={readyEditor.adapter}
          defaultTheme={themeSnapshot.resolvedColorScheme}
          documentPath={activeSession.path}
          documentTitle={activeSession.title}
          onClose={closeExportDialog}
        />
      ) : null}
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

async function chooseSavePath(defaultTitle: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    defaultPath: defaultTitle,
    filters: [
      {
        name: "Excalidraw drawing",
        extensions: ["excalidraw", "excalidraw.json"],
      },
    ],
    title: "Save drawing as",
  });
}
