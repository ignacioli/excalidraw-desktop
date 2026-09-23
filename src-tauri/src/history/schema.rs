//! SQLite schema and connection configuration for the history store.
//!
//! This schema is intentionally separate from `crate::database`: the history
//! database has a stronger durability contract than the hot draft database and
//! must not accidentally inherit its `synchronous=NORMAL` configuration.

use std::time::Duration;

use rusqlite::Connection;
use thiserror::Error;

pub const CURRENT_SCHEMA_VERSION: i64 = 1;

const SCHEMA: &str = r#"
CREATE TABLE history_documents (
    id TEXT PRIMARY KEY NOT NULL,
    canonical_path TEXT NOT NULL,
    filesystem_device INTEGER,
    filesystem_inode INTEGER,
    filesystem_file_size INTEGER,
    filesystem_modified_seconds INTEGER,
    filesystem_modified_nanos INTEGER,
    filesystem_reliable INTEGER CHECK (filesystem_reliable IN (0, 1)),
    filesystem_birthtime_ns INTEGER,
    filesystem_generation TEXT,
    last_self_written_hash TEXT,
    created_at INTEGER NOT NULL,
    last_automatic_at INTEGER,
    state TEXT NOT NULL CHECK (state IN ('active', 'detached', 'deleting'))
);

CREATE INDEX history_documents_path_idx
    ON history_documents (canonical_path);

CREATE TABLE scene_objects (
    hash TEXT PRIMARY KEY NOT NULL,
    schema_version INTEGER NOT NULL CHECK (schema_version > 0),
    codec TEXT NOT NULL CHECK (codec = 'none'),
    raw_length INTEGER NOT NULL CHECK (raw_length >= 0),
    relative_path TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);

CREATE TABLE asset_objects (
    hash TEXT PRIMARY KEY NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    mime_type TEXT NOT NULL CHECK (length(mime_type) > 0 AND instr(mime_type, char(0)) = 0),
    relative_path TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);

CREATE TABLE history_versions (
    id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES history_documents(id) ON DELETE CASCADE,
    scene_hash TEXT NOT NULL REFERENCES scene_objects(hash),
    source TEXT NOT NULL CHECK (source IN ('automatic', 'manual', 'protected')),
    protected_action TEXT,
    recorded_at INTEGER NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    CHECK (
        (source = 'protected' AND protected_action IN ('restore', 'clear', 'import'))
        OR
        (source <> 'protected' AND protected_action IS NULL)
    )
);

CREATE INDEX history_versions_document_order_idx
    ON history_versions (document_id, recorded_at, sequence, id);

CREATE INDEX history_versions_scene_idx
    ON history_versions (scene_hash);

CREATE TABLE version_assets (
    version_id TEXT NOT NULL REFERENCES history_versions(id) ON DELETE CASCADE,
    sdk_file_id TEXT NOT NULL,
    asset_hash TEXT NOT NULL REFERENCES asset_objects(hash),
    mime_type TEXT NOT NULL CHECK (length(mime_type) > 0 AND instr(mime_type, char(0)) = 0),
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    PRIMARY KEY (version_id, sdk_file_id)
);

CREATE INDEX version_assets_hash_idx
    ON version_assets (asset_hash);

CREATE TABLE history_operations (
    idempotency_id TEXT PRIMARY KEY NOT NULL,
    document_id TEXT NOT NULL REFERENCES history_documents(id) ON DELETE CASCADE,
    session_generation INTEGER NOT NULL CHECK (session_generation >= 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('mark', 'replace', 'delete', 'reconcile')),
    -- This is an audit reference, not a foreign key: automatic/protected
    -- history rows may be evicted by retention while the operation record is
    -- still required for crash reconciliation.
    protection_version_id TEXT,
    expected_old_disk_hash TEXT,
    expected_old_identity TEXT,
    prepared_target_identity TEXT,
    observed_published_identity TEXT,
    target_scene_hash TEXT REFERENCES scene_objects(hash),
    target_manifest_hash TEXT,
    actual_target_byte_hash TEXT,
    temp_file TEXT,
    target_object_pins_json TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL CHECK (
        state IN (
            'preparing', 'protected', 'intent_committed', 'target_observed',
            'target_published', 'metadata_committed', 'completed', 'aborted',
            'reconcile', 'conflict'
        )
    ),
    error_classification TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX history_operations_document_idx
    ON history_operations (document_id, updated_at, idempotency_id);

CREATE TABLE maintenance_state (
    scope_key TEXT PRIMARY KEY NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('store', 'document')),
    document_id TEXT REFERENCES history_documents(id) ON DELETE CASCADE,
    issue_code TEXT,
    last_phase TEXT,
    cleanup_work TEXT,
    reconciliation_work TEXT,
    updated_at INTEGER NOT NULL,
    CHECK (
        (scope = 'store' AND document_id IS NULL)
        OR
        (scope = 'document' AND document_id IS NOT NULL)
    )
);

CREATE INDEX maintenance_state_document_idx
    ON maintenance_state (document_id);
"#;

#[derive(Debug, Error)]
pub enum SchemaError {
    #[error("history SQLite schema is newer than supported: found {found}, supported {supported}")]
    UnsupportedVersion { found: i64, supported: i64 },
    #[error("history SQLite schema migration failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

/// Configure a history connection with the required durability and isolation
/// settings.  This function is deliberately not shared with the hot-tier
/// database, whose `synchronous=NORMAL` setting is a different contract.
pub fn configure_connection(connection: &mut Connection) -> Result<(), rusqlite::Error> {
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
    Ok(())
}

/// Initialize or validate the history schema on an already-open connection.
pub fn initialize(connection: &mut Connection) -> Result<(), SchemaError> {
    configure_connection(connection)?;
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(SchemaError::UnsupportedVersion {
            found: version,
            supported: CURRENT_SCHEMA_VERSION,
        });
    }

