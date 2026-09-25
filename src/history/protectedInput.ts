/**
 * Host-side guards for destructive Excalidraw entry points.
 *
 * Excalidraw's public UIOptions can hide its clear/load controls, but it does
 * not provide a public drop callback.  This small capture-phase seam sits on
 * the host container so the coordinator can own the operation before the SDK
 * receives a clear shortcut or a scene file drop.  Ordinary text editing and
 * image/library drops remain SDK-owned.
 */

export type ProtectedInputAction = "clear" | "import-shortcut";

export interface ProtectedSceneDrop {
  readonly files: readonly File[];
  readonly event: DragEvent;
}

export interface ProtectedInputHandlers {
  /** Called for Cmd/Ctrl+Backspace or Cmd/Ctrl+Delete on the canvas. */
  onClear?: () => void | Promise<void>;
  /** Called for Cmd/Ctrl+O on the canvas. */
  onImportShortcut?: () => void | Promise<void>;
  /** Called for an explicit .excalidraw scene drop. */
  onSceneDrop?: (drop: ProtectedSceneDrop) => void | Promise<void>;
  /** Keeps async host errors visible to the shell instead of unhandled. */
  onError?: (error: unknown) => void;
}

/**
 * Install protected-input listeners on a host element.  The listeners use
 * capture so the SDK's own container handlers cannot process a protected
 * command first.  The returned function removes every listener.
 */
export function installProtectedInput(
  root: HTMLElement,
  handlers: ProtectedInputHandlers,
): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (
      !isEventInsideRoot(root, event.target) ||
      isTextEditingTarget(event.target)
    ) {
      return;
    }

    const action = protectedKeyboardAction(event);
    if (action === undefined) {
      return;
    }

    const callback =
      action === "clear" ? handlers.onClear : handlers.onImportShortcut;
    if (callback === undefined) {
      return;
    }

    // UIOptions disables the SDK action, but still stop the event here so a
    // future SDK change cannot bypass the protected coordinator.
    event.preventDefault();
    event.stopPropagation();

    invokeSafely(callback, handlers.onError);
  };

  const onDrop = (event: DragEvent): void => {
    if (
      handlers.onSceneDrop === undefined ||
      !isEventInsideRoot(root, event.target) ||
      !isProtectedSceneDrop(event)
    ) {
      return;
    }

    // Library MIME data and ordinary images intentionally do not match this
    // guard, so the SDK handles those exactly once.
    event.preventDefault();
    event.stopPropagation();
    const callback = handlers.onSceneDrop;
    invokeSafely(
      () =>
        callback({
          files: Array.from(event.dataTransfer?.files ?? []),
          event,
        }),
      handlers.onError,
    );
  };

  root.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("drop", onDrop, true);
  return () => {
    root.removeEventListener("keydown", onKeyDown, true);
    root.removeEventListener("drop", onDrop, true);
  };
}

export function protectedKeyboardAction(
  event: Pick<
    KeyboardEvent,
    "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
): ProtectedInputAction | undefined {
  if (event.altKey || event.shiftKey || (!event.metaKey && !event.ctrlKey)) {
    return undefined;
  }
  if (event.key === "Backspace" || event.key === "Delete") {
    return "clear";
  }
  return event.key.toLowerCase() === "o" ? "import-shortcut" : undefined;
}

/** Return true for explicit scene drops, excluding the SDK's library MIME. */
export function isProtectedSceneDrop(
  event: Pick<DragEvent, "dataTransfer">,
): boolean {
  const transfer = event.dataTransfer;
  if (transfer === null) {
    return false;
  }

  const types = Array.from(transfer.types);
  if (types.some((type) => type.toLowerCase().includes("excalidrawlib"))) {
    return false;
  }

  if (
    types.some((type) =>
      ["application/vnd.excalidraw", "application/x-excalidraw"].includes(
        type.toLowerCase(),
      ),
    )
  ) {
    return true;
  }

  return Array.from(transfer.files).some((file) =>
    /\.excalidraw(?:\.json)?$/iu.test(file.name),
  );
}

/** Text controls must keep their native editing shortcuts. */
export function isTextEditingTarget(target: EventTarget | null): boolean {
  let element = target instanceof Element ? target : null;
  while (element !== null) {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      return true;
    }

    const contentEditable = element.getAttribute("contenteditable");
    if (
      (element instanceof HTMLElement && element.isContentEditable) ||
      (contentEditable !== null && contentEditable.toLowerCase() !== "false")
    ) {
      return true;
    }
    element = element.parentElement;
  }
  return false;
}

function isEventInsideRoot(
  root: HTMLElement,
  target: EventTarget | null,
): boolean {
  return target instanceof Node && (target === root || root.contains(target));
}

function invokeSafely(
  callback: () => void | Promise<void>,
  onError: ((error: unknown) => void) | undefined,
): void {
  try {
    const result = callback();
    if (result !== undefined) {
      void result.catch((error: unknown) => onError?.(error));
    }
  } catch (error) {
    onError?.(error);
  }
}
