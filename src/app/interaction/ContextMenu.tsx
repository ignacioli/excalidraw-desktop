import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";
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
}

export function ContextMenu({
  label,
  items,
  anchor,
  onDismiss,
  triggerRef,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const returnFocusTarget = triggerRef?.current;
    firstEnabledItem(menuRef.current)?.focus();
    return () => returnFocusTarget?.focus();
  }, [triggerRef]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onDismiss("outsidePointer");
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onDismiss]);

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
      default:
        return;
    }
    event.preventDefault();
    next?.focus();
  };

  return (
    <div
      ref={menuRef}
      aria-label={label}
      className="application-context-menu"
      onKeyDown={handleKeyDown}
      role="menu"
      style={{ left: anchor.x, position: "fixed", top: anchor.y }}
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
  );
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
