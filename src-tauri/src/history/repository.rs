//! Transactional publication and retention for history versions.
//!
//! Immutable scene bytes are written and verified before the metadata
//! transaction starts.  The transaction then makes the object metadata and
//! semantic version visible together and applies retention only after the new
//! row has been inserted.  This keeps a failed publication from evicting an
//! older version.

use thiserror::Error;

use super::{
    gc::{ObjectKey, ObjectReferences},
    objects::StoredSceneObject,
    store::{HistoryStore, HistoryStoreError},
    types::{
        validate_identifier, HistoryProtectedAction, HistoryValidationError, HistoryVersionSource,
    },
};

/// The number of automatic and protected semantic records retained per
/// document. Manual records are outside this pool.
pub const RETAINED_VERSION_LIMIT: i64 = 20;

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

    /// Publish metadata for an already-written immutable scene object.
    pub fn publish(
        &self,
        request: PublishVersionRequest,
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

                transaction.execute(
                "INSERT INTO history_versions
                 (id, document_id, scene_hash, source, protected_action, recorded_at, sequence)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    &request.version_id,
                    &request.document_id,
                    &request.scene.hash,
                    source,
                    protected_action,
                    request.recorded_at,
                    sequence,
                ],
            )?;

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

                let mut statement = transaction.prepare(
                "SELECT id
                 FROM history_versions
                 WHERE document_id = ?1 AND source IN ('automatic', 'protected')
                 ORDER BY recorded_at DESC, sequence DESC, id DESC
                 LIMIT -1 OFFSET ?2",
            )?;
                let evicted = statement
                .query_map(
                    rusqlite::params![&request.document_id, RETAINED_VERSION_LIMIT],
                    |row| row.get::<_, String>(0),
                )?
                .collect::<Result<Vec<_>, _>>()?;
                drop(statement);

                for version_id in &evicted {
                    transaction.execute(
                    "DELETE FROM history_versions
                     WHERE document_id = ?1 AND id = ?2
                       AND source IN ('automatic', 'protected')",
                    rusqlite::params![&request.document_id, version_id],
                    )?;
                }
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
