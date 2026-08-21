use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::{
    database::repository::SqliteRepository,
    workspace_entries::{WorkspaceEntryService, WorkspaceMutationGate},
};

use super::{
    dto::{
        EmptyResponse, WorkspaceEntry, WorkspaceEntryCreateRequest,
        WorkspaceEntryDeletePreflightResult, WorkspaceEntryDeleteRequest,
        WorkspaceEntryListRequest, WorkspaceEntryPathRequest, WorkspaceEntryRenameRequest,
        WorkspaceEntryRenameResult,
    },
    error::{AppError, IpcError},
};

#[derive(Clone)]
pub struct WorkspaceEntryState {
    pub service: WorkspaceEntryService,
}

impl WorkspaceEntryState {
    pub fn new(
        repository: Arc<SqliteRepository>,
        mutation_gate: WorkspaceMutationGate,
        recovery: Arc<crate::documents::recovery::RecoveryStore>,
        watcher: crate::watcher::WatcherService,
    ) -> Self {
        Self {
            service: WorkspaceEntryService::with_recovery(repository, mutation_gate, recovery)
                .with_watcher(watcher),
        }
    }
}

#[tauri::command]
pub async fn workspace_entry_list(
    workspace_id: String,
    parent_relative_path: String,
    state: State<'_, WorkspaceEntryState>,
) -> Result<Vec<WorkspaceEntry>, IpcError> {
    state
        .service
        .list(WorkspaceEntryListRequest {
            workspace_id,
            parent_relative_path,
        })
        .await
}

#[tauri::command]
pub async fn workspace_entry_create(
    workspace_id: String,
    parent_relative_path: String,
    kind: crate::commands::dto::WorkspaceEntryKind,
    base_name: String,
    app: AppHandle,
    state: State<'_, WorkspaceEntryState>,
) -> Result<crate::commands::dto::EntryMutationResult, IpcError> {
    let result = state
        .service
        .create(WorkspaceEntryCreateRequest {
            workspace_id: workspace_id.clone(),
            parent_relative_path,
            kind,
            base_name,
        })
        .await?;
    emit_entries_changed(
        &app,
        WorkspaceEntriesChangedEvent {
            workspace_id,
            operation_id: Some(result.operation_id.clone()),
            change: WorkspaceEntriesChange::Created,
            relative_path: result.entry.relative_path.clone(),
            new_relative_path: None,
        },
    )?;
    Ok(result)
}

#[tauri::command]
pub async fn workspace_entry_rename(
    workspace_id: String,
    relative_path: String,
    base_name: String,
    expected_open_documents: Vec<crate::commands::dto::ExpectedOpenDocument>,
    app: AppHandle,
    state: State<'_, WorkspaceEntryState>,
) -> Result<WorkspaceEntryRenameResult, IpcError> {
    let result = state
        .service
        .rename(WorkspaceEntryRenameRequest {
            workspace_id: workspace_id.clone(),
            relative_path,
            base_name,
            expected_open_documents,
        })
        .await?;
    emit_entries_changed(
        &app,
        WorkspaceEntriesChangedEvent {
            workspace_id,
            operation_id: Some(result.operation_id.clone()),
            change: WorkspaceEntriesChange::Renamed,
            relative_path: result.old_relative_path.clone(),
            new_relative_path: Some(result.new_relative_path.clone()),
        },
    )?;
    Ok(result)
}

#[tauri::command]
pub async fn workspace_entry_delete_preflight(
    workspace_id: String,
    relative_path: String,
    state: State<'_, WorkspaceEntryState>,
) -> Result<WorkspaceEntryDeletePreflightResult, IpcError> {
    state
        .service
        .delete_preflight(WorkspaceEntryPathRequest {
            workspace_id,
            relative_path,
        })
        .await
}

#[tauri::command]
pub async fn workspace_entry_delete(
    workspace_id: String,
    relative_path: String,
    expected_open_document: Option<crate::commands::dto::ExpectedOpenDocument>,
    app: AppHandle,
    state: State<'_, WorkspaceEntryState>,
) -> Result<crate::commands::dto::WorkspaceEntryDeleteResult, IpcError> {
    let result = state
        .service
        .delete(WorkspaceEntryDeleteRequest {
            workspace_id: workspace_id.clone(),
            relative_path,
            expected_open_document,
        })
        .await?;
    emit_entries_changed(
        &app,
        WorkspaceEntriesChangedEvent {
            workspace_id,
            operation_id: Some(result.operation_id.clone()),
            change: WorkspaceEntriesChange::Removed,
            relative_path: result.old_relative_path.clone(),
            new_relative_path: None,
        },
    )?;
    Ok(result)
}

#[tauri::command]
pub async fn workspace_entry_reveal(
    workspace_id: String,
    relative_path: String,
    state: State<'_, WorkspaceEntryState>,
) -> Result<EmptyResponse, IpcError> {
    state
        .service
        .reveal(WorkspaceEntryPathRequest {
            workspace_id,
            relative_path,
        })
        .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceEntriesChangedEvent {
    workspace_id: String,
    operation_id: Option<String>,
    change: WorkspaceEntriesChange,
    relative_path: String,
    new_relative_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
enum WorkspaceEntriesChange {
    Created,
    Renamed,
    Removed,
}

fn emit_entries_changed(
    app: &AppHandle,
    event: WorkspaceEntriesChangedEvent,
) -> Result<(), IpcError> {
    app.emit("workspace-entries-changed", event)
        .map_err(|error| IpcError::from(AppError::Internal(error.to_string())))
}
