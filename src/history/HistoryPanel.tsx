import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { HistoryList, type HistoryVersionView } from "./HistoryList";
import { HistoryPreview, type HistoryPreviewState } from "./HistoryPreview";
import { HistoryStateView, type HistoryStateKind } from "./HistoryStates";
import "./history.css";

export type HistoryPanelStatus = HistoryStateKind | "available";

export interface HistoryPanelProps {
  fileName: string;
  items?: readonly HistoryVersionView[];
  status?: HistoryPanelStatus;
  statusMessage?: string;
  currentVersionId?: string | null;
  selectedVersionId?: string | null;
  previewVersionId?: string | null;
  previewState?: HistoryPreviewState;
  previewErrorMessage?: string;
  previewContent?: ReactNode;
  processing?: boolean;
  onClose(): void;
  onRetry?: () => void;
  onSelect?: (item: HistoryVersionView) => void;
  onPreview?: (item: HistoryVersionView) => void;
  onExitPreview?: (item: HistoryVersionView) => void;
  onRestore?: (item: HistoryVersionView) => void | Promise<void>;
  /** Marks the live canvas; the caller resolves only after durable publish. */
  onMark?: () => void | Promise<void>;
  markProcessing?: boolean;
  markSuccessMessage?: string;
  markErrorMessage?: string;
  /** Future Mark/Delete controls are supplied by the domain owner. */
  moreActions?: ReactNode;
  triggerRef?: RefObject<HTMLElement | null>;
}

/**
 * App-owned history drawer composition. Data mutation and IPC remain callback
 * responsibilities of the caller; this component only owns presentation and
 * focus transitions between list and read-only preview.
 */
export function HistoryPanel({
  fileName,
  items = [],
  status = "available",
  statusMessage,
  currentVersionId = null,
  selectedVersionId,
  previewVersionId,
  previewState = "ready",
  previewErrorMessage,
  previewContent,
  processing = false,
  onClose,
  onRetry,
  onSelect,
  onPreview,
  onExitPreview,
  onRestore,
  onMark,
  markProcessing = false,
  markSuccessMessage = "Version marked and saved to history.",
  markErrorMessage,
  moreActions,
  triggerRef,
}: HistoryPanelProps) {
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
  const markIsProcessing = markProcessing || markBusy;
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const previewReturnIdRef = useRef<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  const activeSelectedId =
    selectedVersionId ??
    (internalSelectedId !== null &&
    items.some((item) => item.versionId === internalSelectedId)
      ? internalSelectedId
      : (items[0]?.versionId ?? null));
  const activePreviewId = previewVersionId ?? internalPreviewId;
  const selectedItem =
    items.find((item) => item.versionId === activeSelectedId) ?? items[0];
  const previewItem = items.find((item) => item.versionId === activePreviewId);

  useEffect(() => {
    if (activePreviewId !== null || previewReturnIdRef.current === null) return;
    const returnId = previewReturnIdRef.current;
    previewReturnIdRef.current = null;
    rowRefs.current.get(returnId)?.focus();
  }, [activePreviewId]);

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

  const handleMark = async () => {
    if (onMark === undefined || processing || markIsProcessing) return;
    setMarkFeedback(null);
    setMarkBusy(true);
    try {
      await onMark();
      setMarkFeedback({ status: "success", message: markSuccessMessage });
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

  const handlePanelKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (activePreviewId !== null) {
      exitPreview();
    } else {
      closePanel();
    }
  };

  return (
    <aside
      aria-labelledby="history-panel-title"
      className="history-panel"
      data-history-panel="true"
      onKeyDown={handlePanelKeyDown}
      ref={panelRef}
      role="complementary"
    >
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
          type="button"
        >
          <CloseIcon />
          <span className="visually-hidden">Close</span>
        </button>
      </header>

      <div className="history-panel-body">
        {onMark !== undefined ? (
          <section
            aria-label="Current version actions"
            className="history-current-actions"
          >
            <button
              disabled={processing || markIsProcessing}
              onClick={() => void handleMark()}
              type="button"
            >
              {markIsProcessing
                ? "Marking current version…"
                : "Mark current version"}
            </button>
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
          </section>
        ) : null}
        {previewItem !== undefined ? (
          <HistoryPreview
            content={previewContent}
            errorMessage={previewErrorMessage}
            item={previewItem}
            moreActions={moreActions}
            onExit={exitPreview}
            onRestore={() => onRestore?.(previewItem)}
            processing={processing}
            state={previewState}
          />
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
                  selectedVersionId={activeSelectedId}
                />
                {selectedItem !== undefined ? (
                  <section
                    aria-label="Selected version actions"
                    className="history-selection-actions"
                  >
                    <p>
                      {selectedItem.versionId === currentVersionId
                        ? "Current version"
                        : "Selected version"}
                    </p>
                    <div>
                      <button
                        disabled={
                          processing ||
                          selectedItem.availability.status !== "available"
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
                          selectedItem.availability.status !== "available"
                        }
                        onClick={() => onRestore?.(selectedItem)}
                        type="button"
                      >
                        Restore this version
                      </button>
                    </div>
                  </section>
                ) : null}
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
    </aside>
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
