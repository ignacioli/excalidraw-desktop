import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  documentManager,
  registerDocumentFileChangeEvents,
  useDocumentStore,
  type CloseOutcome,
  type DocumentSaveState,
} from "../documents/documentStore";
import { conflictDetector } from "../documents/conflictDetector";
import { ConflictDialog } from "../documents/ConflictDialog";
import {
  RecoveryNotice,
  RecoveryStartup,
  type RecoveryStartupState,
} from "../documents/RecoveryStartup";
import { ExcalidrawEditor } from "../editor/ExcalidrawEditor";
import type { ExcalidrawAdapter } from "../editor/ExcalidrawAdapter";
import {
  createTauriCommandInvoker,
  hasTauriCommandRuntime,
  type CommandInvoker,
} from "../ipc/client";
import type { Workspace } from "../ipc/contracts";
import { BrowsingHistory, type BrowsingLocation } from "./browsingHistory";
import { WorkspacePanel } from "../workspaces/WorkspacePanel";
import { ExportDialog } from "./ExportDialog";
import {
  hasNativeWindowRuntime,
  registerExitCheckpoint,
} from "./exitCheckpoint";
import { registerOpenFileHandler } from "./openFileHandler";
import { TabBar } from "./TabBar";
import { OrphanCloseDialog } from "./OrphanCloseDialog";
import { WelcomeScreen } from "./WelcomeScreen";
import backIcon from "../../docs/design/desktop-shell/hf-2/icons/back.svg";
import sidebarIcon from "../../docs/design/desktop-shell/hf-2/icons/sidebar.svg";
import { interactionStore } from "./interaction";
import { createSidebarController } from "./sidebarController";
import {
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  ShellPreferences,
  clampSidebarWidth,
} from "./shellPreferences";
import { deriveStartupRoute } from "./startupRoute";
import { useAppStore } from "./store";
import {
  createNativeMenuCommandHandler,
  registerNativeMenuCommand,
  type NativeMenuCommand,
} from "./nativeMenu";
import {
  initializeBrowserThemeController,
  type ThemeController,
} from "./theme/themeController";

interface AppShellProps {
  onCreateDocument?: () => void | Promise<void>;
  onOpenWorkspace?: () => void | Promise<void>;
  workspaceInvoker?: CommandInvoker;
  selectWorkspaceDirectory?: () => Promise<string | null>;
  themeController?: ThemeController;
}

