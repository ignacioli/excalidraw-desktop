import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { middleEllipsis } from "./middleEllipsis";

export type ApplicationDialogDismissalReason = "escape" | "cancel" | "action";

/**
 * `default` keeps each feature's own dialog layout. `sidebar` is the shared
 * anatomy for sidebar naming and confirmation dialogs and the nested
 * Workspace conflict: title, description, object path, caller content
 * (fields), dialog error, then the action row.
 */
export type ApplicationDialogVariant = "default" | "sidebar";

interface ApplicationDialogProps {
  title: string;
  children: ReactNode;
  onDismiss(reason: ApplicationDialogDismissalReason): void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  description?: string;
  errorMessage?: string | null;
  busy?: boolean;
  variant?: ApplicationDialogVariant;
  /** Sidebar variant: the affected object's path, home already abbreviated. */
  objectPath?: string;
  /** Sidebar variant: the action row, rendered after the dialog error. */
  actions?: ReactNode;
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
  variant = "default",
  objectPath,
  actions,
}: ApplicationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const initial =
      initialFocusRef?.current ??
      dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
      dialogRef.current;
    initial?.focus();
    return () => {
      // Read at unmount so a successful mutation can clear this ref and
      // focus the created/surviving tree row instead of the old trigger.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
      const target = returnFocusRef?.current;
      if (target?.isConnected) target.focus();
    };
  }, [initialFocusRef, returnFocusRef]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!busy) onDismiss("escape");
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

  const errorElement = errorMessage ? (
    <p className="conflict-dialog-error" id={errorId} role="alert">
      {errorMessage}
    </p>
  ) : null;

  if (variant === "sidebar") {
    return (
      <div className="application-dialog-backdrop conflict-dialog-backdrop">
        <div
          ref={dialogRef}
          aria-busy={busy || undefined}
          aria-describedby={describedBy}
          aria-labelledby={titleId}
          aria-modal="true"
          className="application-dialog application-dialog--sidebar"
          data-variant="sidebar"
          onKeyDown={handleKeyDown}
          role="dialog"
          tabIndex={-1}
        >
          <h2 className="application-dialog-title" id={titleId}>
            {title}
          </h2>
          {description ? (
            <p className="application-dialog-description" id={descriptionId}>
              {description}
            </p>
          ) : null}
          {objectPath ? (
            <p className="application-dialog-object-path" title={objectPath}>
              {middleEllipsis(objectPath)}
            </p>
          ) : null}
          {children}
          {errorMessage ? (
            <p className="application-dialog-error" id={errorId} role="alert">
              {errorMessage}
            </p>
          ) : null}
          {actions}
        </div>
      </div>
    );
  }

  return (
    <div className="application-dialog-backdrop conflict-dialog-backdrop">
      <div
        ref={dialogRef}
        aria-busy={busy || undefined}
        aria-describedby={describedBy}
        aria-labelledby={titleId}
        aria-modal="true"
        className="application-dialog conflict-dialog"
        onKeyDown={handleKeyDown}
        role="dialog"
        tabIndex={-1}
      >
        <h2 id={titleId}>{title}</h2>
        {description ? <p id={descriptionId}>{description}</p> : null}
        {children}
        {errorElement}
        {actions}
      </div>
    </div>
  );
}

export type ApplicationDialogButtonKind =
  "secondary" | "primary" | "danger" | "link";

interface ApplicationDialogButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type"
> {
  kind: ApplicationDialogButtonKind;
  buttonRef?: Ref<HTMLButtonElement>;
}

export function ApplicationDialogButton({
  kind,
  buttonRef,
  className,
  ...props
}: ApplicationDialogButtonProps) {
  return (
    <button
      {...props}
      ref={buttonRef}
      className={["application-dialog-button", className]
        .filter(Boolean)
        .join(" ")}
      data-kind={kind}
      type="button"
    />
  );
}

/**
 * Sidebar variant action row: an optional leading link action aligned with
 * the content's left edge, then the right-aligned buttons with the primary
 * action last. The row wraps when it does not fit; the primary action stays
 * at the right.
 */
export function ApplicationDialogActions({
  leading,
  children,
}: {
  leading?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="application-dialog-actions application-dialog-actions--sidebar">
      {leading ? (
        <div className="application-dialog-actions-leading">{leading}</div>
      ) : null}
      <div className="application-dialog-actions-trailing">{children}</div>
    </div>
  );
}

interface ApplicationDialogFieldProps {
  label: string;
  value: string;
  onChange(value: string): void;
  inputRef?: Ref<HTMLInputElement>;
  /** Fixed, non-editable suffix shown inside the field box. */
  suffix?: string;
  /** How assistive technology describes the suffix, e.g. "Fixed extension .excalidraw". */
  suffixLabel?: string;
  errorMessage?: string | null;
  disabled?: boolean;
}

/** Sidebar variant name field: label above, full-width input, error below. */
export function ApplicationDialogField({
  label,
  value,
  onChange,
  inputRef,
  suffix,
  suffixLabel,
  errorMessage,
  disabled = false,
}: ApplicationDialogFieldProps) {
  const inputId = useId();
  const suffixId = useId();
  const errorId = useId();
  const describedBy =
    [suffix ? suffixId : null, errorMessage ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="application-dialog-field">
      <label className="application-dialog-field-label" htmlFor={inputId}>
        {label}
      </label>
      <div
        className="application-dialog-field-box"
        data-invalid={errorMessage ? "true" : undefined}
      >
        <input
          ref={inputRef}
          aria-describedby={describedBy}
          aria-invalid={errorMessage ? true : undefined}
          disabled={disabled}
          id={inputId}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          type="text"
          value={value}
        />
        {suffix ? (
          <>
            <span
              aria-hidden="true"
              className="application-dialog-field-suffix"
            >
              {suffix}
            </span>
            <span className="visually-hidden" id={suffixId}>
              {suffixLabel ?? suffix}
            </span>
          </>
        ) : null}
      </div>
      {errorMessage ? (
        <p className="application-dialog-field-error" id={errorId} role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
