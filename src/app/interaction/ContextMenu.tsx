import {
  useId,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { MenuDismissalReason } from "./interactionStore";

export interface ContextMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  onSelect(): void;
}

interface ContextMenuProps {
  label: string;
  items: readonly ContextMenuItem[];
  anchor: { x: number; y: number };
  onDismiss(reason: MenuDismissalReason): void;
  triggerRef?: RefObject<HTMLElement | null>;
  description?: ReactNode;
}

export function ContextMenu({
  label,
  items,
  anchor,
  onDismiss,
  triggerRef,
  description,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef(true);
  const descriptionId = useId();
  const [position, setPosition] = useState(anchor);

  useEffect(() => {
    const returnFocusTarget = triggerRef?.current;
    restoreFocusRef.current = true;
    firstEnabledItem(menuRef.current)?.focus();
    return () => {
      if (restoreFocusRef.current) returnFocusTarget?.focus();
    };
  }, [triggerRef]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef?.current?.contains(target)) return;
      onDismiss("outsidePointer");
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onDismiss, triggerRef]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu === null) return;
    const rect = menu.getBoundingClientRect();
    const next = clampMenuPosition(
      anchor,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPosition((current) =>
      current.x === next.x && current.y === next.y ? current : next,
    );
  }, [anchor, description, items]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = enabledItems(menuRef.current);
    if (enabled.length === 0) return;
    const current = Math.max(
      0,
      enabled.indexOf(document.activeElement as HTMLElement),
    );
    let next: HTMLElement | undefined;
    switch (event.key) {
      case "ArrowDown":
        next = enabled[(current + 1) % enabled.length];
        break;
      case "ArrowUp":
        next = enabled[(current - 1 + enabled.length) % enabled.length];
        break;
      case "Home":
        next = enabled[0];
        break;
      case "End":
        next = enabled.at(-1);
        break;
      case "Escape":
        event.preventDefault();
        onDismiss("escape");
        return;
      case "Tab":
        restoreFocusRef.current = false;
        onDismiss("tab");
        return;
      default:
        return;
    }
    event.preventDefault();
    next?.focus();
  };

  return (
    <div
      ref={menuRef}
      className="application-context-menu"
      onKeyDown={handleKeyDown}
      style={{ left: position.x, position: "fixed", top: position.y }}
    >
      {description ? (
        <p className="application-context-menu-description" id={descriptionId}>
          {description}
        </p>
      ) : null}
      <div
        aria-describedby={description === undefined ? undefined : descriptionId}
        aria-label={label}
        role="menu"
      >
        {items.map((item) => (
          <button
            key={item.id}
            disabled={item.disabled}
            onClick={() => {
              item.onSelect();
              onDismiss("action");
            }}
            role="menuitem"
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function clampMenuPosition(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  let x = anchor.x;
  let y = anchor.y;
  if (x + size.width > viewport.width) {
    x = Math.max(0, viewport.width - size.width);
  }
  if (x < 0) x = 0;
  if (y + size.height > viewport.height) {
    y = anchor.y - size.height;
  }
  if (y + size.height > viewport.height) {
    y = Math.max(0, viewport.height - size.height);
  }
  if (y < 0) y = 0;
  return { x, y };
}

function enabledItems(menu: HTMLElement | null): HTMLElement[] {
  return [
    ...(menu?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([disabled])',
    ) ?? []),
  ];
}

function firstEnabledItem(menu: HTMLElement | null): HTMLElement | undefined {
  return enabledItems(menu)[0];
}
