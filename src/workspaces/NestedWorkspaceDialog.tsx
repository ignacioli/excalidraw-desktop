import { useRef } from "react";
import {
  ApplicationDialog,
  ApplicationDialogActions,
  ApplicationDialogButton,
} from "../app/interaction/ApplicationDialog";
import { useI18n } from "../i18n";
import { abbreviateHome, useHomeDirectory } from "./displayPath";

/**
 * `closing`: "Close it and open here" is waiting for the other window.
 * `notClosed`: that window's close was cancelled or failed; nothing opened.
 */
export type NestedWorkspaceDialogStatus = "idle" | "closing" | "notClosed";

export interface NestedWorkspaceDialogProps {
  /** The folder being opened. */
  targetName: string;
  targetPath: string;
  /** The Workspace inside it, open in another window. */
  openWorkspaceName: string;
  openWorkspacePath: string;
  status: NestedWorkspaceDialogStatus;
  /** Any other failure, shown above the actions. */
  errorMessage?: string | null;
  onSwitch(): void;
  onCloseAndOpen(): void;
  onCancel(): void;
}

/**
 * The folder being opened contains a Workspace open in another window.
 * Sidebar dialog anatomy: title, description, `target ⊃ open` path, then a
 * leading link action and Cancel → Switch to that window (initial focus).
 */
export function NestedWorkspaceDialog({
  targetName,
  targetPath,
  openWorkspaceName,
  openWorkspacePath,
  status,
  errorMessage,
  onSwitch,
  onCloseAndOpen,
  onCancel,
}: NestedWorkspaceDialogProps) {
  const { t } = useI18n();
  const home = useHomeDirectory();
  const switchRef = useRef<HTMLButtonElement>(null);
  const busy = status === "closing";
  const message =
    status === "notClosed"
      ? t("workspace.nested.notClosed", {
          workspace: openWorkspaceName,
          target: targetName,
        })
      : (errorMessage ?? null);

  return (
    <ApplicationDialog
      actions={
        <ApplicationDialogActions
          leading={
            <ApplicationDialogButton
              disabled={busy}
              kind="link"
              onClick={onCloseAndOpen}
            >
              {busy
                ? t("workspace.nested.closing")
                : t("workspace.nested.closeAndOpen")}
            </ApplicationDialogButton>
          }
        >
          <ApplicationDialogButton
            disabled={busy}
            kind="secondary"
            onClick={onCancel}
          >
            {t("workspace.nested.cancel")}
          </ApplicationDialogButton>
          <ApplicationDialogButton
            buttonRef={switchRef}
            disabled={busy}
            kind="primary"
            onClick={onSwitch}
          >
            {t("workspace.nested.switch")}
          </ApplicationDialogButton>
        </ApplicationDialogActions>
      }
      busy={busy}
      description={t("workspace.nested.description", {
        workspace: openWorkspaceName,
      })}
      errorMessage={message}
      initialFocusRef={switchRef}
      objectPath={`${abbreviateHome(targetPath, home)} ⊃ ${abbreviateHome(
        openWorkspacePath,
        home,
      )}`}
      onDismiss={(reason) => {
        if (reason === "escape") onCancel();
      }}
      title={t("workspace.nested.title", { target: targetName })}
      variant="sidebar"
    >
      {null}
    </ApplicationDialog>
  );
}
