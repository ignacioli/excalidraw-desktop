//! Durable journal for Workspace Entry mutations after the filesystem commit.
//!
//! `fs::rename` and Trash are the user-visible commit points. SQLite indexes and
//! recovery snapshots are derived state: they must be rebuildable after a crash
//! or a post-commit storage failure, and the IPC result must not claim the
//! filesystem mutation never happened.

use std::{fs, io, path::PathBuf, sync::Arc};

use serde::{Deserialize, Serialize};

use crate::{
    commands::error::AppError,
    database::repository::SqliteRepository,
    documents::{atomic_write::atomic_write, recovery::RecoveryStore},
};

const JOURNAL_DIRECTORY_NAME: &str = "entry-mutation-journal";
const JOURNAL_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MutationJournalKind {
    Rename,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationJournalRecord {
    pub version: u32,
    pub operation_id: String,
    pub kind: MutationJournalKind,
    pub workspace_id: String,
    pub old_canonical_path: String,
    pub new_canonical_path: Option<String>,
    pub old_relative_path: String,
    pub new_relative_path: Option<String>,
    pub new_display_name: Option<String>,
    pub sqlite_applied: bool,
    pub recovery_applied: bool,
}

impl MutationJournalRecord {
    pub fn rename(
        operation_id: String,
        workspace_id: String,
        old_canonical_path: String,
        new_canonical_path: String,
        old_relative_path: String,
        new_relative_path: String,
        new_display_name: String,
    ) -> Self {
        Self {
            version: JOURNAL_VERSION,
            operation_id,
            kind: MutationJournalKind::Rename,
            workspace_id,
            old_canonical_path,
            new_canonical_path: Some(new_canonical_path),
            old_relative_path,
            new_relative_path: Some(new_relative_path),
            new_display_name: Some(new_display_name),
            sqlite_applied: false,
            recovery_applied: false,
        }
    }

    pub fn delete(
        operation_id: String,
        workspace_id: String,
        old_canonical_path: String,
        old_relative_path: String,
    ) -> Self {
        Self {
            version: JOURNAL_VERSION,
            operation_id,
            kind: MutationJournalKind::Delete,
            workspace_id,
            old_canonical_path,
            new_canonical_path: None,
            old_relative_path,
            new_relative_path: None,
            new_display_name: None,
            sqlite_applied: false,
            recovery_applied: false,
        }
    }

    pub fn is_complete(&self) -> bool {
        self.sqlite_applied && self.recovery_applied
    }
}

pub fn journal_directory(recovery: &RecoveryStore) -> PathBuf {
    recovery.app_data_directory().join(JOURNAL_DIRECTORY_NAME)
}

pub fn save_journal(
    recovery: &RecoveryStore,
    record: &MutationJournalRecord,
) -> Result<(), AppError> {
    let directory = journal_directory(recovery);
    fs::create_dir_all(&directory).map_err(|source| AppError::Io {
        path: Some(directory.clone()),
        source,
    })?;
    let path = journal_path(recovery, &record.operation_id);
    let contents = serde_json::to_vec(record).map_err(|source| {
        AppError::Internal(format!(
            "failed to serialize entry mutation journal: {source}"
        ))
    })?;
    atomic_write(&path, &contents).map_err(AppError::from)
}

pub fn delete_journal(recovery: &RecoveryStore, operation_id: &str) -> Result<(), AppError> {
    let path = journal_path(recovery, operation_id);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(AppError::Io {
            path: Some(path),
            source,
        }),
    }
}

pub fn load_journals(recovery: &RecoveryStore) -> Result<Vec<MutationJournalRecord>, AppError> {
    let directory = journal_directory(recovery);
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(source) => {
            return Err(AppError::Io {
                path: Some(directory),
                source,
            })
        }
    };
    let mut records = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| AppError::Io {
            path: Some(directory.clone()),
            source,
        })?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(source) if source.kind() == io::ErrorKind::NotFound => continue,
            Err(source) => {
                return Err(AppError::Io {
                    path: Some(path),
                    source,
                })
            }
        };
        if let Ok(record) = serde_json::from_slice::<MutationJournalRecord>(&bytes) {
            records.push(record);
        }
    }
    records.sort_by(|left, right| left.operation_id.cmp(&right.operation_id));
    Ok(records)
}

