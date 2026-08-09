//! Crash-recovery snapshots.
//!
//! Recovery snapshots are deliberately kept outside the SQLite hot layer.  A
//! snapshot is a complete, self-contained scene written with the same atomic
//! write primitive as the cold document.  The store owns rotation and
//! corruption handling; commands own policy decisions and path authorization.

use std::{
    collections::BTreeSet,
    fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::commands::error::AppError;

use super::atomic_write::{atomic_write, AtomicWriteError};

pub const RECOVERY_SNAPSHOT_COUNT: usize = 5;
const RECOVERY_DIRECTORY_NAME: &str = "recovery";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySnapshot {
    pub document_id: String,
    pub original_path: Option<String>,
    pub base_file_hash: String,
    pub saved_at: i64,
    pub app_version: String,
    pub scene: serde_json::Value,
}

#[derive(Debug, Error)]
pub enum RecoveryError {
    #[error("failed to {operation} recovery path {path}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to serialize recovery snapshot {path}: {source}")]
    Serialize {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("recovery snapshot {path} is invalid: {source}")]
    InvalidSnapshot {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("no valid recovery snapshot exists for document {0}")]
    SnapshotNotFound(String),
    #[error("recovery scene is invalid: {0}")]
    InvalidScene(String),
    #[error(transparent)]
    AtomicWrite(#[from] AtomicWriteError),
}

#[derive(Debug, Clone)]
pub struct RecoveryStore {
    app_data_directory: PathBuf,
    app_version: String,
}

impl RecoveryStore {
    /// Creates a store using the crate's current package version in snapshot
    /// metadata.  Tests and harnesses can use [`Self::with_app_version`] to
    /// make the value deterministic.
    pub fn new(app_data_directory: impl Into<PathBuf>) -> Self {
        Self::with_app_version(app_data_directory, env!("CARGO_PKG_VERSION"))
    }

    pub fn with_app_version(
        app_data_directory: impl Into<PathBuf>,
        app_version: impl Into<String>,
    ) -> Self {
        Self {
            app_data_directory: app_data_directory.into(),
            app_version: app_version.into(),
        }
    }

    pub fn app_data_directory(&self) -> &Path {
        &self.app_data_directory
    }

    pub fn recovery_directory(&self) -> PathBuf {
        self.app_data_directory.join(RECOVERY_DIRECTORY_NAME)
    }

    /// Writes a complete snapshot into a five-entry ring.  Existing malformed
    /// slots are preferred for reuse so a corrupt file cannot permanently
    /// consume ring capacity.
    pub fn write_snapshot(
        &self,
        document_id: &str,
        original_path: Option<&Path>,
        base_file_hash: &str,
        saved_at: i64,
        scene_json: &str,
    ) -> Result<PathBuf, RecoveryError> {
        let scene =
            serde_json::from_str(scene_json).map_err(|source| RecoveryError::Serialize {
                path: PathBuf::from("<scene>"),
                source,
            })?;
        let snapshot = RecoverySnapshot {
            document_id: document_id.to_owned(),
            original_path: original_path.map(path_string),
            base_file_hash: base_file_hash.to_owned(),
            saved_at,
            app_version: self.app_version.clone(),
            scene,
        };

        let directory = self.snapshot_directory(document_id, original_path);
        fs::create_dir_all(&directory).map_err(|source| RecoveryError::Io {
            operation: "create directory",
            path: directory.clone(),
            source,
        })?;
        let slot = self.next_slot(&directory)?;
        let path = directory.join(snapshot_file_name(slot));
        let contents =
            serde_json::to_vec(&snapshot).map_err(|source| RecoveryError::Serialize {
                path: path.clone(),
                source,
            })?;
        atomic_write(&path, &contents)?;
        Ok(path)
    }

    /// Lists all valid snapshots for a deterministic document id.  Invalid
    /// JSON is intentionally ignored; the caller can still recover from an
    /// older slot.
    pub fn snapshots_for_document(
        &self,
        document_id: &str,
    ) -> Result<Vec<RecoverySnapshot>, RecoveryError> {
        Ok(self
            .snapshots_for_document_with_paths(document_id)?
            .into_iter()
            .map(|(_, snapshot)| snapshot)
            .collect())
    }

    pub fn latest_valid_snapshot(
        &self,
        document_id: &str,
    ) -> Result<Option<RecoverySnapshot>, RecoveryError> {
        Ok(self
            .latest_valid_snapshot_with_path(document_id)?
            .map(|(_, snapshot)| snapshot))
    }

    pub fn latest_snapshot_path(
        &self,
        document_id: &str,
    ) -> Result<Option<PathBuf>, RecoveryError> {
        Ok(self
            .latest_valid_snapshot_with_path(document_id)?
            .map(|(path, _)| path))
    }

    /// Returns all valid snapshots in the recovery tree.  Commands use this
    /// when the application starts because the frontend does not know which
    /// document ids were active before a crash.
    pub fn list_snapshots(&self) -> Result<Vec<(PathBuf, RecoverySnapshot)>, RecoveryError> {
        let root = self.recovery_directory();
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(source) => {
                return Err(RecoveryError::Io {
                    operation: "read directory",
                    path: root,
                    source,
                })
            }
        };

        let mut snapshots = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|source| RecoveryError::Io {
                operation: "read directory entry",
                path: root.clone(),
                source,
            })?;
            let file_type = entry.file_type().map_err(|source| RecoveryError::Io {
                operation: "inspect recovery entry",
                path: entry.path(),
                source,
            })?;
            if !file_type.is_dir() {
                continue;
            }
            for slot in 1..=RECOVERY_SNAPSHOT_COUNT {
                let path = entry.path().join(snapshot_file_name(slot));
                if let Some(snapshot) = read_snapshot_if_valid(&path)? {
                    snapshots.push((path, snapshot));
                }
            }
        }
        Ok(snapshots)
    }

    /// Removes every slot belonging to a document.  The operation is
    /// idempotent, which lets `recovery_apply` safely retry after an IPC retry.
    pub fn remove_document(&self, document_id: &str) -> Result<(), RecoveryError> {
        let mut directories = BTreeSet::new();
        for (path, snapshot) in self.list_snapshots()? {
            if snapshot.document_id == document_id {
                if let Some(parent) = path.parent() {
                    directories.insert(parent.to_path_buf());
                }
            }
        }
        for directory in directories {
            match fs::remove_dir_all(&directory) {
                Ok(()) => {}
                Err(source) if source.kind() == io::ErrorKind::NotFound => {}
                Err(source) => {
                    return Err(RecoveryError::Io {
                        operation: "remove snapshot directory",
                        path: directory,
                        source,
                    })
                }
            }
        }
        Ok(())
    }

    /// Returns the directory convention used by the ring.  It is public so
    /// the test-only E2E harness can locate a snapshot without duplicating the
    /// path-hashing rule.
    pub fn snapshot_directory_for_path(&self, original_path: &Path) -> PathBuf {
        self.recovery_directory()
            .join(sha256_hex(path_string(original_path).as_bytes()))
    }

    fn snapshot_directory(&self, document_id: &str, original_path: Option<&Path>) -> PathBuf {
        original_path
            .map(|path| self.snapshot_directory_for_path(path))
            .unwrap_or_else(|| {
                self.recovery_directory()
                    .join(sha256_hex(document_id.as_bytes()))
            })
    }

    fn snapshots_for_document_with_paths(
        &self,
        document_id: &str,
    ) -> Result<Vec<(PathBuf, RecoverySnapshot)>, RecoveryError> {
        Ok(self
            .list_snapshots()?
            .into_iter()
            .filter(|(_, snapshot)| snapshot.document_id == document_id)
            .collect())
    }

    fn latest_valid_snapshot_with_path(
        &self,
        document_id: &str,
    ) -> Result<Option<(PathBuf, RecoverySnapshot)>, RecoveryError> {
        Ok(self
            .snapshots_for_document_with_paths(document_id)?
            .into_iter()
            .max_by(|(left_path, left), (right_path, right)| {
                left.saved_at
                    .cmp(&right.saved_at)
                    .then_with(|| {
                        snapshot_modified_time(left_path).cmp(&snapshot_modified_time(right_path))
                    })
                    .then_with(|| left_path.cmp(right_path))
            }))
    }

    fn next_slot(&self, directory: &Path) -> Result<usize, RecoveryError> {
        let mut newest: Option<(usize, SystemTime, i64)> = None;
        for slot in 1..=RECOVERY_SNAPSHOT_COUNT {
            let path = directory.join(snapshot_file_name(slot));
            if !path.exists() {
                return Ok(slot);
            }
            match read_snapshot_if_valid(&path)? {
                None => return Ok(slot),
                Some(snapshot) => {
                    let modified = fs::metadata(&path)
                        .and_then(|metadata| metadata.modified())
                        .unwrap_or(UNIX_EPOCH);
                    let is_newer = match newest.as_ref() {
                        None => true,
                        Some((newest_slot, newest_modified, newest_saved_at)) => {
                            (modified, snapshot.saved_at, slot)
                                > (*newest_modified, *newest_saved_at, *newest_slot)
                        }
                    };
                    if is_newer {
                        newest = Some((slot, modified, snapshot.saved_at));
                    }
                }
            }
        }
        newest
            .map(|(slot, _, _)| (slot % RECOVERY_SNAPSHOT_COUNT) + 1)
            .ok_or_else(|| RecoveryError::SnapshotNotFound(directory.display().to_string()))
    }
}

