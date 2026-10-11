import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefCallback,
  type RefObject,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { ApplicationDialog } from "../app/interaction/ApplicationDialog";
import { t, useI18n, type MessageKey } from "../i18n";
import { describeError } from "../i18n/describeError";
import { HistoryList, type HistoryVersionView } from "./HistoryList";
import {
  formatHistoryTimestamp,
  historyDateTime,
  historyDefaultSummary,
  historyVersionLabel,
  historyAccessibleTimestamp,
  historySourceLabel,
} from "./historyFormat";
import { HistoryPreview, type HistoryPreviewState } from "./HistoryPreview";
import { HistoryStateView, type HistoryStateKind } from "./HistoryStates";
import "./history.css";

// Tallest row menu (title, two items, separator) under the SDK menu metrics.
const ACTIONS_MENU_HEIGHT = 120;

export type HistoryPanelStatus = HistoryStateKind | "available";

export interface HistorySuccessNotice {
  title: string;
  message: string;
}

/**
 * Feedback text kept as data so it re-translates when the UI language changes.
 * Caller-provided strings are shown as given.
 */
type FeedbackText =
  | { kind: "text"; text: string }
  | { kind: "key"; key: MessageKey }
  | { kind: "error"; error: unknown; fallback: MessageKey };

function resolveFeedbackText(
  t: (key: MessageKey) => string,
  feedback: FeedbackText,
): string {
  switch (feedback.kind) {
    case "text":
      return feedback.text;
    case "key":
      return t(feedback.key);
    case "error":
      return describeError(feedback.error, feedback.fallback);
  }
}

type InlineMarkKind = "marked" | "alreadyMarked" | "unmarked";

const INLINE_MARK_KEYS: Record<InlineMarkKind, MessageKey> = {
  marked: "history.panel.feedback.marked",
  alreadyMarked: "history.panel.feedback.alreadyMarked",
  unmarked: "history.panel.feedback.unmarked",
};

