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
  /** Resume the SDK's ordinary image path once after asynchronous parsing. */
  forwardOrdinaryImage(): void;
}

export interface ProtectedInputHandlers {
  /** Called for Cmd/Ctrl+Backspace or Cmd/Ctrl+Delete on the canvas. */
  onClear?: () => void | Promise<void>;
  /** Called for Cmd/Ctrl+O on the canvas. */
  onImportShortcut?: () => void | Promise<void>;
  /** Called for scene files and PNG/SVG files that may embed a scene. */
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
  const forwardedEvents = new WeakSet<DragEvent>();
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
      forwardedEvents.has(event) ||
      handlers.onSceneDrop === undefined ||
      !isEventInsideRoot(root, event.target) ||
      !isProtectedSceneDrop(event)
    ) {
      return;
    }

    // Candidate PNG/SVG files need asynchronous parsing before the SDK sees
    // them. Other images and library drags continue directly to the SDK.
    event.preventDefault();
    event.stopPropagation();
    const callback = handlers.onSceneDrop;
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) {
      const sceneMime = Array.from(event.dataTransfer?.types ?? []).find(
        (type) =>
          [
            "application/vnd.excalidraw",
            "application/vnd.excalidraw+json",
            "application/x-excalidraw",
          ].includes(type.toLowerCase()),
      );
      const sceneJson = sceneMime
        ? event.dataTransfer?.getData(sceneMime)
        : undefined;
      if (sceneJson) {
        files.push(
          new File([sceneJson], "dropped.excalidraw", {
            type: sceneMime,
          }),
        );
      }
    }
    if (files.length === 0) {
      handlers.onError?.(new Error("拖放内容缺少可读取的绘图数据。"));
      return;
    }
    const target = event.target;
    const { clientX, clientY } = event;
    let forwardedOnce = false;
    invokeSafely(
      () =>
        callback({
          files,
          event,
          forwardOrdinaryImage: () => {
            if (forwardedOnce) return;
            const file = files[0];
            if (!(target instanceof Node) || !root.contains(target) || !file) {
              throw new Error(
                "The dropped image's canvas is no longer available.",
              );
            }
            forwardedOnce = true;
            const transfer = new DataTransfer();
            transfer.items.add(file);
            const forwarded = new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
              clientX,
              clientY,
            });
            forwardedEvents.add(forwarded);
            target.dispatchEvent(forwarded);
          },
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

/** Return true for possible scene drops, excluding the SDK's library MIME. */
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
      [
        "application/vnd.excalidraw",
        "application/vnd.excalidraw+json",
        "application/x-excalidraw",
      ].includes(type.toLowerCase()),
    )
  ) {
    return true;
  }

  return Array.from(transfer.files).some(
    (file) =>
      /\.(?:excalidraw(?:\.json)?|png|svg)$/iu.test(file.name) ||
      file.type === "image/png" ||
      file.type === "image/svg+xml",
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