/// Derives a stable UUID-shaped id from a canonical path.  The save-draft IPC
/// contract predates recovery and does not carry the frontend's in-memory tab
/// id, so this id keeps snapshots addressable across restarts without adding a
/// second contract version.
pub fn document_id_for_path(path: &Path) -> String {
    let digest = Sha256::digest(path_string(path).as_bytes());
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    // UUID v4/variant bits retain the contract's UUID-shaped representation
    // while keeping the value deterministic for a given path.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

pub fn unix_timestamp() -> Result<i64, RecoveryError> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| RecoveryError::Io {
            operation: "read system clock",
            path: PathBuf::from("<clock>"),
            source: io::Error::other("system clock predates Unix epoch"),
        })?
        .as_secs();
    i64::try_from(seconds).map_err(|_| RecoveryError::Io {
        operation: "read system clock",
        path: PathBuf::from("<clock>"),
        source: io::Error::other("system time exceeds the IPC range"),
    })
}

fn read_snapshot_if_valid(path: &Path) -> Result<Option<RecoverySnapshot>, RecoveryError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(RecoveryError::Io {
                operation: "read snapshot",
                path: path.to_path_buf(),
                source,
            })
        }
    };
    match serde_json::from_slice::<RecoverySnapshot>(&bytes) {
        Ok(snapshot) if is_valid_scene_shape(&snapshot.scene) => Ok(Some(snapshot)),
        Err(_) => Ok(None),
        Ok(_) => Ok(None),
    }
}

