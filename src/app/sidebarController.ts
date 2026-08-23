export type SidebarMode = "hidden" | "overlay" | "pinned";
export type SidebarHoldReason = "focus" | "menu" | "dialog" | "drag";

export interface SidebarSnapshot {
  mode: SidebarMode;
  closePending: boolean;
  hideAtMs: number | null;
  holdReasons: ReadonlySet<SidebarHoldReason>;
}

export interface SidebarControllerOptions {
  initiallyPinned?: boolean;
  now?: () => number;
  pointerLeaveDelayMs?: number;
}

export interface SidebarController {
  getSnapshot(): SidebarSnapshot;
  subscribe(listener: () => void): () => void;
  openOverlay(): void;
  pin(): void;
  unpin(): void;
  hide(): void;
  handleEscape(): boolean;
  setHold(reason: SidebarHoldReason, active: boolean): void;
  handlePointerEnter(): void;
  handlePointerLeave(): void;
  tick(now: number): void;
}

const DEFAULT_POINTER_LEAVE_DELAY_MS = 500;

export function createSidebarController(
  options: SidebarControllerOptions = {},
): SidebarController {
  const now = options.now ?? Date.now;
  const delayMs = options.pointerLeaveDelayMs ?? DEFAULT_POINTER_LEAVE_DELAY_MS;
  const listeners = new Set<() => void>();
  const holdReasons = new Set<SidebarHoldReason>();
  let mode: SidebarMode = options.initiallyPinned === true ? "pinned" : "hidden";
  let closePending = false;
  let hideAt: number | null = null;
  let pointerInside = false;

  let cachedSnapshot: SidebarSnapshot = {
    mode,
    closePending,
    hideAtMs: hideAt,
    holdReasons: new Set(holdReasons),
  };

  const emit = (): void => {
    cachedSnapshot = {
      mode,
      closePending,
      hideAtMs: hideAt,
      holdReasons: new Set(holdReasons),
    };
    for (const listener of listeners) {
      listener();
    }
  };

  const snapshot = (): SidebarSnapshot => cachedSnapshot;

  const clearPending = (): void => {
    closePending = false;
    hideAt = null;
  };

  const hideOverlay = (): void => {
    if (mode === "pinned") return;
    mode = "hidden";
    pointerInside = false;
    clearPending();
  };

  const startPendingClose = (): void => {
    closePending = true;
    hideAt = now() + delayMs;
  };

  return {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    openOverlay() {
      if (mode === "pinned") return;
      mode = "overlay";
      clearPending();
      emit();
    },
    pin() {
      mode = "pinned";
      clearPending();
      emit();
    },
    unpin() {
      if (mode !== "pinned") return;
      mode = "overlay";
      clearPending();
      emit();
    },
    hide() {
      if (mode === "pinned") return;
      hideOverlay();
      emit();
    },
    handleEscape() {
      if (mode === "pinned" || mode === "hidden") {
        return false;
      }
      hideOverlay();
      emit();
      return true;
    },
    setHold(reason, active) {
      if (active) {
        holdReasons.add(reason);
        if (closePending) {
          clearPending();
        }
      } else {
        holdReasons.delete(reason);
        if (
          holdReasons.size === 0 &&
          !pointerInside &&
          mode === "overlay" &&
          !closePending
        ) {
          startPendingClose();
        }
      }
      emit();
    },
    handlePointerEnter() {
      pointerInside = true;
      if (mode === "pinned") return;
      if (closePending) {
        clearPending();
        emit();
      }
    },
    handlePointerLeave() {
      pointerInside = false;
      if (mode !== "overlay" || holdReasons.size > 0) {
        return;
      }
      startPendingClose();
      emit();
    },
    tick(currentNow) {
      if (!closePending || hideAt === null || mode !== "overlay") {
        return;
      }
      if (holdReasons.size > 0) {
        clearPending();
        emit();
        return;
      }
      if (currentNow >= hideAt) {
        hideOverlay();
        emit();
      }
    },
  };
}