    if version == 0 {
        let transaction = connection.transaction()?;
        transaction.execute_batch(SCHEMA)?;
        transaction.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)?;
        transaction.commit()?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    fn temporary_database() -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "excalidraw-history-schema-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap_or_else(|error| panic!("create fixture: {error}"));
        directory.join("history.sqlite3")
    }

    #[test]
    fn initializes_history_schema_with_full_durability() {
        let path = temporary_database();
        let mut connection = Connection::open(&path)
            .unwrap_or_else(|error| panic!("open history database: {error}"));
        initialize(&mut connection).unwrap_or_else(|error| panic!("initialize schema: {error}"));

        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap_or_else(|error| panic!("read schema version: {error}"));
        let foreign_keys: i64 = connection
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap_or_else(|error| panic!("read foreign_keys: {error}"));
        let synchronous: i64 = connection
            .pragma_query_value(None, "synchronous", |row| row.get(0))
            .unwrap_or_else(|error| panic!("read synchronous: {error}"));
        let journal_mode: String = connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap_or_else(|error| panic!("read journal mode: {error}"));

        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        assert_eq!(foreign_keys, 1);
        assert_eq!(synchronous, 2, "SQLite FULL is numeric mode 2");
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");

        for table in [
            "history_documents",
            "scene_objects",
            "asset_objects",
            "history_versions",
            "version_assets",
            "history_operations",
            "maintenance_state",
        ] {
            let exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |row| row.get(0),
                )
                .unwrap_or_else(|error| panic!("query table {table}: {error}"));
            assert!(exists, "table {table} was not created");
        }

        drop(connection);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = fs::remove_file(path.with_extension("sqlite3-shm"));
        let _ = fs::remove_dir(path.parent().expect("fixture parent"));
    }

    #[test]
    fn source_and_protected_action_constraints_are_enforced() {
        let path = temporary_database();
        let mut connection = Connection::open(&path)
            .unwrap_or_else(|error| panic!("open history database: {error}"));
        initialize(&mut connection).unwrap_or_else(|error| panic!("initialize schema: {error}"));

        connection
            .execute(
                "INSERT INTO history_documents
                 (id, canonical_path, created_at, state)
                 VALUES ('doc', '/tmp/doc.excalidraw', 1, 'active')",
                [],
            )
            .unwrap_or_else(|error| panic!("insert document: {error}"));
        connection
            .execute(
                "INSERT INTO scene_objects
                 (hash, schema_version, codec, raw_length, relative_path, created_at)
                 VALUES ('scene', 1, 'none', 2, 'objects/scenes/scene.json', 1)",
                [],
            )
            .unwrap_or_else(|error| panic!("insert scene: {error}"));

        connection
            .execute(
                "INSERT INTO history_versions
                 (id, document_id, scene_hash, source, protected_action, recorded_at, sequence)
                 VALUES ('v1', 'doc', 'scene', 'protected', 'restore', 1, 1)",
                [],
            )
            .unwrap_or_else(|error| panic!("insert protected version: {error}"));
        let invalid = connection.execute(
            "INSERT INTO history_versions
             (id, document_id, scene_hash, source, protected_action, recorded_at, sequence)
             VALUES ('v2', 'doc', 'scene', 'automatic', 'restore', 2, 2)",
            [],
        );
        assert!(
            invalid.is_err(),
            "automatic versions cannot set protected action"
        );

        drop(connection);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = fs::remove_file(path.with_extension("sqlite3-shm"));
        let _ = fs::remove_dir(path.parent().expect("fixture parent"));
    }

    #[test]
    fn operation_metadata_is_explicit_and_protection_is_audit_only() {
        let path = temporary_database();
        let mut connection = Connection::open(&path)
            .unwrap_or_else(|error| panic!("open history database: {error}"));
        initialize(&mut connection).unwrap_or_else(|error| panic!("initialize schema: {error}"));
        let columns = connection
            .prepare("PRAGMA table_info(history_operations)")
            .unwrap_or_else(|error| panic!("prepare operation columns: {error}"))
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap_or_else(|error| panic!("read operation columns: {error}"))
            .collect::<Result<Vec<_>, _>>()
            .unwrap_or_else(|error| panic!("collect operation columns: {error}"));
        assert!(columns.iter().any(|column| column == "temp_file"));
        assert!(columns
            .iter()
            .any(|column| column == "target_object_pins_json"));

        connection
            .execute(
                "INSERT INTO history_documents
                 (id, canonical_path, created_at, state)
                 VALUES ('doc', '/tmp/doc.excalidraw', 1, 'active')",
                [],
            )
            .unwrap_or_else(|error| panic!("insert document: {error}"));
        connection
            .execute(
                "INSERT INTO history_operations
                 (idempotency_id, document_id, session_generation, revision, kind,
                  protection_version_id, state, created_at, updated_at)
                 VALUES ('request', 'doc', 1, 1, 'replace', 'evicted-version',
                         'preparing', 1, 1)",
                [],
            )
            .unwrap_or_else(|error| panic!("insert audit-only protection id: {error}"));

        drop(connection);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("sqlite3-wal"));
        let _ = fs::remove_file(path.with_extension("sqlite3-shm"));
        let _ = fs::remove_dir(path.parent().expect("fixture parent"));
    }
}
