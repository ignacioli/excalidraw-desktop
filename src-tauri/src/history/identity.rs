//! Persistent document identity and filesystem-boundary checks.
//!
//! A history document is a logical record, not a path hash.  The path is a
//! locator that may change during an application-owned rename, while the
//! filesystem evidence protects the record from being silently attached to a
//! different file at the same path.  Storage and document commands own when
//! these values are persisted or refreshed; this module only models the
//! identity invariants.

use std::{
    fmt, fs, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use super::store::{HistoryStore, HistoryStoreError};

/// The lifecycle of a persistent history document.
///
/// `Detached` retains history while the current path is unavailable or no
/// longer authorized.  `Deleting` is a tombstone-like transition used while
/// explicit document deletion is being completed; it must not be reused for
/// an unrelated file that later appears at the old path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IdentityState {
    Active,
    Detached,
    Deleting,
}

/// A timestamp representation that is stable across serde and platforms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileTimestamp {
    pub seconds: i64,
    pub nanoseconds: u32,
}

impl FileTimestamp {
    fn from_system_time(time: SystemTime, path: &Path) -> Result<Self, IdentityError> {
        let duration = time.duration_since(UNIX_EPOCH).map_err(|source| {
            IdentityError::InvalidFileTimestamp {
                path: path.to_path_buf(),
                source,
            }
        })?;
        let seconds = i64::try_from(duration.as_secs()).map_err(|_| {
            IdentityError::FileMetadataOutOfRange {
                path: path.to_path_buf(),
            }
        })?;
        Ok(Self {
            seconds,
            nanoseconds: duration.subsec_nanos(),
        })
    }
}

/// Metadata needed to distinguish an application-owned replacement from a
/// different file that happens to have the same path and bytes.
///
/// On Unix, device/inode form the reliable identity pair.  The size and
/// modification timestamp are retained as supporting evidence and for
/// diagnostics, but are deliberately not used as a substitute for the pair.
/// On platforms without a stable pair this value is marked unreliable and
/// callers must fail closed rather than merge identities.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileSystemIdentity {
    pub device: Option<u64>,
    pub inode: Option<u64>,
    pub file_size: u64,
    pub modified: FileTimestamp,
    pub reliable: bool,
}

impl FileSystemIdentity {
    pub fn from_path(path: &Path) -> Result<Self, IdentityError> {
        let metadata = fs::metadata(path).map_err(|source| IdentityError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        Self::from_metadata(path, &metadata)
    }

    pub fn from_metadata(path: &Path, metadata: &fs::Metadata) -> Result<Self, IdentityError> {
        if !metadata.is_file() {
            return Err(IdentityError::NotRegularFile(path.to_path_buf()));
        }

        #[cfg(unix)]
        let (device, inode, reliable) = {
            use std::os::unix::fs::MetadataExt;
            (Some(metadata.dev()), Some(metadata.ino()), true)
        };
        #[cfg(not(unix))]
        let (device, inode, reliable) = (None, None, false);

        Ok(Self {
            device,
            inode,
            file_size: metadata.len(),
            modified: FileTimestamp::from_system_time(
                metadata.modified().map_err(|source| IdentityError::Io {
                    path: path.to_path_buf(),
                    source,
                })?,
                path,
            )?,
            reliable,
        })
    }

    /// Returns whether both records carry a reliable identity pair and refer
    /// to the same filesystem object.  A false result is intentionally
    /// conservative: equal path, hash, size, or mtime is not enough.
    pub fn refers_to_same_file(&self, other: &Self) -> bool {
        self.reliable
            && other.reliable
            && self.device.is_some()
            && self.inode.is_some()
            && self.device == other.device
            && self.inode == other.inode
    }
}

/// A verified observation of a real file path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileObservation {
    pub canonical_path: String,
    pub filesystem_identity: FileSystemIdentity,
}

impl FileObservation {
    pub fn inspect(path: &Path) -> Result<Self, IdentityError> {
        let canonical = canonical_existing_path(path)?;
        let filesystem_identity = FileSystemIdentity::from_path(&canonical)?;
        Ok(Self {
            canonical_path: path_string(&canonical),
            filesystem_identity,
        })
    }
}

/// Result of comparing an observed file with the persistent identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileObservationKind {
    /// The path and filesystem identity are unchanged.
    Unchanged,
    /// The observation matches the most recent application-owned write.
    SelfWriteEcho,
    /// The same file object changed in place and is therefore an external
    /// content change unless a higher layer has an explicit write receipt.
    ExternalChange,
    /// The path now resolves to a different filesystem object.
    ExternalReplacement,
}

/// Persistent identity for one real document file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentIdentity {
    /// Stable logical identity.  It is intentionally a string because the
    /// public IPC contracts use UUID-shaped strings and the uuid crate's
    /// serde feature is not enabled by the product manifest.
    pub document_id: String,
    pub canonical_path: String,
    pub filesystem_identity: FileSystemIdentity,
    pub recent_self_write_hash: Option<String>,
    pub recent_self_write_identity: Option<FileSystemIdentity>,
    pub state: IdentityState,
}

