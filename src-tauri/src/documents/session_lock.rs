#![allow(
    dead_code,
    reason = "explicit lock inspection and release are retained for later lifecycle and recovery tasks"
)]

use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::atomic_write::{atomic_write, cleanup_atomic_write_temps, AtomicWriteError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SessionLockContents {
    pid: u32,
    started_at: u64,
}

#[derive(Debug, Error)]
pub enum SessionLockError {
    #[error("failed to create application data directory {path}: {source}")]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("system clock is before the Unix epoch")]
    InvalidSystemTime,
    #[error("failed to serialize session lock: {0}")]
    Serialize(#[from] serde_json::Error),
    #[error(transparent)]
    AtomicWrite(#[from] AtomicWriteError),
    #[error("failed to remove session lock {path}: {source}")]
    Remove {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to sync session lock directory {path}: {source}")]
    SyncDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

#[derive(Debug)]
pub struct SessionLock {
    path: PathBuf,
    abnormal_exit: bool,
    released: bool,
}

impl SessionLock {
    pub fn acquire(app_data_directory: &Path) -> Result<Self, SessionLockError> {
        fs::create_dir_all(app_data_directory).map_err(|source| {
            SessionLockError::CreateDirectory {
                path: app_data_directory.to_path_buf(),
                source,
            }
        })?;
        let path = app_data_directory.join("session.lock");
        let abnormal_exit = path.exists();
        cleanup_atomic_write_temps(&path)?;

        let started_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| SessionLockError::InvalidSystemTime)?
            .as_secs();
        let contents = serde_json::to_vec(&SessionLockContents {
            pid: std::process::id(),
            started_at,
        })?;
        atomic_write(&path, &contents)?;

        Ok(Self {
            path,
            abnormal_exit,
            released: false,
        })
    }

    pub fn abnormal_exit(&self) -> bool {
        self.abnormal_exit
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn release(mut self) -> Result<(), SessionLockError> {
        self.remove_lock()?;
        self.released = true;
        Ok(())
    }

    fn remove_lock(&self) -> Result<(), SessionLockError> {
        match fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(source) => {
                return Err(SessionLockError::Remove {
                    path: self.path.clone(),
                    source,
                });
            }
        }
        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|source| SessionLockError::SyncDirectory {
                path: parent.to_path_buf(),
                source,
            })
    }
}

impl Drop for SessionLock {
    fn drop(&mut self) {
        if !self.released {
            let _ = self.remove_lock();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_an_existing_lock_and_cleans_up_on_release() {
        let directory = std::env::temp_dir().join(format!(
            "excalidraw-session-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory)
            .unwrap_or_else(|error| panic!("create session fixture: {error}"));
        fs::write(directory.join("session.lock"), "stale")
            .unwrap_or_else(|error| panic!("write stale lock: {error}"));

        let lock = SessionLock::acquire(&directory)
            .unwrap_or_else(|error| panic!("acquire session lock: {error}"));
        assert!(lock.abnormal_exit());
        let contents: SessionLockContents = serde_json::from_slice(
            &fs::read(lock.path()).unwrap_or_else(|error| panic!("read lock: {error}")),
        )
        .unwrap_or_else(|error| panic!("parse lock: {error}"));
        assert_eq!(contents.pid, std::process::id());
        lock.release()
            .unwrap_or_else(|error| panic!("release lock: {error}"));
        assert!(!directory.join("session.lock").exists());
        fs::remove_dir_all(directory)
            .unwrap_or_else(|error| panic!("remove session fixture: {error}"));
    }
}
