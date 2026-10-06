//! Durable journal for Workspace Entry mutations after the filesystem commit.
//!
//! `fs::rename` and Trash are the user-visible commit points. SQLite indexes and
//! recovery snapshots are derived state: they must be rebuildable after a crash
//! or a post-commit storage failure, and the IPC result must not claim the
//! filesystem mutation never happened.

use std::{
    fs::{self, File},
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::{Duration, SystemTime},
};

use serde::{Deserialize, Serialize};

use crate::{
    commands::error::AppError,
    database::repository::SqliteRepository,
    documents::{atomic_write::atomic_write, recovery::RecoveryStore},
};

const JOURNAL_DIRECTORY_NAME: &str = "entry-mutation-journal";
const JOURNAL_VERSION: u32 = 3;
const HISTORY_PHASE_VERSION: u32 = 2;
pub(crate) const UNCOMMITTED_JOURNAL_TTL: Duration = Duration::from_secs(60);

#[cfg(test)]
static PARENT_SYNC_FAULT: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// History owns the replay implementation; the entry journal only owns the
/// durable phase boundary and retry semantics.
pub type HistoryReplay = Arc<
    dyn Fn(MutationJournalRecord) -> Pin<Box<dyn Future<Output = Result<(), AppError>> + Send>>
        + Send
        + Sync,
>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MutationJournalKind {
    Rename,
    Delete,
}

/// Stable identity evidence for one filesystem object involved in a rename.
/// Unix device/inode is the authoritative pair.  `is_directory` keeps a
/// directory rename from being confused with a regular file, while
/// `reliable=false` makes unsupported platforms fail closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationFilesystemIdentity {
    pub device: Option<u64>,
    pub inode: Option<u64>,
    pub is_directory: bool,
    pub reliable: bool,
}

impl MutationFilesystemIdentity {
    fn from_path(path: &Path) -> Option<Self> {
        let metadata = fs::symlink_metadata(path).ok()?;
        if metadata.file_type().is_symlink()
            || (!metadata.file_type().is_file() && !metadata.file_type().is_dir())
        {
            return None;
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Some(Self {
                device: Some(metadata.dev()),
                inode: Some(metadata.ino()),
                is_directory: metadata.is_dir(),
                reliable: true,
            })
        }
        #[cfg(not(unix))]
        {
            let _ = metadata;
            Some(Self {
                device: None,
                inode: None,
                is_directory: false,
                reliable: false,
            })
        }
    }

    fn matches_path(&self, path: &Path) -> bool {
        fs::symlink_metadata(path)
            .ok()
            .is_some_and(|metadata| self.matches_metadata(&metadata))
    }

    fn matches_metadata(&self, metadata: &fs::Metadata) -> bool {
        if metadata.file_type().is_symlink()
            || (!metadata.file_type().is_file() && !metadata.file_type().is_dir())
        {
            return false;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            self.reliable
                && self.device.is_some()
                && self.inode.is_some()
                && self.device == Some(metadata.dev())
                && self.inode == Some(metadata.ino())
                && self.is_directory == metadata.is_dir()
        }
        #[cfg(not(unix))]
        {
            let _ = metadata;
            false
        }
    }

    fn old_path_is_absent(&self, path: &Path) -> bool {
        // A recreated path, even with a different inode, is ambiguous to the
        // history path migrator.  Only a proven missing old locator allows
        // replay to derive the old identity prefix safely.
        matches!(
            fs::symlink_metadata(path),
            Err(error) if error.kind() == io::ErrorKind::NotFound
        )
    }
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
    /// Durable post-filesystem-commit marker for v2 journals. v1 records do
    /// not carry this phase and retain their legacy path inference.
    #[serde(default)]
    pub filesystem_committed: bool,
    /// The source object's identity captured immediately before an
    /// application-owned rename.  A missing or unreliable value is never
    /// replaced with path or content inference during replay.
    #[serde(default)]
    pub filesystem_identity: Option<MutationFilesystemIdentity>,
    pub sqlite_applied: bool,
    pub recovery_applied: bool,
    /// Stable history identity captured before a destructive delete. Rename
    /// records intentionally leave this unset because identity is located by
    /// the old path and verified by filesystem evidence.
    #[serde(default)]
    pub history_document_id: Option<String>,
    /// Missing in v1 journals, where it intentionally defaults to false.
    #[serde(default)]
    pub history_required: bool,
    /// Defaults to false so an old or partial record is never assumed done.
    #[serde(default)]
    pub history_applied: bool,
    /// A rename is not durable until both affected parent directories have
    /// been synced. Missing in older journals, where it remains pending and
    /// is retried before derived state is repaired.
    #[serde(default)]
    pub parent_sync_applied: bool,
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
            filesystem_committed: false,
            filesystem_identity: None,
            sqlite_applied: false,
            recovery_applied: false,
            history_document_id: None,
            history_required: false,
            history_applied: false,
            parent_sync_applied: false,
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
            filesystem_committed: false,
            filesystem_identity: None,
            sqlite_applied: false,
            recovery_applied: false,
            history_document_id: None,
            history_required: false,
            history_applied: false,
            parent_sync_applied: true,
        }
    }

    /// Mark this operation as requiring the history replay phase.
    pub fn with_history_required(mut self, required: bool) -> Self {
        self.history_required = required;
        if !required {
            self.history_applied = false;
        }
        self
    }

    pub fn history_pending(&self) -> bool {
        self.history_required && !self.history_applied
    }

    pub fn with_filesystem_committed(mut self, committed: bool) -> Self {
        self.filesystem_committed = committed;
        self
    }

    pub fn with_filesystem_identity(
        mut self,
        identity: Option<MutationFilesystemIdentity>,
    ) -> Self {
        self.filesystem_identity = identity;
        self
    }

    pub fn with_history_document_id(mut self, document_id: impl Into<String>) -> Self {
        self.history_document_id = Some(document_id.into());
        self.history_required = true;
        self
    }

    pub fn is_complete(&self) -> bool {
        self.parent_sync_applied
            && self.sqlite_applied
            && self.recovery_applied
            && (!self.history_required || self.history_applied)
    }
}