impl DocumentIdentity {
    /// Establishes a new logical identity only from an existing regular file.
    /// Unsaved tabs cannot call this constructor successfully.
    pub fn establish(path: &Path) -> Result<Self, IdentityError> {
        let observation = FileObservation::inspect(path)?;
        Ok(Self {
            document_id: Uuid::new_v4().to_string(),
            canonical_path: observation.canonical_path,
            filesystem_identity: observation.filesystem_identity,
            recent_self_write_hash: None,
            recent_self_write_identity: None,
            state: IdentityState::Active,
        })
    }

    /// Rehydrates a persisted identity after validating its UUID-shaped id
    /// and the current file evidence.  The caller is responsible for loading
    /// this only from the history store, not from an untrusted IPC path.
    pub fn rehydrate(
        document_id: impl Into<String>,
        path: &Path,
        filesystem_identity: FileSystemIdentity,
        recent_self_write_hash: Option<String>,
        recent_self_write_identity: Option<FileSystemIdentity>,
        state: IdentityState,
    ) -> Result<Self, IdentityError> {
        let document_id = document_id.into();
        Uuid::parse_str(&document_id)
            .map_err(|_| IdentityError::InvalidDocumentId(document_id.clone()))?;
        validate_optional_hash(recent_self_write_hash.as_deref())?;
        Ok(Self {
            document_id,
            canonical_path: path_string(path),
            filesystem_identity,
            recent_self_write_hash,
            recent_self_write_identity,
            state,
        })
    }

    pub fn tab_identity(&self) -> TabIdentity {
        TabIdentity::new()
    }

    pub fn recovery_identity(&self) -> RecoveryIdentity {
        RecoveryIdentity::new()
    }

    /// Records a successful application-owned atomic write.  The observed
    /// file identity is refreshed because an atomic rename normally creates a
    /// new inode.  Callers must perform their pre-publish conflict check before
    /// invoking this method.
    pub fn record_self_write(
        &mut self,
        path: &Path,
        content_hash: impl Into<String>,
    ) -> Result<(), IdentityError> {
        self.ensure_active()?;
        let observation = FileObservation::inspect(path)?;
        if observation.canonical_path != self.canonical_path {
            return Err(IdentityError::UnexpectedPath {
                expected: PathBuf::from(&self.canonical_path),
                observed: PathBuf::from(observation.canonical_path),
            });
        }
        let content_hash = content_hash.into();
        validate_hash(&content_hash)?;
        self.filesystem_identity = observation.filesystem_identity.clone();
        self.recent_self_write_hash = Some(content_hash);
        self.recent_self_write_identity = Some(observation.filesystem_identity);
        Ok(())
    }

    /// Checks a path before any history or destructive operation.  A missing,
    /// renamed, or replaced file is an error; callers must not silently bind a
    /// same-path file to this identity.
    pub fn verify_current_file(&self, path: &Path) -> Result<FileObservation, IdentityError> {
        self.ensure_active()?;
        let observation = FileObservation::inspect(path)?;
        if observation.canonical_path != self.canonical_path {
            return Err(IdentityError::UnexpectedPath {
                expected: PathBuf::from(&self.canonical_path),
                observed: PathBuf::from(observation.canonical_path),
            });
        }
        if !self
            .filesystem_identity
            .refers_to_same_file(&observation.filesystem_identity)
        {
            return Err(IdentityError::ExternalReplacement {
                path: PathBuf::from(&self.canonical_path),
            });
        }
        Ok(observation)
    }

    /// Classifies a verified observation using the latest self-write receipt.
    /// The hash is supplied by the caller so bounded document readers and the
    /// existing watcher verification triplet can share their work.
    pub fn classify_observation(
        &self,
        observation: &FileObservation,
        content_hash: &str,
    ) -> Result<FileObservationKind, IdentityError> {
        validate_hash(content_hash)?;
        if observation.canonical_path != self.canonical_path {
            return Ok(FileObservationKind::ExternalReplacement);
        }
        if !self
            .filesystem_identity
            .refers_to_same_file(&observation.filesystem_identity)
        {
            return Ok(FileObservationKind::ExternalReplacement);
        }
        if self
            .recent_self_write_hash
            .as_deref()
            .is_some_and(|hash| hash == content_hash)
            && self
                .recent_self_write_identity
                .as_ref()
                .is_some_and(|identity| {
                    identity.refers_to_same_file(&observation.filesystem_identity)
                })
        {
            return Ok(FileObservationKind::SelfWriteEcho);
        }
        if self
            .recent_self_write_hash
            .as_deref()
            .is_some_and(|hash| hash == content_hash)
        {
            return Ok(FileObservationKind::Unchanged);
        }
        Ok(FileObservationKind::ExternalChange)
    }

    pub fn clear_recent_self_write(&mut self) {
        self.recent_self_write_hash = None;
        self.recent_self_write_identity = None;
    }

