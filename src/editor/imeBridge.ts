import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

const WYSIWYG_SELECTOR = "textarea.excalidraw-wysiwyg";

export class ImeBridge {
  private readonly root: HTMLElement;
  private readonly observer: MutationObserver;
  private readonly unsubscribeScroll: () => void;
  private frame: number | undefined;

  constructor(root: HTMLElement, api: ExcalidrawImperativeAPI) {
    this.root = root;
    this.observer = new MutationObserver(this.scheduleSync);
    this.observer.observe(root, { childList: true, subtree: true });
    this.unsubscribeScroll = api.onScrollChange(this.scheduleSync);
    this.scheduleSync();
  }

  dispose(): void {
    this.observer.disconnect();
    this.unsubscribeScroll();
    if (this.frame !== undefined) {
      cancelAnimationFrame(this.frame);
    }
  }

  private readonly scheduleSync = (): void => {
    if (this.frame !== undefined) {
      return;
    }

    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      const textarea =
        this.root.querySelector<HTMLTextAreaElement>(WYSIWYG_SELECTOR);
      if (textarea === null) {
        return;
      }

      // Excalidraw owns the exact text transform. Its public editor registers a
      // resize listener that recalculates the absolute textarea position from
      // scroll and zoom; triggering that path keeps native IME candidate UI
      // anchored without depending on private style calculations.
      textarea.style.position = "absolute";
      window.dispatchEvent(new Event("resize"));
    });
  };
}
