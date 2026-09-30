import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefCallback,
  type RefObject,
  type CSSProperties,
} from "react";
import { ApplicationDialog } from "../app/interaction/ApplicationDialog";
import { HistoryList, type HistoryVersionView } from "./HistoryList";
import {
  formatHistoryTimestamp,
  historyDateTime,
  historySourceLabel,
} from "./historyFormat";
import { HistoryPreview, type HistoryPreviewState } from "./HistoryPreview";
import { HistoryStateView, type HistoryStateKind } from "./HistoryStates";
import "./history.css";

export type HistoryPanelStatus = HistoryStateKind | "available";

export interface HistoryPanelProps {
  /** Stable active document identity, used to bind open row actions. */
  documentId?: string;
  fileName: string;
  width?: number;
  onWidthChange?: (width: number) => void;
  items?: readonly HistoryVersionView[];
  status?: HistoryPanelStatus;
  statusMessage?: string;
  currentVersionId?: string | null;
  selectedVersionId?: string | null;
  previewVersionId?: string | null;
  previewState?: HistoryPreviewState;
  previewErrorMessage?: string;
  previewContent?: ReactNode;
  /** Callers without a safe rendered preview must keep restore disabled. */
  restoreEnabled?: boolean;
  processing?: boolean;
  onClose(): void;
  onRetry?: () => void;
  onSelect?: (item: HistoryVersionView) => void;
  onPreview?: (item: HistoryVersionView) => void;
  onExitPreview?: (item: HistoryVersionView) => void;
  onRestore?: (item: HistoryVersionView) => void | Promise<void>;
  onDelete?: (item: HistoryVersionView) => void | Promise<void>;
  /** Marks the live canvas; the caller resolves only after durable publish. */
  onMark?: () => void | Promise<void | null | {
    versionId: string;
    reused: boolean;
  }>;
  /** Persists the selected version's mark state. */
  onSetMarked?: (
    item: HistoryVersionView,
    marked: boolean,
  ) => void | Promise<void | {
    versionId: string;
    marked: boolean;
    retained: boolean;
  }>;
  markProcessing?: boolean;
  markSuccessMessage?: string;
  markErrorMessage?: string;
  deleteProcessing?: boolean;
  deleteSuccessMessage?: string;
  deleteErrorMessage?: string;
  /** Additional caller-owned entries rendered inside More version actions. */
  moreActions?: ReactNode;
  triggerRef?: RefObject<HTMLElement | null>;
}

/**
 * App-owned history drawer composition. Data mutation and IPC remain callback
 * responsibilities of the caller; this component only owns presentation and
 * focus transitions between list and read-only preview.
 */