    pub fn detach(&mut self) {
        self.state = IdentityState::Detached;
    }

    pub fn begin_deleting(&mut self) {
        self.state = IdentityState::Deleting;
    }

    /// Reattaches a detached identity only when the old filesystem object is
    /// still provably the same object.  A same-name replacement is rejected.
    pub fn reattach(&mut self, path: &Path) -> Result<(), IdentityError> {
        if self.state != IdentityState::Detached {
            return Err(IdentityError::InvalidState {
                expected: IdentityState::Detached,
                actual: self.state,
            });
        }
        let observation = FileObservation::inspect(path)?;
        if !self
            .filesystem_identity
            .refers_to_same_file(&observation.filesystem_identity)
        {
            return Err(IdentityError::ExternalReplacement {
                path: PathBuf::from(observation.canonical_path),
            });
        }
        self.canonical_path = observation.canonical_path;
        self.filesystem_identity = observation.filesystem_identity;
        self.state = IdentityState::Active;
        Ok(())
    }

    /// Updates the locator after an application-owned rename or move.  The
    /// source and target must refer to the same filesystem object.
    pub fn record_app_rename(
        &mut self,
        old_path: &Path,
        new_path: &Path,
    ) -> Result<(), IdentityError> {
        self.ensure_active()?;
        // Mutation-journal replay normally calls this after the filesystem
        // rename has committed, so the old locator may already be absent.  If
        // it is still present, verify it as well; otherwise require that the
        // caller supplied the identity's previously recorded locator.
        if old_path.exists() {
            self.verify_current_file(old_path)?;
        } else if canonical_locator(old_path)? != self.canonical_path {
            return Err(IdentityError::UnexpectedPath {
                expected: PathBuf::from(&self.canonical_path),
                observed: old_path.to_path_buf(),
            });
        }
        let new = FileObservation::inspect(new_path)?;
        if !self
            .filesystem_identity
            .refers_to_same_file(&new.filesystem_identity)
        {
            return Err(IdentityError::ExternalReplacement {
                path: PathBuf::from(new.canonical_path),
            });
        }
        self.canonical_path = new.canonical_path;
        self.filesystem_identity = new.filesystem_identity.clone();
        self.recent_self_write_identity = self
            .recent_self_write_hash
            .as_ref()
            .map(|_| new.filesystem_identity);
        Ok(())
    }

    fn ensure_active(&self) -> Result<(), IdentityError> {
        if self.state != IdentityState::Active {
            return Err(IdentityError::Inactive { state: self.state });
        }
        Ok(())
    }
}

/// Ephemeral frontend tab identity.  It is deliberately a distinct Rust type
/// from both persistent history and Recovery identities.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TabIdentity(String);

impl TabIdentity {
    pub fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for TabIdentity {
    fn default() -> Self {
        Self::new()
    }
}

/// Recovery identity.  Recovery owns abnormal-exit snapshots and therefore
/// must not reuse a tab id or the persistent history document UUID.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RecoveryIdentity(String);

impl RecoveryIdentity {
    pub fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for RecoveryIdentity {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Error)]
pub enum IdentityError {
    #[error("failed to inspect document path {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("document path is not a regular file: {0}")]
    NotRegularFile(PathBuf),
    #[error("document file timestamp is invalid: {path}: {source}")]
    InvalidFileTimestamp {
        path: PathBuf,
        #[source]
        source: std::time::SystemTimeError,
    },
    #[error("document file metadata is outside the supported range: {path}")]
    FileMetadataOutOfRange { path: PathBuf },
    #[error("document id is not a UUID: {0}")]
    InvalidDocumentId(String),
    #[error("content hash is not a lowercase SHA-256 digest")]
    InvalidHash,
    #[error("document path changed from {expected} to {observed}")]
    UnexpectedPath {
        expected: PathBuf,
        observed: PathBuf,
    },
    #[error("document file identity changed at {path}")]
    ExternalReplacement { path: PathBuf },
    #[error("document identity is {state:?} and cannot perform this operation")]
    Inactive { state: IdentityState },
    #[error("document identity state is {actual:?}, expected {expected:?}")]
    InvalidState {
        expected: IdentityState,
        actual: IdentityState,
    },
}

impl IdentityError {
    /// Returns true when a caller must stop using the document rather than
    /// retrying the same operation against the current path.
    pub fn is_stale_boundary(&self) -> bool {
        matches!(
            self,
            Self::ExternalReplacement { .. } | Self::UnexpectedPath { .. } | Self::Inactive { .. }
        ) || matches!(
            self,
            Self::Io { source, .. } if source.kind() == io::ErrorKind::NotFound
        )
    }
}

#[derive(Debug, Error)]
pub enum IdentityStoreError {
    #[error(transparent)]
    Store(#[from] HistoryStoreError),
    #[error(transparent)]
    Identity(#[from] IdentityError),
    #[error("history identity metadata is invalid: {0}")]
    InvalidMetadata(String),
}

/// Persistence boundary for `history_documents`.
///
/// This is implemented next to the identity model so document commands can
/// use the durable store without introducing a second in-memory registry. The
/// history store remains the serialization boundary; callers invoke these
/// synchronous methods from their existing blocking-work wrapper.
impl HistoryStore {
    /// Load the currently active identity for a canonical path.
    pub fn load_active_document_identity(
        &self,
        canonical_path: &str,
    ) -> Result<Option<DocumentIdentity>, IdentityStoreError> {
        self.load_document_identity_by_path(canonical_path, false)
    }

    /// Load the newest non-deleting identity for open/remount resolution.
    /// Detached rows remain eligible so a remounted original file can reclaim
    /// its UUID; a different file at the same path still gets a new UUID.
    pub fn load_non_deleting_document_identity(
        &self,
        canonical_path: &str,
    ) -> Result<Option<DocumentIdentity>, IdentityStoreError> {
        self.load_document_identity_by_path(canonical_path, true)
    }

    fn load_document_identity_by_path(
        &self,
        canonical_path: &str,
        include_detached: bool,
    ) -> Result<Option<DocumentIdentity>, IdentityStoreError> {
        let state_clause = if include_detached {
            "state <> 'deleting'"
        } else {
            "state = 'active'"
        };
        let query = format!(
            "SELECT id, canonical_path, filesystem_device, filesystem_inode,
                    filesystem_file_size, filesystem_modified_seconds,
                    filesystem_modified_nanos, filesystem_reliable,
                    last_self_written_hash, state
             FROM history_documents
             WHERE canonical_path = ?1 AND {state_clause}
             ORDER BY CASE WHEN state = 'active' THEN 0 ELSE 1 END,
                      created_at DESC, id DESC
             LIMIT 1"
        );
        let row = self.with_connection(|connection| {
            rusqlite::OptionalExtension::optional(connection.query_row(
                &query,
                [canonical_path],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, String>(9)?,
                    ))
                },
            ))
        })?;
        row.map(document_identity_from_row).transpose()
    }