#[cfg(test)]
pub(crate) fn set_parent_sync_fault(operation_id: Option<String>) {
    *PARENT_SYNC_FAULT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = operation_id;
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
        let mut record =
            serde_json::from_slice::<MutationJournalRecord>(&bytes).map_err(|error| {
                AppError::Internal(format!(
                    "failed to deserialize entry mutation journal {}: {error}",
                    path.display()
                ))
            })?;
        if record.version == 0 || record.version > JOURNAL_VERSION {
            return Err(AppError::Internal(format!(
                "unsupported entry mutation journal version {} at {}",
                record.version,
                path.display()
            )));
        }
        if record.version < HISTORY_PHASE_VERSION {
            // v1 had no history phase. Keep the record durable until a
            // history owner probes and either migrates the existing identity
            // or reports a retryable/unavailable result.
            record.history_required = true;
        }
        records.push(record);
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
    reconcile_pending_mutations_inner(repository, recovery, None).await
}

/// Replay pending mutations with the history phase supplied by the history
/// owner. The callback receives an owned record so it can safely cross an
/// async or blocking boundary and must be idempotent by operation ID.
pub async fn reconcile_pending_mutations_with_history(
    repository: &SqliteRepository,
    recovery: &RecoveryStore,
    history_replay: HistoryReplay,
) -> Result<(), AppError> {
    reconcile_pending_mutations_inner(repository, recovery, Some(&history_replay)).await
}

