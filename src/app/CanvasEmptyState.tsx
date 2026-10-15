import { useI18n } from "../i18n";

export interface CanvasEmptyStateProps {
  /** A pinned sidebar is already showing the drawings. */
  sidebarPinned: boolean;
  busy?: boolean;
  onNewDrawing: () => void;
  onShowSidebar: () => void;
}

/**
 * The canvas area of a Workspace window with no open drawing: the canvas
 * background and grid, a handwritten hint, and the next actions. No editor
 * is mounted, so nothing can be drawn here.
 */
export function CanvasEmptyState({
  sidebarPinned,
  busy = false,
  onNewDrawing,
  onShowSidebar,
}: CanvasEmptyStateProps) {
  const { t } = useI18n();
  return (
    <section
      aria-label={t("shell.emptyState.label")}
      className="canvas-empty-state"
      data-sidebar-pinned={sidebarPinned ? "true" : "false"}
    >
      {sidebarPinned ? null : (
        <div aria-hidden="true" className="canvas-empty-state__pointer">
          <svg
            className="canvas-empty-state__arrow"
            fill="none"
            height="100"
            viewBox="0 0 160 100"
            width="160"
          >
            <path d="M154 90 C 92 88, 40 64, 10 14" />
            <path d="M4 34 L 9 12 L 28 24" />
          </svg>
          <span className="canvas-empty-state__note">
            {t("shell.emptyState.sidebarNote")}
          </span>
        </div>
      )}
      <div className="canvas-empty-state__content">
        <p className="canvas-empty-state__title">
          {t("shell.emptyState.title")}
        </p>
        <p className="canvas-empty-state__subtitle">
          {t("shell.emptyState.subtitle")}
        </p>
        <div className="canvas-empty-state__actions">
          <button
            className="canvas-empty-state__action"
            disabled={busy}
            onClick={onNewDrawing}
            type="button"
          >
            {t("shell.emptyState.newDrawing")}
          </button>
          {sidebarPinned ? null : (
            <button
              className="canvas-empty-state__action"
              onClick={onShowSidebar}
              type="button"
            >
              {t("shell.emptyState.showSidebar")}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
