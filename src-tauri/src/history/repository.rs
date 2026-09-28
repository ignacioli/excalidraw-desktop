//! Transactional publication and retention for history versions.
//!
//! Immutable scene bytes are written and verified before the metadata
//! transaction starts.  The transaction then makes the object metadata and
//! semantic version visible together and applies retention only after the new
//! row has been inserted.  This keeps a failed publication from evicting an
//! older version.

use rusqlite::OptionalExtension;
use thiserror::Error;

use super::{
    gc::{ObjectKey, ObjectReferences},
    objects::StoredSceneObject,
    store::{HistoryStore, HistoryStoreError},
    types::{
        validate_identifier, HistoryProtectedAction, HistoryValidationError, HistoryVersionSource,
    },
};

/// The number of unmarked semantic records retained per document.
pub const RETAINED_VERSION_LIMIT: i64 = 20;

/// The minimum time between ordinary automatic history records for one
/// document.  This is deliberately measured only when a successful cold
/// checkpoint calls the automatic coordinator; it is not a timer interval.
pub const AUTOMATIC_INTERVAL_SECONDS: i64 = 30 * 60;

/// Input to the metadata publication primitive. The scene object must already
/// have been written through [`HistoryStore::put_scene`] (or the convenience
/// [`HistoryRepository::publish_scene`] method).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishVersionRequest {
    pub version_id: String,
    pub document_id: String,
    pub scene: StoredSceneObject,
    pub source: HistoryVersionSource,
    pub protected_action: Option<HistoryProtectedAction>,
    pub recorded_at: i64,
    pub sequence: u64,
}

/// Input for publishing a new scene payload and its metadata atomically from
/// the caller's perspective. The payload itself is immutable before the
/// metadata transaction; an unsuccessful transaction leaves only an
/// unregistered object candidate for later cleanup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishSceneRequest {
    pub version_id: String,
    pub document_id: String,
    pub scene_bytes: Vec<u8>,
    pub schema_version: i64,
    pub source: HistoryVersionSource,
    pub protected_action: Option<HistoryProtectedAction>,
    pub recorded_at: i64,
    pub sequence: u64,
}

/// An asset captured from the exact scene being published.  Asset bytes are
/// copied into the immutable history object store before the metadata
/// transaction, so a workspace asset can never become a dangling reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishAsset {
    pub file_id: String,
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

impl PublishSceneRequest {
    fn into_version_request(self, scene: StoredSceneObject) -> PublishVersionRequest {
        PublishVersionRequest {
            version_id: self.version_id,
            document_id: self.document_id,
            scene,
            source: self.source,
            protected_action: self.protected_action,
            recorded_at: self.recorded_at,
            sequence: self.sequence,
        }
    }
}

/// The durable result of one version publication.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedVersion {
    pub version_id: String,
    pub document_id: String,
    pub scene_hash: String,
    pub source: HistoryVersionSource,
    pub protected_action: Option<HistoryProtectedAction>,
    pub recorded_at: i64,
    pub sequence: u64,
    /// Automatic/protected rows removed by this publication, in oldest-first
    /// order. Manual rows never appear here.
    pub evicted_version_ids: Vec<String>,
}

/// The durable result of an explicit user deletion.  The semantic version is
/// gone before this value is returned; object bytes may remain when they are
/// still reachable from another version or an in-flight operation pin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletedVersion {
    pub version_id: String,
    pub document_id: String,
}

/// The semantic result of deleting a document's history.  GC is deliberately
/// represented separately because object cleanup can fail after the SQLite
/// deletion has committed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletedDocumentHistory {
    pub document_id: String,
    pub deleted_version_ids: Vec<String>,
    pub gc: HistoryGcStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HistoryGcStatus {
    pub deleted_objects: usize,
    pub retained_objects: usize,
    pub failures: Vec<String>,
    pub error: Option<String>,
    pub maintenance_record_error: Option<String>,
}

