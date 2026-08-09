#![allow(
    dead_code,
    reason = "the Phase 2 repository queue is exercised by tests before later commands enqueue writes"
)]

use std::{path::Path, sync::Arc};

use rusqlite::Connection;
use thiserror::Error;
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
};

use super::migrations::{open_database, MigrationError};

type WriteJob = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

#[derive(Debug, Error)]
pub enum DatabaseWriterError {
    #[error("database writer queue capacity must be greater than zero")]
    InvalidCapacity,
    #[error("database initialization failed: {0}")]
    Initialization(#[from] MigrationError),
    #[error("database initialization task failed: {0}")]
    InitializationTask(String),
    #[error("database writer queue is closed")]
    QueueClosed,
    #[error("database operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

#[derive(Clone)]
pub struct DatabaseWriter {
    sender: mpsc::Sender<WriteJob>,
    _worker: Arc<JoinHandle<()>>,
}

impl DatabaseWriter {
    pub async fn open(path: &Path, queue_capacity: usize) -> Result<Self, DatabaseWriterError> {
        if queue_capacity == 0 {
            return Err(DatabaseWriterError::InvalidCapacity);
        }

        let path = path.to_path_buf();
        let connection = tokio::task::spawn_blocking(move || open_database(&path))
            .await
            .map_err(|error| DatabaseWriterError::InitializationTask(error.to_string()))??;
        let (sender, mut receiver) = mpsc::channel::<WriteJob>(queue_capacity);
        let worker = tokio::task::spawn_blocking(move || {
            let mut connection = connection;
            while let Some(job) = receiver.blocking_recv() {
                job(&mut connection);
            }
        });

        Ok(Self {
            sender,
            _worker: Arc::new(worker),
        })
    }

    pub async fn execute<T, F>(&self, operation: F) -> Result<T, DatabaseWriterError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        let (reply_sender, reply_receiver) = oneshot::channel();
        let job = Box::new(move |connection: &mut Connection| {
            let _ = reply_sender.send(operation(connection));
        });
        self.sender
            .send(job)
            .await
            .map_err(|_| DatabaseWriterError::QueueClosed)?;
        reply_receiver
            .await
            .map_err(|_| DatabaseWriterError::QueueClosed)?
            .map_err(DatabaseWriterError::Sqlite)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn serializes_database_operations_through_a_bounded_queue() {
        let path = std::env::temp_dir().join(format!(
            "excalidraw-writer-{}-{}.sqlite3",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let writer = DatabaseWriter::open(&path, 2)
            .await
            .unwrap_or_else(|error| panic!("open writer: {error}"));

        writer
            .execute(|connection| {
                connection.execute(
                    "INSERT INTO workspaces (id, name, root_path, created_at) VALUES ('a', 'A', '/a', 1)",
                    [],
                )?;
                Ok(())
            })
            .await
            .unwrap_or_else(|error| panic!("insert workspace: {error}"));
        let count: i64 = writer
            .execute(|connection| {
                connection.query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))
            })
            .await
            .unwrap_or_else(|error| panic!("count workspaces: {error}"));
        assert_eq!(count, 1);

        drop(writer);
        std::fs::remove_file(&path)
            .unwrap_or_else(|error| panic!("remove database fixture: {error}"));
        let wal = path.with_extension("sqlite3-wal");
        let shm = path.with_extension("sqlite3-shm");
        let _ = std::fs::remove_file(wal);
        let _ = std::fs::remove_file(shm);
    }
}
