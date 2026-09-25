import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installProtectedInput,
  isProtectedSceneDrop,
  isTextEditingTarget,
  protectedKeyboardAction,
} from "./protectedInput";

describe("protected input", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it.each([
    ["Backspace", "clear"],
    ["Delete", "clear"],
    ["o", "import-shortcut"],
  ] as const)("recognizes canvas Cmd shortcut %s", (key, action) => {
    expect(
      protectedKeyboardAction({
        key,
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe(action);
  });

  it("accepts Control shortcuts and rejects modified text variants", () => {
    expect(
      protectedKeyboardAction({
        key: "Delete",
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe("clear");
    expect(
      protectedKeyboardAction({
        key: "o",
        metaKey: true,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
      }),
    ).toBeUndefined();
  });

  it("protects canvas shortcuts while preserving text editing", () => {
    const root = document.createElement("div");
    const canvas = document.createElement("div");
    const input = document.createElement("input");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    root.append(canvas, input, editable);
    document.body.append(root);
    const onClear = vi.fn();
    const onImportShortcut = vi.fn();
    const dispose = installProtectedInput(root, {
      onClear,
      onImportShortcut,
    });

    const clearEvent = dispatchKey(canvas, "Delete", { metaKey: true });
    const importEvent = dispatchKey(canvas, "o", { metaKey: true });
    const inputEvent = dispatchKey(input, "Backspace", { metaKey: true });
    const editableEvent = dispatchKey(editable, "Delete", { metaKey: true });

    expect(clearEvent.defaultPrevented).toBe(true);
    expect(importEvent.defaultPrevented).toBe(true);
    expect(inputEvent.defaultPrevented).toBe(false);
    expect(editableEvent.defaultPrevented).toBe(false);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onImportShortcut).toHaveBeenCalledTimes(1);
    dispose();
    const afterDispose = dispatchKey(canvas, "Delete", { metaKey: true });
    expect(afterDispose.defaultPrevented).toBe(false);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("captures explicit scene drops but delegates ordinary images and libraries", () => {
    const root = document.createElement("div");
    const canvas = document.createElement("div");
    root.append(canvas);
    document.body.append(root);
    const onSceneDrop = vi.fn();
    installProtectedInput(root, { onSceneDrop });

    const sceneFile = new File(["{}"], "drawing.excalidraw", {
      type: "application/json",
    });
    const sceneEvent = dispatchDrop(canvas, [sceneFile], ["Files"]);
    expect(sceneEvent.defaultPrevented).toBe(true);
    expect(onSceneDrop).toHaveBeenCalledWith(
      expect.objectContaining({ files: [sceneFile], event: sceneEvent }),
    );

    const imageFile = new File(["png"], "photo.png", { type: "image/png" });
    const imageEvent = dispatchDrop(canvas, [imageFile], ["Files"]);
    expect(imageEvent.defaultPrevented).toBe(false);

    const libraryEvent = dispatchDrop(
      canvas,
      [],
      ["application/vnd.excalidrawlib"],
    );
    expect(libraryEvent.defaultPrevented).toBe(false);
    expect(onSceneDrop).toHaveBeenCalledTimes(1);
  });

  it("does not classify a file without an explicit scene extension as protected", () => {
    const file = new File(["{}"], "drawing.json", {
      type: "application/json",
    });
    const event = makeDropEvent([file], ["Files"]);
    expect(isProtectedSceneDrop(event)).toBe(false);
    expect(isTextEditingTarget(document.createElement("div"))).toBe(false);
  });

  it("does not swallow protected commands until the host supplies a handler", () => {
    const root = document.createElement("div");
    const canvas = document.createElement("div");
    root.append(canvas);
    document.body.append(root);
    installProtectedInput(root, {});

    expect(dispatchKey(canvas, "Delete", { metaKey: true }).defaultPrevented).toBe(
      false,
    );
    expect(
      dispatchDrop(
        canvas,
        [new File(["{}"], "drawing.excalidraw")],
        ["Files"],
      ).defaultPrevented,
    ).toBe(false);
  });
});

function dispatchKey(
  target: HTMLElement,
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey">>,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
    metaKey: modifiers.metaKey,
    ctrlKey: modifiers.ctrlKey,
  });
  target.dispatchEvent(event);
  return event;
}

function dispatchDrop(
  target: HTMLElement,
  files: readonly File[],
  types: readonly string[],
): DragEvent {
  const event = makeDropEvent(files, types);
  target.dispatchEvent(event);
  return event;
}

function makeDropEvent(
  files: readonly File[],
  types: readonly string[],
): DragEvent {
  const event = new Event("drop", {
    bubbles: true,
    cancelable: true,
  }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", {
    configurable: true,
    value: {
      files,
      types,
    },
  });
  return event;
}