#[derive(Debug, Error)]
pub enum HistoryRepositoryError {
    #[error(transparent)]
    Store(#[from] HistoryStoreError),
    #[error("history version id is invalid: {0}")]
    InvalidVersionId(#[source] HistoryValidationError),
    #[error("history document id is invalid: {0}")]
    InvalidDocumentId(#[source] HistoryValidationError),
    #[error("automatic and manual versions cannot have a protected action")]
    UnexpectedProtectedAction,
    #[error("protected versions require a protected action")]
    MissingProtectedAction,
    #[error("history sequence {0} cannot be represented by SQLite")]
    SequenceOverflow(u64),
    #[error("history version {version_id} does not belong to document {document_id}")]
    VersionNotFound {
        document_id: String,
        version_id: String,
    },
    #[error("history version is referenced by an active operation")]
    VersionInUse,
    #[error("history delete request conflicts with an existing operation")]
    DeleteRequestConflict,
    #[error("history delete operation is still pending")]
    DeletePending,
    #[error("history mark request conflicts with a previous request")]
    MarkRequestConflict,
    #[error("history document does not exist: {0}")]
    DocumentNotFound(String),
    #[cfg(feature = "e2e-harness")]
    #[error("history fault barrier failed: {0}")]
    FaultInjected(String),
}

/// The single metadata publication and retention boundary for history
/// versions.
pub struct HistoryRepository<'store> {
    store: &'store HistoryStore,
}

impl<'store> HistoryRepository<'store> {
    pub fn new(store: &'store HistoryStore) -> Self {
        Self { store }
    }

    pub fn store(&self) -> &'store HistoryStore {
        self.store
    }

    /// Change retention status without changing a version's historical source.
    /// The request receipt and any newly eligible retention eviction commit
    /// together, so retries remain stable even when unmarking prunes the row.
    pub fn set_marked(
        &self,
        request_id: &str,
        document_id: &str,
        version_id: &str,
        marked: bool,
    ) -> Result<bool, HistoryRepositoryError> {
        validate_identifier(request_id, "requestId")
            .map_err(HistoryRepositoryError::InvalidVersionId)?;
        validate_identifier(document_id, "documentId")
            .map_err(HistoryRepositoryError::InvalidDocumentId)?;
        validate_identifier(version_id, "versionId")
            .map_err(HistoryRepositoryError::InvalidVersionId)?;

        let (exists, in_use, conflict, retained, evicted) = self.store.with_mutation(|mutation| {
            let result = self.store.with_transaction(|transaction| -> Result<_, rusqlite::Error> {
                let previous = transaction.query_row(
                    "SELECT document_id, version_id, marked, retained FROM history_mark_requests WHERE request_id = ?1",
                    [request_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, bool>(2)?, row.get::<_, bool>(3)?)),
                ).optional()?;
                if let Some((previous_document, previous_version, previous_marked, previous_retained)) = previous {
                    return Ok((true, false, previous_document != document_id || previous_version != version_id || previous_marked != marked, previous_retained, Vec::new()));
                }
                let exists = transaction.query_row(
                    "SELECT 1 FROM history_versions WHERE id = ?1 AND document_id = ?2",
                    rusqlite::params![version_id, document_id],
                    |_| Ok(()),
                ).optional()?.is_some();
                if !exists {
                    return Ok((false, false, false, false, Vec::new()));
                }
                let in_use = transaction.query_row(
                    "SELECT 1 FROM history_operations WHERE document_id = ?1
                     AND protection_version_id = ?2
                     AND state NOT IN ('completed', 'aborted', 'conflict') LIMIT 1",
                    rusqlite::params![document_id, version_id],
                    |_| Ok(()),
                ).optional()?.is_some();
                if in_use {
                    return Ok((true, true, false, false, Vec::new()));
                }
                transaction.execute(
                    "UPDATE history_versions SET marked = ?3 WHERE id = ?1 AND document_id = ?2",
                    rusqlite::params![version_id, document_id, marked],
                )?;
                let evicted = if marked { Vec::new() } else { prune_unmarked(transaction, document_id)? };
                let retained = !evicted.iter().any(|evicted_id| evicted_id == version_id);
                transaction.execute(
                    "INSERT INTO history_mark_requests (request_id, document_id, version_id, marked, retained)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![request_id, document_id, version_id, marked, retained],
                )?;
                Ok((true, false, false, retained, evicted))
            })?;
            for version_id in &result.4 {
                mutation.remove_committed_version(version_id);
            }
            Ok::<_, HistoryStoreError>(result)
        })?;
        if conflict {
            return Err(HistoryRepositoryError::MarkRequestConflict);
        }
        if !exists {
            return Err(HistoryRepositoryError::VersionNotFound {
                document_id: document_id.to_owned(),
                version_id: version_id.to_owned(),
            });
        }
        if in_use {
            return Err(HistoryRepositoryError::VersionInUse);
        }
        if !evicted.is_empty() {
            let _ = self.store.collect_garbage(
                std::time::SystemTime::now(),
                super::gc::DEFAULT_ORPHAN_GRACE,
            );
        }
        Ok(retained)
    }