    /// Insert or update one durable identity record.  The UUID is the primary
    /// key, so a Save As identity cannot overwrite the original document.
    pub fn persist_document_identity(
        &self,
        identity: &DocumentIdentity,
        created_at: i64,
    ) -> Result<(), IdentityStoreError> {
        let filesystem = &identity.filesystem_identity;
        let device = filesystem
            .device
            .map(i64::try_from)
            .transpose()
            .map_err(|_| {
                IdentityStoreError::InvalidMetadata(
                    "filesystem device exceeds SQLite range".to_owned(),
                )
            })?;
        let inode = filesystem
            .inode
            .map(i64::try_from)
            .transpose()
            .map_err(|_| {
                IdentityStoreError::InvalidMetadata(
                    "filesystem inode exceeds SQLite range".to_owned(),
                )
            })?;
        let file_size = i64::try_from(filesystem.file_size).map_err(|_| {
            IdentityStoreError::InvalidMetadata(
                "filesystem file size exceeds SQLite range".to_owned(),
            )
        })?;
        self.with_connection(|connection| {
            connection
                .execute(
                    "INSERT INTO history_documents
                 (id, canonical_path, filesystem_device, filesystem_inode,
                  filesystem_file_size, filesystem_modified_seconds,
                  filesystem_modified_nanos, filesystem_reliable,
                  last_self_written_hash, created_at, state)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(id) DO UPDATE SET
                    canonical_path = excluded.canonical_path,
                    filesystem_device = excluded.filesystem_device,
                    filesystem_inode = excluded.filesystem_inode,
                    filesystem_file_size = excluded.filesystem_file_size,
                    filesystem_modified_seconds = excluded.filesystem_modified_seconds,
                    filesystem_modified_nanos = excluded.filesystem_modified_nanos,
                    filesystem_reliable = excluded.filesystem_reliable,
                    last_self_written_hash = excluded.last_self_written_hash,
                    state = excluded.state",
                    rusqlite::params![
                        identity.document_id,
                        identity.canonical_path,
                        device,
                        inode,
                        file_size,
                        filesystem.modified.seconds,
                        i64::from(filesystem.modified.nanoseconds),
                        i64::from(u8::from(filesystem.reliable)),
                        identity.recent_self_write_hash,
                        created_at,
                        identity_state_name(identity.state),
                    ],
                )
                .map(|_| ())
        })?;
        Ok(())
    }

