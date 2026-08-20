import { describe, expect, it } from "vitest";
import { createInteractionState, interactionReducer } from "./interactionStore";

describe("interactionReducer", () => {
  it("keeps exactly one menu and toggles or replaces it", () => {
    let state = createInteractionState();
    state = interactionReducer(state, {
      type: "openMenu",
      menuId: "workspace-menu",
      triggerId: "workspace-trigger",
      returnFocusId: "workspace-trigger",
    });
    state = interactionReducer(state, {
      type: "openMenu",
      menuId: "drawing-menu",
      triggerId: "drawing-trigger",
      returnFocusId: "drawing-trigger",
    });
    expect(state.menu).toMatchObject({
      menuId: "drawing-menu",
      triggerId: "drawing-trigger",
    });

    state = interactionReducer(state, {
      type: "openMenu",
      menuId: "drawing-menu",
      triggerId: "drawing-trigger",
      returnFocusId: "drawing-trigger",
    });
    expect(state.menu).toBeNull();
  });

  it.each([
    "outsidePointer",
    "escape",
    "action",
    "ownerCollapsed",
    "treeScroll",
    "dialogOpened",
    "triggerRemoved",
    "workspaceRemoved",
  ] as const)("records the %s menu dismissal reason", (reason) => {
    let state = interactionReducer(createInteractionState(), {
      type: "openMenu",
      menuId: "menu",
      triggerId: "trigger",
      returnFocusId: "trigger",
    });
    state = interactionReducer(state, { type: "closeMenu", reason });
    expect(state.menu).toBeNull();
    expect(state.lastDismissal).toEqual({ interaction: "menu", reason });
    expect(state.pendingFocusReturnId).toBe("trigger");
  });

  it("opening a dialog closes the menu and maintains dialog/sidebar holds", () => {
    let state = interactionReducer(createInteractionState(), {
      type: "openMenu",
      menuId: "menu",
      triggerId: "trigger",
      returnFocusId: "trigger",
    });
    state = interactionReducer(state, {
      type: "openDialog",
      dialogId: "rename",
      returnFocusId: "trigger",
    });
    expect(state.menu).toBeNull();
    expect(state.dialog).toEqual({
      dialogId: "rename",
      returnFocusId: "trigger",
    });
    expect(state.holdReasons).toEqual(new Set(["dialog"]));

    state = interactionReducer(state, { type: "addHold", reason: "focus" });
    state = interactionReducer(state, { type: "addHold", reason: "drag" });
    state = interactionReducer(state, { type: "removeHold", reason: "focus" });
    expect(state.holdReasons).toEqual(new Set(["dialog", "drag"]));

    state = interactionReducer(state, {
      type: "closeDialog",
      reason: "escape",
    });
    expect(state.dialog).toBeNull();
    expect(state.holdReasons).toEqual(new Set(["drag"]));
    expect(state.pendingFocusReturnId).toBe("trigger");
  });
});
