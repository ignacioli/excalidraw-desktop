#![allow(
    dead_code,
    reason = "Phase 2 freezes the complete IPC contract before later commands consume every DTO"
)]

use serde::{Deserialize, Serialize};

pub const IPC_CONTRACT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppHandshakeResponse {
    pub contract_version: u32,
    pub app_version: String,
    pub abnormal_exit: bool,
    /// Drawing files handed to this launch by the OS (file association) or
    /// forwarded by a single-instance handoff. Populated before the first
    /// render so the frontend can open them without racing an event.
    pub pending_open_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCandidate {
    pub document_id: String,
    pub original_path: Option<String>,
    pub display_name: String,
    pub snapshot_saved_at: i64,
    pub cold_file_mtime: Option<i64>,
    pub snapshot_newer: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryAction {
    Restore,
    KeepDisk,
    SaveAsNew,
    Discard,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryApplyRequest {
    pub document_id: String,
    pub action: RecoveryAction,
    pub save_as_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryApplyResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAddRequest {
    pub root_path: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRemoveRequest {
    pub workspace_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListRequest {
    pub workspace_id: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DirEntryKind {
    Dir,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub relative_path: String,
    pub kind: DirEntryKind,
    pub mtime: i64,
    pub file_size: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub canonical_path: String,
    pub workspace_id: String,
    pub display_name: String,
    pub relative_path: String,
    pub mtime: i64,
    pub file_size: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCreateRequest {
    pub workspace_id: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRenameRequest {
    pub path: String,
    pub new_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathRequest {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneOpenResponse {
    pub scene: serde_json::Value,
    pub base_hash: String,
    pub has_newer_draft: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDraftRequest {
    pub path: String,
    pub scene_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDraftResponse {
    pub content_hash: String,
    pub saved_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckpointReason {
    ManualSave,
    TabSwitch,
    TabClose,
    Idle,
    AppExit,
    MaxWait,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRequest {
    pub path: String,
    pub scene_json: String,
    pub reason: CheckpointReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointResponse {
    pub new_base_hash: String,
    pub mtime: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseDocumentRequest {
    pub path: String,
    pub discard_draft: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictResolution {
    TakeExternal,
    KeepLocal,
    SaveAsNew,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveConflictRequest {
    pub path: String,
    pub resolution: ConflictResolution,
    pub save_as_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveConflictResponse {
    pub scene: Option<serde_json::Value>,
    pub new_base_hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Png,
    Svg,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportBackground {
    Transparent,
    Solid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    Light,
    Dark,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub scale: Option<u8>,
    pub background: Option<ExportBackground>,
    pub theme: Option<Theme>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub path: Option<String>,
    pub scene_json: String,
    pub format: ExportFormat,
    pub target_path: String,
    pub options: ExportOptions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResponse {
    pub written_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailLookupRequest {
    pub path: String,
    pub theme: Theme,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailLookupResponse {
    pub hit: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webp_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailStoreRequest {
    pub path: String,
    pub theme: String,
    pub key: String,
    pub webp_bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailStoreResponse {
    pub webp_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmptyResponse {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeKind {
    Modified,
    Created,
    Removed,
    Renamed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangedEvent {
    pub path: String,
    pub change: FileChangeKind,
    pub new_path: Option<String>,
    pub mtime: Option<i64>,
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexProgressEvent {
    pub workspace_id: String,
    pub scanned: u64,
    pub total: Option<u64>,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSavedEvent {
    pub path: String,
    pub saved_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDetectedEvent {
    pub path: String,
    pub external_mtime: i64,
    pub local_draft_updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFileRequestEvent {
    pub paths: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_contract_fields_and_variants_as_camel_case() {
        let response = AppHandshakeResponse {
            contract_version: IPC_CONTRACT_VERSION,
            app_version: "0.1.0".to_owned(),
            abnormal_exit: false,
            pending_open_paths: vec!["/tmp/drawing.excalidraw".to_owned()],
        };
        let value = serde_json::to_value(response)
            .unwrap_or_else(|error| panic!("serialize handshake: {error}"));
        assert_eq!(value["contractVersion"], 1);
        assert_eq!(value["abnormalExit"], false);
        assert_eq!(value["pendingOpenPaths"][0], "/tmp/drawing.excalidraw");

        let reason = serde_json::to_string(&CheckpointReason::ManualSave)
            .unwrap_or_else(|error| panic!("serialize checkpoint reason: {error}"));
        assert_eq!(reason, "\"manualSave\"");
    }
}