    /// Migrate every non-deleting identity below an application-owned rename.
    /// Filesystem evidence is checked before the metadata transaction, so a
    /// missing target, an external replacement, or an unknown result leaves
    /// all identities unchanged and lets the mutation journal retry.
    pub fn migrate_app_rename(
        &self,
        old_path: &Path,
        new_path: &Path,
    ) -> Result<(), IdentityStoreError> {
        let old_prefix = canonical_locator(old_path)?;
        let new_prefix = canonical_locator(new_path)?;
        let rows = self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, canonical_path, filesystem_device, filesystem_inode,
                        filesystem_file_size, filesystem_modified_seconds,
                        filesystem_modified_nanos, filesystem_reliable,
                        last_self_written_hash, state
                 FROM history_documents
                 WHERE state = 'active'",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, String>(9)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>();
            rows
        })?;

        let mut updates = Vec::new();
        for row in rows {
            let identity = document_identity_from_row(row)?;
            let Some(suffix) = path_suffix(Path::new(&identity.canonical_path), &old_prefix) else {
                continue;
            };
            let target = PathBuf::from(&new_prefix).join(suffix);
            let mut migrated = identity;
            let previous_path = PathBuf::from(&migrated.canonical_path);
            migrated.record_app_rename(&previous_path, &target)?;
            updates.push(migrated);
        }

        self.with_transaction(|transaction| {
            for identity in &updates {
                let filesystem = &identity.filesystem_identity;
                let device = filesystem
                    .device
                    .map(i64::try_from)
                    .transpose()
                    .map_err(|_| {
                        rusqlite::Error::ToSqlConversionFailure(Box::new(
                            IdentityStoreError::InvalidMetadata(
                                "filesystem device exceeds SQLite range".to_owned(),
                            ),
                        ))
                    })?;
                let inode = filesystem
                    .inode
                    .map(i64::try_from)
                    .transpose()
                    .map_err(|_| {
                        rusqlite::Error::ToSqlConversionFailure(Box::new(
                            IdentityStoreError::InvalidMetadata(
                                "filesystem inode exceeds SQLite range".to_owned(),
                            ),
                        ))
                    })?;
                let file_size = i64::try_from(filesystem.file_size).map_err(|_| {
                    rusqlite::Error::ToSqlConversionFailure(Box::new(
                        IdentityStoreError::InvalidMetadata(
                            "filesystem file size exceeds SQLite range".to_owned(),
                        ),
                    ))
                })?;
                transaction.execute(
                    "UPDATE history_documents
                     SET canonical_path = ?1,
                         filesystem_device = ?2,
                         filesystem_inode = ?3,
                         filesystem_file_size = ?4,
                         filesystem_modified_seconds = ?5,
                         filesystem_modified_nanos = ?6,
                         filesystem_reliable = ?7,
                         last_self_written_hash = ?8,
                         state = ?9
                     WHERE id = ?10",
                    rusqlite::params![
                        identity.canonical_path,
                        device,
                        inode,
                        file_size,
                        filesystem.modified.seconds,
                        i64::from(filesystem.modified.nanoseconds),
                        i64::from(u8::from(filesystem.reliable)),
                        identity.recent_self_write_hash,
                        identity_state_name(identity.state),
                        identity.document_id,
                    ],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })?;
        Ok(())
    }

    /// Mark an identity detached without deleting its versions.  This is
    /// idempotent and is used before establishing a new UUID for a same-path
    /// replacement.
    pub fn detach_document_identity(&self, document_id: &str) -> Result<(), IdentityStoreError> {
        self.with_connection(|connection| {
            connection
                .execute(
                    "UPDATE history_documents SET state = 'detached'
                     WHERE id = ?1 AND state <> 'deleting'",
                    [document_id],
                )
                .map(|_| ())
        })?;
        Ok(())
    }

    /// Open resolution establishes a new identity only when no prior identity
    /// exists.  An existing row whose filesystem evidence differs is a stale
    /// document and must be handled by an explicit future authorization flow;
    /// opening it must not silently detach history or allocate a new UUID.
    pub fn resolve_document_identity_for_open(
        &self,
        path: &Path,
        created_at: i64,
    ) -> Result<DocumentIdentity, IdentityStoreError> {
        let candidate = DocumentIdentity::establish(path)?;
        if let Some(mut existing) =
            self.load_non_deleting_document_identity(&candidate.canonical_path)?
        {
            if existing
                .filesystem_identity
                .refers_to_same_file(&candidate.filesystem_identity)
            {
                if existing.state == IdentityState::Detached {
                    existing.state = IdentityState::Active;
                    self.persist_document_identity(&existing, created_at)?;
                }
                return Ok(existing);
            }
            return Err(IdentityStoreError::Identity(
                IdentityError::ExternalReplacement {
                    path: PathBuf::from(candidate.canonical_path),
                },
            ));
        }
        self.persist_document_identity(&candidate, created_at)?;
        Ok(candidate)
    }

    /// Existing-file operations must refuse an identity mismatch.  This is
    /// used by draft save and checkpoint before they can attach state to a
    /// same-path replacement.
    pub fn resolve_document_identity_for_existing(
        &self,
        path: &Path,
        created_at: i64,
    ) -> Result<DocumentIdentity, IdentityStoreError> {
        let candidate = DocumentIdentity::establish(path)?;
        if let Some(existing) = self.load_active_document_identity(&candidate.canonical_path)? {
            if !existing
                .filesystem_identity
                .refers_to_same_file(&candidate.filesystem_identity)
            {
                return Err(IdentityStoreError::Identity(
                    IdentityError::ExternalReplacement {
                        path: PathBuf::from(candidate.canonical_path),
                    },
                ));
            }
            return Ok(existing);
        }
        self.persist_document_identity(&candidate, created_at)?;
        Ok(candidate)
    }
}