    /// Return the durable automatic-history baseline. It is separate from the
    /// latest version row because the first successful checkpoint establishes
    /// the interval without creating a history record.
    pub fn automatic_baseline(
        &self,
        document_id: &str,
    ) -> Result<Option<i64>, HistoryRepositoryError> {
        self.store
            .with_connection(|connection| {
                connection.query_row(
                    "SELECT last_automatic_at FROM history_documents WHERE id = ?1",
                    [document_id],
                    |row| row.get::<_, Option<i64>>(0),
                )
            })
            .map_err(HistoryRepositoryError::Store)
    }

    /// Establish the first-checkpoint baseline without moving an existing
    /// baseline.  This compare-and-set behavior makes a concurrent retry
    /// harmless and keeps manual/protected publication from changing it.
    pub fn establish_automatic_baseline(
        &self,
        document_id: &str,
        recorded_at: i64,
    ) -> Result<bool, HistoryRepositoryError> {
        let changed = self
            .store
            .with_transaction(|transaction| {
                let updated = transaction.execute(
                    "UPDATE history_documents SET last_automatic_at = ?2
                     WHERE id = ?1 AND last_automatic_at IS NULL",
                    rusqlite::params![document_id, recorded_at],
                )?;
                Ok::<_, rusqlite::Error>(updated != 0)
            })
            .map_err(HistoryRepositoryError::Store)?;
        Ok(changed)
    }

