#![allow(
    dead_code,
    reason = "Phase 2 defines stable error categories before later command handlers construct all variants"
)]

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
    database::{repository::RepositoryError, writer::DatabaseWriterError},
    documents::atomic_write::AtomicWriteError,
    security::PathSecurityError,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    PathAccessDenied,
    WorkspaceNotFound,
    WorkspaceOverlap,
    FileNotFound,
    FileCorrupted,
    FileTooLarge,
    InvalidScene,
    ConflictPending,
    DiskFull,
    IoError,
    DbError,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: ErrorCode,
    pub message: String,
    pub retriable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Error)]
pub enum AppError {
    #[error("path access denied: {0}")]
    PathAccessDenied(PathBuf),
    #[error("workspace not found: {0}")]
    WorkspaceNotFound(String),
    #[error("workspace overlaps an existing mount: {0}")]
    WorkspaceOverlap(String),
    #[error("file not found: {0}")]
    FileNotFound(PathBuf),
    #[error("file is corrupted: {0}")]
    FileCorrupted(String),
    #[error("file is too large: {actual_bytes} bytes exceeds {maximum_bytes} bytes")]
    FileTooLarge {
        actual_bytes: u64,
        maximum_bytes: u64,
    },
    #[error("scene is invalid: {0}")]
    InvalidScene(String),
    #[error("document has a pending conflict: {0}")]
    ConflictPending(PathBuf),
    #[error("disk is full")]
    DiskFull,
    #[error("I/O operation failed")]
    Io {
        path: Option<PathBuf>,
        #[source]
        source: std::io::Error,
    },
    #[error("database operation failed")]
    Database {
        #[source]
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    #[error("internal operation failed: {0}")]
    Internal(String),
}

impl AppError {
    pub fn into_ipc(self) -> IpcError {
        let (code, message, retriable, path) = match &self {
            Self::PathAccessDenied(path) => (
                ErrorCode::PathAccessDenied,
                "Path is outside the mounted workspaces.".to_owned(),
                false,
                Some(path),
            ),
            Self::WorkspaceNotFound(_) => (
                ErrorCode::WorkspaceNotFound,
                "Workspace was not found.".to_owned(),
                false,
                None,
            ),
            Self::WorkspaceOverlap(_) => (
                ErrorCode::WorkspaceOverlap,
                "Workspace overlaps an existing mount.".to_owned(),
                false,
                None,
            ),
            Self::FileNotFound(path) => (
                ErrorCode::FileNotFound,
                "File was not found.".to_owned(),
                false,
                Some(path),
            ),
            Self::FileCorrupted(_) => (
                ErrorCode::FileCorrupted,
                "File contains invalid or corrupted data.".to_owned(),
                false,
                None,
            ),
            Self::FileTooLarge { .. } => (
                ErrorCode::FileTooLarge,
                "File exceeds the supported size limit.".to_owned(),
                false,
                None,
            ),
            Self::InvalidScene(_) => (
                ErrorCode::InvalidScene,
                "Scene data is invalid.".to_owned(),
                false,
                None,
            ),
            Self::ConflictPending(path) => (
                ErrorCode::ConflictPending,
                "Resolve the pending external-change conflict before saving.".to_owned(),
                false,
                Some(path),
            ),
            Self::DiskFull => (
                ErrorCode::DiskFull,
                "The destination does not have enough free space.".to_owned(),
                true,
                None,
            ),
            Self::Io { path, .. } => (
                ErrorCode::IoError,
                "The filesystem operation failed.".to_owned(),
                true,
                path.as_ref(),
            ),
            Self::Database { .. } => (
                ErrorCode::DbError,
                "The local database operation failed.".to_owned(),
                true,
                None,
            ),
            Self::Internal(_) => (
                ErrorCode::Internal,
                "An internal operation failed.".to_owned(),
                false,
                None,
            ),
        };
        IpcError {
            code,
            message,
            retriable,
            context: path.map(|value| path_context(value.as_path())),
        }
    }
}

impl From<PathSecurityError> for AppError {
    fn from(error: PathSecurityError) -> Self {
        match error {
            PathSecurityError::AccessDenied(path) => Self::PathAccessDenied(path),
            PathSecurityError::WorkspaceOverlap { first, second } => {
                Self::WorkspaceOverlap(format!("{} and {}", first.display(), second.display()))
            }
            PathSecurityError::Canonicalize { path, source } => {
                if source.kind() == std::io::ErrorKind::NotFound {
                    Self::FileNotFound(path)
                } else {
                    Self::Io {
                        path: Some(path),
                        source,
                    }
                }
            }
            PathSecurityError::WorkspaceNotDirectory(path)
            | PathSecurityError::MissingParent(path) => Self::PathAccessDenied(path),
        }
    }
}

impl From<AtomicWriteError> for AppError {
    fn from(error: AtomicWriteError) -> Self {
        match error {
            AtomicWriteError::InvalidJson(source) => Self::InvalidScene(source.to_string()),
            AtomicWriteError::Io { path, source, .. } if is_disk_full(&source) => {
                let _ = path;
                Self::DiskFull
            }
            AtomicWriteError::Io { path, source, .. } => Self::Io {
                path: Some(path),
                source,
            },
            AtomicWriteError::InvalidTarget(path) => Self::PathAccessDenied(path),
            AtomicWriteError::FaultInjected(point) => {
                Self::Internal(format!("atomic write interrupted at {point}"))
            }
        }
    }
}

impl From<DatabaseWriterError> for AppError {
    fn from(source: DatabaseWriterError) -> Self {
        Self::Database {
            source: Box::new(source),
        }
    }
}

impl From<RepositoryError> for AppError {
    fn from(source: RepositoryError) -> Self {
        Self::Database {
            source: Box::new(source),
        }
    }
}

impl From<AppError> for IpcError {
    fn from(error: AppError) -> Self {
        error.into_ipc()
    }
}

fn path_context(path: &Path) -> BTreeMap<String, String> {
    BTreeMap::from([("path".to_owned(), path.display().to_string())])
}

fn is_disk_full(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(28) | Some(112))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_stable_error_code_and_shape() {
        let error = AppError::PathAccessDenied(PathBuf::from("/outside"));
        let value = serde_json::to_value(error.into_ipc())
            .unwrap_or_else(|source| panic!("serialize IPC error: {source}"));
        assert_eq!(value["code"], "PATH_ACCESS_DENIED");
        assert_eq!(value["retriable"], false);
        assert_eq!(value["context"]["path"], "/outside");
    }
}
