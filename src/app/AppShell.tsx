import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  documentManager,
  registerDocumentFileChangeEvents,
  registerDocumentHistoryEvents,
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
import type { EditorPreferences } from "../editor/CanvasMainMenu";
import {
  ExcalidrawEditor,
  type EditorControls,
} from "../editor/ExcalidrawEditor";
import type { ExcalidrawAdapter } from "../editor/ExcalidrawAdapter";
import {
  HistoryCoordinator,
  HistoryReplacementCancelledError,
  type HistoryReplacementResult,
} from "../history/historyCoordinator";
import { deserializeSceneData } from "../editor/sceneSerializer";
import {
  createHistoryClient,
  HistoryReplaceResponseLostError,
  HistoryReplaceStatusError,
} from "../history/historyClient";
import {
  HistoryPanel,
  type HistoryPanelStatus,
  type HistorySuccessNotice,
} from "../history/HistoryPanel";
import type { HistoryVersionView } from "../history/HistoryList";
import { ReadonlyPreviewCanvas } from "../history/ReadonlyPreviewCanvas";
import {
  prepareImport,
  type ImportSelection,
} from "../history/importProtection";
import type { ProtectedInputHandlers } from "../history/protectedInput";
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
  setNativeMenuCommandEnabled,
  type NativeMenuCommand,
} from "./nativeMenu";
import {
  initializeBrowserThemeController,
  type ThemeController,
} from "./theme/themeController";
import { createNativeMenuSync } from "./nativeMenuSync";
import {
  DescribedError,
  describeError,
  LocalizedError,
} from "../i18n/describeError";
import {
  initializeBrowserLocaleController,
  t as translateNow,
  useI18n,
  type LocaleController,
  type MessageKey,
} from "../i18n";

/**
 * User-facing shell status kept in React state as data, so it re-translates
 * when the UI language changes instead of freezing the language at set time.
 */
type ShellMessage =
  | { readonly key: MessageKey }
  | { readonly error: unknown; readonly fallback: MessageKey }
  | { readonly text: string };

function fileOperationError(error: unknown): ShellMessage {
  return { error, fallback: "error.fileOperationFailed" };
}

function renderShellMessage(message: ShellMessage): string {
  if ("key" in message) return translateNow(message.key);
  if ("text" in message) return message.text;
  return describeError(message.error, message.fallback);
}

interface AppShellProps {
  onCreateDocument?: () => void | Promise<void>;
  onOpenWorkspace?: () => void | Promise<void>;
  workspaceInvoker?: CommandInvoker;
  selectWorkspaceDirectory?: () => Promise<string | null>;
  themeController?: ThemeController;
  localeController?: LocaleController;
}