    /// Delete exactly one semantic version and record the idempotent delete
    /// result in the same SQLite transaction.  The reachability gate is held
    /// while the metadata mutation and committed-reference update occur, so
    /// collection cannot race the removal.  Object files are collected only
    /// after the transaction and remain protected by any operation or
    /// hydration pins.
    pub fn delete_version(
        &self,
        request_id: &str,
        document_id: &str,
        version_id: &str,
        now: i64,
    ) -> Result<DeletedVersion, HistoryRepositoryError> {
        validate_identifier(request_id, "requestId")
            .map_err(HistoryRepositoryError::InvalidVersionId)?;
        validate_identifier(document_id, "documentId")
            .map_err(HistoryRepositoryError::InvalidDocumentId)?;
        validate_identifier(version_id, "versionId")
            .map_err(HistoryRepositoryError::InvalidVersionId)?;

        // A completed delete is the idempotent response.  A request ID can
        // never be rebound to another document, operation kind, or version.
        if let Some((existing_document, kind, target, state)) =
            self.store.with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT document_id, kind, prepared_target_identity, state
                         FROM history_operations WHERE idempotency_id = ?1",
                        [request_id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, Option<String>>(2)?,
                                row.get::<_, String>(3)?,
                            ))
                        },
                    )
                    .optional()
            })?
        {
            if existing_document != document_id
                || kind != "delete"
                || target.as_deref() != Some(version_id)
            {
                return Err(HistoryRepositoryError::DeleteRequestConflict);
            }
            if state == "completed" {
                return Ok(DeletedVersion {
                    version_id: version_id.to_owned(),
                    document_id: document_id.to_owned(),
                });
            }
            return Err(HistoryRepositoryError::DeletePending);
        }

        let (deleted, version_exists, referenced) = self.store.with_mutation(|mutation| {
            let result =
                self.store
                    .with_transaction(|transaction| -> Result<_, rusqlite::Error> {
                        let version_exists = transaction
                            .query_row(
                                "SELECT 1 FROM history_versions
                         WHERE id = ?1 AND document_id = ?2",
                                rusqlite::params![version_id, document_id],
                                |_| Ok(()),
                            )
                            .optional()?
                            .is_some();
                        let referenced = transaction
                            .query_row(
                                "SELECT 1 FROM history_operations
                         WHERE document_id = ?1
                           AND protection_version_id = ?2
                           AND state NOT IN ('completed', 'aborted', 'conflict')
                         LIMIT 1",
                                rusqlite::params![document_id, version_id],
                                |_| Ok(()),
                            )
                            .optional()?
                            .is_some();
                        if !version_exists || referenced {
                            return Ok((false, version_exists, referenced));
                        }

                        // The delete operation is completed atomically with the
                        // semantic row removal. A retry therefore returns the same
                        // result without deleting another record.
                        transaction.execute(
                            "INSERT INTO history_operations
                     (idempotency_id, document_id, session_generation, revision,
                      kind, prepared_target_identity, target_object_pins_json,
                      state, created_at, updated_at)
                     VALUES (?1, ?2, 0, 0, 'delete', ?3, '[]', 'completed', ?4, ?4)",
                            rusqlite::params![request_id, document_id, version_id, now],
                        )?;
                        transaction.execute(
                            "DELETE FROM history_versions WHERE id = ?1 AND document_id = ?2",
                            rusqlite::params![version_id, document_id],
                        )?;
                        Ok((true, true, false))
                    })?;
            if result.0 {
                mutation.remove_committed_version(version_id);
            }
            Ok::<_, HistoryStoreError>(result)
        })?;

        if !deleted {
            if referenced {
                return Err(HistoryRepositoryError::VersionInUse);
            }
            if !version_exists {
                return Err(HistoryRepositoryError::VersionNotFound {
                    document_id: document_id.to_owned(),
                    version_id: version_id.to_owned(),
                });
            }
            return Err(HistoryRepositoryError::DeletePending);
        }

        let deleted = DeletedVersion {
            version_id: version_id.to_owned(),
            document_id: document_id.to_owned(),
        };

        // Physical cleanup is best effort.  Reachability pins keep shared
        // objects alive; a cleanup failure leaves maintenance debt and does
        // not change the already committed semantic deletion.
        let _ = self.store.collect_garbage(
            std::time::SystemTime::now(),
            super::gc::DEFAULT_ORPHAN_GRACE,
        );
        Ok(deleted)
    }

    /// Remove every semantic history row for a document after the caller has
    /// committed the document's filesystem/Trash deletion. The identity row
    /// is retained in `deleting` state so a later same-path file cannot
    /// inherit this document's history. Object bytes remain reachable through
    /// other documents and all operation/hydration pins until GC can safely
    /// remove them.
    pub fn delete_document_history(
        &self,
        operation_id: &str,
        document_id: &str,
        now: i64,
    ) -> Result<DeletedDocumentHistory, HistoryRepositoryError> {
        validate_identifier(operation_id, "requestId")
            .map_err(HistoryRepositoryError::InvalidVersionId)?;
        validate_identifier(document_id, "documentId")
            .map_err(HistoryRepositoryError::InvalidDocumentId)?;
        // The document ID is already stored and checked on the operation row;
        // keep this marker bounded so it remains valid operation metadata.
        let target_marker = "document-history-delete";

        if let Some((existing_document, kind, target, state)) =
            self.store.with_connection(|connection| {
                connection
                    .query_row(
                        "SELECT document_id, kind, prepared_target_identity, state
                         FROM history_operations WHERE idempotency_id = ?1",
                        [operation_id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, Option<String>>(2)?,
                                row.get::<_, String>(3)?,
                            ))
                        },
                    )
                    .optional()
            })?
        {
            if existing_document != document_id
                || kind != "delete"
                || target.as_deref() != Some(target_marker)
            {
                return Err(HistoryRepositoryError::DeleteRequestConflict);
            }
            if state == "completed" {
                // A process may have stopped after the semantic transaction
                // committed but before its best-effort GC pass. Retrying the
                // same idempotent request is therefore also a safe chance to
                // surface or clear the independent maintenance outcome.
                return Ok(DeletedDocumentHistory {
                    document_id: document_id.to_owned(),
                    deleted_version_ids: Vec::new(),
                    gc: self.collect_gc_after_document_delete(document_id, now),
                });
            }
            return Err(HistoryRepositoryError::DeletePending);
        }

        let (deleted_version_ids, document_exists, pending_operation) =
            self.store.with_mutation(|mutation| {
                let result =
                    self.store
                        .with_transaction(|transaction| -> Result<_, rusqlite::Error> {
                            let document_exists = transaction
                                .query_row(
                                    "SELECT 1 FROM history_documents WHERE id = ?1",
                                    [document_id],
                                    |_| Ok(()),
                                )
                                .optional()?
                                .is_some();
                            if !document_exists {
                                return Ok((Vec::new(), false, false));
                            }

                            // Keep every semantic row needed to rebuild an
                            // incomplete operation pin after restart. The
                            // operation's protection_version_id may be the only
                            // durable path to its scene/assets once in-memory
                            // state is gone.
                            let pending_operation = transaction.query_row(
                                "SELECT EXISTS(
                                   SELECT 1 FROM history_operations
                                   WHERE document_id = ?1
                                     AND state NOT IN ('completed', 'aborted', 'conflict')
                                 )",
                                [document_id],
                                |row| row.get::<_, bool>(0),
                            )?;
                            if pending_operation {
                                return Ok((Vec::new(), true, true));
                            }

                            let mut statement = transaction.prepare(
                                "SELECT id FROM history_versions
                         WHERE document_id = ?1 ORDER BY recorded_at, sequence, id",
                            )?;
                            let deleted_version_ids = statement
                                .query_map([document_id], |row| row.get::<_, String>(0))?
                                .collect::<Result<Vec<_>, _>>()?;
                            drop(statement);

                            // This operation row is an audit/idempotency record. Its
                            // target marker is intentionally not a path, and its
                            // absence of object pins does not release any existing
                            // pins owned by other operations.
                            transaction.execute(
                                "INSERT INTO history_operations
                         (idempotency_id, document_id, session_generation, revision,
                          kind, prepared_target_identity, target_object_pins_json,
                          state, created_at, updated_at)
                         VALUES (?1, ?2, 0, 0, 'delete', ?3, '[]', 'completed', ?4, ?4)",
                                rusqlite::params![operation_id, document_id, target_marker, now],
                            )?;
                            transaction.execute(
                                "UPDATE history_documents SET state = 'deleting' WHERE id = ?1",
                                [document_id],
                            )?;
                            transaction.execute(
                                "DELETE FROM history_versions WHERE document_id = ?1",
                                [document_id],
                            )?;
                            Ok((deleted_version_ids, true, false))
                        })?;
                for version_id in &result.0 {
                    mutation.remove_committed_version(version_id);
                }
                Ok::<_, HistoryStoreError>(result)
            })?;

        if !document_exists {
            return Err(HistoryRepositoryError::DocumentNotFound(
                document_id.to_owned(),
            ));
        }
        if pending_operation {
            return Err(HistoryRepositoryError::DeletePending);
        }

        let gc = self.collect_gc_after_document_delete(document_id, now);
        Ok(DeletedDocumentHistory {
            document_id: document_id.to_owned(),
            deleted_version_ids,
            gc,
        })
    }

    fn collect_gc_after_document_delete(&self, document_id: &str, now: i64) -> HistoryGcStatus {
        let mut status = HistoryGcStatus::default();
        match self.store.collect_garbage(
            std::time::SystemTime::now(),
            super::gc::DEFAULT_ORPHAN_GRACE,
        ) {
            Ok(report) => {
                status.deleted_objects = report.deleted.len();
                status.retained_objects = report.retained.len();
                status.failures = report
                    .failures
                    .into_iter()
                    .map(|(object, error)| format!("{object:?}: {error}"))
                    .collect();
                if !status.failures.is_empty() {
                    let issue = format!(
                        "{} history object cleanup failure(s)",
                        status.failures.len()
                    );
                    if let Err(error) = self.store.record_maintenance_issue(
                        document_id,
                        "HISTORY_GC_FAILED",
                        "document-delete-gc",
                        now,
                    ) {
                        status.maintenance_record_error = Some(error.to_string());
                    }
                    status.error = Some(issue);
                } else if let Err(error) = self.store.with_connection(|connection| {
                    connection.execute(
                        "DELETE FROM maintenance_state
                         WHERE scope_key = ?1 AND issue_code = 'HISTORY_GC_FAILED'
                           AND last_phase = 'document-delete-gc'",
                        [format!("document:{document_id}")],
                    )?;
                    Ok(())
                }) {
                    status.maintenance_record_error = Some(error.to_string());
                }
            }
            Err(error) => {
                status.error = Some(error.to_string());
                if let Err(record_error) = self.store.record_maintenance_issue(
                    document_id,
                    "HISTORY_GC_FAILED",
                    "document-delete-gc",
                    now,
                ) {
                    status.maintenance_record_error = Some(record_error.to_string());
                }
            }
        }
        status
    }

    /// Write an immutable scene object, then publish its metadata and version
    /// row. The version transaction owns the object metadata insert and the
    /// retention delete, so any metadata failure rolls both back together.
    pub fn publish_scene(
        &self,
        request: PublishSceneRequest,
    ) -> Result<PublishedVersion, HistoryRepositoryError> {
        let scene = self
            .store
            .put_scene(&request.scene_bytes, request.schema_version)?;
        self.publish(request.into_version_request(scene))
    }

    pub fn publish_scene_with_assets(
        &self,
        request: PublishSceneRequest,
        assets: Vec<PublishAsset>,
    ) -> Result<PublishedVersion, HistoryRepositoryError> {
        let scene = self
            .store
            .put_scene(&request.scene_bytes, request.schema_version)?;
        let asset_objects = assets
            .iter()
            .map(|asset| {
                self.store
                    .put_asset(&asset.bytes, &asset.mime_type)
                    .map(|object| (asset.file_id.clone(), object))
            })
            .collect::<Result<Vec<_>, _>>()?;
        self.publish_with_assets(request.into_version_request(scene), asset_objects)
    }

    /// Publish metadata for an already-written immutable scene object.
    pub fn publish(
        &self,
        request: PublishVersionRequest,
    ) -> Result<PublishedVersion, HistoryRepositoryError> {
        self.publish_with_assets(request, Vec::new())
    }

    fn publish_with_assets(
        &self,
        request: PublishVersionRequest,
        asset_objects: Vec<(String, super::objects::StoredAssetObject)>,
    ) -> Result<PublishedVersion, HistoryRepositoryError> {
        validate_request(&request)?;
        let sequence = i64::try_from(request.sequence)
            .map_err(|_| HistoryRepositoryError::SequenceOverflow(request.sequence))?;
        let source = source_sql(request.source);
        let protected_action = request.protected_action.map(protected_action_sql);

        let evicted_version_ids = self.store.with_mutation(|mutation| {
            self.store
                .objects()
                .verify_scene(&request.scene)
                .map_err(HistoryStoreError::from)?;
            let (evicted_version_ids, references) = self.store.with_transaction(|transaction| {
                transaction.execute(
                "INSERT INTO scene_objects
                 (hash, schema_version, codec, raw_length, relative_path, created_at)
                 VALUES (?1, ?2, 'none', ?3, ?4, ?5)
                 ON CONFLICT(hash) DO NOTHING",
                rusqlite::params![
                    &request.scene.hash,
                    request.scene.schema_version,
                    request.scene.raw_length,
                    &request.scene.relative_path,
                    request.recorded_at,
                ],
            )?;

            let metadata_matches: bool = transaction.query_row(
                "SELECT schema_version, codec, raw_length, relative_path
                 FROM scene_objects WHERE hash = ?1",
                [&request.scene.hash],
                |row| {
                    Ok(row.get::<_, i64>(0)? == request.scene.schema_version
                        && row.get::<_, String>(1)? == "none"
                        && row.get::<_, i64>(2)? == request.scene.raw_length
                        && row.get::<_, String>(3)? == request.scene.relative_path)
                },
            )?;
            if !metadata_matches {
                return Err(HistoryStoreError::ObjectMetadataMismatch {
                    hash: request.scene.hash.clone(),
                });
            }

            for (_, asset) in &asset_objects {
                transaction.execute(
                    "INSERT INTO asset_objects
                     (hash, byte_length, mime_type, relative_path, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(hash) DO NOTHING",
                    rusqlite::params![
                        &asset.hash,
                        asset.byte_length,
                        &asset.mime_type,
                        &asset.relative_path,
                        request.recorded_at,
                    ],
                )?;
            }

                transaction.execute(
                "INSERT INTO history_versions
                 (id, document_id, scene_hash, source, marked, protected_action, recorded_at, sequence)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    &request.version_id,
                    &request.document_id,
                    &request.scene.hash,
                    source,
                    request.source == HistoryVersionSource::Manual,
                    protected_action,
                    request.recorded_at,
                    sequence,
                ],
            )?;

                if request.source == HistoryVersionSource::Automatic {
                    transaction.execute(
                        "UPDATE history_documents SET last_automatic_at = ?2 WHERE id = ?1",
                        rusqlite::params![&request.document_id, request.recorded_at],
                    )?;
                }

                for (file_id, asset) in &asset_objects {
                    transaction.execute(
                        "INSERT INTO version_assets
                         (version_id, sdk_file_id, asset_hash, mime_type, byte_length)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        rusqlite::params![
                            &request.version_id,
                            file_id,
                            &asset.hash,
                            &asset.mime_type,
                            asset.byte_length,
                        ],
                    )?;
                }

                let mut objects = vec![ObjectKey::scene(request.scene.hash.clone())?];
                let mut asset_statement = transaction.prepare(
                    "SELECT asset_hash FROM version_assets WHERE version_id = ?1 ORDER BY sdk_file_id",
                )?;
                for row in asset_statement.query_map([&request.version_id], |row| row.get::<_, String>(0))? {
                    objects.push(ObjectKey::asset(row?)?);
                }
                let references = ObjectReferences::from_objects(objects);

                if request.source == HistoryVersionSource::Manual {
                    return Ok((Vec::new(), references));
                }
                let evicted = prune_unmarked(transaction, &request.document_id)?;
                Ok((evicted, references))
            })?;
            mutation.set_committed_version(request.version_id.clone(), references);
            for version_id in &evicted_version_ids {
                mutation.remove_committed_version(version_id);
            }
            Ok(evicted_version_ids)
        })?;

        #[cfg(feature = "e2e-harness")]
        crate::e2e_harness::history_fault_barrier_from_environment(
            crate::e2e_harness::HistoryFaultStage::EvictionDeleteGc,
        )
        .map_err(HistoryRepositoryError::FaultInjected)?;

        Ok(PublishedVersion {
            version_id: request.version_id,
            document_id: request.document_id,
            scene_hash: request.scene.hash,
            source: request.source,
            protected_action: request.protected_action,
            recorded_at: request.recorded_at,
            sequence: request.sequence,
            evicted_version_ids,
        })
    }
}

