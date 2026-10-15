-- Windows to restore after a normal quit, in creation order. A NULL
-- workspace_id is a Welcome window that still has open drawings.
CREATE TABLE IF NOT EXISTS window_session (
    position     INTEGER PRIMARY KEY,
    workspace_id TEXT,
    tabs_json    TEXT NOT NULL DEFAULT '[]',
    active_path  TEXT,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
);

-- Window placement and sidebar state remembered per Workspace. Geometry is
-- stored in logical pixels; sidebar_width is stored as reported by the
-- frontend, which owns its clamping rule.
CREATE TABLE IF NOT EXISTS workspace_window_state (
    workspace_id   TEXT PRIMARY KEY,
    x              REAL,
    y              REAL,
    width          REAL,
    height         REAL,
    maximized      INTEGER NOT NULL DEFAULT 0 CHECK (maximized IN (0, 1)),
    fullscreen     INTEGER NOT NULL DEFAULT 0 CHECK (fullscreen IN (0, 1)),
    sidebar_pinned INTEGER CHECK (sidebar_pinned IN (0, 1)),
    sidebar_width  INTEGER,
    expanded_json  TEXT NOT NULL DEFAULT '[]',
    updated_at     INTEGER NOT NULL,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- Application-level one-time markers, such as the shell preference import.
CREATE TABLE IF NOT EXISTS app_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
