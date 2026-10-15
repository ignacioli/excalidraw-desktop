#![allow(
    dead_code,
    reason = "Phase 2 freezes the complete IPC contract before later commands consume every DTO"
)]

use serde::{Deserialize, Serialize};

use crate::commands::error::IpcError;

pub use crate::history::types::{
    HistoryChangeKind, HistoryCurrentFileSaveOutcome, HistoryDocumentLocator, HistoryIssueSource,
    HistoryOperationKind, HistoryOperationState, HistoryProtectedAction, HistoryReplaceResponse,
    HistoryReplaceTarget, HistoryVersionAvailability, HistoryVersionItem, HistoryVersionSource,
    HISTORY_DEFAULT_PAGE_LIMIT, HISTORY_MAX_PAGE_LIMIT, HISTORY_MAX_SCENE_BYTES,
};

use crate::history::types::{
    validate_cursor, validate_hash, validate_identifier, validate_page_limit, validate_scene_json,
    HistoryValidationError,
};

pub const IPC_CONTRACT_VERSION: u32 = 5;
/// Reserved history contract version marker retained for compatibility with
/// code that needs to distinguish the activated v3 boundary.
pub const RESERVED_HISTORY_CONTRACT_VERSION: u32 = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppHandshakeResponse {
    pub contract_version: u32,
    pub app_version: String,
    /// True only for the window that presents Recovery after an abnormal
    /// exit.
    pub abnormal_exit: bool,
    /// Drawing files routed to this window at launch (file association or a
    /// single-instance handoff). Handed out once: a later handshake from the
    /// same window returns an empty list.
    pub pending_open_paths: Vec<String>,
    /// System UI languages as raw BCP-47 tags in the user's order (at most
    /// 16), read once at startup. The frontend resolves the UI language.
    pub preferred_languages: Vec<String>,
    /// What the calling window shows; ownership is already decided.
    pub window: WindowBootstrap,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBootstrap {
    pub label: String,
    /// The Workspace this window already owns; `None` is Welcome.
    pub workspace: Option<Workspace>,
    /// A session Workspace that could not be opened again.
    pub unavailable_workspace: Option<Workspace>,
    pub restore: Option<WindowRestoreBootstrap>,
    pub shell: Option<crate::window::session::WorkspaceShellState>,
    /// Names of the Workspaces open in any window, for title disambiguation.
    pub open_workspace_names: Vec<OpenWorkspaceName>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRestoreBootstrap {
    pub tabs: Vec<String>,
    pub active_path: Option<String>,
    pub skipped: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWorkspaceName {
    pub workspace_id: String,
    pub name: String,
    pub root_path: String,
}

/// `app-preferences-changed`: an app-wide preference changed in another
/// window. Absent fields did not change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPreferencesChangedEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub appearance: Option<crate::native_menu_spec::AppearancePreference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<crate::native_menu_spec::LanguagePreference>,
}

/// `open-workspaces-changed`: the Workspaces open in any window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWorkspacesChangedEvent {
    pub workspaces: Vec<OpenWorkspaceName>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceEntryKind {
    Drawing,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub workspace_id: String,
    pub kind: WorkspaceEntryKind,
    pub canonical_path: String,
    pub relative_path: String,
    pub parent_relative_path: String,
    pub name: String,
    pub display_name: String,
    pub mtime: i64,
    pub file_size: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedOpenDocument {
    pub relative_path: String,
    pub base_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathMigration {
    pub old_relative_path: String,
    pub new_relative_path: String,
    pub old_canonical_path: String,
    pub new_canonical_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryMutationResult {
    pub operation_id: String,
    pub entry: WorkspaceEntry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntryListRequest {
    pub workspace_id: String,
    pub parent_relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntryCreateRequest {
    pub workspace_id: String,
    pub parent_relative_path: String,
    pub kind: WorkspaceEntryKind,
    pub base_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntryRenameRequest {
    pub workspace_id: String,
    pub relative_path: String,
    pub base_name: String,
    pub expected_open_documents: Vec<ExpectedOpenDocument>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntryRenameResult {
    pub operation_id: String,
    pub entry: WorkspaceEntry,
    pub old_relative_path: String,
    pub new_relative_path: String,
    pub path_migrations: Vec<PathMigration>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntryPathRequest {
    pub workspace_id: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WorkspaceEntryDeletePreflightResult {
    Confirmable { entry: WorkspaceEntry },
    DirectoryNotEmpty { entry: WorkspaceEntry },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntryDeleteRequest {
    pub workspace_id: String,
    pub relative_path: String,
    pub expected_open_document: Option<ExpectedOpenDocument>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntryDeleteResult {
    pub operation_id: String,
    pub kind: WorkspaceEntryKind,
    pub old_relative_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_maintenance: Option<EntryHistoryMaintenance>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EntryHistoryMaintenance {
    PendingReplay,
    CleanupPending,
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
    SaveAsNew,
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
    pub mode: CloseDocumentMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CloseDocumentMode {
    Checkpointed,
    DiscardOrphan,
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
pub struct HistoryListRequest {
    pub document: HistoryDocumentLocator,
    pub cursor: Option<String>,
    pub limit: Option<u16>,
}

impl HistoryListRequest {
    pub fn validate(&self) -> Result<(), HistoryValidationError> {
        self.document.validate()?;
        if let Some(cursor) = &self.cursor {
            validate_cursor(cursor)?;
        }
        validate_page_limit(self.limit)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryListResponse {
    pub document_id: String,
    pub items: Vec<HistoryVersionItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_issue: Option<IpcError>,
    pub list_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPreviewRequest {
    pub document: HistoryDocumentLocator,
    pub version_id: String,
}

impl HistoryPreviewRequest {
    pub fn validate(&self) -> Result<(), HistoryValidationError> {
        self.document.validate()?;
        validate_identifier(&self.version_id, "versionId")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPreviewResponse {
    pub version_id: String,
    pub scene: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMarkRequest {
    pub document: HistoryDocumentLocator,
    pub request_id: String,
    pub session_generation: u64,
    pub revision: u64,
    pub current_scene_json: String,
}

impl HistoryMarkRequest {
    pub fn validate(&self) -> Result<(), HistoryValidationError> {
        self.document.validate()?;
        validate_identifier(&self.request_id, "requestId")?;
        validate_scene_json(&self.current_scene_json)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMarkResponse {
    pub version_id: String,
    pub recorded_at: i64,
    pub source: HistoryVersionSource,
    pub content_hash: String,
    pub reused: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySetMarkedRequest {
    pub document: HistoryDocumentLocator,
    pub request_id: String,
    pub version_id: String,
    pub marked: bool,
}

impl HistorySetMarkedRequest {
    pub fn validate(&self) -> Result<(), HistoryValidationError> {
        self.document.validate()?;
        validate_identifier(&self.request_id, "requestId")?;
        validate_identifier(&self.version_id, "versionId")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySetMarkedResponse {
    pub version_id: String,
    pub marked: bool,
    pub retained: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryReplaceRequest {
    pub document: HistoryDocumentLocator,
    pub request_id: String,
    pub session_generation: u64,
    pub revision: u64,
    pub expected_base_hash: String,
    pub current_scene_json: String,
    pub target: HistoryReplaceTarget,
}

impl HistoryReplaceRequest {
    pub fn validate(&self) -> Result<(), HistoryValidationError> {
        self.document.validate()?;
        validate_identifier(&self.request_id, "requestId")?;
        validate_hash(&self.expected_base_hash, "expectedBaseHash")?;
        validate_scene_json(&self.current_scene_json)?;
        match &self.target {
            HistoryReplaceTarget::Restore { version_id } => {
                validate_identifier(version_id, "target.versionId")
            }
            HistoryReplaceTarget::Clear => Ok(()),
            HistoryReplaceTarget::Import {
                candidate_scene_json,
            } => validate_scene_json(candidate_scene_json),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryOperationStatusRequest {
    pub document: HistoryDocumentLocator,
    pub request_id: String,
}

impl HistoryOperationStatusRequest {
    pub fn validate(&self) -> Result<(), HistoryValidationError> {
        self.document.validate()?;
        validate_identifier(&self.request_id, "requestId")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryOperationStatusResponse {
    pub request_id: String,
    pub state: HistoryOperationState,
    pub replacement_committed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protection_version_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adopted_scene: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_base_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_session_generation: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDeleteRequest {
    pub document: HistoryDocumentLocator,
    pub request_id: String,
    pub version_id: String,
}

impl HistoryDeleteRequest {
    pub fn validate(&self) -> Result<(), HistoryValidationError> {
        self.document.validate()?;
        validate_identifier(&self.request_id, "requestId")?;
        validate_identifier(&self.version_id, "versionId")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDeleteResponse {
    pub deleted_version_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmptyResponse {}

/// Result of asking to open a Workspace in the calling window. `W` is
/// `Workspace` for `window_claim_workspace`; for the read-only
/// `window_probe_workspace` it is `Option<Workspace>`, `None` when the
/// claimable folder has never been opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClaimWorkspaceOutcome<W> {
    Claimed {
        workspace: W,
        replaced: Option<String>,
        /// The sidebar state to show for the Workspace: its own record,
        /// else the most recent one. Always `None` from a probe.
        shell: Option<crate::window::session::WorkspaceShellState>,
    },
    OwnedBy {
        label: String,
        workspace_id: String,
    },
    InsideOpen {
        label: String,
        workspace_id: String,
        relative_path: String,
    },
    ContainsOpen {
        label: String,
        workspace_id: String,
    },
}

/// `window_close_other_and_claim`: the other window was asked to close; the
/// result arrives as `window-claim-result`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WindowCloseOtherResponse {
    /// `request_id` names the `window-claim-result` that answers this call.
    Closing {
        #[serde(rename = "requestId")]
        request_id: String,
    },
}

/// `window-close-requested-by-peer`: close this window the normal way;
/// report a failed close with `window_peer_close_failed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowCloseRequestedByPeerEvent {
    pub request_id: String,
}

/// The other window's close was cancelled or failed; nothing was opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PeerCloseCancelled {
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum PeerClaimOutcome {
    Claim(ClaimWorkspaceOutcome<Workspace>),
    Cancelled(PeerCloseCancelled),
}

/// `window-claim-result`: what "Close it and open here" ended with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowClaimResultEvent {
    pub request_id: String,
    pub outcome: PeerClaimOutcome,
}

/// `workspace-reveal-entry`: show the folder at `relative_path` in this
/// window's sidebar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRevealEntryEvent {
    pub relative_path: String,
    pub name: String,
}

/// `app-quit-requested`: checkpoint every drawing, then answer with
/// `app_quit_ready`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppQuitRequestedEvent {
    pub request_id: String,
}

/// `app-quit-cancelled`: the quit stopped because `failed_label` could not
/// checkpoint or did not answer in time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppQuitCancelledEvent {
    pub request_id: String,
    pub failed_label: String,
}

/// `shell_preferences_migrate`: whether this call imported the legacy
/// preferences (only the first call does).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellPreferencesMigrateResponse {
    pub migrated: bool,
}

/// `doc_open`: the opened drawing, or the window that already has it. An
/// `ownedElsewhere` response reads nothing; that window was brought to the
/// front and asked to show the drawing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DocOpenResponse {
    Opened(SceneOpenResponse),
    OwnedElsewhere { label: String },
}

/// `window-activate-document`: show `path` in this window, opening it when
/// it is not open yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowActivateDocumentEvent {
    pub path: String,
}

/// `window_new`: the label of the Welcome window just opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowNewResponse {
    pub label: String,
}

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
            preferred_languages: vec!["zh-Hans-CN".to_owned(), "en-US".to_owned()],
            window: WindowBootstrap {
                label: "window-1".to_owned(),
                workspace: None,
                unavailable_workspace: None,
                restore: Some(WindowRestoreBootstrap {
                    tabs: vec!["/tmp/drawing.excalidraw".to_owned()],
                    active_path: None,
                    skipped: 1,
                }),
                shell: None,
                open_workspace_names: Vec::new(),
            },
        };
        let value = serde_json::to_value(response)
            .unwrap_or_else(|error| panic!("serialize handshake: {error}"));
        assert_eq!(value["contractVersion"], 5);
        assert_eq!(value["window"]["label"], "window-1");
        assert_eq!(
            value["window"]["unavailableWorkspace"],
            serde_json::Value::Null
        );
        assert_eq!(
            value["window"]["restore"]["activePath"],
            serde_json::Value::Null
        );
        assert_eq!(value["window"]["openWorkspaceNames"], serde_json::json!([]));
        assert_eq!(
            value["preferredLanguages"],
            serde_json::json!(["zh-Hans-CN", "en-US"])
        );
        assert_eq!(value["abnormalExit"], false);
        assert_eq!(value["pendingOpenPaths"][0], "/tmp/drawing.excalidraw");

        let reason = serde_json::to_string(&CheckpointReason::ManualSave)
            .unwrap_or_else(|error| panic!("serialize checkpoint reason: {error}"));
        assert_eq!(reason, "\"manualSave\"");
        let save_as_reason = serde_json::to_string(&CheckpointReason::SaveAsNew)
            .unwrap_or_else(|error| panic!("serialize save-as checkpoint reason: {error}"));
        assert_eq!(save_as_reason, "\"saveAsNew\"");
    }

    #[test]
    fn peer_close_messages_name_their_request() {
        let closing = serde_json::to_value(WindowCloseOtherResponse::Closing {
            request_id: "request-1".to_owned(),
        })
        .unwrap_or_else(|error| panic!("serialize close response: {error}"));
        assert_eq!(
            closing,
            serde_json::json!({ "status": "closing", "requestId": "request-1" })
        );
        let cancelled = serde_json::to_value(WindowClaimResultEvent {
            request_id: "request-1".to_owned(),
            outcome: PeerClaimOutcome::Cancelled(PeerCloseCancelled::Cancelled),
        })
        .unwrap_or_else(|error| panic!("serialize claim result: {error}"));
        assert_eq!(
            cancelled,
            serde_json::json!({ "requestId": "request-1", "outcome": { "kind": "cancelled" } })
        );
    }
}
