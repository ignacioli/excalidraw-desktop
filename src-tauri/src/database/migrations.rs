use std::{path::Path, time::Duration};

use rusqlite::Connection;
use thiserror::Error;

const CURRENT_SCHEMA_VERSION: i64 = 1;
const MIGRATION_0001: &str = include_str!("../../migrations/0001_init.sql");

#[derive(Debug, Error)]
pub enum MigrationError {
    #[error("failed to open SQLite database at {path}: {source}")]
    Open {
        path: String,
        #[source]
        source: rusqlite::Error,
    },
    #[error("SQLite migration failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("database schema version {found} is newer than supported version {supported}")]
    UnsupportedVersion { found: i64, supported: i64 },
}

pub fn open_database(path: &Path) -> Result<Connection, MigrationError> {
    let mut connection = Connection::open(path).map_err(|source| MigrationError::Open {
        path: path.display().to_string(),
        source,
    })?;
    run_migrations(&mut connection)?;
    Ok(connection)
}

pub fn run_migrations(connection: &mut Connection) -> Result<(), MigrationError> {
    configure_connection(connection)?;
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(MigrationError::UnsupportedVersion {
            found: version,
            supported: CURRENT_SCHEMA_VERSION,
        });
    }

    if version < 1 {
        apply_migration(connection, 1, MIGRATION_0001)?;
    }
    Ok(())
}

fn configure_connection(connection: &Connection) -> Result<(), rusqlite::Error> {
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
    Ok(())
}

fn apply_migration(
    connection: &mut Connection,
    version: i64,
    migration: &str,
) -> Result<(), rusqlite::Error> {
    // Connection PRAGMAs are applied before the transaction. SQLite rejects changes to
    // journal_mode and synchronous inside a transaction, while schema and user_version
    // must commit atomically.
    let transactional_sql = migration
        .lines()
        .filter(|line| !line.trim_start().starts_with("PRAGMA "))
        .collect::<Vec<_>>()
        .join("\n");
    let transaction = connection.transaction()?;
    transaction.execute_batch(&transactional_sql)?;
    transaction.pragma_update(None, "user_version", version)?;
    transaction.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_all_tables_and_records_the_schema_version() {
        let mut connection = Connection::open_in_memory()
            .unwrap_or_else(|error| panic!("open in-memory database: {error}"));
        run_migrations(&mut connection).unwrap_or_else(|error| panic!("run migrations: {error}"));

        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap_or_else(|error| panic!("read user_version: {error}"));
        assert_eq!(version, CURRENT_SCHEMA_VERSION);

        for table in ["workspaces", "file_index", "drafts", "file_meta"] {
            let exists: bool = connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |row| row.get(0),
                )
                .unwrap_or_else(|error| panic!("query table {table}: {error}"));
            assert!(exists, "table {table} was not created");
        }
    }

    #[test]
    fn failed_migration_rolls_back_schema_and_user_version() {
        let mut connection = Connection::open_in_memory()
            .unwrap_or_else(|error| panic!("open in-memory database: {error}"));
        connection
            .execute_batch("CREATE TABLE file_index (canonical_path TEXT PRIMARY KEY);")
            .unwrap_or_else(|error| panic!("create conflicting table: {error}"));

        assert!(run_migrations(&mut connection).is_err());
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap_or_else(|error| panic!("read user_version: {error}"));
        assert_eq!(version, 0);

        let drafts_exist: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='drafts')",
                [],
                |row| row.get(0),
            )
            .unwrap_or_else(|error| panic!("query drafts table: {error}"));
        assert!(!drafts_exist);
    }
}
