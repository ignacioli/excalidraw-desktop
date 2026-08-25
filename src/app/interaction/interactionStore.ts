import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

export type InteractionHoldReason = "focus" | "menu" | "dialog" | "drag";
export type MenuDismissalReason =
  | "outsidePointer"
  | "escape"
  | "action"
  | "tab"
  | "ownerCollapsed"
  | "treeScroll"
  | "dialogOpened"
  | "triggerRemoved"
  | "workspaceRemoved";
export type DialogDismissalReason = "escape" | "cancel" | "action";

export interface OpenMenuState {
  menuId: string;
  triggerId: string;
  returnFocusId: string;
}

export interface OpenDialogState {
  dialogId: string;
  returnFocusId: string;
}

export interface InteractionState {
  menu: OpenMenuState | null;
  dialog: OpenDialogState | null;
  holdReasons: Set<InteractionHoldReason>;
  pendingFocusReturnId: string | null;
  lastDismissal:
    | { interaction: "menu"; reason: MenuDismissalReason }
    | { interaction: "dialog"; reason: DialogDismissalReason }
    | null;
}

export type InteractionAction =
  | ({ type: "openMenu" } & OpenMenuState)
  | { type: "closeMenu"; reason: MenuDismissalReason }
  | ({ type: "openDialog" } & OpenDialogState)
  | { type: "closeDialog"; reason: DialogDismissalReason }
  | { type: "addHold"; reason: InteractionHoldReason }
  | { type: "removeHold"; reason: InteractionHoldReason }
  | { type: "focusReturnHandled" };

export function createInteractionState(): InteractionState {
  return {
    menu: null,
    dialog: null,
    holdReasons: new Set(),
    pendingFocusReturnId: null,
    lastDismissal: null,
  };
}

export function interactionReducer(
  state: InteractionState,
  action: InteractionAction,
): InteractionState {
  switch (action.type) {
    case "openMenu": {
      const sameTrigger = state.menu?.triggerId === action.triggerId;
      if (sameTrigger) {
        return closeMenu(state, "action");
      }
      return {
        ...state,
        menu: {
          menuId: action.menuId,
          triggerId: action.triggerId,
          returnFocusId: action.returnFocusId,
        },
        pendingFocusReturnId: null,
        holdReasons: withHold(state.holdReasons, "menu"),
      };
    }
    case "closeMenu":
      return closeMenu(state, action.reason);
    case "openDialog": {
      const menuClosed =
        state.menu === null ? state : closeMenu(state, "dialogOpened");
      return {
        ...menuClosed,
        dialog: {
          dialogId: action.dialogId,
          returnFocusId: action.returnFocusId,
        },
        pendingFocusReturnId: null,
        holdReasons: withHold(
          withoutHold(menuClosed.holdReasons, "menu"),
          "dialog",
        ),
      };
    }
    case "closeDialog":
      if (state.dialog === null) return state;
      return {
        ...state,
        dialog: null,
        holdReasons: withoutHold(state.holdReasons, "dialog"),
        pendingFocusReturnId: state.dialog.returnFocusId,
        lastDismissal: { interaction: "dialog", reason: action.reason },
      };
    case "addHold":
      return {
        ...state,
        holdReasons: withHold(state.holdReasons, action.reason),
      };
    case "removeHold":
      return {
        ...state,
        holdReasons: withoutHold(state.holdReasons, action.reason),
      };
    case "focusReturnHandled":
      return { ...state, pendingFocusReturnId: null };
  }
}

function closeMenu(
  state: InteractionState,
  reason: MenuDismissalReason,
): InteractionState {
  if (state.menu === null) return state;
  return {
    ...state,
    menu: null,
    holdReasons: withoutHold(state.holdReasons, "menu"),
    pendingFocusReturnId: state.menu.returnFocusId,
    lastDismissal: { interaction: "menu", reason },
  };
}

function withHold(
  holds: ReadonlySet<InteractionHoldReason>,
  reason: InteractionHoldReason,
): Set<InteractionHoldReason> {
  return new Set([...holds, reason]);
}

function withoutHold(
  holds: ReadonlySet<InteractionHoldReason>,
  reason: InteractionHoldReason,
): Set<InteractionHoldReason> {
  const next = new Set(holds);
  next.delete(reason);
  return next;
}

interface InteractionStoreState extends InteractionState {
  dispatch(action: InteractionAction): void;
}

export const interactionStore = createStore<InteractionStoreState>((set) => ({
  ...createInteractionState(),
  dispatch: (action) => set((state) => interactionReducer(state, action)),
}));

export function useInteractionStore<Selection>(
  selector: (state: InteractionStoreState) => Selection,
): Selection {
  return useStore(interactionStore, selector);
}
