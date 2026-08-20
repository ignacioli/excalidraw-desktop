use std::sync::Arc;

use tauri::State;

use crate::{
    database::repository::SqliteRepository,
    workspace_entries::{WorkspaceEntryService, WorkspaceMutationGate},
};

use super::{
    dto::{WorkspaceEntry, WorkspaceEntryListRequest},
    error::IpcError,
};

#[derive(Clone)]
pub struct WorkspaceEntryState {
    pub service: WorkspaceEntryService,
}

impl WorkspaceEntryState {
    pub fn new(repository: Arc<SqliteRepository>, mutation_gate: WorkspaceMutationGate) -> Self {
        Self {
            service: WorkspaceEntryService::new(repository, mutation_gate),
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