export function AppShell({
  onCreateDocument,
  onOpenWorkspace,
  workspaceInvoker: providedWorkspaceInvoker,
  selectWorkspaceDirectory = selectNativeWorkspaceDirectory,
  themeController = initializeBrowserThemeController(),
  localeController = initializeBrowserLocaleController([]),
}: AppShellProps) {
  useI18n();
  const [interactionError, setInteractionError] = useState<ShellMessage | null>(
    null,
  );
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
  const historyFrontendDriverRef = useRef<
    | {
        attachEditor(documentId: string, adapter: ExcalidrawAdapter): void;
        start(): void;
      }
    | undefined
  >(undefined);
  const editorAdaptersRef = useRef(new Map<string, ExcalidrawAdapter>());
  const editorControlsRef = useRef(new Map<string, EditorControls>());
  const [canvasPreferencesById, setCanvasPreferencesById] = useState<
    Readonly<Record<string, EditorPreferences>>
  >({});
  const [historyBusyDocumentIds, setHistoryBusyDocumentIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
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
  const [historyFeedback, setHistoryFeedback] = useState<MessageKey | null>(
    null,
  );
  const [historyNotice, setHistoryNotice] = useState<
    (HistorySuccessNotice & { id: number }) | null
  >(null);
  const historyNoticeSequenceRef = useRef(0);
  const historyNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPanelWidth, setHistoryPanelWidth] = useState(360);
  const [historyItems, setHistoryItems] = useState<HistoryVersionView[]>([]);
  const [historySelectedVersionId, setHistorySelectedVersionId] = useState<
    string | null
  >(null);
  const [historyPanelStatus, setHistoryPanelStatus] =
    useState<HistoryPanelStatus>("empty");
  const [historyPanelMessage, setHistoryPanelMessage] =
    useState<ShellMessage>();
  const [historyPreviewVersionId, setHistoryPreviewVersionId] = useState<
    string | null
  >(null);
  const [historyPreviewState, setHistoryPreviewState] = useState<
    "loading" | "ready" | "error"
  >("ready");
  const [historyPreviewRenderedVersionId, setHistoryPreviewRenderedVersionId] =
    useState<string | null>(null);
  const [historyPreviewContent, setHistoryPreviewContent] =
    useState<ReactNode>(null);
  const [historyPreviewHost, setHistoryPreviewHost] =
    useState<HTMLDivElement | null>(null);
  const clearHistoryNotice = useCallback(() => {
    historyNoticeSequenceRef.current += 1;
    if (historyNoticeTimerRef.current !== null) {
      clearTimeout(historyNoticeTimerRef.current);
      historyNoticeTimerRef.current = null;
    }
    setHistoryNotice(null);
  }, []);
  const showHistoryNotice = useCallback((notice: HistorySuccessNotice) => {
    if (historyNoticeTimerRef.current !== null) {
      clearTimeout(historyNoticeTimerRef.current);
    }
    const id = ++historyNoticeSequenceRef.current;
    setHistoryNotice({ ...notice, id });
    historyNoticeTimerRef.current = setTimeout(() => {
      if (historyNoticeSequenceRef.current !== id) return;
      historyNoticeTimerRef.current = null;
      setHistoryNotice(null);
    }, 4000);
  }, []);
  useEffect(
    () => () => {
      if (historyNoticeTimerRef.current !== null) {
        clearTimeout(historyNoticeTimerRef.current);
      }
    },
    [],
  );
  const historyPanelRequestRef = useRef(0);
  const historyOpenRef = useRef(historyOpen);
  historyOpenRef.current = historyOpen;
  const [pendingHistory, setPendingHistory] = useState<
    Readonly<Record<string, string>>
  >({});
  const retryInFlightRef = useRef(new Set<string>());
  const [retryingHistory, setRetryingHistory] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
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
  const [historyClient] = useState(() => createHistoryClient(workspaceInvoker));
  const historyCoordinatorRef = useRef<HistoryCoordinator | null>(null);
  useEffect(() => {
    historyCoordinatorRef.current = new HistoryCoordinator(
      documentManager,
      historyClient,
      async (scene, context) => {
        const adapter = editorAdaptersRef.current.get(context.documentId);
        if (adapter === undefined) return false;
        await adapter.replaceScene(scene);
        return context.commit(adapter.readScene());
      },
    );
    return () => {
      historyCoordinatorRef.current = null;
    };
  }, [historyClient]);
  const requireHistoryCoordinator = (): HistoryCoordinator => {
    const coordinator = historyCoordinatorRef.current;
    if (coordinator === null) {
      throw new LocalizedError("history.error.notReady");
    }
    return coordinator;
  };
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string | null>(
    () => preferences.getSnapshot().currentWorkspaceId,
  );
  const [welcomeWorkspaces, setWelcomeWorkspaces] = useState<Workspace[]>([]);
  const [mountedWorkspaces, setMountedWorkspaces] = useState<Workspace[]>([]);
  const workspaceRevisionRef = useRef(0);
  const [welcomeBusy, setWelcomeBusy] = useState(false);
  const [welcomeError, setWelcomeError] = useState<ShellMessage | null>(null);
  const [welcomeErrorVisuallyHidden, setWelcomeErrorVisuallyHidden] =
    useState(false);
  const [unavailableWorkspaceId, setUnavailableWorkspaceId] = useState<
    string | null
  >(null);
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
  useEffect(() => {
    if (activeDocumentId === null) return;
    const coordinator = historyCoordinatorRef.current;
    if (coordinator === null) return;
    let cancelled = false;
    void coordinator
      .adoptDeferred(activeDocumentId)
      .then((adopted) => {
        if (!adopted || cancelled) return;
        setHistoryBusyDocumentIds((current) => {
          const next = new Set(current);
          next.delete(activeDocumentId);
          return next;
        });
        setPendingHistory((current) => {
          const next = { ...current };
          delete next[activeDocumentId];
          return next;
        });
        const adapter = editorAdaptersRef.current.get(activeDocumentId);
        const session =
          documentManager.store.getState().sessionsById[activeDocumentId];
        adapter?.setReadOnly(session?.saveState === "conflicted");
        setHistoryFeedback("shell.history.replacementVerified");
      })
      .catch((error: unknown) => {
        if (!cancelled) setInteractionError(fileOperationError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [activeDocumentId]);
  const historyPanelText =
    historyPanelMessage === undefined
      ? undefined
      : renderShellMessage(historyPanelMessage);
  const documentSessions = Object.values(sessionsById);
  useEffect(() => {
    for (const documentId of editorAdaptersRef.current.keys()) {
      if (sessionsById[documentId] === undefined) {
        editorAdaptersRef.current.delete(documentId);
      }
    }
  }, [sessionsById]);
  const exportReady =
    activeSession !== undefined && readyEditor?.documentId === activeSession.id;
  const startupRoute = deriveStartupRoute({
    handshake:
      startupState.handshake ??
      ({ abnormalExit: false, pendingOpenPaths: [] } as const),
    recoveryCandidates: startupState.candidates,
    currentWorkspaceId,
    workspaces: mountedWorkspaces,
    openDocumentCount: documentSessions.length,
  });
  const showWelcome =
    startupState.status === "ready" && startupRoute.kind === "welcome";
  const themeSnapshot = useSyncExternalStore(
    themeController.subscribe,
    themeController.getSnapshot,
    themeController.getSnapshot,
  );
  const localeSnapshot = useSyncExternalStore(
    localeController.subscribe,
    localeController.getSnapshot,
    localeController.getSnapshot,
  );
  const clearWelcomeError = useCallback((): void => {
    setWelcomeError(null);
    setWelcomeErrorVisuallyHidden(false);
  }, []);
  const reportWelcomeError = useCallback(
    (error: unknown, visuallyHidden = false): void => {
      setWelcomeError(fileOperationError(error));
      setWelcomeErrorVisuallyHidden(visuallyHidden);
    },
    [],
  );
  const runAction = async (action: () => void | Promise<unknown>) => {
    setInteractionError(null);
    try {
      await action();
    } catch (error) {
      setInteractionError(fileOperationError(error));
    }
  };

  const closeOpenDocumentsForWorkspaceSwitch = async (): Promise<void> => {
    const tabOrder = documentManager.store.getState().tabOrder;
    const outcome = await documentManager.closeMany(tabOrder);
    if (outcome.status !== "closed") {
      throw outcome.status === "failed"
        ? new DescribedError(outcome.message)
        : new LocalizedError("error.closeBeforeWorkspaceSwitch");
    }
  };

  const selectCurrentWorkspace = useCallback(
    (workspace: Workspace): void => {
      preferences.setCurrentWorkspaceId(workspace.id);
      setCurrentWorkspaceId(workspace.id);
      setUnavailableWorkspaceId(null);
      clearWelcomeError();
    },
    [clearWelcomeError, preferences],
  );

  const handleMountedWorkspacesChange = useCallback(
    (items: Workspace[]): void => {
      workspaceRevisionRef.current += 1;
      setMountedWorkspaces(items);
      setUnavailableWorkspaceId((current) =>
        items.some((workspace) => workspace.id === current) ? null : current,
      );
      void workspaceInvoker
        .invoke("workspace_recent_list", {})
        .then(setWelcomeWorkspaces)
        .catch((error: unknown) => reportWelcomeError(error));
    },
    [reportWelcomeError, workspaceInvoker],
  );

  const handleCurrentWorkspaceChange = useCallback(
    (workspace: Workspace | null): void => {
      preferences.setCurrentWorkspaceId(workspace?.id ?? null);
      setCurrentWorkspaceId(workspace?.id ?? null);
      setUnavailableWorkspaceId(null);
      clearWelcomeError();
    },
    [clearWelcomeError, preferences],
  );

  const openWorkspace = async (): Promise<void> => {
    if (onOpenWorkspace !== undefined) {
      await onOpenWorkspace();
      setUnavailableWorkspaceId(null);
      clearWelcomeError();
      return;
    }
    setWelcomeBusy(true);
    clearWelcomeError();
    try {
      const rootPath = await selectWorkspaceDirectory();
      if (rootPath === null) return;
      await closeOpenDocumentsForWorkspaceSwitch();
      const workspace = await workspaceInvoker.invoke("workspace_add", {
        rootPath,
      });
      workspaceRevisionRef.current += 1;
      selectCurrentWorkspace(workspace);
      setWelcomeWorkspaces((current) => [
        ...current.filter((item) => item.id !== workspace.id),
        workspace,
      ]);
      setMountedWorkspaces((current) => [
        ...current.filter((item) => item.id !== workspace.id),
        workspace,
      ]);
    } catch (error) {
      reportWelcomeError(error);
    } finally {
      setWelcomeBusy(false);
    }
  };

  const openRecentWorkspace = async (workspace: Workspace): Promise<void> => {
    setWelcomeBusy(true);
    clearWelcomeError();
    try {
      await closeOpenDocumentsForWorkspaceSwitch();
    } catch (error) {
      reportWelcomeError(error);
      setWelcomeBusy(false);
      return;
    }
    try {
      const remounted = await workspaceInvoker.invoke("workspace_remount", {
        workspaceId: workspace.id,
      });
      workspaceRevisionRef.current += 1;
      selectCurrentWorkspace(remounted);
      setMountedWorkspaces((current) => [
        ...current.filter((item) => item.id !== remounted.id),
        remounted,
      ]);
    } catch (error) {
      reportWelcomeError(error, true);
      setUnavailableWorkspaceId(workspace.id);
    } finally {
      setWelcomeBusy(false);
    }
  };

  const removeRecentWorkspace = async (workspace: Workspace): Promise<void> => {
    setWelcomeBusy(true);
    clearWelcomeError();
    try {
      await workspaceInvoker.invoke("workspace_recent_remove", {
        workspaceId: workspace.id,
      });
      workspaceRevisionRef.current += 1;
      setUnavailableWorkspaceId((current) =>
        current === workspace.id ? null : current,
      );
      setWelcomeWorkspaces((current) =>
        current.filter((item) => item.id !== workspace.id),
      );
    } catch (error) {
      reportWelcomeError(error);
    } finally {
      setWelcomeBusy(false);
    }
  };

  const createWelcomeDrawing = async (): Promise<void> => {
    setWelcomeBusy(true);
    clearWelcomeError();
    try {
      await (onCreateDocument === undefined
        ? documentManager.createUntitled()
        : onCreateDocument());
    } catch (error) {
      reportWelcomeError(error);
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
    const requestedRevision = workspaceRevisionRef.current;
    void Promise.all([
      workspaceInvoker.invoke("workspace_list", {}),
      workspaceInvoker.invoke("workspace_recent_list", {}),
    ])
      .then(([items, recentItems]) => {
        if (disposed || workspaceRevisionRef.current !== requestedRevision)
          return;
        setMountedWorkspaces(items);
        setWelcomeWorkspaces(recentItems);
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
        if (!disposed) reportWelcomeError(error);
      });
    return () => {
      disposed = true;
    };
  }, [
    preferences,
    reportWelcomeError,
    selectCurrentWorkspace,
    workspaceInvoker,
  ]);

  const saveDocument = () =>
    runAction(() => documentManager.checkpointActive("manualSave"));
  const prepareUnsavedHistoryDocument = async (capture: {
    documentId: string;
  }) => {
    const session =
      documentManager.store.getState().sessionsById[capture.documentId];
    if (session === undefined) {
      throw new LocalizedError("history.error.drawingClosed");
    }
    const path = await chooseSavePath(session.title);
    if (path === null) return { status: "cancelled" as const };
    if (
      documentManager.store.getState().activeDocumentId !== capture.documentId
    ) {
      return { status: "cancelled" as const };
    }
    await documentManager.saveOrphanedAs(capture.documentId, path);
    return { status: "saved" as const };
  };
  const runProtectedReplacement = async (
    documentId: string,
    replace: () => Promise<HistoryReplacementResult>,
    successMessage: MessageKey,
  ): Promise<void> => {
    setHistoryFeedback(null);
    const editor = editorAdaptersRef.current.get(documentId);
    if (
      editor === undefined ||
      documentManager.store.getState().activeDocumentId !== documentId
    ) {
      throw new LocalizedError("history.error.drawingNotReady");
    }
    setHistoryBusyDocumentIds((current) => new Set(current).add(documentId));
    editor.setReadOnly(true);
    try {
      const result = await replace();
      if (!result.adopted) {
        setPendingHistory((current) => ({
          ...current,
          [documentId]: result.response.requestId,
        }));
        throw new LocalizedError("history.error.replacementUnverified");
      }
      setPendingHistory((current) => {
        const next = { ...current };
        delete next[documentId];
        return next;
      });
      setHistoryFeedback(successMessage);
    } catch (error) {
      if (error instanceof HistoryReplaceResponseLostError) {
        setPendingHistory((current) => ({
          ...current,
          [documentId]: error.requestId,
        }));
        throw new LocalizedError(
          "history.error.replacementUnverified",
          undefined,
          { cause: error },
        );
      }
      if (!(error instanceof HistoryReplacementCancelledError)) throw error;
    } finally {
      const current = documentManager.store.getState().sessionsById[documentId];
      if (!documentManager.isHistoryFrozen(documentId)) {
        setHistoryBusyDocumentIds((current) => {
          const next = new Set(current);
          next.delete(documentId);
          return next;
        });
        if (editorAdaptersRef.current.get(documentId) === editor) {
          editor.setReadOnly(current?.saveState === "conflicted");
        }
      }
    }
  };
  const retryPendingHistory = async (): Promise<void> => {
    const documentId = documentManager.store.getState().activeDocumentId;
    if (documentId === null) return;
    const requestId = pendingHistory[documentId];
    if (requestId === undefined) return;
    const retryKey = `${documentId}:${requestId}`;
    if (retryInFlightRef.current.has(retryKey)) return;
    retryInFlightRef.current.add(retryKey);
    setRetryingHistory((current) => new Set(current).add(documentId));
    try {
      await runAction(async () => {
        try {
          const coordinator = requireHistoryCoordinator();
          const adopted =
            (await coordinator.adoptDeferred(documentId)) ||
            (await coordinator.resolvePending(documentId, requestId)).adopted;
          if (!adopted) {
            throw new LocalizedError(
              "history.error.replacementStillUnverified",
            );
          }
          setPendingHistory((current) => {
            const next = { ...current };
            delete next[documentId];
            return next;
          });
          setHistoryFeedback("shell.history.replacementVerified");
        } catch (error) {
          if (error instanceof HistoryReplaceStatusError) {
            setPendingHistory((current) => {
              const next = { ...current };
              delete next[documentId];
              return next;
            });
          }
          throw error;
        } finally {
          if (!documentManager.isHistoryFrozen(documentId)) {
            setHistoryBusyDocumentIds((current) => {
              const next = new Set(current);
              next.delete(documentId);
              return next;
            });
            const adapter = editorAdaptersRef.current.get(documentId);
            const session =
              documentManager.store.getState().sessionsById[documentId];
            adapter?.setReadOnly(session?.saveState === "conflicted");
          }
        }
      });
    } finally {
      retryInFlightRef.current.delete(retryKey);
      setRetryingHistory((current) => {
        const next = new Set(current);
        next.delete(documentId);
        return next;
      });
    }
  };
  const protectedInputFor = (documentId: string): ProtectedInputHandlers => ({
    onClear: () =>
      runAction(() =>
        runProtectedReplacement(
          documentId,
          () =>
            requireHistoryCoordinator().clear(documentId, undefined, {
              prepareUnsaved: prepareUnsavedHistoryDocument,
            }),
          "shell.history.clearSaved",
        ),
      ),
    onImportShortcut: () =>
      runAction(async () => {
        const files = await chooseImportFiles();
        if (files === null) return;
        await importIntoDocument(documentId, files);
      }),
    onSceneDrop: (drop) =>
      runAction(async () => {
        const prepared = await prepareImport(drop.files);
        if (prepared.status === "ordinaryImage") {
          if (
            documentManager.store.getState().activeDocumentId !== documentId
          ) {
            throw new LocalizedError(
              "history.error.drawingSwitchedDuringImage",
            );
          }
          drop.forwardOrdinaryImage();
          return;
        }
        await replacePreparedImport(documentId, prepared);
      }),
    onError: (error) => setInteractionError(fileOperationError(error)),
  });
  const importIntoDocument = async (
    documentId: string,
    files: ImportSelection,
  ): Promise<void> => {
    await replacePreparedImport(documentId, await prepareImport(files));
  };
  const replacePreparedImport = async (
    documentId: string,
    prepared: Awaited<ReturnType<typeof prepareImport>>,
  ): Promise<void> => {
    if (prepared.status === "cancelled") return;
    if (prepared.status === "multiple") {
      throw new LocalizedError("error.importMultipleDrawings");
    }
    if (prepared.status === "ordinaryImage") {
      throw new LocalizedError("history.error.imageHasNoDrawing");
    }
    await runProtectedReplacement(
      documentId,
      () =>
        requireHistoryCoordinator().replaceImportedScene(
          documentId,
          prepared.candidate,
          undefined,
          { prepareUnsaved: prepareUnsavedHistoryDocument },
        ),
      "shell.history.importSaved",
    );
  };
  const openExportDialog = (): void => {
    if (!exportReady || activeSession === undefined) {
      setInteractionError({ key: "shell.exportUnavailable" });
      return;
    }
    setInteractionError(null);
    setExportDocumentId(activeSession.id);
  };
  const closeExportDialog = (): void => {
    setExportDocumentId(null);
  };

  const loadHistoryPanel = useCallback(
    async (preserveAvailableRows = false): Promise<void> => {
      if (
        !historyOpenRef.current ||
        documentManager.store.getState().activeDocumentId !== activeDocumentId
      )
        return;
      const session =
        activeDocumentId === null
          ? undefined
          : documentManager.store.getState().sessionsById[activeDocumentId];
      if (session === undefined || session.path.length === 0) {
        setHistoryItems([]);
        setHistoryPanelStatus("empty");
        setHistoryPanelMessage(undefined);
        return;
      }
      const request = ++historyPanelRequestRef.current;
      setHistoryPanelStatus((current) =>
        preserveAvailableRows && current === "available" ? current : "loading",
      );
      setHistoryPanelMessage(undefined);
      try {
        const response = await historyClient.list({
          document: historyDocumentLocator(session),
        });
        if (
          request !== historyPanelRequestRef.current ||
          !historyOpenRef.current ||
          documentManager.store.getState().activeDocumentId !== session.id
        )
          return;
        setHistoryItems(
          response.items.map((item) => ({
            ...item,
            summary: "",
            summaryReliable: false,
          })),
        );
        if (response.pendingIssue !== undefined) {
          setHistoryPanelStatus("error");
          const { code, message } = response.pendingIssue;
          setHistoryPanelMessage({
            text:
              code === "HISTORY_OPERATION_PENDING" &&
              message === "The history operation is pending reconciliation."
                ? ""
                : message,
          });
        } else {
          setHistoryPanelStatus(
            response.items.length === 0 ? "empty" : "available",
          );
        }
      } catch (error) {
        if (
          request !== historyPanelRequestRef.current ||
          !historyOpenRef.current ||
          documentManager.store.getState().activeDocumentId !== session.id
        )
          return;
        setHistoryPanelStatus("error");
        setHistoryPanelMessage(fileOperationError(error));
      }
    },
    [activeDocumentId, historyClient],
  );

  const openVersionHistory = useCallback((): void => {
    const session =
      activeDocumentId === null
        ? undefined
        : documentManager.store.getState().sessionsById[activeDocumentId];
    if (session === undefined || session.path.length === 0) {
      setInteractionError({ key: "shell.historySavedOnly" });
      return;
    }
    setInteractionError(null);
    clearHistoryNotice();
    setHistoryOpen(true);
  }, [activeDocumentId, clearHistoryNotice]);

  const closeVersionHistory = useCallback((): void => {
    historyPanelRequestRef.current += 1;
    clearHistoryNotice();
    setHistoryOpen(false);
    setHistorySelectedVersionId(null);
    setHistoryPreviewVersionId(null);
    setHistoryPreviewState("ready");
    setHistoryPreviewRenderedVersionId(null);
    setHistoryPreviewContent(null);
  }, [clearHistoryNotice]);

  useEffect(() => {
    if (!historyOpen) return;
    setHistorySelectedVersionId(null);
    setHistoryPreviewVersionId(null);
    setHistoryPreviewState("ready");
    setHistoryPreviewRenderedVersionId(null);
    setHistoryPreviewContent(null);
    void loadHistoryPanel();
  }, [activeDocumentId, historyOpen, loadHistoryPanel]);

  const previewHistoryVersion = useCallback(
    (item: HistoryVersionView): void => {
      const session =
        activeDocumentId === null
          ? undefined
          : documentManager.store.getState().sessionsById[activeDocumentId];
      if (session === undefined || session.path.length === 0) return;
      const request = ++historyPanelRequestRef.current;
      setHistoryPreviewVersionId(item.versionId);
      setHistoryPreviewState("loading");
      setHistoryPreviewRenderedVersionId(null);
      setHistoryPanelMessage(undefined);
      setHistoryPreviewContent(null);
      void historyClient
        .preview({
          document: historyDocumentLocator(session),
          versionId: item.versionId,
        })
        .then((response) => {
          if (request !== historyPanelRequestRef.current) return;
          const scene = deserializeSceneData(response.scene);
          setHistoryPreviewContent(
            <ReadonlyPreviewCanvas
              onError={(error) => {
                if (request !== historyPanelRequestRef.current) return;
                setHistoryPreviewRenderedVersionId(null);
                setHistoryPreviewState("error");
                setHistoryPanelMessage(fileOperationError(error));
              }}
              onRendered={() => {
                if (request !== historyPanelRequestRef.current) return;
                setHistoryPreviewRenderedVersionId(response.versionId);
              }}
              scene={scene}
              theme={themeSnapshot.resolvedColorScheme}
            />,
          );
          setHistoryPreviewState("ready");
        })
        .catch((error: unknown) => {
          if (request !== historyPanelRequestRef.current) return;
          setHistoryPreviewRenderedVersionId(null);
          setHistoryPreviewState("error");
          setHistoryPanelMessage(fileOperationError(error));
        });
    },
    [activeDocumentId, historyClient, themeSnapshot.resolvedColorScheme],
  );

  const restoreHistoryVersion = useCallback(
    async (item: HistoryVersionView): Promise<void> => {
      const documentId = documentManager.store.getState().activeDocumentId;
      if (documentId === null) return;
      await runProtectedReplacement(
        documentId,
        () =>
          requireHistoryCoordinator().replace(documentId, {
            kind: "restore",
            versionId: item.versionId,
          }),
        "shell.history.restored",
      );
      setHistoryOpen(false);
      setHistoryPreviewVersionId(null);
      setHistoryPreviewRenderedVersionId(null);
      await loadHistoryPanel();
    },
    [loadHistoryPanel],
  );

  const markCurrentHistoryVersion = useCallback(async () => {
    const documentId = documentManager.store.getState().activeDocumentId;
    if (documentId === null) return null;
    const outcome = await requireHistoryCoordinator().mark(documentId, {
      prepareUnsaved: prepareUnsavedHistoryDocument,
    });
    if (outcome.status === "cancelled") return null;
    if (documentManager.store.getState().activeDocumentId !== documentId)
      return null;
    setHistorySelectedVersionId(outcome.response.versionId);
    await loadHistoryPanel(true);
    return {
      versionId: outcome.response.versionId,
      reused: outcome.response.reused,
    };
  }, [loadHistoryPanel]);

  const deleteHistoryVersion = useCallback(
    async (item: HistoryVersionView): Promise<void> => {
      const session =
        activeDocumentId === null
          ? undefined
          : documentManager.store.getState().sessionsById[activeDocumentId];
      if (session === undefined || session.path.length === 0) return;
      await historyClient.delete({
        document: historyDocumentLocator(session),
        requestId: createHistoryRequestId(),
        versionId: item.versionId,
      });
      if (
        !historyOpenRef.current ||
        documentManager.store.getState().activeDocumentId !== session.id
      )
        return;
      setHistoryPreviewVersionId(null);
      setHistorySelectedVersionId((selected) =>
        selected === item.versionId ? null : selected,
      );
      await loadHistoryPanel();
    },
    [activeDocumentId, historyClient, loadHistoryPanel],
  );

  const setHistoryVersionMarked = useCallback(
    async (item: HistoryVersionView, marked: boolean) => {
      const session =
        activeDocumentId === null
          ? undefined
          : documentManager.store.getState().sessionsById[activeDocumentId];
      if (session === undefined || session.path.length === 0) return;
      const response = await historyClient.setMarked({
        document: historyDocumentLocator(session),
        requestId: createHistoryRequestId(),
        versionId: item.versionId,
        marked,
      });
      if (
        !historyOpenRef.current ||
        documentManager.store.getState().activeDocumentId !== session.id
      )
        return response;
      if (!response.retained) {
        setHistorySelectedVersionId((selected) =>
          selected === item.versionId ? null : selected,
        );
      }
      await loadHistoryPanel(true);
      return response;
    },
    [activeDocumentId, historyClient, loadHistoryPanel],
  );

  useEffect(() => {
    nativeMenuHandlerRef.current = createNativeMenuCommandHandler({
      onSave: () => void saveDocument(),
      onExportImage: openExportDialog,
      onVersionHistory: openVersionHistory,
      onAppearance: (mode) =>
        void runAction(() => themeController.setModePreference(mode)),
      onLanguage: (preference) => localeController.setPreference(preference),
      onHelp: () => activeEditorControls()?.openHelp(),
      onTogglePreference: (preference) =>
        activeEditorControls()?.togglePreference(preference),
    });
  });

  // Help and preference commands are ignored when no document is active.
  const activeEditorControls = () => {
    const documentId = documentManager.store.getState().activeDocumentId;
    return documentId === null
      ? undefined
      : editorControlsRef.current.get(documentId);
  };
  const handleEditorControlsReady = useCallback(
    (documentId: string, controls: EditorControls) => {
      editorControlsRef.current.set(documentId, controls);
    },
    [],
  );
  const handleEditorPreferencesChange = useCallback(
    (documentId: string, preferences: EditorPreferences) => {
      setCanvasPreferencesById((current) => ({
        ...current,
        [documentId]: preferences,
      }));
    },
    [],
  );
  const activePreferences =
    activeSession === undefined
      ? undefined
      : canvasPreferencesById[activeSession.id];

  const [syncNativeMenu] = useState(() =>
    createNativeMenuSync(workspaceInvoker),
  );
  const forcedReadOnly =
    activeSession !== undefined &&
    (activeSession.saveState === "conflicted" ||
      historyBusyDocumentIds.has(activeSession.id));
  useEffect(() => {
    if (!hasNativeWindowRuntime()) return;
    void syncNativeMenu(localeSnapshot.resolvedLanguage, {
      language: localeSnapshot.preference,
      appearance: themeSnapshot.preference.modePreference,
      hasDocument: activeSession !== undefined,
      forcedReadOnly,
      toolLock: activePreferences?.toolLock ?? false,
      grid: activePreferences?.grid ?? false,
      snap: activePreferences?.snap ?? false,
      zen: activePreferences?.zen ?? false,
      viewMode: activePreferences?.viewMode ?? forcedReadOnly,
    }).catch((error: unknown) =>
      setInteractionError(fileOperationError(error)),
    );
  }, [
    activePreferences,
    activeSession,
    forcedReadOnly,
    localeSnapshot,
    syncNativeMenu,
    themeSnapshot.preference.modePreference,
  ]);

  const historyMenuEnabled =
    hasNativeWindowRuntime() &&
    activeSession !== undefined &&
    activeSession.path.length > 0;
  useEffect(() => {
    if (!hasNativeWindowRuntime()) return;
    void setNativeMenuCommandEnabled(
      workspaceInvoker,
      "versionHistory",
      historyMenuEnabled,
    ).catch((error: unknown) => setInteractionError(fileOperationError(error)));
  }, [historyMenuEnabled, workspaceInvoker]);
  const applyCloseOutcome = (outcome: CloseOutcome) => {
    if (outcome.status === "orphaned") {
      setOrphanCloseId(outcome.documentId);
      return;
    }
    if (outcome.status === "failed") {
      setInteractionError({ text: outcome.message });
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
      historyFrontendDriverRef.current?.attachEditor(documentId, adapter);
      editorAdaptersRef.current.set(documentId, adapter);
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
      .catch((error: unknown) =>
        setInteractionError(fileOperationError(error)),
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (import.meta.env.VITE_E2E_HISTORY_FRONTEND !== "1") {
      return;
    }
    let disposed = false;
    void import("../e2e/historyFrontendDriver")
      .then(({ nativeHistoryFrontendDriver }) => {
        if (disposed) return;
        historyFrontendDriverRef.current = nativeHistoryFrontendDriver;
        nativeHistoryFrontendDriver.start();
        const readyEditor = readyEditorRef.current;
        if (readyEditor !== undefined) {
          nativeHistoryFrontendDriver.attachEditor(
            readyEditor.documentId,
            readyEditor.adapter,
          );
        }
      })
      .catch((error: unknown) =>
        setInteractionError(fileOperationError(error)),
      );
    return () => {
      disposed = true;
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
      .catch((error: unknown) =>
        setInteractionError(fileOperationError(error)),
      );
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
      setInteractionError(fileOperationError(error)),
    )
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
        } else {
          unlisten = nextUnlisten;
        }
      })
      .catch((error: unknown) =>
        setInteractionError(fileOperationError(error)),
      );
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
    void registerDocumentHistoryEvents(documentManager)
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
        } else {
          unlisten = nextUnlisten;
        }
      })
      .catch((error: unknown) =>
        setInteractionError(fileOperationError(error)),
      );
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
      onError: (error) => setInteractionError(fileOperationError(error)),
    })
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten();
        } else {
          unlisten = nextUnlisten;
        }
      })
      .catch((error: unknown) =>
        setInteractionError(fileOperationError(error)),
      );
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
      .catch((error: unknown) =>
        setInteractionError(fileOperationError(error)),
      );
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
      .catch((error: unknown) =>
        setInteractionError(fileOperationError(error)),
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    // The native File > Save accelerator owns Command-S in the desktop shell;
    // handling the keydown as well would save twice per press.
    if (hasNativeWindowRuntime()) return;
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
        data-history-open={historyOpen ? "true" : "false"}
        data-sidebar-mode={sidebarSnapshot.mode}
      >
        <div
          className="shell-left"
          aria-label={translateNow("shell.navigation")}
          role="group"
        >
          <button
            aria-expanded={sidebarSnapshot.mode !== "hidden"}
            aria-controls="workspace-sidebar"
            aria-label={translateNow("shell.toggleSidebar")}
            className="icon-button shell-sidebar-toggle"
            onClick={() => {
              if (historyOpen) {
                closeVersionHistory();
                if (sidebarSnapshot.mode === "hidden") {
                  sidebarController.openOverlay();
                }
                return;
              }
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
            title={translateNow("shell.toggleSidebar")}
            type="button"
          >
            <img alt="" aria-hidden="true" src={sidebarIcon} />
          </button>
          <button
            aria-label={translateNow("shell.back")}
            className="icon-button shell-back-button"
            disabled={!canGoBack}
            onClick={goBack}
            title={translateNow("shell.back")}
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
          {historyFeedback !== null ? (
            <p role="status">{translateNow(historyFeedback)}</p>
          ) : null}
          {activeDocumentId !== null &&
          pendingHistory[activeDocumentId] !== undefined ? (
            <button
              disabled={retryingHistory.has(activeDocumentId)}
              onClick={() => void retryPendingHistory()}
              type="button"
            >
              {translateNow("shell.history.verifyReplacement")}
            </button>
          ) : null}
          <p
            className={
              interactionError
                ? "save-status save-status--error"
                : "save-status visually-hidden"
            }
            role="status"
            aria-live="polite"
          >
            {interactionError !== null
              ? renderShellMessage(interactionError)
              : getSaveStatus(activeSession?.saveState)}
          </p>
        </div>
      </header>

      {activeSession !== undefined && activeSession.lastReloadedAt !== null ? (
        <p className="reload-notice" role="status">
          {translateNow("shell.reloaded")}
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
        className={[
          "app-shell-body",
          sidebarSnapshot.mode === "pinned" && "app-shell-body--pinned",
          historyOpen && "app-shell-body--history",
        ]
          .filter(Boolean)
          .join(" ")}
        data-history-open={historyOpen ? "true" : "false"}
        data-sidebar-mode={sidebarSnapshot.mode}
        style={
          {
            "--history-panel-width": `${historyPanelWidth}px`,
          } as CSSProperties & Record<"--history-panel-width", string>
        }
      >
        {sidebarSnapshot.mode === "hidden" && !historyOpen ? (
          <div
            aria-hidden="true"
            className="sidebar-reveal-zone"
            data-testid="sidebar-reveal-zone"
            onPointerEnter={() => sidebarController.openOverlay()}
            style={{ position: "absolute" }}
          />
        ) : null}
        <aside
          aria-label={translateNow("shell.files")}
          className="file-sidebar"
          hidden={sidebarSnapshot.mode === "hidden" || historyOpen}
          id="workspace-sidebar"
          inert={sidebarSnapshot.mode === "hidden" || historyOpen}
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
              onWorkspacesChange={handleMountedWorkspacesChange}
              onCurrentWorkspaceChange={handleCurrentWorkspaceChange}
              onBrowse={handleBrowse}
              backLocation={backLocation}
              onBackLocationApplied={() => setBackLocation(null)}
            />
          ) : null}
          {sidebarSnapshot.mode === "pinned" ? (
            <div
              aria-label={translateNow("shell.resizeSidebar")}
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
          aria-label={translateNow("shell.canvas")}
          className={
            showWelcome
              ? "canvas-region canvas-region--welcome"
              : "canvas-region"
          }
        >
          <div
            className="canvas-current-content"
            inert={historyPreviewVersionId !== null}
          >
            {startupState.status === "ready" &&
            startupState.recoveredCount > 0 ? (
              <RecoveryNotice count={startupState.recoveredCount} />
            ) : null}
            {showWelcome ? (
              <WelcomeScreen
                busy={welcomeBusy}
                error={
                  welcomeError === null
                    ? null
                    : renderShellMessage(welcomeError)
                }
                errorVisuallyHidden={welcomeErrorVisuallyHidden}
                unavailableWorkspaceId={unavailableWorkspaceId}
                onNewDrawing={createWelcomeDrawing}
                onOpenRecentWorkspace={openRecentWorkspace}
                onOpenWorkspace={openWorkspace}
                onRemoveRecentWorkspace={removeRecentWorkspace}
                mountedWorkspaceIds={
                  new Set(mountedWorkspaces.map((workspace) => workspace.id))
                }
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
                    appearance={themeSnapshot.preference.modePreference}
                    documentId={session.id}
                    initialScene={session.scene}
                    protectedInput={protectedInputFor(session.id)}
                    onSceneChange={(scene) =>
                      documentManager.updateScene(session.id, scene)
                    }
                    onAppearanceChange={(mode) =>
                      void runAction(() =>
                        themeController.setModePreference(mode),
                      )
                    }
                    onControlsReady={handleEditorControlsReady}
                    onLanguageChange={(preference) =>
                      localeController.setPreference(preference)
                    }
                    onPreferencesChange={handleEditorPreferencesChange}
                    onReady={handleEditorReady}
                    readOnly={
                      session.saveState === "conflicted" ||
                      historyBusyDocumentIds.has(session.id)
                    }
                    theme={themeSnapshot.resolvedColorScheme}
                  />
                </section>
              ))
            ) : (
              <div className="canvas-empty-state">
                <p>{translateNow("shell.emptyState")}</p>
              </div>
            )}
          </div>
          {historyOpen &&
          historyNotice !== null &&
          activeSession !== undefined ? (
            <div
              aria-live="polite"
              className="history-action-notice"
              key={historyNotice.id}
              role="status"
            >
              <strong>{historyNotice.title}</strong>
              <span>{historyNotice.message}</span>
            </div>
          ) : null}
          <div className="history-preview-root" ref={setHistoryPreviewHost} />
        </main>
        {historyOpen && activeSession !== undefined ? (
          <HistoryPanel
            documentId={activeSession.id}
            key={activeSession.id}
            fileName={activeSession.title}
            width={historyPanelWidth}
            onWidthChange={setHistoryPanelWidth}
            items={historyItems.map((item) => ({
              ...item,
              summary: historySourceSummary(item.source, item.protectedAction),
            }))}
            selectedVersionId={historySelectedVersionId}
            onSelect={(item) => setHistorySelectedVersionId(item.versionId)}
            onClose={closeVersionHistory}
            onDelete={deleteHistoryVersion}
            onExitPreview={() => {
              historyPanelRequestRef.current += 1;
              setHistoryPreviewVersionId(null);
              setHistoryPreviewState("ready");
              setHistoryPreviewRenderedVersionId(null);
              setHistoryPreviewContent(null);
            }}
            onMark={markCurrentHistoryVersion}
            onSuccessNotice={showHistoryNotice}
            onClearSuccessNotice={clearHistoryNotice}
            onSetMarked={setHistoryVersionMarked}
            onPreview={previewHistoryVersion}
            onRestore={restoreHistoryVersion}
            previewContent={historyPreviewContent}
            previewPortalContainer={historyPreviewHost}
            previewErrorMessage={historyPanelText}
            restoreEnabled={
              historyPreviewRenderedVersionId === historyPreviewVersionId
            }
            previewState={historyPreviewState}
            previewVersionId={historyPreviewVersionId}
            processing={historyBusyDocumentIds.has(activeSession.id)}
            status={historyPanelStatus}
            statusMessage={historyPanelText}
            onRetry={() => void loadHistoryPanel()}
          />
        ) : null}
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
            sessionsById[orphanCloseId]?.title ??
            translateNow("shell.untitledDrawing")
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

function historyDocumentLocator(session: {
  path: string;
  historyDocumentId?: string;
}) {
  return session.historyDocumentId === undefined
    ? ({ kind: "path", path: session.path } as const)
    : ({ kind: "handle", documentId: session.historyDocumentId } as const);
}

const PROTECTED_ACTION_KEYS: Readonly<
  Record<NonNullable<HistoryVersionView["protectedAction"]>, MessageKey>
> = {
  restore: "shell.history.beforeRestore",
  clear: "shell.history.beforeClear",
  import: "shell.history.beforeImport",
};

function historySourceSummary(
  source: HistoryVersionView["source"],
  protectedAction: HistoryVersionView["protectedAction"],
): string {
  if (source === "protected" && protectedAction !== undefined) {
    return translateNow(PROTECTED_ACTION_KEYS[protectedAction]);
  }
  return translateNow(
    source === "automatic"
      ? "shell.history.automaticCheckpoint"
      : "shell.history.manualMark",
  );
}

function createHistoryRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `history-${Date.now()}`;
}

function getSaveStatus(saveState: DocumentSaveState | undefined): string {
  switch (saveState) {
    case "dirty":
      return translateNow("shell.saveStatus.dirty");
    case "savingDraft":
      return translateNow("shell.saveStatus.savingDraft");
    case "draftSaved":
      return translateNow("shell.saveStatus.draftSaved");
    case "checkpointing":
      return translateNow("shell.saveStatus.checkpointing");
    case "conflicted":
      return translateNow("shell.saveStatus.conflicted");
    case "orphaned":
      return translateNow("shell.saveStatus.orphaned");
    case "error":
      return translateNow("shell.saveStatus.error");
    case "clean":
      return translateNow("shell.saveStatus.clean");
    default:
      return translateNow("shell.saveStatus.none");
  }
}

async function chooseSavePath(defaultTitle: string): Promise<string | null> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({
    defaultPath: defaultTitle,
    filters: [
      {
        name: translateNow("shell.dialog.drawingFilter"),
        extensions: ["excalidraw", "excalidraw.json"],
      },
    ],
    title: translateNow("shell.dialog.saveDrawingAs"),
  });
}

function chooseImportFiles(): Promise<readonly File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".excalidraw,.excalidraw.json,.png,.svg";
    input.multiple = false;
    input.hidden = true;
    let settled = false;
    let focusTimer: number | undefined;
    const finish = (files: FileList | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(focusTimer);
      window.removeEventListener("focus", onWindowFocus);
      input.remove();
      resolve(files === null ? null : Array.from(files));
    };
    const onWindowFocus = () => {
      focusTimer = window.setTimeout(
        () => finish(input.files?.length ? input.files : null),
        300,
      );
    };
    input.addEventListener("change", () => finish(input.files), { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    window.addEventListener("focus", onWindowFocus, { once: true });
    document.body.append(input);
    input.click();
  });
}

async function selectNativeWorkspaceDirectory(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    directory: true,
    multiple: false,
    title: translateNow("shell.dialog.openWorkspace"),
  });
  return typeof selected === "string" ? selected : null;
}