fn prune_unmarked(
    transaction: &rusqlite::Transaction<'_>,
    document_id: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let mut statement = transaction.prepare(
        "SELECT candidate.id FROM (
             SELECT id, document_id FROM history_versions
             WHERE document_id = ?1 AND marked = 0
             ORDER BY recorded_at DESC, sequence DESC, id DESC
             LIMIT -1 OFFSET ?2
         ) AS candidate
         WHERE NOT EXISTS (
             SELECT 1 FROM history_operations operation
             WHERE operation.document_id = candidate.document_id
               AND operation.protection_version_id = candidate.id
               AND operation.state NOT IN ('completed', 'aborted', 'conflict')
         )",
    )?;
    let evicted = statement
        .query_map(
            rusqlite::params![document_id, RETAINED_VERSION_LIMIT],
            |row| row.get::<_, String>(0),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for version_id in &evicted {
        transaction.execute(
            "DELETE FROM history_versions WHERE document_id = ?1 AND id = ?2 AND marked = 0",
            rusqlite::params![document_id, version_id],
        )?;
    }
    Ok(evicted)
}

fn validate_request(request: &PublishVersionRequest) -> Result<(), HistoryRepositoryError> {
    validate_identifier(&request.version_id, "versionId")
        .map_err(HistoryRepositoryError::InvalidVersionId)?;
    validate_identifier(&request.document_id, "documentId")
        .map_err(HistoryRepositoryError::InvalidDocumentId)?;
    match (request.source, request.protected_action) {
        (HistoryVersionSource::Protected, Some(_)) => Ok(()),
        (HistoryVersionSource::Protected, None) => {
            Err(HistoryRepositoryError::MissingProtectedAction)
        }
        (HistoryVersionSource::Automatic | HistoryVersionSource::Manual, Some(_)) => {
            Err(HistoryRepositoryError::UnexpectedProtectedAction)
        }
        (HistoryVersionSource::Automatic | HistoryVersionSource::Manual, None) => Ok(()),
    }
}

fn source_sql(source: HistoryVersionSource) -> &'static str {
    match source {
        HistoryVersionSource::Automatic => "automatic",
        HistoryVersionSource::Manual => "manual",
        HistoryVersionSource::Protected => "protected",
    }
}

fn protected_action_sql(action: HistoryProtectedAction) -> &'static str {
    match action {
        HistoryProtectedAction::Restore => "restore",
        HistoryProtectedAction::Clear => "clear",
        HistoryProtectedAction::Import => "import",
    }
}

#[cfg(test)]
mod compile_tests {
    use super::{HistoryRepository, PublishSceneRequest};

    // Keep the public construction path exercised when this module is wired
    // into history/mod.rs; behavior lives in repository_test.rs.
    #[allow(dead_code)]
    fn _repository_type_is_constructible(
        store: &super::super::store::HistoryStore,
        request: PublishSceneRequest,
    ) {
        let repository = HistoryRepository::new(store);
        let _ = repository.publish_scene(request);
    }
}
