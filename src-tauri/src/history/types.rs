//! Version-history domain types shared by the future history service and IPC DTOs.
//!
//! This module intentionally contains no command handlers or persistence. The
//! validation helpers describe the v3 wire boundary; every eventual handler
//! must repeat them before resolving document authority.

#![allow(
    dead_code,
    reason = "T006 freezes the history contract before service handlers land"
)]

use serde::{Deserialize, Serialize};

use crate::commands::error::IpcError;

pub const HISTORY_DEFAULT_PAGE_LIMIT: u16 = 50;
pub const HISTORY_MAX_PAGE_LIMIT: u16 = 100;
pub const HISTORY_MAX_SCENE_BYTES: usize = 256 * 1024 * 1024;
pub const HISTORY_MAX_IDENTIFIER_LENGTH: usize = 128;
pub const HISTORY_MAX_CURSOR_LENGTH: usize = 4096;
pub const HISTORY_MAX_PATH_LENGTH: usize = 4096;
pub const HISTORY_HASH_HEX_LENGTH: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HistoryDocumentLocator {
    Path {
        path: String,
    },
    Handle {
        #[serde(rename = "documentId")]
        document_id: String,
    },
}

impl HistoryDocumentLocator {
    pub fn validate(&self) -> Result<(), HistoryValidationError> {
        match self {
            Self::Path { path } => validate_text(path, "document.path", HISTORY_MAX_PATH_LENGTH),
            Self::Handle { document_id } => validate_text(
                document_id,
                "document.documentId",
                HISTORY_MAX_IDENTIFIER_LENGTH,
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryVersionSource {
    Automatic,
    Manual,
    Protected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryProtectedAction {
    Restore,
    Clear,
    Import,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum HistoryVersionAvailability {
    Available,
    Unavailable { error: IpcError },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryOperationState {
    Preparing,
    Protected,
    IntentCommitted,
    TargetObserved,
    TargetPublished,
    MetadataCommitted,
    Completed,
    Aborted,
    Reconcile,
    Conflict,
    PendingReconciliation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryOperationKind {
    Mark,
    Replace,
    Delete,
    Reconcile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryIssueSource {
    Automatic,
    Manual,
    Protected,
    Reconciliation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryChangeKind {
    Automatic,
    Manual,
    Protected,
    Deleted,
    Reconciled,
    Invalidated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryCurrentFileSaveOutcome {
    NotAttempted,
    Succeeded,
    Failed,
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HistoryReplaceTarget {
    Restore {
        #[serde(rename = "versionId")]
        version_id: String,
    },
    Clear,
    Import {
        #[serde(rename = "candidateSceneJson")]
        candidate_scene_json: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum HistoryReplaceResponse {
    Completed {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "replacementCommitted")]
        replacement_committed: bool,
        #[serde(rename = "protectionVersionId")]
        protection_version_id: String,
        #[serde(rename = "adoptedScene")]
        adopted_scene: serde_json::Value,
        #[serde(rename = "newBaseHash")]
        new_base_hash: String,
        #[serde(rename = "newSessionGeneration")]
        new_session_generation: u64,
    },
    PendingReconciliation {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "replacementCommitted")]
        replacement_committed: Option<bool>,
        #[serde(rename = "operationState")]
        operation_state: HistoryOperationState,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryVersionItem {
    pub version_id: String,
    pub source: HistoryVersionSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protected_action: Option<HistoryProtectedAction>,
    pub recorded_at: i64,
    pub sequence: u64,
    pub content_hash: String,
    pub availability: HistoryVersionAvailability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryChangedEvent {
    pub document_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub list_revision: u64,
    pub change: HistoryChangeKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryIssueEvent {
    pub document_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<HistoryOperationKind>,
    pub source: HistoryIssueSource,
    pub error: IpcError,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_file_save_outcome: Option<HistoryCurrentFileSaveOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HistoryValidationError {
    #[error("{field} must be a non-empty string without NUL")]
    InvalidText { field: &'static str },
    #[error("{field} exceeds the maximum length of {maximum} bytes")]
    TooLong { field: &'static str, maximum: usize },
    #[error("{field} is not a lowercase SHA-256 hex digest")]
    InvalidHash { field: &'static str },
    #[error("history page limit must be between 1 and {maximum}")]
    InvalidPageLimit { maximum: u16 },
    #[error("scene payload exceeds the maximum size of {maximum} bytes")]
    SceneTooLarge { maximum: usize },
}

pub fn validate_text(
    value: &str,
    field: &'static str,
    maximum: usize,
) -> Result<(), HistoryValidationError> {
    if value.is_empty() || value.contains('\0') {
        return Err(HistoryValidationError::InvalidText { field });
    }
    if value.len() > maximum {
        return Err(HistoryValidationError::TooLong { field, maximum });
    }
    Ok(())
}

pub fn validate_identifier(value: &str, field: &'static str) -> Result<(), HistoryValidationError> {
    validate_text(value, field, HISTORY_MAX_IDENTIFIER_LENGTH)
}

pub fn validate_cursor(value: &str) -> Result<(), HistoryValidationError> {
    validate_text(value, "cursor", HISTORY_MAX_CURSOR_LENGTH)
}

pub fn validate_scene_json(value: &str) -> Result<(), HistoryValidationError> {
    if value.is_empty() {
        return Err(HistoryValidationError::InvalidText { field: "sceneJson" });
    }
    if value.len() > HISTORY_MAX_SCENE_BYTES {
        return Err(HistoryValidationError::SceneTooLarge {
            maximum: HISTORY_MAX_SCENE_BYTES,
        });
    }
    Ok(())
}

pub fn validate_hash(value: &str, field: &'static str) -> Result<(), HistoryValidationError> {
    if value.len() != HISTORY_HASH_HEX_LENGTH
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
        || value.bytes().any(|byte| byte.is_ascii_uppercase())
    {
        return Err(HistoryValidationError::InvalidHash { field });
    }
    Ok(())
}

pub fn validate_page_limit(limit: Option<u16>) -> Result<(), HistoryValidationError> {
    if limit.is_some_and(|value| !(1..=HISTORY_MAX_PAGE_LIMIT).contains(&value)) {
        return Err(HistoryValidationError::InvalidPageLimit {
            maximum: HISTORY_MAX_PAGE_LIMIT,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_locator_and_replace_targets_as_tagged_camel_case() {
        let locator = serde_json::to_value(HistoryDocumentLocator::Handle {
            document_id: "doc-1".to_owned(),
        })
        .expect("serialize locator");
        assert_eq!(locator["kind"], "handle");
        assert_eq!(locator["documentId"], "doc-1");

        let target = serde_json::to_value(HistoryReplaceTarget::Import {
            candidate_scene_json: "{}".to_owned(),
        })
        .expect("serialize target");
        assert_eq!(target["kind"], "import");
        assert_eq!(target["candidateSceneJson"], "{}");

        let response = serde_json::to_value(HistoryReplaceResponse::PendingReconciliation {
            request_id: "request-1".to_owned(),
            replacement_committed: None,
            operation_state: HistoryOperationState::PendingReconciliation,
        })
        .expect("serialize pending response");
        assert_eq!(response["status"], "pendingReconciliation");
        assert_eq!(response["requestId"], "request-1");
        assert_eq!(response["replacementCommitted"], serde_json::Value::Null);
        assert_eq!(response["operationState"], "pendingReconciliation");
    }

    #[test]
    fn rejects_untrusted_text_hash_scene_and_page_inputs() {
        assert!(validate_text("/tmp/file.excalidraw", "path", 100).is_ok());
        assert!(validate_text("", "path", 100).is_err());
        assert!(validate_text("bad\0path", "path", 100).is_err());
        assert!(validate_hash(&"a".repeat(64), "hash").is_ok());
        assert!(validate_hash(&"A".repeat(64), "hash").is_err());
        assert!(validate_hash("not-a-hash", "hash").is_err());
        assert!(validate_scene_json("{}").is_ok());
        assert!(validate_scene_json("").is_err());
        assert!(validate_page_limit(Some(HISTORY_MAX_PAGE_LIMIT)).is_ok());
        assert!(validate_page_limit(Some(HISTORY_MAX_PAGE_LIMIT + 1)).is_err());
    }
}