type PersistedIdentityRow = (
    String,
    String,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    Option<String>,
    String,
);

fn document_identity_from_row(
    row: PersistedIdentityRow,
) -> Result<DocumentIdentity, IdentityStoreError> {
    let (
        id,
        canonical_path,
        device,
        inode,
        file_size,
        modified_seconds,
        modified_nanos,
        reliable,
        recent_self_write_hash,
        state,
    ) = row;
    let filesystem_identity = FileSystemIdentity {
        device: device.map(sqlite_u64).transpose()?,
        inode: inode.map(sqlite_u64).transpose()?,
        file_size: file_size.map(sqlite_u64).transpose()?.unwrap_or_default(),
        modified: FileTimestamp {
            seconds: modified_seconds.unwrap_or_default(),
            nanoseconds: modified_nanos
                .map(sqlite_u32)
                .transpose()?
                .unwrap_or_default(),
        },
        reliable: reliable.unwrap_or_default() != 0,
    };
    let state = match state.as_str() {
        "active" => IdentityState::Active,
        "detached" => IdentityState::Detached,
        "deleting" => IdentityState::Deleting,
        other => {
            return Err(IdentityStoreError::InvalidMetadata(format!(
                "unknown document state {other}"
            )))
        }
    };
    let recent_self_write_identity = recent_self_write_hash
        .as_ref()
        .map(|_| filesystem_identity.clone());
    DocumentIdentity::rehydrate(
        id,
        Path::new(&canonical_path),
        filesystem_identity,
        recent_self_write_hash,
        recent_self_write_identity,
        state,
    )
    .map_err(Into::into)
}

fn sqlite_u64(value: i64) -> Result<u64, IdentityStoreError> {
    u64::try_from(value)
        .map_err(|_| IdentityStoreError::InvalidMetadata("negative filesystem metadata".to_owned()))
}

fn sqlite_u32(value: i64) -> Result<u32, IdentityStoreError> {
    u32::try_from(value).map_err(|_| {
        IdentityStoreError::InvalidMetadata("invalid filesystem timestamp nanoseconds".to_owned())
    })
}

fn identity_state_name(state: IdentityState) -> &'static str {
    match state {
        IdentityState::Active => "active",
        IdentityState::Detached => "detached",
        IdentityState::Deleting => "deleting",
    }
}

impl fmt::Display for FileSystemIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "device={:?}, inode={:?}, size={}, modified={}.{:09}, reliable={}",
            self.device,
            self.inode,
            self.file_size,
            self.modified.seconds,
            self.modified.nanoseconds,
            self.reliable
        )
    }
}

