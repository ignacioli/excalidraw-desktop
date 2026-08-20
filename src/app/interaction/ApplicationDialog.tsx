import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

export type ApplicationDialogDismissalReason = "escape" | "cancel" | "action";

interface ApplicationDialogProps {
  title: string;
  children: ReactNode;
  onDismiss(reason: ApplicationDialogDismissalReason): void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  description?: string;
  errorMessage?: string | null;
  busy?: boolean;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function ApplicationDialog({
  title,
  children,
  onDismiss,
  initialFocusRef,
  returnFocusRef,
  description,
  errorMessage,
  busy = false,
}: ApplicationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const returnFocusTarget = returnFocusRef?.current;
    const initial =
      initialFocusRef?.current ??
      dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    initial?.focus();
    return () => returnFocusTarget?.focus();
  }, [initialFocusRef, returnFocusRef]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss("escape");
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [
      ...(dialogRef.current?.querySelectorAll<HTMLElement>(
        FOCUSABLE_SELECTOR,
      ) ?? []),
    ];
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const describedBy =
    [description ? descriptionId : null, errorMessage ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <div className="application-dialog-backdrop">
      <div
        ref={dialogRef}
        aria-busy={busy || undefined}
        aria-describedby={describedBy}
        aria-labelledby={titleId}
        aria-modal="true"
        className="application-dialog"
        onKeyDown={handleKeyDown}
        role="dialog"
        tabIndex={-1}
      >
        <h2 id={titleId}>{title}</h2>
        {description ? <p id={descriptionId}>{description}</p> : null}
        {children}
        {errorMessage ? (
          <p id={errorId} role="alert">
            {errorMessage}
          </p>
        ) : null}
      </div>
    </div>
  );
}