async fn reconcile_pending_mutations_inner(
    repository: &SqliteRepository,
    recovery: &RecoveryStore,
    history_replay: Option<&HistoryReplay>,
) -> Result<(), AppError> {
    let mut first_error = None;
    for mut record in load_journals(recovery)? {
        if let Err(error) = apply_committed_record_with_history(
            repository,
            recovery,
            &mut record,
            false,
            false,
            history_replay,
        )
        .await
        {
            first_error = first_error.or(Some(error));
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

pub async fn apply_committed_record_with_history(
    repository: &SqliteRepository,
    recovery: &RecoveryStore,
    record: &mut MutationJournalRecord,
    skip_sqlite: bool,
    skip_recovery: bool,
    history_replay: Option<&HistoryReplay>,
) -> Result<(), AppError> {
    if !record.filesystem_committed
        && record.version >= JOURNAL_VERSION
        && record.kind == MutationJournalKind::Rename
        && rename_commit_proven(record)
    {
        // The filesystem rename is the user-visible commit.  Persist the
        // inferred marker before repairing any derived state so a second
        // replay observes the same phase boundary.
        record.filesystem_committed = true;
        save_journal(recovery, record)?;
    }
    if !filesystem_commit_observed(record) {
        if uncommitted_filesystem_state_is_safe_to_drop(record) {
            if uncommitted_journal_is_stale(recovery, record) {
                delete_journal(recovery, &record.operation_id)?;
            }
            return Ok(());
        }
        if record.version >= HISTORY_PHASE_VERSION {
            return Err(AppError::HistoryOperationPending(
                record.operation_id.clone(),
            ));
        }
        return Ok(());
    }

    let mut apply_error = None;
    if !record.parent_sync_applied {
        match sync_rename_parent_directories(record) {
            Ok(()) => {
                record.parent_sync_applied = true;
                save_journal(recovery, record)?;
            }
            Err(error) => {
                // The filesystem mutation is already committed. Keep the
                // durable record and stop before repairing derived state so a
                // retry can establish parent-directory durability first.
                return Err(error);
            }
        }
    }
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
    // v1 records predate the explicit history flags. When a history replay
    // owner is available, probe them as well so an existing identity is not
    // stranded behind the legacy two-phase completion path. Without a
    // history owner, preserve the legacy behavior unless the record explicitly
    // requires the new phase.
    let legacy_history_probe = record.version < HISTORY_PHASE_VERSION;
    if record.sqlite_applied
        && record.recovery_applied
        && (record.history_pending() || legacy_history_probe)
    {
        match history_replay {
            Some(history_replay) => match history_replay(record.clone()).await {
                Ok(()) => {
                    record.history_applied = true;
                    save_journal(recovery, record)?;
                }
                Err(error) => apply_error = apply_error.or(Some(error)),
            },
            None if record.history_pending() => {
                apply_error = apply_error.or(Some(AppError::HistoryOperationPending(
                    record.operation_id.clone(),
                )))
            }
            None => {}
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

fn sync_rename_parent_directories(record: &MutationJournalRecord) -> Result<(), AppError> {
    if record.kind != MutationJournalKind::Rename {
        return Ok(());
    }

    #[cfg(test)]
    let injected_failure = PARENT_SYNC_FAULT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_deref()
        == Some(record.operation_id.as_str());
    #[cfg(test)]
    if injected_failure {
        return Err(AppError::Io {
            path: None,
            source: io::Error::other("injected parent directory sync failure"),
        });
    }

    let old_parent = Path::new(&record.old_canonical_path)
        .parent()
        .ok_or_else(|| AppError::Internal("rename journal is missing the old parent".to_owned()))?;
    let new_parent = record
        .new_canonical_path
        .as_deref()
        .and_then(|path| Path::new(path).parent())
        .ok_or_else(|| AppError::Internal("rename journal is missing the new parent".to_owned()))?;

    sync_parent_directory(old_parent)?;
    if new_parent != old_parent {
        sync_parent_directory(new_parent)?;
    }
    Ok(())
}

fn sync_parent_directory(parent: &Path) -> Result<(), AppError> {
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| AppError::Io {
            path: Some(parent.to_path_buf()),
            source,
        })
}

pub(crate) fn filesystem_commit_observed(record: &MutationJournalRecord) -> bool {
    if record.version >= JOURNAL_VERSION {
        return record.filesystem_committed;
    }
    if record.version >= HISTORY_PHASE_VERSION {
        // v2 has an explicit marker but no pre-rename identity.  An
        // unmarked record is therefore ambiguous and must not use path
        // existence as a commit proof.
        return record.filesystem_committed;
    }
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

/// Capture the identity of the object at a rename source before the source
/// path is changed.  `symlink_metadata` deliberately rejects a symlink itself
/// as an identity witness; following a replacement symlink would make replay
/// accept an object merely reachable through the old path.
pub(crate) fn filesystem_identity_for_path(path: &Path) -> Option<MutationFilesystemIdentity> {
    MutationFilesystemIdentity::from_path(path)
}

fn rename_commit_proven(record: &MutationJournalRecord) -> bool {
    let Some(identity) = record.filesystem_identity.as_ref() else {
        return false;
    };
    let Some(new_path) = record.new_canonical_path.as_deref() else {
        return false;
    };

    identity.matches_path(Path::new(new_path))
        && identity.old_path_is_absent(Path::new(&record.old_canonical_path))
}

/// A v2/v3 journal may be removed after TTL only when the filesystem still
/// proves that the mutation never started. Once the old path disappears, the
/// process may have committed the mutation immediately before a crash and
/// before the durable marker was written; retaining the journal is fail-closed
/// in that ambiguous state.
fn uncommitted_filesystem_state_is_safe_to_drop(record: &MutationJournalRecord) -> bool {
    if record.version < 2 {
        return true;
    }
    let old = PathBuf::from(&record.old_canonical_path);
    match record.kind {
        MutationJournalKind::Rename => {
            let Some(new_canonical_path) = record.new_canonical_path.as_ref() else {
                return false;
            };
            old.exists() && !PathBuf::from(new_canonical_path).exists()
        }
        MutationJournalKind::Delete => old.exists(),
    }
}

fn uncommitted_journal_is_stale(recovery: &RecoveryStore, record: &MutationJournalRecord) -> bool {
    let path = journal_path(recovery, &record.operation_id);
    let Ok(metadata) = fs::metadata(&path) else {
        return false;
    };
    let Ok(modified) = metadata.modified() else {
        return false;
    };
    SystemTime::now()
        .duration_since(modified)
        .is_ok_and(|age| age >= UNCOMMITTED_JOURNAL_TTL)
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