fn canonical_existing_path(path: &Path) -> Result<PathBuf, IdentityError> {
    let canonical = fs::canonicalize(path).map_err(|source| IdentityError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let metadata = fs::metadata(&canonical).map_err(|source| IdentityError::Io {
        path: canonical.clone(),
        source,
    })?;
    if !metadata.is_file() {
        return Err(IdentityError::NotRegularFile(canonical));
    }
    Ok(canonical)
}

/// Canonicalizes a path whose final component may already have been removed
/// by an application-owned rename.  This also handles macOS `/var` ->
/// `/private/var` aliases consistently with `fs::canonicalize`.
fn canonical_locator(path: &Path) -> Result<String, IdentityError> {
    if path.exists() {
        return Ok(path_string(&fs::canonicalize(path).map_err(|source| {
            IdentityError::Io {
                path: path.to_path_buf(),
                source,
            }
        })?));
    }
    let mut missing_components = Vec::new();
    let mut existing_ancestor = path;
    while !existing_ancestor.exists() {
        let component =
            existing_ancestor
                .file_name()
                .ok_or_else(|| IdentityError::UnexpectedPath {
                    expected: PathBuf::from("<document>"),
                    observed: path.to_path_buf(),
                })?;
        missing_components.push(component.to_os_string());
        existing_ancestor = existing_ancestor
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
    }
    let mut canonical =
        fs::canonicalize(existing_ancestor).map_err(|source| IdentityError::Io {
            path: existing_ancestor.to_path_buf(),
            source,
        })?;
    for component in missing_components.iter().rev() {
        canonical.push(component);
    }
    Ok(path_string(&canonical))
}

fn path_suffix(path: &Path, prefix: &str) -> Option<PathBuf> {
    let prefix = Path::new(prefix);
    if path == prefix {
        return Some(PathBuf::new());
    }
    path.strip_prefix(prefix).ok().map(PathBuf::from)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn validate_optional_hash(hash: Option<&str>) -> Result<(), IdentityError> {
    if let Some(hash) = hash {
        validate_hash(hash)?;
    }
    Ok(())
}

fn validate_hash(hash: &str) -> Result<(), IdentityError> {
    if hash.len() != 64
        || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        || hash.bytes().any(|byte| byte.is_ascii_uppercase())
    {
        return Err(IdentityError::InvalidHash);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, File},
        io::Write,
        path::Path,
    };

    use super::*;

    fn temp_file(name: &str, contents: &[u8]) -> PathBuf {
        let root = std::env::temp_dir().join(format!("excalidraw-history-identity-{name}"));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create temp root");
        let path = root.join("drawing.excalidraw");
        File::create(&path)
            .and_then(|mut file| file.write_all(contents))
            .expect("write temp file");
        path
    }

    fn hash(byte: u8) -> String {
        format!("{byte:02x}").repeat(32)
    }

    #[test]
    fn establishes_uuid_and_canonical_filesystem_identity() {
        let path = temp_file("establish", b"scene-a");
        let identity = DocumentIdentity::establish(&path).expect("establish identity");

        assert!(Uuid::parse_str(&identity.document_id).is_ok());
        assert_eq!(
            identity.canonical_path,
            fs::canonicalize(&path).unwrap().display().to_string()
        );
        assert!(identity.filesystem_identity.reliable);
        assert_eq!(identity.state, IdentityState::Active);
        assert!(identity.recent_self_write_hash.is_none());
    }

    #[test]
    fn atomic_self_write_refreshes_identity_and_classifies_echo() {
        let path = temp_file("self-write", b"scene-a");
        let mut identity = DocumentIdentity::establish(&path).expect("establish identity");
        let old_identity = identity.filesystem_identity.clone();

        let replacement = path.with_extension("tmp");
        fs::write(&replacement, b"scene-b").expect("write replacement");
        fs::rename(&replacement, &path).expect("replace file");
        identity
            .record_self_write(&path, hash(b'b'))
            .expect("record self write");

        assert!(!old_identity.refers_to_same_file(&identity.filesystem_identity));
        let observation = FileObservation::inspect(&path).expect("inspect echo");
        assert_eq!(
            identity
                .classify_observation(&observation, &hash(b'b'))
                .expect("classify echo"),
            FileObservationKind::SelfWriteEcho
        );
        identity.clear_recent_self_write();
        assert!(identity.recent_self_write_hash.is_none());
    }

    #[test]
    fn rejects_same_path_external_replacement_even_when_hash_is_valid() {
        let path = temp_file("external-replacement", b"scene-a");
        let identity = DocumentIdentity::establish(&path).expect("establish identity");
        let replacement = path.with_extension("tmp");
        fs::write(&replacement, b"scene-a").expect("write replacement");
        fs::rename(&replacement, &path).expect("replace file");

        let error = identity
            .verify_current_file(&path)
            .expect_err("replacement rejected");
        assert!(matches!(error, IdentityError::ExternalReplacement { .. }));
    }

    #[test]
    fn application_rename_preserves_logical_uuid_but_new_save_as_does_not() {
        let path = temp_file("rename", b"scene-a");
        let mut identity = DocumentIdentity::establish(&path).expect("establish identity");
        let document_id = identity.document_id.clone();
        let new_path = path.with_file_name("renamed.excalidraw");
        fs::rename(&path, &new_path).expect("rename file");
        identity
            .record_app_rename(&path, &new_path)
            .expect("record app rename");
        assert_eq!(identity.document_id, document_id);

        let save_as_path = new_path.with_file_name("save-as.excalidraw");
        fs::copy(&new_path, &save_as_path).expect("copy save-as");
        let save_as = DocumentIdentity::establish(&save_as_path).expect("new identity");
        assert_ne!(save_as.document_id, identity.document_id);
    }

    #[test]
    fn persisted_identity_migrates_through_an_ancestor_directory_rename() {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-history-identity-ancestor-{}",
            Uuid::new_v4()
        ));
        let old_directory = root.join("old");
        let new_directory = root.join("new");
        let old_path = old_directory.join("nested/drawing.excalidraw");
        let new_path = new_directory.join("nested/drawing.excalidraw");
        fs::create_dir_all(old_path.parent().expect("nested parent")).expect("create drawing dir");
        fs::write(&old_path, b"scene-a").expect("write drawing");
        let store = HistoryStore::open_version_history_root(&root.join("version-history"))
            .expect("open history store");
        let original = store
            .resolve_document_identity_for_open(&old_path, 10)
            .expect("persist original identity");

        fs::rename(&old_directory, &new_directory).expect("rename ancestor directory");
        store
            .migrate_app_rename(&old_directory, &new_directory)
            .expect("migrate ancestor rename");

        let migrated = store
            .load_active_document_identity(
                &new_path
                    .canonicalize()
                    .expect("canonical new path")
                    .display()
                    .to_string(),
            )
            .expect("load migrated identity")
            .expect("migrated identity");
        assert_eq!(migrated.document_id, original.document_id);
        assert_eq!(
            migrated.canonical_path,
            new_path
                .canonicalize()
                .expect("canonical new path")
                .display()
                .to_string()
        );
        assert!(migrated
            .filesystem_identity
            .refers_to_same_file(&original.filesystem_identity));
        fs::remove_dir_all(root).expect("remove identity fixture");
    }

    #[test]
    fn active_identity_wins_over_detached_row_with_same_creation_time() {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-history-identity-active-order-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create identity root");
        let path = root.join("drawing.excalidraw");
        fs::write(&path, b"scene-a").expect("write drawing");
        let store = HistoryStore::open_version_history_root(&root.join("version-history"))
            .expect("open history store");
        let detached = store
            .resolve_document_identity_for_open(&path, 10)
            .expect("persist detached identity");
        store
            .detach_document_identity(&detached.document_id)
            .expect("detach identity");
        let active = DocumentIdentity::establish(&path).expect("establish active identity");
        store
            .persist_document_identity(&active, 10)
            .expect("persist active identity");

        let loaded = store
            .load_non_deleting_document_identity(&active.canonical_path)
            .expect("load active identity")
            .expect("active identity");
        assert_eq!(loaded.document_id, active.document_id);
        assert_eq!(loaded.state, IdentityState::Active);
        fs::remove_dir_all(root).expect("remove identity fixture");
    }

    #[test]
    fn lifecycle_and_tab_recovery_identities_are_isolated() {
        let path = temp_file("lifecycle", b"scene-a");
        let mut identity = DocumentIdentity::establish(&path).expect("establish identity");
        let tab = identity.tab_identity();
        let recovery = identity.recovery_identity();
        assert_ne!(identity.document_id, tab.as_str());
        assert_ne!(identity.document_id, recovery.as_str());
        assert_ne!(tab.as_str(), recovery.as_str());

        identity.detach();
        assert_eq!(identity.state, IdentityState::Detached);
        identity.reattach(&path).expect("reattach same file");
        assert_eq!(identity.state, IdentityState::Active);
        identity.begin_deleting();
        assert_eq!(identity.state, IdentityState::Deleting);
        assert!(identity
            .verify_current_file(Path::new(&identity.canonical_path))
            .is_err());
    }

    #[test]
    fn rejects_invalid_persisted_hash_and_non_file_paths() {
        let directory = tempfile_directory("invalid");
        assert!(matches!(
            DocumentIdentity::establish(&directory),
            Err(IdentityError::NotRegularFile(_))
        ));

        let path = temp_file("invalid-hash", b"scene-a");
        let evidence = FileSystemIdentity::from_path(&path).expect("evidence");
        assert!(matches!(
            DocumentIdentity::rehydrate(
                Uuid::new_v4().to_string(),
                &path,
                evidence,
                Some("not-a-hash".to_owned()),
                None,
                IdentityState::Active,
            ),
            Err(IdentityError::InvalidHash)
        ));
    }

    #[test]
    fn persists_identity_and_refuses_existing_same_path_replacement() {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-history-identity-store-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create store root");
        let path = root.join("drawing.excalidraw");
        fs::write(&path, b"scene-a").expect("write original");
        let store = HistoryStore::open_version_history_root(&root.join("version-history"))
            .expect("open history store");

        let original = store
            .resolve_document_identity_for_open(&path, 10)
            .expect("persist original identity");
        let loaded = store
            .load_active_document_identity(&original.canonical_path)
            .expect("load persisted identity")
            .expect("active identity");
        assert_eq!(loaded.document_id, original.document_id);
        assert_eq!(loaded.filesystem_identity, original.filesystem_identity);
        store
            .detach_document_identity(&original.document_id)
            .expect("detach identity");
        let remounted = store
            .resolve_document_identity_for_open(&path, 11)
            .expect("remount original identity");
        assert_eq!(remounted.document_id, original.document_id);
        assert_eq!(remounted.state, IdentityState::Active);

        let replacement = path.with_extension("tmp");
        fs::write(&replacement, b"scene-a").expect("write replacement");
        fs::rename(&replacement, &path).expect("replace same path");
        let error = store
            .resolve_document_identity_for_existing(&path, 12)
            .expect_err("existing operation must reject replacement");
        assert!(matches!(
            error,
            IdentityStoreError::Identity(IdentityError::ExternalReplacement { .. })
        ));

        let open_error = store
            .resolve_document_identity_for_open(&path, 13)
            .expect_err("open replacement must fail closed");
        assert!(matches!(
            open_error,
            IdentityStoreError::Identity(IdentityError::ExternalReplacement { .. })
        ));
        let old_state: String = store
            .with_connection(|connection| {
                connection.query_row(
                    "SELECT state FROM history_documents WHERE id = ?1",
                    [&original.document_id],
                    |row| row.get(0),
                )
            })
            .expect("read detached state");
        assert_eq!(old_state, "active");

        drop(store);
        fs::remove_dir_all(root).expect("remove store fixture");
    }

    fn tempfile_directory(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("excalidraw-history-identity-dir-{name}"));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create temp dir");
        root
    }
}
