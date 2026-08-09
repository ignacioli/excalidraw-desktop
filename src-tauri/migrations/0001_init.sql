PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS workspaces (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    root_path   TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS file_index (
    canonical_path TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL,
    display_name   TEXT NOT NULL,
    relative_path  TEXT NOT NULL,
    mtime          INTEGER NOT NULL,
    file_size      INTEGER NOT NULL,
    content_hash   TEXT,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_file_index_ws ON file_index(workspace_id);

CREATE TABLE IF NOT EXISTS drafts (
    file_path    TEXT PRIMARY KEY,
    scene_json   TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    base_hash    TEXT,
    updated_at   INTEGER NOT NULL,
    is_dirty     INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_drafts_dirty ON drafts(is_dirty);

CREATE TABLE IF NOT EXISTS file_meta (
    canonical_path   TEXT PRIMARY KEY,
    thumbnail_key    TEXT NOT NULL,
    thumbnail_path   TEXT NOT NULL,
    generated_at     INTEGER NOT NULL,
    renderer_version TEXT NOT NULL,
    theme             TEXT NOT NULL CHECK (theme IN ('light','dark'))
);