fn is_valid_scene_shape(scene: &serde_json::Value) -> bool {
    scene.as_object().is_some_and(|object| {
        object.get("type").and_then(serde_json::Value::as_str) == Some("excalidraw")
            && object
                .get("version")
                .and_then(serde_json::Value::as_u64)
                .is_some()
            && object
                .get("elements")
                .and_then(serde_json::Value::as_array)
                .is_some()
    })
}

fn snapshot_file_name(slot: usize) -> String {
    format!("recovery-{slot:03}.json")
}

fn snapshot_modified_time(path: &Path) -> SystemTime {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .unwrap_or(UNIX_EPOCH)
}

fn path_string(path: &Path) -> String {
    path.display().to_string()
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

impl From<RecoveryError> for AppError {
    fn from(error: RecoveryError) -> Self {
        match error {
            RecoveryError::Io { path, source, .. } => AppError::Io {
                path: Some(path),
                source,
            },
            RecoveryError::Serialize { source, .. } => AppError::FileCorrupted(source.to_string()),
            RecoveryError::InvalidSnapshot { source, .. } => {
                AppError::FileCorrupted(source.to_string())
            }
            RecoveryError::SnapshotNotFound(document_id) => {
                AppError::FileNotFound(PathBuf::from(document_id))
            }
            RecoveryError::InvalidScene(message) => AppError::InvalidScene(message),
            RecoveryError::AtomicWrite(source) => source.into(),
        }
    }
}