/// Replay every durable post-commit record. Each record is applied
/// independently so one stuck mutation does not hide another.
pub async fn reconcile_pending_mutations(
    repository: &SqliteRepository,
    recovery: &RecoveryStore,
) -> Result<(), AppError> {
    let mut first_error = None;
    for mut record in load_journals(recovery)? {
        if let Err(error) = apply_committed_record(repository, recovery, &mut record).await {
            first_error = first_error.or(Some(error));
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

pub async fn apply_committed_record(
    repository: &SqliteRepository,
    recovery: &RecoveryStore,
    record: &mut MutationJournalRecord,
) -> Result<(), AppError> {
    apply_committed_record_with_skip(repository, recovery, record, false, false).await
}

pub async fn apply_committed_record_with_skip(
    repository: &SqliteRepository,
    recovery: &RecoveryStore,
    record: &mut MutationJournalRecord,
    skip_sqlite: bool,
    skip_recovery: bool,
) -> Result<(), AppError> {
    if !filesystem_commit_observed(record) {
        delete_journal(recovery, &record.operation_id)?;
        return Ok(());
    }

    let mut apply_error = None;
    if !record.sqlite_applied && !skip_sqlite {
        match apply_sqlite(repository, record).await {
            Ok(()) => {
                record.sqlite_applied = true;
                save_journal(recovery, record)?;
            }
            Err(error) => apply_error = Some(error),
        }
    }
    if !record.recovery_applied && !skip_recovery {
        match apply_recovery(recovery, record).await {
            Ok(()) => {
                record.recovery_applied = true;
                save_journal(recovery, record)?;
            }
            Err(error) => apply_error = apply_error.or(Some(error)),
        }
    }
    if record.is_complete() {
        delete_journal(recovery, &record.operation_id)?;
    }
    if let Some(error) = apply_error {
        return Err(error);
    }
    Ok(())
}

fn filesystem_commit_observed(record: &MutationJournalRecord) -> bool {
    let old = PathBuf::from(&record.old_canonical_path);
    match record.kind {
        MutationJournalKind::Rename => {
            let Some(new_canonical_path) = record.new_canonical_path.as_ref() else {
                return false;
            };
            let new = PathBuf::from(new_canonical_path);
            new.exists() || !old.exists()
        }
        MutationJournalKind::Delete => !old.exists(),
    }
}

async fn apply_sqlite(
    repository: &SqliteRepository,
    record: &MutationJournalRecord,
) -> Result<(), AppError> {
    match record.kind {
        MutationJournalKind::Rename => {
            let new_canonical_path = record.new_canonical_path.clone().ok_or_else(|| {
                AppError::Internal("rename journal is missing the new path".to_owned())
            })?;
            let new_relative_path = record.new_relative_path.clone().ok_or_else(|| {
                AppError::Internal("rename journal is missing the new relative path".to_owned())
            })?;
            let new_display_name = record.new_display_name.clone().ok_or_else(|| {
                AppError::Internal("rename journal is missing the new display name".to_owned())
            })?;
            repository
                .migrate_entry_paths(
                    record.old_canonical_path.clone(),
                    new_canonical_path,
                    record.old_relative_path.clone(),
                    new_relative_path,
                    new_display_name,
                )
                .await?;
        }
        MutationJournalKind::Delete => {
            repository
                .remove_clean_entry_metadata(record.old_canonical_path.clone())
                .await?;
        }
    }
    Ok(())
}

async fn apply_recovery(
    recovery: &RecoveryStore,
    record: &MutationJournalRecord,
) -> Result<(), AppError> {
    let recovery = Arc::new(recovery.clone());
    let record = record.clone();
    tokio::task::spawn_blocking(move || match record.kind {
        MutationJournalKind::Rename => {
            let new_canonical_path = record.new_canonical_path.as_ref().ok_or_else(|| {
                AppError::Internal("rename journal is missing the new path".to_owned())
            })?;
            recovery
                .migrate_entry_snapshots(
                    PathBuf::from(&record.old_canonical_path).as_path(),
                    PathBuf::from(new_canonical_path).as_path(),
                )
                .map_err(AppError::from)
        }
        MutationJournalKind::Delete => recovery
            .remove_snapshots_for_path(PathBuf::from(&record.old_canonical_path).as_path())
            .map_err(AppError::from),
    })
    .await
    .map_err(|error| {
        AppError::Internal(format!("blocking journal recovery task failed: {error}"))
    })?
}

fn journal_path(recovery: &RecoveryStore, operation_id: &str) -> PathBuf {
    journal_directory(recovery).join(format!("{operation_id}.json"))
}