export function AppShell({
  onCreateDocument,
  onOpenWorkspace,
  workspaceInvoker: providedWorkspaceInvoker,
  selectWorkspaceDirectory = selectNativeWorkspaceDirectory,
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
  const nativeMenuHandlerRef = useRef<(command: NativeMenuCommand) => void>(
    () => undefined,
  );
  const [readyEditor, setReadyEditor] = useState<
    | {
        documentId: string;
        adapter: ExcalidrawAdapter;
      }
    | undefined
  >(undefined);
  const [exportDocumentId, setExportDocumentId] = useState<string | null>(null);
  const [orphanCloseId, setOrphanCloseId] = useState<string | null>(null);
  const [preferences] = useState(() => new ShellPreferences());
  const [sidebarWidth, setSidebarWidth] = useState(
    () => preferences.getSnapshot().sidebarWidth,
  );
  const [sidebarMaximum, setSidebarMaximum] = useState(SIDEBAR_WIDTH_MAX);
  const appShellRef = useRef<HTMLDivElement | null>(null);
  const sidebarResizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [workspaceInvoker] = useState(
    () => providedWorkspaceInvoker ?? createTauriCommandInvoker(),
  );
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string | null>(
    () => preferences.getSnapshot().currentWorkspaceId,
  );
  const [welcomeWorkspaces, setWelcomeWorkspaces] = useState<Workspace[]>([]);
  const [welcomeBusy, setWelcomeBusy] = useState(false);
  const [welcomeError, setWelcomeError] = useState<string | null>(null);
  const [browsingHistory] = useState(() => new BrowsingHistory());
  const currentBrowsingLocationRef = useRef<BrowsingLocation | null>(null);
  const [backLocation, setBackLocation] = useState<BrowsingLocation | null>(
    null,
  );
  const [, setHistoryVersion] = useState(0);
  const [startupState, setStartupState] = useState<RecoveryStartupState>({
    status: hasNativeWindowRuntime() ? "checking" : "ready",
    handshake: null,
    candidates: [],
    recoveredCount: 0,
  });
  const [sidebarController] = useState(() =>
    createSidebarController({
      initiallyPinned: preferences.getSnapshot().sidebarPinned,
    }),
  );
  const sidebarSnapshot = useSyncExternalStore(
    sidebarController.subscribe,
    sidebarController.getSnapshot,
    sidebarController.getSnapshot,
  );
  const pointerLeaveTimerRef = useRef<number | undefined>(undefined);

  const getSidebarMaximum = useCallback(() => {
    const measuredWidth =
      appShellRef.current?.getBoundingClientRect().width ?? 0;
    const shellWidth = measuredWidth > 0 ? measuredWidth : window.innerWidth;
    if (shellWidth <= 0) return SIDEBAR_WIDTH_MAX;
    return Math.max(
      SIDEBAR_WIDTH_MIN,
      Math.min(SIDEBAR_WIDTH_MAX, Math.floor(shellWidth * 0.3)),
    );
  }, []);

  const renderedSidebarWidth = Math.min(sidebarWidth, sidebarMaximum);

  const commitSidebarWidth = useCallback(
    (candidate: number) => {
      const width = Math.min(clampSidebarWidth(candidate), getSidebarMaximum());
      setSidebarWidth(width);
      preferences.setSidebarWidth(width);
    },
    [getSidebarMaximum, preferences],
  );

  const handleSidebarResizeKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = renderedSidebarWidth - 8;
    if (event.key === "ArrowRight") nextWidth = renderedSidebarWidth + 8;
    if (event.key === "Home") nextWidth = SIDEBAR_WIDTH_MIN;
    if (event.key === "End") nextWidth = getSidebarMaximum();
    if (nextWidth === null) return;
    event.preventDefault();
    commitSidebarWidth(nextWidth);
  };

  const handleSidebarResizePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    sidebarResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: renderedSidebarWidth,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleSidebarResizePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const resize = sidebarResizeRef.current;
    if (resize === null || resize.pointerId !== event.pointerId) return;
    commitSidebarWidth(resize.startWidth + event.clientX - resize.startX);
  };

  const handleSidebarResizePointerEnd = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (sidebarResizeRef.current?.pointerId !== event.pointerId) return;
    sidebarResizeRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const setHasMountedWorkspace = useAppStore(
    (state) => state.setHasMountedWorkspace,
  );
  const sessionsById = useDocumentStore((state) => state.sessionsById);
  const activeDocumentId = useDocumentStore((state) => state.activeDocumentId);
  const activeSession =
    activeDocumentId === null ? undefined : sessionsById[activeDocumentId];
  const documentSessions = Object.values(sessionsById);
  const exportReady =
    activeSession !== undefined && readyEditor?.documentId === activeSession.id;
  const startupRoute = deriveStartupRoute({
    handshake:
      startupState.handshake ??
      ({ abnormalExit: false, pendingOpenPaths: [] } as const),
    recoveryCandidates: startupState.candidates,
    currentWorkspaceId,
    workspaces: welcomeWorkspaces,
    openDocumentCount: documentSessions.length,
  });
  const showWelcome =
    startupState.status === "ready" && startupRoute.kind === "welcome";
  const themeSnapshot = useSyncExternalStore(
    themeController.subscribe,
    themeController.getSnapshot,
    themeController.getSnapshot,
  );
  const runAction = async (action: () => void | Promise<unknown>) => {
    setInteractionError(null);
    try {
      await action();
    } catch (error) {
      setInteractionError(getErrorMessage(error));
    }
  };

  const closeOpenDocumentsForWorkspaceSwitch = async (): Promise<void> => {
    const tabOrder = documentManager.store.getState().tabOrder;
    const outcome = await documentManager.closeMany(tabOrder);
    if (outcome.status !== "closed") {
      throw new Error(
        outcome.status === "failed"
          ? outcome.message
          : "Close or save the open drawings before switching workspaces.",
      );
    }
  };

  const selectCurrentWorkspace = useCallback(
    (workspace: Workspace): void => {
      preferences.setCurrentWorkspaceId(workspace.id);
      setCurrentWorkspaceId(workspace.id);
    },
    [preferences],
  );

  const openWorkspace = async (): Promise<void> => {
    if (onOpenWorkspace !== undefined) {
      await onOpenWorkspace();
      return;
    }
    setWelcomeBusy(true);
    setWelcomeError(null);
    try {
      const rootPath = await selectWorkspaceDirectory();
      if (rootPath === null) return;
      await closeOpenDocumentsForWorkspaceSwitch();
      const workspace = await workspaceInvoker.invoke("workspace_add", {
        rootPath,
      });
      selectCurrentWorkspace(workspace);
      setWelcomeWorkspaces((current) => [
        ...current.filter((item) => item.id !== workspace.id),
        workspace,
      ]);
    } catch (error) {
      setWelcomeError(getErrorMessage(error));
    } finally {
      setWelcomeBusy(false);
    }
  };

  const openRecentWorkspace = async (workspace: Workspace): Promise<void> => {
    setWelcomeBusy(true);
    setWelcomeError(null);
    try {
      await closeOpenDocumentsForWorkspaceSwitch();
      await workspaceInvoker.invoke("workspace_entry_list", {
        workspaceId: workspace.id,
        parentRelativePath: "",
      });
      selectCurrentWorkspace(workspace);
    } catch (error) {
      setWelcomeError(getErrorMessage(error));
    } finally {
      setWelcomeBusy(false);
    }
  };

  const createWelcomeDrawing = async (): Promise<void> => {
    setWelcomeBusy(true);
    setWelcomeError(null);
    try {
      await (onCreateDocument === undefined
        ? documentManager.createUntitled()
        : onCreateDocument());
    } catch (error) {
      setWelcomeError(getErrorMessage(error));
    } finally {
      setWelcomeBusy(false);
    }
  };

  const handleBrowse = (location: BrowsingLocation): void => {
    const current = currentBrowsingLocationRef.current;
    if (
      current?.workspaceId === location.workspaceId &&
      current.directoryRelativePath === location.directoryRelativePath
    ) {
      return;
    }
    if (current !== null) browsingHistory.push(current);
    currentBrowsingLocationRef.current = location;
    setHistoryVersion((version) => version + 1);
  };

  const goBack = (): void => {
    const target = browsingHistory.pop(
      (location) => location.workspaceId === currentWorkspaceId,
    );
    if (target === null) return;
    currentBrowsingLocationRef.current = target;
    setBackLocation(target);
    setHistoryVersion((version) => version + 1);
  };

  const canGoBack = browsingHistory.canGoBack(
    (location) => location.workspaceId === currentWorkspaceId,
  );

  useEffect(() => {
    const updateMaximum = () => setSidebarMaximum(getSidebarMaximum());
    updateMaximum();
    window.addEventListener("resize", updateMaximum);
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(updateMaximum)
        : null;
    if (appShellRef.current !== null) observer?.observe(appShellRef.current);
    return () => {
      window.removeEventListener("resize", updateMaximum);
      observer?.disconnect();
    };
  }, [getSidebarMaximum]);

  useEffect(() => {
    if (!hasTauriCommandRuntime()) return;
    let disposed = false;
    void workspaceInvoker
      .invoke("workspace_list", {})
      .then((items) => {
        if (disposed) return;
        setWelcomeWorkspaces(items);
        const validIds = new Set(items.map((workspace) => workspace.id));
        const nextCurrentWorkspaceId = preferences.resolveCurrentWorkspaceId(
          validIds,
          null,
        );
        const nextWorkspace = items.find(
          (workspace) => workspace.id === nextCurrentWorkspaceId,
        );
        if (nextWorkspace === undefined) {
          preferences.setCurrentWorkspaceId(null);
          setCurrentWorkspaceId(null);
        } else {
          selectCurrentWorkspace(nextWorkspace);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) setWelcomeError(getErrorMessage(error));
      });
    return () => {
      disposed = true;
    };
  }, [preferences, selectCurrentWorkspace, workspaceInvoker]);

  const saveDocument = () =>
    runAction(() => documentManager.checkpointActive("manualSave"));
  const openExportDialog = (): void => {
    if (!exportReady || activeSession === undefined) {
      setInteractionError(
        "Export is unavailable until the active drawing is ready.",
      );
      return;
    }
    setInteractionError(null);
    setExportDocumentId(activeSession.id);
  };
  const closeExportDialog = (): void => {
    setExportDocumentId(null);
  };
  useEffect(() => {
    nativeMenuHandlerRef.current = createNativeMenuCommandHandler({
      onSave: () => void saveDocument(),
      onExportImage: openExportDialog,
      onAppearance: (mode) =>
        void runAction(() => themeController.setModePreference(mode)),
    });
  });
  const applyCloseOutcome = (outcome: CloseOutcome) => {
    if (outcome.status === "orphaned") {
      setOrphanCloseId(outcome.documentId);
      return;
    }
    if (outcome.status === "failed") {
      setInteractionError(outcome.message);
      return;
    }
    setOrphanCloseId(null);
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
    if (!hasNativeWindowRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void registerNativeMenuCommand((command) =>
      nativeMenuHandlerRef.current(command),
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

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (sidebarController.handleEscape()) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [sidebarController]);

  useEffect(() => {
    const syncHolds = () => {
      const reasons = interactionStore.getState().holdReasons;
      sidebarController.setHold("menu", reasons.has("menu"));
      sidebarController.setHold("dialog", reasons.has("dialog"));
      sidebarController.setHold("drag", reasons.has("drag"));
    };
    syncHolds();
    return interactionStore.subscribe(syncHolds);
  }, [sidebarController]);

  useEffect(() => {
    if (!sidebarSnapshot.closePending || sidebarSnapshot.hideAtMs === null) {
      window.clearTimeout(pointerLeaveTimerRef.current);
      return;
    }
    window.clearTimeout(pointerLeaveTimerRef.current);
    const remainingMs = Math.max(0, sidebarSnapshot.hideAtMs - Date.now());
    pointerLeaveTimerRef.current = window.setTimeout(() => {
      sidebarController.tick(Date.now());
    }, remainingMs);
    return () => window.clearTimeout(pointerLeaveTimerRef.current);
  }, [
    sidebarSnapshot.closePending,
    sidebarSnapshot.hideAtMs,
    sidebarController,
  ]);

  return (
    <div
      className="app-shell"
      ref={appShellRef}
      style={
        {
          "--workspace-sidebar-width": `${renderedSidebarWidth}px`,
        } as CSSProperties
      }
    >
      <RecoveryStartup
        enabled={hasNativeWindowRuntime()}
        onStateChange={setStartupState}
      />
      <header
        className="app-shell-tabs"
        data-sidebar-mode={sidebarSnapshot.mode}
      >
        <div className="shell-left" aria-label="Shell navigation" role="group">
          <button
            aria-expanded={sidebarSnapshot.mode !== "hidden"}
            aria-controls="workspace-sidebar"
            aria-label="Toggle workspace sidebar"
            className="icon-button shell-sidebar-toggle"
            onClick={() => {
              if (sidebarSnapshot.mode === "hidden") {
                sidebarController.openOverlay();
              } else if (sidebarSnapshot.mode === "overlay") {
                sidebarController.pin();
                preferences.setSidebarPinned(true);
              } else {
                sidebarController.unpin();
                sidebarController.hide();
                preferences.setSidebarPinned(false);
              }
            }}
            title="Toggle workspace sidebar"
            type="button"
          >
            <img alt="" aria-hidden="true" src={sidebarIcon} />
          </button>
          <button
            aria-label="Back"
            className="icon-button shell-back-button"
            disabled={!canGoBack}
            onClick={goBack}
            title="Back"
            type="button"
          >
            <img alt="" aria-hidden="true" src={backIcon} />
          </button>
        </div>
        <div className="shell-center">
          <TabBar
            onCloseOutcome={(_, outcome) => {
              applyCloseOutcome(outcome);
            }}
          />
        </div>
        <div className="app-commands" aria-live="polite">
          <p
            className={
              interactionError
                ? "save-status save-status--error"
                : "save-status visually-hidden"
            }
            role="status"
            aria-live="polite"
          >
            {interactionError ?? getSaveStatus(activeSession?.saveState)}
          </p>
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

      <div
        className={
          sidebarSnapshot.mode === "pinned"
            ? "app-shell-body app-shell-body--pinned"
            : "app-shell-body"
        }
        data-sidebar-mode={sidebarSnapshot.mode}
      >
        {sidebarSnapshot.mode === "hidden" ? (
          <div
            aria-hidden="true"
            className="sidebar-reveal-zone"
            data-testid="sidebar-reveal-zone"
            onPointerEnter={() => sidebarController.openOverlay()}
            style={{ position: "absolute" }}
          />
        ) : null}
        <aside
          aria-label="Files"
          className="file-sidebar"
          hidden={sidebarSnapshot.mode === "hidden"}
          id="workspace-sidebar"
          inert={sidebarSnapshot.mode === "hidden"}
          style={
            sidebarSnapshot.mode === "overlay"
              ? { position: "absolute" }
              : undefined
          }
          onPointerEnter={() => sidebarController.handlePointerEnter()}
          onPointerLeave={() => sidebarController.handlePointerLeave()}
          onFocusCapture={() => sidebarController.setHold("focus", true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) {
              sidebarController.setHold("focus", false);
            }
          }}
        >
          {hasTauriCommandRuntime() ? (
            <WorkspacePanel
              currentWorkspaceId={currentWorkspaceId}
              invoker={workspaceInvoker}
              preferences={preferences}
              captureFocus={sidebarSnapshot.mode === "overlay"}
              onOpenFile={(entry) => {
                void runAction(() => documentManager.open(entry.canonicalPath));
              }}
              onWorkspacePresenceChange={setHasMountedWorkspace}
              onCurrentWorkspaceChange={(workspace) => {
                preferences.setCurrentWorkspaceId(workspace?.id ?? null);
                setCurrentWorkspaceId(workspace?.id ?? null);
              }}
              onBrowse={handleBrowse}
              backLocation={backLocation}
              onBackLocationApplied={() => setBackLocation(null)}
            />
          ) : null}
          {sidebarSnapshot.mode === "pinned" ? (
            <div
              aria-label="Resize workspace sidebar"
              aria-orientation="vertical"
              aria-valuemax={sidebarMaximum}
              aria-valuemin={SIDEBAR_WIDTH_MIN}
              aria-valuenow={renderedSidebarWidth}
              className="sidebar-resizer"
              onKeyDown={handleSidebarResizeKeyDown}
              onPointerCancel={handleSidebarResizePointerEnd}
              onPointerDown={handleSidebarResizePointerDown}
              onPointerMove={handleSidebarResizePointerMove}
              onPointerUp={handleSidebarResizePointerEnd}
              role="separator"
              tabIndex={0}
            />
          ) : null}
        </aside>

        <main
          aria-label="Drawing canvas"
          className={
            showWelcome
              ? "canvas-region canvas-region--welcome"
              : "canvas-region"
          }
        >
          {startupState.status === "ready" &&
          startupState.recoveredCount > 0 ? (
            <RecoveryNotice count={startupState.recoveredCount} />
          ) : null}
          {showWelcome ? (
            <WelcomeScreen
              busy={welcomeBusy}
              error={welcomeError}
              onNewDrawing={createWelcomeDrawing}
              onOpenRecentWorkspace={openRecentWorkspace}
              onOpenWorkspace={openWorkspace}
              workspaces={welcomeWorkspaces}
            />
          ) : documentSessions.length > 0 ? (
            documentSessions.map((session) => (
              <section
                aria-labelledby={`tab-${session.id}`}
                className="canvas-document"
                hidden={session.id !== activeDocumentId}
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
          ) : (
            <div className="canvas-empty-state">
              <p>Select a drawing to begin.</p>
            </div>
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
      {orphanCloseId !== null ? (
        <OrphanCloseDialog
          key={orphanCloseId}
          documentTitle={
            sessionsById[orphanCloseId]?.title ?? "Untitled drawing"
          }
          onSaveAs={() => {
            const documentId = orphanCloseId;
            void runAction(async () => {
              const session =
                documentManager.store.getState().sessionsById[documentId];
              if (session === undefined) return;
              const selectedPath = await chooseSavePath(session.title);
              if (selectedPath === null) return;
              applyCloseOutcome(
                await documentManager.confirmOrphanClose(
                  documentId,
                  "saveAs",
                  selectedPath,
                ),
              );
            });
          }}
          onDiscard={() => {
            const documentId = orphanCloseId;
            void runAction(async () => {
              applyCloseOutcome(
                await documentManager.confirmOrphanClose(documentId, "discard"),
              );
            });
          }}
          onCancel={() => {
            void documentManager
              .confirmOrphanClose(orphanCloseId, "cancel")
              .then(applyCloseOutcome);
          }}
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

async function selectNativeWorkspaceDirectory(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open workspace",
  });
  return typeof selected === "string" ? selected : null;
}
