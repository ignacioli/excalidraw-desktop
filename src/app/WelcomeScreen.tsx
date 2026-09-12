import newDrawingIcon from "../../docs/design/desktop-shell/hf-2/icons/new-drawing.svg";
import folderIcon from "../assets/folder.svg";
import type { Workspace } from "../ipc/contracts";

export interface WelcomeScreenProps {
  workspaces: readonly Workspace[];
  onNewDrawing: () => void | Promise<void>;
  onOpenWorkspace: () => void | Promise<void>;
  onOpenRecentWorkspace: (workspace: Workspace) => void | Promise<void>;
  busy?: boolean;
  error?: string | null;
}

export function WelcomeScreen({
  workspaces,
  onNewDrawing,
  onOpenWorkspace,
  onOpenRecentWorkspace,
  busy = false,
  error = null,
}: WelcomeScreenProps) {
  const recentWorkspaces = [...workspaces].sort(
    (left, right) =>
      right.createdAt - left.createdAt || right.id.localeCompare(left.id),
  );

  return (
    <section
      aria-labelledby="welcome-title"
      className="welcome-screen"
      data-testid="welcome-screen"
    >
      <div className="welcome-content">
        <p className="welcome-eyebrow">Excalidraw Desktop</p>
        <h1 id="welcome-title">Draw locally. Keep every workspace close.</h1>
        <p className="welcome-description">
          Open an existing workspace or start a drawing. Your files stay local,
          recoverable, and ready across sessions.
        </p>
        <div aria-busy={busy || undefined} className="welcome-actions">
          <button
            className="welcome-action primary-action"
            disabled={busy}
            onClick={() => void onNewDrawing()}
            type="button"
          >
            <img alt="" aria-hidden="true" src={newDrawingIcon} />
            New Drawing
          </button>
          <button
            className="welcome-action"
            disabled={busy}
            onClick={() => void onOpenWorkspace()}
            type="button"
          >
            <img alt="" aria-hidden="true" src={folderIcon} />
            Open Workspace
          </button>
        </div>
        {error !== null ? (
          <p aria-live="assertive" className="welcome-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      {recentWorkspaces.length > 0 ? (
        <section
          aria-labelledby="recent-workspaces-title"
          className="recent-workspaces"
        >
          <h2 id="recent-workspaces-title">Recent Workspaces</h2>
          <p className="recent-workspaces-description">
            Continue where you left off
          </p>
          <ul
            aria-label="Recent Workspaces"
            className="recent-workspace-list"
          >
            {recentWorkspaces.map((workspace) => (
              <li key={workspace.id}>
                <button
                  aria-label={`Open workspace ${workspace.name}`}
                  className="recent-workspace"
                  disabled={busy}
                  onClick={() => void onOpenRecentWorkspace(workspace)}
                  type="button"
                >
                  <img alt="" aria-hidden="true" src={folderIcon} />
                  <span className="recent-workspace-name">
                    {workspace.name}
                  </span>
                  <span className="recent-workspace-path">
                    {workspace.rootPath}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="welcome-session-note">
        No recoverable session · Welcome is a document state, not an extra
        permanent tab.
      </p>
    </section>
  );
}