interface InlineMarkFeedback {
  documentId: string;
  versionId: string;
  kind: InlineMarkKind;
  identity: string;
  announcementId: number;
  itemsAtCommit: readonly HistoryVersionView[];
}

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
  /** AppShell canvas-region host for the independent preview surface. */
  previewPortalContainer?: HTMLElement | null;
  /** Callers without a safe rendered preview must keep restore disabled. */
  restoreEnabled?: boolean;
  processing?: boolean;
  onClose(): void;
  onRetry?: () => void;
  onSelect?: (item: HistoryVersionView) => void;
  onPreview?: (item: HistoryVersionView) => void;
  onExitPreview?: (item?: HistoryVersionView) => void;
  onRestore?: (item: HistoryVersionView) => void | Promise<void>;
  onDelete?: (item: HistoryVersionView) => void | Promise<void>;
  /** Marks the live canvas; the caller resolves only after durable publish. */
  onMark?: () => void | Promise<void | null | {
    versionId: string;
    reused: boolean;
  }>;
  onSuccessNotice?: (notice: HistorySuccessNotice) => void;
  onClearSuccessNotice?: () => void;
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
  previewPortalContainer,
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
  onSuccessNotice,
  onClearSuccessNotice,
  onSetMarked,
  markProcessing = false,
  markSuccessMessage,
  markErrorMessage,
  deleteProcessing = false,
  deleteSuccessMessage,
  deleteErrorMessage,
  moreActions,
  triggerRef,
}: HistoryPanelProps) {
  const { t } = useI18n();
  const activeDocumentKey = documentId ?? fileName;
  const onClearSuccessNoticeRef = useRef(onClearSuccessNotice);
  const activeDocumentRef = useRef(activeDocumentKey);
  useLayoutEffect(() => {
    onClearSuccessNoticeRef.current = onClearSuccessNotice;
    activeDocumentRef.current = activeDocumentKey;
  }, [activeDocumentKey, onClearSuccessNotice]);
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
  const [markFeedback, setMarkFeedback] = useState<{
    status: "success" | "error";
    text: FeedbackText;
  } | null>(null);
  const [inlineMarkFeedback, setInlineMarkFeedback] =
    useState<InlineMarkFeedback | null>(null);
  const [reusedTargetId, setReusedTargetId] = useState<string | null>(null);
  const [markBusy, setMarkBusy] = useState(false);
  const [setMarkedBusy, setSetMarkedBusy] = useState(false);
  const markIsProcessing = markProcessing || markBusy || setMarkedBusy;
  const [deleteFeedback, setDeleteFeedback] = useState<{
    status: "error";
    text: FeedbackText;
  } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const deleteIsProcessing = deleteProcessing || deleteBusy;
  const [openActionsTarget, setOpenActionsTarget] = useState<{
    documentId: string;
    item: HistoryVersionView;
    upward: boolean;
  } | null>(null);
  const [actionsTargetError, setActionsTargetError] =
    useState<MessageKey | null>(null);
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
  const restoreInFlightRef = useRef(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<FeedbackText | null>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const previewReturnIdRef = useRef<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const infoButtonRef = useRef<HTMLButtonElement>(null);
  const infoPopoverRef = useRef<HTMLDivElement>(null);
  const [retentionInfoOpen, setRetentionInfoOpen] = useState(false);
  const [retentionInfoPinned, setRetentionInfoPinned] = useState(false);
  const retentionInfoCloseTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const focusRetentionInfoOnOpenRef = useRef(false);
  const suppressRetentionInfoFocusOpenRef = useRef(false);
  const actionNoticeGenerationRef = useRef(0);
  const inlineAnnouncementIdRef = useRef(0);
  const localSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const inlineSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const cancelRetentionInfoClose = () => {
    if (retentionInfoCloseTimerRef.current !== null) {
      clearTimeout(retentionInfoCloseTimerRef.current);
      retentionInfoCloseTimerRef.current = null;
    }
  };

  const scheduleRetentionInfoClose = () => {
    cancelRetentionInfoClose();
    retentionInfoCloseTimerRef.current = setTimeout(() => {
      retentionInfoCloseTimerRef.current = null;
      if (retentionInfoPinned) return;
      if (
        infoButtonRef.current?.contains(document.activeElement) ||
        infoPopoverRef.current?.contains(document.activeElement)
      ) {
        return;
      }
      setRetentionInfoOpen(false);
    }, 160);
  };

  useEffect(() => {
    if (!retentionInfoOpen) return;
    if (focusRetentionInfoOnOpenRef.current) {
      focusRetentionInfoOnOpenRef.current = false;
      infoPopoverRef.current?.focus();
    }
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !infoPopoverRef.current?.contains(event.target) &&
        !infoButtonRef.current?.contains(event.target)
      ) {
        cancelRetentionInfoClose();
        setRetentionInfoPinned(false);
        setRetentionInfoOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismissOnOutsidePointer, true);
    return () =>
      document.removeEventListener(
        "pointerdown",
        dismissOnOutsidePointer,
        true,
      );
  }, [retentionInfoOpen]);

  useEffect(
    () => () => {
      actionNoticeGenerationRef.current += 1;
      if (retentionInfoCloseTimerRef.current !== null) {
        clearTimeout(retentionInfoCloseTimerRef.current);
      }
      if (localSuccessTimerRef.current !== null) {
        clearTimeout(localSuccessTimerRef.current);
      }
      if (inlineSuccessTimerRef.current !== null) {
        clearTimeout(inlineSuccessTimerRef.current);
      }
      onClearSuccessNoticeRef.current?.();
    },
    [activeDocumentKey],
  );

  const previousDocumentKeyRef = useRef(activeDocumentKey);
  useEffect(() => {
    if (previousDocumentKeyRef.current === activeDocumentKey) return;
    previousDocumentKeyRef.current = activeDocumentKey;
    actionNoticeGenerationRef.current += 1;
    if (localSuccessTimerRef.current !== null) {
      clearTimeout(localSuccessTimerRef.current);
      localSuccessTimerRef.current = null;
    }
    if (inlineSuccessTimerRef.current !== null) {
      clearTimeout(inlineSuccessTimerRef.current);
      inlineSuccessTimerRef.current = null;
    }
    setInlineMarkFeedback(null);
    setMarkFeedback(null);
    setReusedTargetId(null);
  }, [activeDocumentKey]);

  const clearActionSuccessNotice = () => {
    actionNoticeGenerationRef.current += 1;
    if (localSuccessTimerRef.current !== null) {
      clearTimeout(localSuccessTimerRef.current);
      localSuccessTimerRef.current = null;
    }
    setMarkFeedback((current) =>
      current?.status === "success" ? null : current,
    );
    if (inlineSuccessTimerRef.current !== null) {
      clearTimeout(inlineSuccessTimerRef.current);
      inlineSuccessTimerRef.current = null;
    }
    setInlineMarkFeedback(null);
    setReusedTargetId(null);
    onClearSuccessNotice?.();
    return actionNoticeGenerationRef.current;
  };

  const showInlineMarkFeedback = (
    generation: number,
    versionId: string,
    kind: InlineMarkKind,
    identity: string,
  ) => {
    if (generation !== actionNoticeGenerationRef.current) return;
    if (localSuccessTimerRef.current !== null) {
      clearTimeout(localSuccessTimerRef.current);
      localSuccessTimerRef.current = null;
    }
    if (inlineSuccessTimerRef.current !== null) {
      clearTimeout(inlineSuccessTimerRef.current);
    }
    const announcementId = ++inlineAnnouncementIdRef.current;
    setInlineMarkFeedback({
      documentId: activeDocumentKey,
      versionId,
      kind,
      identity,
      announcementId,
      itemsAtCommit: items,
    });
    inlineSuccessTimerRef.current = setTimeout(() => {
      inlineSuccessTimerRef.current = null;
      setInlineMarkFeedback((current) =>
        current?.announcementId === announcementId ? null : current,
      );
    }, 3000);
  };

  const showActionSuccessNotice = (
    generation: number,
    titleKey: MessageKey,
    text: FeedbackText,
  ) => {
    if (generation !== actionNoticeGenerationRef.current) return;
    if (onSuccessNotice !== undefined) {
      onSuccessNotice({
        title: t(titleKey),
        message: resolveFeedbackText(t, text),
      });
      return;
    }
    setMarkFeedback({ status: "success", text });
    if (localSuccessTimerRef.current !== null) {
      clearTimeout(localSuccessTimerRef.current);
    }
    localSuccessTimerRef.current = setTimeout(() => {
      localSuccessTimerRef.current = null;
      if (generation !== actionNoticeGenerationRef.current) return;
      setMarkFeedback((current) =>
        current?.status === "success" ? null : current,
      );
    }, 4000);
  };

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

  const deleteDocumentChanged =
    deleteTarget !== null && deleteTarget.documentId !== activeDocumentKey;
  const visibleDeleteTarget = deleteDocumentChanged ? null : deleteTarget;
  const visibleRestoreTarget =
    restoreTarget?.documentId === activeDocumentKey ? restoreTarget : null;
  const activeSelectedId =
    selectedVersionId ??
    (internalSelectedId !== null &&
    items.some((item) => item.versionId === internalSelectedId)
      ? internalSelectedId
      : (items[0]?.versionId ?? null));
  const requestedPreviewId =
    previewVersionId === undefined ? internalPreviewId : previewVersionId;
  const previewTargetMissing =
    requestedPreviewId !== null &&
    (status === "available" || status === "empty") &&
    !items.some((item) => item.versionId === requestedPreviewId);
  const activePreviewId = previewTargetMissing ? null : requestedPreviewId;
  const selectedItem =
    items.find((item) => item.versionId === activeSelectedId) ??
    (activeSelectedId === null ? items[0] : undefined);
  const previewItem = items.find((item) => item.versionId === activePreviewId);
  const selectedRestoreReady =
    selectedItem !== undefined &&
    restoreEnabled &&
    (activePreviewId === null ||
      (selectedItem.versionId === activePreviewId && previewState === "ready"));
  const restoreTargetInvalidMessage =
    visibleRestoreTarget === null
      ? null
      : status !== "available"
        ? t("history.panel.guard.restoreChanging")
        : !restoreEnabled ||
            (activePreviewId !== null &&
              (selectedItem?.versionId !== activePreviewId ||
                visibleRestoreTarget.item.versionId !== activePreviewId ||
                previewState !== "ready"))
          ? t("history.panel.guard.restorePreviewUnavailable")
          : items.some(
                (item) =>
                  item.versionId === visibleRestoreTarget.item.versionId &&
                  item.availability.status === "available",
              )
            ? null
            : t("history.panel.guard.restoreVersionUnavailable");
  const restoreDialogError =
    restoreTargetInvalidMessage ??
    (restoreError === null ? null : resolveFeedbackText(t, restoreError));
  const openTargetUnavailableMessage =
    openActionsTarget === null
      ? null
      : openActionsTarget.documentId !== activeDocumentKey
        ? t("history.panel.guard.documentChanged")
        : items.some(
              (item) => item.versionId === openActionsTarget.item.versionId,
            )
          ? null
          : t("history.panel.guard.menuVersionUnavailable");
  const actionsTargetBannerMessage =
    actionsTargetError !== null
      ? t(actionsTargetError)
      : (openTargetUnavailableMessage ??
        (deleteDocumentChanged
          ? t("history.panel.guard.documentChanged")
          : null));

  useEffect(() => {
    if (activePreviewId === null && previewReturnIdRef.current !== null) {
      const returnId = previewReturnIdRef.current;
      previewReturnIdRef.current = null;
      const row = rowRefs.current.get(returnId);
      if (row !== undefined) row.focus();
      else closeButtonRef.current?.focus();
    }
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
    if (selectionChanged && activePreviewId === null) {
      row.scrollIntoView?.({ block: "nearest" });
      row.focus();
    }
  }, [activePreviewId, items, selectedVersionId]);

  useEffect(() => {
    if (
      inlineMarkFeedback === null ||
      inlineMarkFeedback.documentId !== activeDocumentKey ||
      status !== "available" ||
      items === inlineMarkFeedback.itemsAtCommit ||
      items.some((item) => item.versionId === inlineMarkFeedback.versionId)
    ) {
      return;
    }
    const removedAnnouncementId = inlineMarkFeedback.announcementId;
    queueMicrotask(() => {
      setInlineMarkFeedback((current) =>
        current?.announcementId === removedAnnouncementId ? null : current,
      );
    });
  }, [activeDocumentKey, inlineMarkFeedback, items, status]);

  useEffect(() => {
    if (selectedVersionId === undefined) return;
    setInlineMarkFeedback((current) => {
      if (
        current === null ||
        current.documentId !== activeDocumentKey ||
        current.versionId === selectedVersionId
      ) {
        return current;
      }
      if (inlineSuccessTimerRef.current !== null) {
        clearTimeout(inlineSuccessTimerRef.current);
        inlineSuccessTimerRef.current = null;
      }
      return null;
    });
  }, [activeDocumentKey, selectedVersionId]);

  const selectItem = (item: HistoryVersionView) => {
    clearActionSuccessNotice();
    if (item.versionId !== reusedTargetId) setReusedTargetId(null);
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
    if (activePreviewId === null) return;
    previewReturnIdRef.current = activePreviewId;
    if (previewVersionId === undefined) setInternalPreviewId(null);
    onExitPreview?.(previewItem);
  };

  useEffect(() => {
    if (!previewTargetMissing || requestedPreviewId === null) return;
    closeButtonRef.current?.focus();
    onExitPreview?.();
  }, [onExitPreview, previewTargetMissing, requestedPreviewId]);

  const closePanel = () => {
    clearActionSuccessNotice();
    triggerRef?.current?.focus();
    onClose();
  };

  /*
   * Keep these callbacks below the preview identity calculation so removal
   * events can dismiss a preview even after its list item has disappeared.
   */

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
    const operationDocumentKey = activeDocumentKey;
    const noticeGeneration = clearActionSuccessNotice();
    setMarkFeedback(null);
    setMarkBusy(true);
    try {
      const result = await onMark();
      if (
        noticeGeneration !== actionNoticeGenerationRef.current ||
        operationDocumentKey !== activeDocumentRef.current
      )
        return;
      const outcome = result ?? undefined;
      if (outcome !== undefined && selectedVersionId === undefined) {
        setInternalSelectedId(outcome.versionId);
      }
      if (result === null) return;
      if (outcome?.reused) {
        setReusedTargetId(outcome.versionId);
      }
      if (outcome !== undefined) {
        const identity = items.find(
          (item) => item.versionId === outcome.versionId,
        )?.sequence;
        const announcementIdentity =
          identity === undefined
            ? outcome.versionId
            : `v-${String(identity).padStart(3, "0")}`;
        showInlineMarkFeedback(
          noticeGeneration,
          outcome.versionId,
          outcome.reused ? "alreadyMarked" : "marked",
          announcementIdentity,
        );
      } else {
        showActionSuccessNotice(
          noticeGeneration,
          "history.panel.notice.markedTitle",
          markSuccessMessage === undefined
            ? { kind: "key", key: "history.panel.notice.markedMessage" }
            : { kind: "text", text: markSuccessMessage },
        );
      }
    } catch (error) {
      if (
        noticeGeneration !== actionNoticeGenerationRef.current ||
        operationDocumentKey !== activeDocumentRef.current
      )
        return;
      setMarkFeedback({
        status: "error",
        text:
          markErrorMessage !== undefined
            ? { kind: "text", text: markErrorMessage }
            : {
                kind: "error",
                error,
                fallback: "history.panel.error.markFailed",
              },
      });
    } finally {
      setMarkBusy(false);
    }
  };

  const handleSetMarked = async (item: HistoryVersionView, marked: boolean) => {
    if (processing || setMarkedBusy || onSetMarked === undefined) {
      return;
    }
    const operationDocumentKey = activeDocumentKey;
    const noticeGeneration = clearActionSuccessNotice();
    setMarkFeedback(null);
    setSetMarkedBusy(true);
    try {
      const result = await onSetMarked(item, marked);
      if (
        noticeGeneration !== actionNoticeGenerationRef.current ||
        operationDocumentKey !== activeDocumentRef.current
      )
        return;
      if (
        !marked &&
        result !== undefined &&
        result.retained === false &&
        activePreviewId === item.versionId
      ) {
        exitPreview();
      }
      if (result !== undefined && result.retained === false) {
        showActionSuccessNotice(
          noticeGeneration,
          "history.panel.notice.unmarkedTitle",
          {
            kind: "key",
            key: "history.panel.notice.unmarkedRemoved",
          },
        );
      } else if (result !== undefined) {
        const identity = items.find(
          (candidate) => candidate.versionId === result.versionId,
        )?.sequence;
        const announcementIdentity =
          identity === undefined
            ? result.versionId
            : `v-${String(identity).padStart(3, "0")}`;
        showInlineMarkFeedback(
          noticeGeneration,
          result.versionId,
          marked ? "marked" : "unmarked",
          announcementIdentity,
        );
      } else {
        const identity = items.find(
          (candidate) => candidate.versionId === item.versionId,
        )?.sequence;
        const announcementIdentity =
          identity === undefined
            ? item.versionId
            : `v-${String(identity).padStart(3, "0")}`;
        showInlineMarkFeedback(
          noticeGeneration,
          item.versionId,
          marked ? "marked" : "unmarked",
          announcementIdentity,
        );
      }
    } catch (error) {
      if (
        noticeGeneration !== actionNoticeGenerationRef.current ||
        operationDocumentKey !== activeDocumentRef.current
      )
        return;
      setMarkFeedback({
        status: "error",
        text:
          markErrorMessage !== undefined
            ? { kind: "text", text: markErrorMessage }
            : {
                kind: "error",
                error,
                fallback: "history.panel.error.updateFailed",
              },
      });
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
    if (retentionInfoOpen) {
      cancelRetentionInfoClose();
      setRetentionInfoPinned(false);
      setRetentionInfoOpen(false);
      if (infoPopoverRef.current?.contains(document.activeElement)) {
        suppressRetentionInfoFocusOpenRef.current = true;
        infoButtonRef.current?.focus();
      }
      return;
    }
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
    const noticeGeneration = clearActionSuccessNotice();
    if (
      deleteTarget?.documentId !== activeDocumentKey ||
      deleteTarget.item.versionId !== item.versionId ||
      !items.some((candidate) => candidate.versionId === item.versionId)
    ) {
      setDeleteTarget(null);
      setActionsTargetError("history.panel.guard.menuVersionUnavailable");
      return;
    }
    setDeleteFeedback(null);
    setDeleteBusy(true);
    try {
      await onDelete(item);
      if (noticeGeneration !== actionNoticeGenerationRef.current) return;
      if (activePreviewId === item.versionId) exitPreview();
      deleteReturnFocusRef.current = closeButtonRef.current;
      showActionSuccessNotice(
        noticeGeneration,
        "history.panel.notice.deletedTitle",
        deleteSuccessMessage === undefined
          ? { kind: "key", key: "history.panel.notice.deletedMessage" }
          : { kind: "text", text: deleteSuccessMessage },
      );
      setDeleteTarget(null);
    } catch (error) {
      if (noticeGeneration !== actionNoticeGenerationRef.current) return;
      setDeleteFeedback({
        status: "error",
        text:
          deleteErrorMessage !== undefined
            ? { kind: "text", text: deleteErrorMessage }
            : {
                kind: "error",
                error,
                fallback: "history.panel.error.deleteFailed",
              },
      });
    } finally {
      setDeleteBusy(false);
    }
  };

  const requestRestore = (
    item: HistoryVersionView,
    trigger: HTMLButtonElement | null,
  ) => {
    clearActionSuccessNotice();
    if (
      onRestore === undefined ||
      processing ||
      restoreBusy ||
      !selectedRestoreReady ||
      selectedItem?.versionId !== item.versionId ||
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
      setRestoreError({
        kind: "error",
        error,
        fallback: "history.panel.error.restoreFailed",
      });
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
      setActionsTargetError("history.panel.guard.menuVersionUnavailable");
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
        ACTIONS_MENU_HEIGHT;
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
          aria-label={t("history.panel.moreActionsFor", {
            target: historyTargetLabel(item),
          })}
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
            aria-label={t("history.panel.moreActions")}
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
                {t("history.panel.unmark")}
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
                {t("history.panel.mark")}
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
                  {t("history.panel.delete")}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const previewElement =
    previewItem === undefined ? null : (
      <HistoryPreview
        content={previewContent}
        errorMessage={previewErrorMessage}
        item={previewItem}
        onExit={exitPreview}
        processing={processing}
        state={previewState}
      />
    );

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
        aria-label={t("history.panel.resizeLabel")}
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
        {t("history.panel.resizeHelp")}
      </span>
      <header className="history-panel-header">
        <div>
          <h1 id="history-panel-title">{t("history.panel.title")}</h1>
          <p className="history-panel-file-name" title={fileName}>
            {fileName}
          </p>
        </div>
        <div className="history-panel-header-actions">
          <button
            aria-controls="history-retention-info"
            aria-expanded={retentionInfoOpen}
            aria-label={t("history.panel.infoLabel")}
            className="history-info-trigger"
            onPointerEnter={() => {
              cancelRetentionInfoClose();
              setRetentionInfoOpen(true);
            }}
            onPointerLeave={scheduleRetentionInfoClose}
            onFocus={() => {
              if (suppressRetentionInfoFocusOpenRef.current) {
                suppressRetentionInfoFocusOpenRef.current = false;
                return;
              }
              cancelRetentionInfoClose();
              setRetentionInfoOpen(true);
            }}
            onBlur={scheduleRetentionInfoClose}
            onClick={() => {
              cancelRetentionInfoClose();
              if (retentionInfoPinned) {
                setRetentionInfoPinned(false);
                setRetentionInfoOpen(false);
                if (document.activeElement !== infoButtonRef.current) {
                  suppressRetentionInfoFocusOpenRef.current = true;
                  infoButtonRef.current?.focus();
                }
              } else {
                focusRetentionInfoOnOpenRef.current = !retentionInfoOpen;
                setRetentionInfoPinned(true);
                setRetentionInfoOpen(true);
                if (retentionInfoOpen) infoPopoverRef.current?.focus();
              }
            }}
            ref={infoButtonRef}
            title={t("history.panel.infoLabel")}
            type="button"
          >
            <InfoIcon />
          </button>
          <div className="history-close-anchor">
            <button
              aria-label={t("history.panel.closeLabel")}
              className="icon-button"
              onClick={closePanel}
              ref={closeButtonRef}
              type="button"
            >
              <CloseIcon />
              <span className="visually-hidden">
                {t("history.panel.close")}
              </span>
            </button>
          </div>
        </div>
      </header>
      <p
        aria-atomic="true"
        aria-live="polite"
        className="visually-hidden"
        role="status"
      >
        {inlineMarkFeedback?.documentId === activeDocumentKey
          ? t("history.panel.feedback.announce", {
              message: t(INLINE_MARK_KEYS[inlineMarkFeedback.kind]),
              identity: inlineMarkFeedback.identity,
            })
          : ""}
      </p>
      <div
        aria-labelledby="history-retention-heading"
        className="history-retention-popover"
        hidden={!retentionInfoOpen}
        id="history-retention-info"
        ref={infoPopoverRef}
        onPointerEnter={cancelRetentionInfoClose}
        onPointerLeave={scheduleRetentionInfoClose}
        role="region"
        tabIndex={-1}
      >
        <h2 id="history-retention-heading">
          {t("history.panel.retention.title")}
        </h2>
        <p>{t("history.panel.retention.body")}</p>
      </div>

      <div className="history-panel-main">
        <div className="history-panel-body">
          {actionsTargetBannerMessage !== null ? (
            <p role="alert">{actionsTargetBannerMessage}</p>
          ) : null}
          {onMark !== undefined ? (
            <section
              aria-label={t("history.panel.current.region")}
              className="history-current-actions"
            >
              <div className="history-current-card">
                <span>{t("history.panel.current.title")}</span>
                <p>{t("history.panel.current.canvas")}</p>
              </div>
              <div className="history-version-toolbar">
                <span className="history-version-count">
                  {t(
                    items.length === 1
                      ? "history.panel.count.one"
                      : "history.panel.count.other",
                    { count: items.length },
                  )}
                </span>
                <button
                  className="history-mark-current"
                  disabled={processing || markIsProcessing}
                  onClick={() => void handleMark()}
                  type="button"
                >
                  {markIsProcessing
                    ? t("history.panel.markingCurrent")
                    : t("history.panel.markCurrent")}
                </button>
              </div>
            </section>
          ) : null}
          {markFeedback !== null ? (
            <p
              aria-live={
                markFeedback.status === "error" ? "assertive" : "polite"
              }
              className={`history-mark-feedback is-${markFeedback.status}`}
              role={markFeedback.status === "error" ? "alert" : "status"}
            >
              {resolveFeedbackText(t, markFeedback.text)}
            </p>
          ) : null}
          {previewItem !== undefined && previewPortalContainer === undefined ? (
            <>
              {previewElement}
              {deleteFeedback?.status === "error" && deleteTarget === null ? (
                <p aria-live="assertive" role="alert">
                  {resolveFeedbackText(t, deleteFeedback.text)}
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
                    successFeedback={
                      inlineMarkFeedback?.documentId === activeDocumentKey
                        ? {
                            versionId: inlineMarkFeedback.versionId,
                            message: t(
                              INLINE_MARK_KEYS[inlineMarkFeedback.kind],
                            ),
                          }
                        : null
                    }
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
      {selectedItem !== undefined && status === "available" ? (
        <section
          aria-label={t("history.panel.selected.region")}
          className="history-selection-actions"
        >
          <p className="history-selection-eyebrow">
            {selectedItem.availability.status === "unavailable"
              ? t("history.panel.selected.eyebrowUnavailable")
              : selectedItem.versionId === reusedTargetId
                ? t("history.panel.selected.eyebrowReused")
                : t("history.panel.selected.eyebrowTarget")}
          </p>
          <h2
            className="history-selection-title"
            title={historySummaryLabel(selectedItem)}
          >
            {historySummaryLabel(selectedItem)}
          </h2>
          <p className="history-selection-metadata">
            {historyVersionLabel(selectedItem.sequence)}
            {" · "}
            <time
              dateTime={historyDateTime(selectedItem.recordedAt)}
              title={historyAccessibleTimestamp(selectedItem.recordedAt)}
            >
              {formatHistoryTimestamp(selectedItem.recordedAt)}
            </time>
            {" · "}
            {historySourceLabel(selectedItem)}
          </p>
          {selectedItem.availability.status === "unavailable" ? (
            <p className="history-selection-unavailable-reason">
              {t("history.panel.selected.unavailableReason", {
                reason: describeError(selectedItem.availability.error),
              })}
            </p>
          ) : null}
          <div>
            <button
              disabled={
                processing || selectedItem.availability.status !== "available"
              }
              onClick={() => openPreview(selectedItem)}
              type="button"
            >
              {t("history.panel.selected.preview")}
            </button>
            <button
              className="primary-action"
              aria-label={t("history.panel.selected.restoreLabel")}
              disabled={
                processing ||
                selectedItem.availability.status !== "available" ||
                !selectedRestoreReady
              }
              onClick={(event) =>
                requestRestore(selectedItem, event.currentTarget)
              }
              ref={selectedRestoreRef}
              type="button"
            >
              {t("history.panel.selected.restore")}
            </button>
          </div>
          {deleteFeedback?.status === "error" && deleteTarget === null ? (
            <p aria-live="assertive" role="alert">
              {resolveFeedbackText(t, deleteFeedback.text)}
            </p>
          ) : null}
        </section>
      ) : null}
      {visibleDeleteTarget !== null ? (
        <ApplicationDialog
          busy={deleteIsProcessing}
          description={t("history.panel.deleteDialog.description", {
            source: sourceLabel(visibleDeleteTarget.item),
          })}
          errorMessage={
            deleteFeedback?.status === "error"
              ? resolveFeedbackText(t, deleteFeedback.text)
              : null
          }
          initialFocusRef={deleteCancelRef}
          onDismiss={() => {
            if (!deleteIsProcessing) setDeleteTarget(null);
          }}
          returnFocusRef={deleteReturnFocusRef}
          title={t("history.panel.deleteDialog.title", {
            version: historyVersionLabel(visibleDeleteTarget.item.sequence),
          })}
        >
          <div className="application-dialog-actions conflict-dialog-actions">
            <button
              disabled={deleteIsProcessing}
              onClick={() => setDeleteTarget(null)}
              ref={deleteCancelRef}
              type="button"
            >
              {t("history.panel.cancel")}
            </button>
            <button
              disabled={deleteIsProcessing}
              onClick={() => void handleDelete(visibleDeleteTarget.item)}
              type="button"
            >
              {deleteIsProcessing
                ? t("history.panel.deleteDialog.deleting")
                : t("history.panel.deleteDialog.delete")}
            </button>
          </div>
        </ApplicationDialog>
      ) : null}
      {visibleRestoreTarget !== null ? (
        <ApplicationDialog
          busy={restoreBusy}
          description={t("history.panel.restoreDialog.description")}
          errorMessage={restoreDialogError}
          initialFocusRef={restoreCancelRef}
          onDismiss={() => {
            if (!restoreBusy) {
              setRestoreTarget(null);
            }
          }}
          returnFocusRef={restoreReturnFocusRef}
          title={t("history.panel.restoreDialog.title")}
        >
          <p className="history-restore-target">
            {t("history.panel.restoreDialog.target", {
              version: historyVersionLabel(visibleRestoreTarget.item.sequence),
              summary: historyTargetSummary(visibleRestoreTarget.item),
            })}
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
              {t("history.panel.cancel")}
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
              {restoreBusy
                ? t("history.panel.restoreDialog.restoring")
                : t("history.panel.restoreDialog.restore")}
            </button>
          </div>
        </ApplicationDialog>
      ) : null}
      {previewElement !== null && previewPortalContainer != null
        ? createPortal(previewElement, previewPortalContainer)
        : null}
    </aside>
  );
}

function historyTargetSummary(item: HistoryVersionView): string {
  return item.summary !== undefined &&
    item.summary !== "" &&
    item.summaryReliable !== false
    ? item.summary
    : historyDefaultSummary();
}

function sourceLabel(item: HistoryVersionView): string {
  if (item.source === "protected" && item.protectedAction !== undefined) {
    return historySourceLabel(item);
  }
  return t(
    item.source === "manual"
      ? "history.deleteSource.manual"
      : "history.deleteSource.automatic",
  );
}

function historyTargetLabel(item: HistoryVersionView): string {
  const summary =
    item.summaryReliable === false || !item.summary
      ? historyDefaultSummary()
      : item.summary;
  return `${historyVersionLabel(item.sequence)} · ${summary}`;
}

function historySummaryLabel(item: HistoryVersionView): string {
  return item.summaryReliable === false || !item.summary
    ? historyDefaultSummary()
    : item.summary;
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

function InfoIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 7.2v3.6M8 5.2h.01"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
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