export function HistoryPanel({
  documentId,
  fileName,
  width,
  onWidthChange,
  items = [],
  status = "available",
  statusMessage,
  currentVersionId = null,
  selectedVersionId,
  previewVersionId,
  previewState = "ready",
  previewErrorMessage,
  previewContent,
  restoreEnabled = true,
  processing = false,
  onClose,
  onRetry,
  onSelect,
  onPreview,
  onExitPreview,
  onRestore,
  onDelete,
  onMark,
  onSetMarked,
  markProcessing = false,
  markSuccessMessage = "Version marked and saved to history.",
  markErrorMessage,
  deleteProcessing = false,
  deleteSuccessMessage = "Version deleted from history.",
  deleteErrorMessage,
  moreActions,
  triggerRef,
}: HistoryPanelProps) {
  const [internalWidth, setInternalWidth] = useState(360);
  const activeWidth = width ?? internalWidth;
  const resizeStartRef = useRef<{
    pointerId: number;
    x: number;
    width: number;
  } | null>(null);
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(
    selectedVersionId ?? items[0]?.versionId ?? null,
  );
  const [internalPreviewId, setInternalPreviewId] = useState<string | null>(
    previewVersionId ?? null,
  );
  const [markFeedback, setMarkFeedback] = useState<
    | { status: "success"; message: string }
    | { status: "error"; message: string }
    | null
  >(null);
  const [markBusy, setMarkBusy] = useState(false);
  const [setMarkedBusy, setSetMarkedBusy] = useState(false);
  const markIsProcessing = markProcessing || markBusy || setMarkedBusy;
  const [deleteFeedback, setDeleteFeedback] = useState<
    | { status: "success"; message: string }
    | { status: "error"; message: string }
    | null
  >(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const deleteIsProcessing = deleteProcessing || deleteBusy;
  const [openActionsTarget, setOpenActionsTarget] = useState<{
    documentId: string;
    item: HistoryVersionView;
    upward: boolean;
  } | null>(null);
  const [actionsTargetError, setActionsTargetError] = useState<string | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<{
    documentId: string;
    item: HistoryVersionView;
  } | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<{
    documentId: string;
    item: HistoryVersionView;
  } | null>(null);
  const actionsTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const deleteReturnFocusRef = useRef<HTMLButtonElement>(null);
  const restoreCancelRef = useRef<HTMLButtonElement>(null);
  const restoreReturnFocusRef = useRef<HTMLElement | null>(null);
  const selectedRestoreRef = useRef<HTMLButtonElement>(null);
  const previewRestoreRef = useRef<HTMLButtonElement>(null);
  const restoreInFlightRef = useRef(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const previewReturnIdRef = useRef<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (openActionsTarget === null) return;
    const firstAction = actionsMenuRef.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])',
    );
    firstAction?.focus();
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !actionsMenuRef.current?.contains(event.target) &&
        ![...actionsTriggerRefs.current.values()].some((trigger) =>
          trigger.contains(event.target as Node),
        )
      ) {
        setOpenActionsTarget(null);
      }
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer, true);
    return () => {
      document.removeEventListener(
        "pointerdown",
        dismissOnOutsidePointer,
        true,
      );
    };
  }, [openActionsTarget]);

  const activeDocumentKey = documentId ?? fileName;
  const deleteDocumentChanged =
    deleteTarget !== null && deleteTarget.documentId !== activeDocumentKey;
  const visibleDeleteTarget = deleteDocumentChanged ? null : deleteTarget;
  const visibleRestoreTarget =
    restoreTarget?.documentId === activeDocumentKey ? restoreTarget : null;
  const restoreTargetInvalidMessage =
    visibleRestoreTarget === null
      ? null
      : status !== "available"
        ? "Version history is changing. Cancel and reopen Restore when the list is ready."
        : !restoreEnabled
          ? "A safe preview is no longer available. Cancel and reopen Restore."
          : items.some(
                (item) =>
                  item.versionId === visibleRestoreTarget.item.versionId &&
                  item.availability.status === "available",
              )
            ? null
            : "This version is no longer available. Cancel and choose an available version.";
  const restoreDialogError = restoreTargetInvalidMessage ?? restoreError;
  const openTargetUnavailableMessage =
    openActionsTarget === null
      ? null
      : openActionsTarget.documentId !== activeDocumentKey
        ? "The history document changed. Reopen the version menu before acting."
        : items.some(
              (item) => item.versionId === openActionsTarget.item.versionId,
            )
          ? null
          : "This version is no longer available. Reopen the history menu to choose an available version.";

  const activeSelectedId =
    selectedVersionId ??
    (internalSelectedId !== null &&
    items.some((item) => item.versionId === internalSelectedId)
      ? internalSelectedId
      : (items[0]?.versionId ?? null));
  const activePreviewId = previewVersionId ?? internalPreviewId;
  const selectedItem =
    items.find((item) => item.versionId === activeSelectedId) ??
    (activeSelectedId === null ? items[0] : undefined);
  const previewItem = items.find((item) => item.versionId === activePreviewId);

  useEffect(() => {
    if (activePreviewId !== null || previewReturnIdRef.current === null) return;
    const returnId = previewReturnIdRef.current;
    previewReturnIdRef.current = null;
    rowRefs.current.get(returnId)?.focus();
  }, [activePreviewId]);

  const previousControlledSelectionRef = useRef<string | null | undefined>(
    undefined,
  );
  useEffect(() => {
    if (selectedVersionId === undefined) return;
    if (selectedVersionId === null) {
      previousControlledSelectionRef.current = null;
      return;
    }
    if (!items.some((item) => item.versionId === selectedVersionId)) return;
    const row = rowRefs.current.get(selectedVersionId);
    if (row === undefined) return;
    const selectionChanged =
      previousControlledSelectionRef.current !== selectedVersionId;
    previousControlledSelectionRef.current = selectedVersionId;
    if (selectionChanged) {
      row.scrollIntoView?.({ block: "nearest" });
      row.focus();
    }
  }, [items, selectedVersionId]);

  const selectItem = (item: HistoryVersionView) => {
    if (selectedVersionId === undefined) setInternalSelectedId(item.versionId);
    onSelect?.(item);
  };

  const openPreview = (item: HistoryVersionView) => {
    if (item.availability.status !== "available" || processing) return;
    selectItem(item);
    if (previewVersionId === undefined) setInternalPreviewId(item.versionId);
    onPreview?.(item);
  };

  const exitPreview = () => {
    if (previewItem === undefined) return;
    previewReturnIdRef.current = previewItem.versionId;
    if (previewVersionId === undefined) setInternalPreviewId(null);
    onExitPreview?.(previewItem);
  };

  const closePanel = () => {
    triggerRef?.current?.focus();
    onClose();
  };

  const setPanelWidth = (nextWidth: number) => {
    const clampedWidth = Math.max(300, Math.min(360, nextWidth));
    if (width === undefined) setInternalWidth(clampedWidth);
    onWidthChange?.(clampedWidth);
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 20 : 10;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = activeWidth + step;
    if (event.key === "ArrowRight") nextWidth = activeWidth - step;
    if (event.key === "Home") nextWidth = 300;
    if (event.key === "End") nextWidth = 360;
    if (nextWidth === null) return;
    event.preventDefault();
    setPanelWidth(nextWidth);
  };

  const handleResizePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    resizeStartRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      width: activeWidth,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const handleResizePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const start = resizeStartRef.current;
    if (start === null || start.pointerId !== event.pointerId) return;
    setPanelWidth(start.width - (event.clientX - start.x));
  };

  const handleResizePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeStartRef.current?.pointerId !== event.pointerId) return;
    resizeStartRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handleMark = async () => {
    if (onMark === undefined || processing || markIsProcessing) return;
    setMarkFeedback(null);
    setMarkBusy(true);
    try {
      const result = await onMark();
      if (result != null && selectedVersionId === undefined) {
        setInternalSelectedId(result.versionId);
      }
      if (result === null) return;
      setMarkFeedback({
        status: "success",
        message: result?.reused
          ? "Already marked. Selected the existing version."
          : markSuccessMessage,
      });
    } catch (error) {
      const message =
        markErrorMessage ??
        (error instanceof Error
          ? error.message
          : "The current version could not be marked.");
      setMarkFeedback({ status: "error", message });
    } finally {
      setMarkBusy(false);
    }
  };

  const handleSetMarked = async (item: HistoryVersionView, marked: boolean) => {
    if (processing || setMarkedBusy || onSetMarked === undefined) {
      return;
    }
    setMarkFeedback(null);
    setSetMarkedBusy(true);
    try {
      const result = await onSetMarked(item, marked);
      setMarkFeedback({
        status: "success",
        message: marked
          ? "Version marked."
          : result?.retained === false
            ? "Version unmarked and removed by the retention policy."
            : "Version unmarked.",
      });
    } catch (error) {
      const message =
        markErrorMessage ??
        (error instanceof Error
          ? error.message
          : "The selected version could not be updated.");
      setMarkFeedback({ status: "error", message });
    } finally {
      setSetMarkedBusy(false);
    }
  };

  const handlePanelKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('[role="dialog"]') !== null) {
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (openActionsTarget !== null) {
      setOpenActionsTarget(null);
      actionsTriggerRefs.current.get(openActionsTarget.item.versionId)?.focus();
      return;
    }
    if (activePreviewId !== null) {
      exitPreview();
    } else {
      closePanel();
    }
  };

  const handleDelete = async (item: HistoryVersionView) => {
    if (onDelete === undefined || processing || deleteIsProcessing) return;
    if (
      deleteTarget?.documentId !== activeDocumentKey ||
      deleteTarget.item.versionId !== item.versionId ||
      !items.some((candidate) => candidate.versionId === item.versionId)
    ) {
      setDeleteTarget(null);
      setActionsTargetError(
        "This version is no longer available. Reopen the history menu to choose an available version.",
      );
      return;
    }
    setDeleteFeedback(null);
    setDeleteBusy(true);
    try {
      await onDelete(item);
      deleteReturnFocusRef.current = closeButtonRef.current;
      setDeleteFeedback({ status: "success", message: deleteSuccessMessage });
      setDeleteTarget(null);
    } catch (error) {
      const message =
        deleteErrorMessage ??
        (error instanceof Error
          ? error.message
          : "The selected version could not be deleted.");
      setDeleteFeedback({ status: "error", message });
    } finally {
      setDeleteBusy(false);
    }
  };

  const requestRestore = (
    item: HistoryVersionView,
    trigger: HTMLButtonElement | null,
  ) => {
    if (
      onRestore === undefined ||
      processing ||
      restoreBusy ||
      !restoreEnabled ||
      status !== "available" ||
      item.availability.status !== "available" ||
      !items.some((candidate) => candidate.versionId === item.versionId)
    ) {
      return;
    }
    setRestoreError(null);
    restoreReturnFocusRef.current = trigger;
    setRestoreTarget({ documentId: activeDocumentKey, item });
  };

  const handleRestore = async () => {
    const target = visibleRestoreTarget;
    if (
      target === null ||
      onRestore === undefined ||
      processing ||
      restoreInFlightRef.current ||
      target.documentId !== activeDocumentKey
    ) {
      return;
    }
    if (restoreTargetInvalidMessage !== null) {
      return;
    }
    restoreInFlightRef.current = true;
    setRestoreBusy(true);
    try {
      await onRestore(target.item);
      setRestoreTarget(null);
    } catch (error) {
      setRestoreError(
        error instanceof Error
          ? error.message
          : "The selected version could not be restored.",
      );
    } finally {
      restoreInFlightRef.current = false;
      setRestoreBusy(false);
    }
  };

  const handleActionsMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const menuItems = [
      ...(actionsMenuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])',
      ) ?? []),
    ];
    const currentIndex = menuItems.indexOf(
      document.activeElement as HTMLElement,
    );
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpenActionsTarget(null);
      if (openActionsTarget !== null) {
        actionsTriggerRefs.current
          .get(openActionsTarget.item.versionId)
          ?.focus();
      }
      return;
    }
    let nextIndex: number | undefined;
    if (event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % menuItems.length;
    } else if (event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + menuItems.length) % menuItems.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = menuItems.length - 1;
    }
    if (nextIndex !== undefined && menuItems.length > 0) {
      event.preventDefault();
      menuItems[nextIndex]?.focus();
    }
  };

  const handleActionsMenuClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-history-action]",
    );
    if (action === null || openActionsTarget === null) return;
    const targetItem = openActionsTarget.item;
    const targetExists = items.some(
      (candidate) => candidate.versionId === targetItem.versionId,
    );
    if (openActionsTarget.documentId !== activeDocumentKey || !targetExists) {
      setActionsTargetError(
        "This version is no longer available. Reopen the history menu to choose an available version.",
      );
      setOpenActionsTarget(null);
      return;
    }
    const actionName = action.dataset.historyAction;
    if (actionName === "mark" || actionName === "unmark") {
      if (markIsProcessing) return;
      void handleSetMarked(targetItem, actionName === "mark");
      setOpenActionsTarget(null);
      actionsTriggerRefs.current.get(targetItem.versionId)?.focus();
    } else if (actionName === "delete") {
      if (processing || deleteIsProcessing || markIsProcessing) return;
      setOpenActionsTarget(null);
      deleteReturnFocusRef.current =
        actionsTriggerRefs.current.get(targetItem.versionId) ?? null;
      setDeleteFeedback(null);
      setDeleteTarget({ documentId: activeDocumentKey, item: targetItem });
    }
  };

  const toggleActionsMenu = (
    item: HistoryVersionView,
    isTargetOpen: boolean,
    trigger: HTMLButtonElement,
  ) => {
    setActionsTargetError(null);
    const scrollport = trigger.closest(".history-panel-body");
    const upward =
      scrollport !== null &&
      scrollport.getBoundingClientRect().bottom -
        trigger.getBoundingClientRect().top <
        116;
    setOpenActionsTarget(
      isTargetOpen ? null : { documentId: activeDocumentKey, item, upward },
    );
  };

  const registerActionsTrigger = (
    versionId: string,
  ): RefCallback<HTMLButtonElement> => {
    return (element) => {
      if (element === null) actionsTriggerRefs.current.delete(versionId);
      else actionsTriggerRefs.current.set(versionId, element);
    };
  };

  const actionsFor = (item: HistoryVersionView) => {
    const isTargetOpen =
      openActionsTarget?.documentId === activeDocumentKey &&
      openActionsTarget.item.versionId === item.versionId;
    const menuTarget = isTargetOpen ? openActionsTarget.item : null;
    if (onSetMarked === undefined && onDelete === undefined) return null;
    return (
      <div className="history-actions-anchor" key={item.versionId}>
        <button
          aria-expanded={isTargetOpen}
          aria-haspopup="menu"
          aria-disabled={markIsProcessing || undefined}
          aria-label={`More actions for ${historyTargetLabel(item)}`}
          className="history-actions-trigger"
          disabled={processing || deleteIsProcessing}
          onClick={(event) => {
            if (markIsProcessing) return;
            toggleActionsMenu(item, isTargetOpen, event.currentTarget);
          }}
          ref={registerActionsTrigger(item.versionId)}
          type="button"
        >
          <MoreIcon />
        </button>
        {menuTarget !== null ? (
          <div
            aria-label="More version actions"
            className={`history-actions-menu${openActionsTarget?.upward ? " is-upward" : ""}`}
            onClick={handleActionsMenuClick}
            onKeyDown={handleActionsMenuKeyDown}
            ref={actionsMenuRef}
            role="menu"
          >
            <div
              className="history-actions-menu-title"
              title={historyTargetLabel(menuTarget)}
            >
              {historyTargetLabel(menuTarget)}
            </div>
            {menuTarget.marked ? (
              <button
                className="history-actions-menu-item"
                disabled={
                  onSetMarked === undefined || processing || markIsProcessing
                }
                data-history-action="unmark"
                role="menuitem"
                type="button"
              >
                <BookmarkIcon />
                Unmark version
              </button>
            ) : onSetMarked !== undefined ? (
              <button
                className="history-actions-menu-item"
                disabled={processing || markIsProcessing}
                data-history-action="mark"
                role="menuitem"
                type="button"
              >
                <BookmarkIcon />
                Mark version
              </button>
            ) : null}
            {moreActions}
            {onDelete !== undefined ? (
              <>
                <div
                  aria-hidden="true"
                  className="history-actions-separator"
                  role="separator"
                />
                <button
                  className="history-actions-menu-item is-destructive"
                  disabled={
                    processing || deleteIsProcessing || markIsProcessing
                  }
                  data-history-action="delete"
                  role="menuitem"
                  type="button"
                >
                  <TrashIcon />
                  Delete version
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <aside
      aria-labelledby="history-panel-title"
      className={`history-panel${activeWidth === 300 ? " is-compact" : ""}`}
      data-history-panel="true"
      data-compact={activeWidth === 300 ? "true" : undefined}
      onKeyDown={handlePanelKeyDown}
      ref={panelRef}
      role="complementary"
      style={
        {
          "--history-panel-width": `${activeWidth}px`,
        } as CSSProperties & Record<"--history-panel-width", string>
      }
    >
      <div
        aria-describedby="history-panel-resize-help"
        aria-label="Resize version history panel"
        aria-orientation="vertical"
        aria-valuemax={360}
        aria-valuemin={300}
        aria-valuenow={activeWidth}
        className="history-panel-resize"
        onKeyDown={handleResizeKeyDown}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerUp}
        onPointerCancel={handleResizePointerUp}
        onLostPointerCapture={() => {
          resizeStartRef.current = null;
        }}
        role="separator"
        tabIndex={0}
      />
      <span className="visually-hidden" id="history-panel-resize-help">
        Left Arrow moves the divider left and increases width by 10 pixels;
        Right Arrow moves it right and decreases width by 10 pixels. Home sets
        300 pixels; End sets 360 pixels. Hold Shift to resize by 20 pixels.
      </span>
      <header className="history-panel-header">
        <div>
          <p className="history-panel-eyebrow">File history</p>
          <h1 id="history-panel-title">Version History</h1>
          <p className="history-panel-file-name" title={fileName}>
            {fileName}
          </p>
        </div>
        <button
          aria-label="Close version history"
          className="icon-button"
          onClick={closePanel}
          ref={closeButtonRef}
          type="button"
        >
          <CloseIcon />
          <span className="visually-hidden">Close</span>
        </button>
      </header>

      <div className="history-panel-main">
        <div className="history-panel-body">
          {(actionsTargetError ??
          openTargetUnavailableMessage ??
          (deleteDocumentChanged
            ? "The history document changed. Reopen the version menu before acting."
            : null)) ? (
            <p role="alert">
              {actionsTargetError ??
                openTargetUnavailableMessage ??
                "The history document changed. Reopen the version menu before acting."}
            </p>
          ) : null}
          <p className="history-retention-policy">
            Automatic and before-operation versions share the newest 20 entries.
            They do not expire by age. Manual marks stay until you delete them.
          </p>
          {onMark !== undefined ? (
            <section
              aria-label="Current drawing"
              className="history-current-actions"
            >
              <div className="history-current-card">
                <span>Current drawing</span>
                <p>Open canvas</p>
              </div>
              <button
                className="history-mark-current"
                disabled={processing || markIsProcessing}
                onClick={() => void handleMark()}
                type="button"
              >
                {markIsProcessing
                  ? "Marking current version…"
                  : "Mark current version"}
              </button>
            </section>
          ) : null}
          {markFeedback?.status === "success" ? (
            <p aria-live="polite" role="status">
              {markFeedback.message}
            </p>
          ) : null}
          {markFeedback?.status === "error" ? (
            <p aria-live="assertive" role="alert">
              {markFeedback.message}
            </p>
          ) : null}
          {previewItem !== undefined ? (
            <>
              <HistoryPreview
                content={previewContent}
                errorMessage={previewErrorMessage}
                item={previewItem}
                moreActions={actionsFor(previewItem)}
                onExit={exitPreview}
                onRestore={() =>
                  requestRestore(previewItem, previewRestoreRef.current)
                }
                processing={processing}
                restoreEnabled={restoreEnabled}
                restoreButtonRef={previewRestoreRef}
                state={previewState}
              />
              {deleteFeedback?.status === "success" ? (
                <p aria-live="polite" role="status">
                  {deleteFeedback.message}
                </p>
              ) : null}
              {deleteFeedback?.status === "error" && deleteTarget === null ? (
                <p aria-live="assertive" role="alert">
                  {deleteFeedback.message}
                </p>
              ) : null}
            </>
          ) : status === "available" ? (
            <>
              {items.length === 0 ? (
                <HistoryStateView state="empty" />
              ) : (
                <>
                  <HistoryList
                    currentVersionId={currentVersionId}
                    items={items}
                    onPreview={openPreview}
                    onRegisterRow={(versionId, element) => {
                      if (element === null) rowRefs.current.delete(versionId);
                      else rowRefs.current.set(versionId, element);
                    }}
                    onSelect={selectItem}
                    previewVersionId={activePreviewId}
                    renderRowActions={actionsFor}
                    selectedVersionId={activeSelectedId}
                  />
                </>
              )}
            </>
          ) : (
            <HistoryStateView
              message={statusMessage}
              onRetry={onRetry}
              state={status}
            />
          )}
        </div>
      </div>
      {previewItem === undefined &&
      selectedItem !== undefined &&
      status === "available" ? (
        <section
          aria-label="Selected version actions"
          className="history-selection-actions"
        >
          <p className="history-selection-eyebrow">
            Selected version · action target
          </p>
          <strong className="history-selection-title">
            {historyTargetLabel(selectedItem)}
          </strong>
          <p className="history-selection-metadata">
            <time dateTime={historyDateTime(selectedItem.recordedAt)}>
              {formatHistoryTimestamp(selectedItem.recordedAt)}
            </time>
            {" · "}
            {historySourceLabel(selectedItem)}
          </p>
          <div>
            <button
              disabled={
                processing || selectedItem.availability.status !== "available"
              }
              onClick={() => openPreview(selectedItem)}
              type="button"
            >
              Preview
            </button>
            <button
              className="primary-action"
              disabled={
                processing ||
                selectedItem.availability.status !== "available" ||
                !restoreEnabled
              }
              onClick={(event) =>
                requestRestore(selectedItem, event.currentTarget)
              }
              ref={selectedRestoreRef}
              type="button"
            >
              Restore this version
            </button>
          </div>
          {deleteFeedback?.status === "success" ? (
            <p aria-live="polite" role="status">
              {deleteFeedback.message}
            </p>
          ) : null}
          {deleteFeedback?.status === "error" && deleteTarget === null ? (
            <p aria-live="assertive" role="alert">
              {deleteFeedback.message}
            </p>
          ) : null}
        </section>
      ) : null}
      {visibleDeleteTarget !== null ? (
        <ApplicationDialog
          busy={deleteIsProcessing}
          description={`Delete the ${sourceLabel(visibleDeleteTarget.item)} version from history? This cannot be undone.`}
          errorMessage={
            deleteFeedback?.status === "error" ? deleteFeedback.message : null
          }
          initialFocusRef={deleteCancelRef}
          onDismiss={() => {
            if (!deleteIsProcessing) setDeleteTarget(null);
          }}
          returnFocusRef={deleteReturnFocusRef}
          title={`Delete v-${String(visibleDeleteTarget.item.sequence).padStart(3, "0")}?`}
        >
          <div className="application-dialog-actions conflict-dialog-actions">
            <button
              disabled={deleteIsProcessing}
              onClick={() => setDeleteTarget(null)}
              ref={deleteCancelRef}
              type="button"
            >
              Cancel
            </button>
            <button
              disabled={deleteIsProcessing}
              onClick={() => void handleDelete(visibleDeleteTarget.item)}
              type="button"
            >
              {deleteIsProcessing ? "Deleting…" : "Delete"}
            </button>
          </div>
        </ApplicationDialog>
      ) : null}
      {visibleRestoreTarget !== null ? (
        <ApplicationDialog
          busy={restoreBusy}
          description="The current drawing will be replaced after a protected snapshot is created."
          errorMessage={restoreDialogError}
          initialFocusRef={restoreCancelRef}
          onDismiss={() => {
            if (!restoreBusy) {
              setRestoreTarget(null);
            }
          }}
          returnFocusRef={restoreReturnFocusRef}
          title="Restore this version?"
        >
          <p className="history-restore-target">
            Target: v-
            {String(visibleRestoreTarget.item.sequence).padStart(3, "0")} ·{" "}
            {historyTargetSummary(visibleRestoreTarget.item)}
          </p>
          <div className="application-dialog-actions conflict-dialog-actions">
            <button
              disabled={restoreBusy}
              onClick={() => {
                setRestoreTarget(null);
              }}
              ref={restoreCancelRef}
              type="button"
            >
              Cancel
            </button>
            <button
              className="primary-action"
              disabled={
                restoreBusy ||
                processing ||
                restoreTargetInvalidMessage !== null
              }
              onClick={() => void handleRestore()}
              type="button"
            >
              {restoreBusy ? "Restoring…" : "Restore version"}
            </button>
          </div>
        </ApplicationDialog>
      ) : null}
    </aside>
  );
}

function historyTargetSummary(item: HistoryVersionView): string {
  return item.summary !== undefined &&
    item.summary !== "" &&
    item.summaryReliable !== false
    ? item.summary
    : "Canvas changed";
}

function sourceLabel(item: HistoryVersionView): string {
  if (item.source === "protected" && item.protectedAction !== undefined) {
    return {
      restore: "Before restore",
      clear: "Before clear",
      import: "Before import",
    }[item.protectedAction];
  }
  return item.source === "manual" ? "manual" : "automatic";
}

function historyTargetLabel(item: HistoryVersionView): string {
  const summary =
    item.summaryReliable === false || !item.summary
      ? "Canvas changed"
      : item.summary;
  return `v-${String(item.sequence).padStart(3, "0")} · ${summary}`;
}

function MoreIcon() {
  return (
    <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
      <circle cx="8" cy="3" r="1" fill="currentColor" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
      <circle cx="8" cy="13" r="1" fill="currentColor" />
    </svg>
  );
}

function BookmarkIcon() {
  return (
    <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
      <path
        d="M4 2.5h8v11l-4-2.7-4 2.7z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
      <path
        d="M3.5 4.5h9l-.7 9h-7.6zM2.5 3h11M6 3V1.8h4V3m-3 3v5m2-5v5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" height="16" viewBox="0 0 16 16" width="16">
      <path
        d="m4 4 8 8M12 4l-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}
