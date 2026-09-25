//! Serialized history metadata store.
//!
//! `HistoryStore` owns a database connection for one history root.  The
//! connection is guarded by one mutex so all metadata writes are serialized;
//! callers that need async behavior must run these blocking operations on the
//! existing blocking-work boundary.  No hot-tier database initializer is used.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{Duration, SystemTime},
};

#[cfg(all(feature = "e2e-harness", not(test)))]
use std::sync::OnceLock;

use rusqlite::{params, Connection};
use thiserror::Error;

use super::{
    gc::{
        GcCandidate, GcError, GcReport, ObjectKey, ObjectKind, ObjectReferences, ReachabilityGate,
    },
    objects::{ObjectStore, ObjectStoreError, StoredAssetObject, StoredSceneObject},
    schema::{self, SchemaError},
};

pub const HISTORY_DIRECTORY_NAME: &str = "version-history";
pub const HISTORY_DATABASE_NAME: &str = "history.sqlite3";
/// Completed replacement results remain GC roots for this period so a delayed
/// status replay can still hydrate the target scene/assets after the initial
/// IPC response was lost.  The current document remains authoritative after
/// expiry; this is only a bounded replay-retention window.
pub const COMPLETED_RESULT_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);

/// Typed SQLite commit failures exposed only to focused tests and the
/// test-only native harness.  The production store has no selector for these
/// failures; real I/O errors continue to use the existing `Sqlite` variant.
#[cfg(any(test, feature = "e2e-harness"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum HistoryStoreFault {
    #[error("disk full")]
    DiskFull,
    #[error("permission denied")]
    PermissionDenied,
    #[error("read-only filesystem")]
    ReadOnly,
}

#[cfg(test)]
thread_local! {
    static CONFIGURED_TRANSACTION_FAULT: std::cell::RefCell<Option<HistoryStoreFault>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(all(feature = "e2e-harness", not(test)))]
static CONFIGURED_TRANSACTION_FAULT: OnceLock<Mutex<Option<HistoryStoreFault>>> = OnceLock::new();

#[cfg(any(test, feature = "e2e-harness"))]
#[allow(dead_code, reason = "called by focused tests and the e2e harness")]
pub(crate) fn set_transaction_fault(fault: Option<HistoryStoreFault>) {
    #[cfg(test)]
    CONFIGURED_TRANSACTION_FAULT.with(|configured| configured.replace(fault));
    #[cfg(all(feature = "e2e-harness", not(test)))]
    {
        *configured_transaction_fault()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = fault;
    }
}

#[cfg(any(test, feature = "e2e-harness"))]
#[allow(dead_code, reason = "called by focused tests and the e2e harness")]
pub(crate) fn clear_transaction_fault() {
    set_transaction_fault(None);
}

#[cfg(all(feature = "e2e-harness", not(test)))]
fn configured_transaction_fault() -> &'static Mutex<Option<HistoryStoreFault>> {
    CONFIGURED_TRANSACTION_FAULT.get_or_init(|| Mutex::new(None))
}

#[cfg(any(test, feature = "e2e-harness"))]
fn take_transaction_fault() -> Option<HistoryStoreFault> {
    #[cfg(test)]
    return CONFIGURED_TRANSACTION_FAULT.with(|configured| configured.take());
    #[cfg(all(feature = "e2e-harness", not(test)))]
    configured_transaction_fault()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
}

#[derive(Debug, Error)]
pub enum HistoryStoreError {
    #[error("failed to create history directory at {path}: {source}")]
    CreateDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to open history database at {path}: {source}")]
    OpenDatabase {
        path: PathBuf,
        #[source]
        source: rusqlite::Error,
    },
    #[error("history schema initialization failed: {0}")]
    Schema(#[from] SchemaError),
    #[error("history object store failed: {0}")]
    Objects(#[from] ObjectStoreError),
    #[error("history database lock is poisoned")]
    LockPoisoned,
    #[error("history reachability gate failed: {0}")]
    Gc(#[from] GcError),
    #[error("history object enumeration failed at {path}: {source}")]
    EnumerateObjects {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("history metadata operation failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("metadata for immutable object {hash} does not match the persisted object")]
    ObjectMetadataMismatch { hash: String },
    #[cfg(any(test, feature = "e2e-harness"))]
    #[error("history transaction fault injected: {0}")]
    InjectedTransactionFault(HistoryStoreFault),
    #[cfg(feature = "e2e-harness")]
    #[error("history fault barrier failed: {0}")]
    FaultInjected(String),
}

/// The SQLite connection and object store for one `<app-data>/version-history`
/// directory.  The mutex is the single serialization boundary for metadata
/// writes and reads that must be consistent with a transaction.
pub struct HistoryStore {
    version_history_root: PathBuf,
    database_path: PathBuf,
    objects: ObjectStore,
    connection: Mutex<Connection>,
    reachability: ReachabilityGate,
}

impl HistoryStore {
    /// Open the history store below an application data directory.
    pub fn open(app_data_directory: &Path) -> Result<Self, HistoryStoreError> {
        Self::open_version_history_root(&app_data_directory.join(HISTORY_DIRECTORY_NAME))
    }

    /// Open the store at an explicit version-history root.  This is useful for
    /// tests and keeps the production path construction in `open`.
    pub fn open_version_history_root(root: &Path) -> Result<Self, HistoryStoreError> {
        std::fs::create_dir_all(root).map_err(|source| HistoryStoreError::CreateDirectory {
            path: root.to_path_buf(),
            source,
        })?;
        let objects = ObjectStore::new(root)?;
        let database_path = root.join(HISTORY_DATABASE_NAME);
        let mut connection =
            Connection::open(&database_path).map_err(|source| HistoryStoreError::OpenDatabase {
                path: database_path.clone(),
                source,
            })?;
        schema::initialize(&mut connection)?;
        let store = Self {
            version_history_root: root.to_path_buf(),
            database_path,
            objects,
            connection: Mutex::new(connection),
            reachability: ReachabilityGate::new(),
        };
        store.rehydrate_committed_references()?;
        store.rehydrate_incomplete_operation_pins()?;
        store.rehydrate_recent_completed_operation_pins(SystemTime::now())?;
        Ok(store)
    }

    pub fn version_history_root(&self) -> &Path {
        &self.version_history_root
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    pub fn objects(&self) -> &ObjectStore {
        &self.objects
    }

    pub fn reachability(&self) -> &ReachabilityGate {
        &self.reachability
    }

    pub fn put_scene(
        &self,
        bytes: &[u8],
        schema_version: i64,
    ) -> Result<StoredSceneObject, HistoryStoreError> {
        let object = self.objects.put_scene(bytes, schema_version)?;
        #[cfg(feature = "e2e-harness")]
        crate::e2e_harness::history_fault_barrier_from_environment(
            crate::e2e_harness::HistoryFaultStage::ObjectPublish,
        )
        .map_err(HistoryStoreError::FaultInjected)?;
        Ok(object)
    }

    pub fn put_asset(
        &self,
        bytes: &[u8],
        mime_type: &str,
    ) -> Result<StoredAssetObject, HistoryStoreError> {
        let object = self.objects.put_asset(bytes, mime_type)?;
        #[cfg(feature = "e2e-harness")]
        crate::e2e_harness::history_fault_barrier_from_environment(
            crate::e2e_harness::HistoryFaultStage::ObjectPublish,
        )
        .map_err(HistoryStoreError::FaultInjected)?;
        Ok(object)
    }

    /// Publish scene metadata only after the immutable scene bytes have been
    /// written, re-read and hash-verified by `ObjectStore`.
    pub fn register_scene_object(
        &self,
        object: &StoredSceneObject,
        created_at: i64,
    ) -> Result<(), HistoryStoreError> {
        self.with_mutation(|mutation| {
            self.objects.verify_scene(object)?;
            self.with_transaction(|transaction| {
                let inserted = transaction.execute(
                    "INSERT INTO scene_objects
                 (hash, schema_version, codec, raw_length, relative_path, created_at)
                 VALUES (?1, ?2, 'none', ?3, ?4, ?5)
                 ON CONFLICT(hash) DO NOTHING",
                    params![
                        object.hash,
                        object.schema_version,
                        object.raw_length,
                        object.relative_path,
                        created_at
                    ],
                )?;
                if inserted == 0 {
                    let matches: bool = transaction.query_row(
                        "SELECT schema_version, codec, raw_length, relative_path
                     FROM scene_objects WHERE hash=?1",
                        [&object.hash],
                        |row| {
                            Ok(row.get::<_, i64>(0)? == object.schema_version
                                && row.get::<_, String>(1)? == "none"
                                && row.get::<_, i64>(2)? == object.raw_length
                                && row.get::<_, String>(3)? == object.relative_path)
                        },
                    )?;
                    if !matches {
                        return Err(HistoryStoreError::ObjectMetadataMismatch {
                            hash: object.hash.clone(),
                        });
                    }
                }
                Ok(())
            })?;
            mutation.mark_registered(&ObjectKey::scene(object.hash.clone())?);
            Ok(())
        })
    }

    /// Publish asset metadata only after the immutable asset bytes have been
    /// written, re-read and hash-verified by `ObjectStore`.
    pub fn register_asset_object(
        &self,
        object: &StoredAssetObject,
        created_at: i64,
    ) -> Result<(), HistoryStoreError> {
        self.with_mutation(|mutation| {
            self.objects.verify_asset(object)?;
            self.with_transaction(|transaction| {
                let inserted = transaction.execute(
                    "INSERT INTO asset_objects
                 (hash, byte_length, mime_type, relative_path, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(hash) DO NOTHING",
                    params![
                        object.hash,
                        object.byte_length,
                        object.mime_type,
                        object.relative_path,
                        created_at
                    ],
                )?;
                if inserted == 0 {
                    let matches: bool = transaction.query_row(
                        "SELECT byte_length, mime_type, relative_path
                     FROM asset_objects WHERE hash=?1",
                        [&object.hash],
                        |row| {
                            Ok(row.get::<_, i64>(0)? == object.byte_length
                                && row.get::<_, String>(1)? == object.mime_type
                                && row.get::<_, String>(2)? == object.relative_path)
                        },
                    )?;
                    if !matches {
                        return Err(HistoryStoreError::ObjectMetadataMismatch {
                            hash: object.hash.clone(),
                        });
                    }
                }
                Ok(())
            })?;
            mutation.mark_registered(&ObjectKey::asset(object.hash.clone())?);
            Ok(())
        })
    }

    /// Write and register a scene in that order.  This helper is intentionally
    /// small; version publication will later add its version/reference rows in
    /// one transaction using the same primitives.
    pub fn persist_scene(
        &self,
        bytes: &[u8],
        schema_version: i64,
        created_at: i64,
    ) -> Result<StoredSceneObject, HistoryStoreError> {
        let object = self.put_scene(bytes, schema_version)?;
        self.register_scene_object(&object, created_at)?;
        Ok(object)
    }

    pub fn persist_asset(
        &self,
        bytes: &[u8],
        mime_type: &str,
        created_at: i64,
    ) -> Result<StoredAssetObject, HistoryStoreError> {
        let object = self.put_asset(bytes, mime_type)?;
        self.register_asset_object(&object, created_at)?;
        Ok(object)
    }

    /// Run one operation while holding the serialized connection boundary.
    /// The closure may perform reads or writes, but a write should use
    /// `with_transaction` when multiple statements must become visible
    /// atomically.
    pub fn with_connection<T, F>(&self, operation: F) -> Result<T, HistoryStoreError>
    where
        F: FnOnce(&mut Connection) -> Result<T, rusqlite::Error>,
    {
        let mut connection = self.lock_connection()?;
        Ok(operation(&mut connection)?)
    }

    pub fn with_transaction<T, E, F>(&self, operation: F) -> Result<T, HistoryStoreError>
    where
        E: Into<HistoryStoreError>,
        F: FnOnce(&rusqlite::Transaction<'_>) -> Result<T, E>,
    {
        let mut connection = self.lock_connection()?;
        let transaction = connection.transaction()?;
        let result = operation(&transaction).map_err(Into::into)?;
        #[cfg(any(test, feature = "e2e-harness"))]
        if let Some(fault) = take_transaction_fault() {
            // Returning before `commit` deliberately drops the transaction;
            // rusqlite rolls back the callback's successful writes.
            return Err(HistoryStoreError::InjectedTransactionFault(fault));
        }
        transaction.commit()?;
        Ok(result)
    }

    /// Run a metadata/object publication operation under the same gate as
    /// history GC. The callback must perform object verification before its
    /// transaction and update committed references before returning.
    pub fn with_mutation<T, F>(&self, operation: F) -> Result<T, HistoryStoreError>
    where
        F: FnOnce(&mut super::gc::ReachabilityMutation<'_>) -> Result<T, HistoryStoreError>,
    {
        self.reachability.with_mutation(operation)
    }

    /// Enumerate both registered objects and orphan candidates. Invalid
    /// filenames are ignored and retained for maintenance inspection; this
    /// method never turns an untrusted path into a deletion target.
    pub fn enumerate_object_candidates(&self) -> Result<Vec<GcCandidate>, HistoryStoreError> {
        let registered = self.registered_objects()?;
        let mut candidates = Vec::new();
        for (kind, directory, extension) in [
            (
                ObjectKind::Scene,
                self.version_history_root.join("objects/scenes"),
                "json",
            ),
            (
                ObjectKind::Asset,
                self.version_history_root.join("objects/assets"),
                "bin",
            ),
        ] {
            enumerate_object_directory(&directory, kind, extension, &registered, &mut candidates)?;
        }
        Ok(candidates)
    }

    /// Collect unreachable immutable objects using the production object
    /// paths. Bytes are re-verified before deletion, and the gate remains held
    /// throughout enumeration-driven deletion.
    pub fn collect_garbage(
        &self,
        now: SystemTime,
        grace: Duration,
    ) -> Result<GcReport<String>, HistoryStoreError> {
        self.expire_completed_operation_pins(now)?;
        let candidates = self.enumerate_object_candidates()?;
        self.reachability
            .collect(candidates, now, grace, |object| {
                let path = match object.kind {
                    ObjectKind::Scene => self
                        .objects
                        .read_scene(&object.hash)
                        .map(|_| self.objects.scene_path(&object.hash)),
                    ObjectKind::Asset => self
                        .objects
                        .read_asset(&object.hash)
                        .map(|_| self.objects.asset_path(&object.hash)),
                }
                .map_err(|error| error.to_string())?
                .map_err(|error| error.to_string())?;
                fs::remove_file(&path).map_err(|error| {
                    format!(
                        "failed to delete history object {}: {error}",
                        path.display()
                    )
                })
            })
            .map_err(HistoryStoreError::Gc)
    }

    fn registered_objects(&self) -> Result<BTreeSet<ObjectKey>, HistoryStoreError> {
        self.with_connection(|connection| {
            let mut objects = BTreeSet::new();
            let mut scenes = connection.prepare("SELECT hash FROM scene_objects")?;
            for row in scenes.query_map([], |row| row.get::<_, String>(0))? {
                let hash = row?;
                if let Ok(object) = ObjectKey::scene(hash) {
                    objects.insert(object);
                }
            }
            let mut assets = connection.prepare("SELECT hash FROM asset_objects")?;
            for row in assets.query_map([], |row| row.get::<_, String>(0))? {
                let hash = row?;
                if let Ok(object) = ObjectKey::asset(hash) {
                    objects.insert(object);
                }
            }
            Ok(objects)
        })
    }

    fn rehydrate_committed_references(&self) -> Result<(), HistoryStoreError> {
        let references = self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, scene_hash FROM history_versions ORDER BY id",
            )?;
            let mut versions = BTreeMap::<String, ObjectReferences>::new();
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (version_id, scene_hash) = row?;
                versions.insert(
                    version_id,
                    ObjectReferences::from_objects([ObjectKey::scene(scene_hash)
                        .map_err(|_| rusqlite::Error::InvalidQuery)?]),
                );
            }
            let mut assets = connection.prepare(
                "SELECT version_id, asset_hash FROM version_assets ORDER BY version_id, sdk_file_id",
            )?;
            let rows = assets.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (version_id, asset_hash) = row?;
                if let Some(reference) = versions.get_mut(&version_id) {
                    let mut objects = reference.iter().cloned().collect::<BTreeSet<_>>();
                    objects.insert(ObjectKey::asset(asset_hash).map_err(|_| rusqlite::Error::InvalidQuery)?);
                    *reference = ObjectReferences::from_objects(objects);
                }
            }
            Ok(versions)
        })?;
        self.reachability.with_mutation(|mutation| {
            for (version_id, reference) in references {
                mutation.set_committed_version(version_id, reference);
            }
            Ok::<(), GcError>(())
        })?;
        Ok(())
    }

    fn rehydrate_incomplete_operation_pins(&self) -> Result<(), HistoryStoreError> {
        let rows = self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT idempotency_id, protection_version_id, target_scene_hash,
                        CASE WHEN target_object_pins_json IS NULL
                                  OR (target_object_pins_json = '[]'
                                      AND target_manifest_hash LIKE 'history-operation-metadata:v1:%')
                             THEN target_manifest_hash ELSE target_object_pins_json END
                 FROM history_operations
                 WHERE state NOT IN ('completed', 'aborted', 'conflict')
                 ORDER BY updated_at, idempotency_id",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        for (operation_id, protection_version_id, target_scene_hash, metadata) in rows {
            let mut objects = Vec::new();
            if let Some(scene_hash) = target_scene_hash {
                objects.push(ObjectKey::scene(scene_hash)?);
            }
            if let Some(version_id) = protection_version_id {
                let refs = self.version_references(&version_id)?;
                objects.extend(refs.iter().cloned());
            }
            objects.extend(parse_operation_pins(metadata.as_deref())?);
            self.reachability
                .restore_operation_pin(operation_id, ObjectReferences::from_objects(objects))?;
        }
        Ok(())
    }

    fn rehydrate_recent_completed_operation_pins(
        &self,
        now: SystemTime,
    ) -> Result<(), HistoryStoreError> {
        let now = unix_seconds(now)?;
        let cutoff = now.saturating_sub(COMPLETED_RESULT_RETENTION.as_secs() as i64);
        let rows = self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT idempotency_id, target_scene_hash,
                        CASE WHEN target_object_pins_json IS NULL
                                  OR (target_object_pins_json = '[]'
                                      AND target_manifest_hash LIKE 'history-operation-metadata:v1:%')
                             THEN target_manifest_hash ELSE target_object_pins_json END
                 FROM history_operations
                 WHERE state = 'completed' AND updated_at >= ?1
                 ORDER BY updated_at, idempotency_id",
            )?;
            let rows = statement
                .query_map([cutoff], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        for (operation_id, target_scene_hash, pins) in rows {
            let mut objects = Vec::new();
            if let Some(scene_hash) = target_scene_hash {
                objects.push(ObjectKey::scene(scene_hash)?);
            }
            objects.extend(parse_operation_pins(pins.as_deref())?);
            self.reachability
                .restore_operation_pin(operation_id, ObjectReferences::from_objects(objects))?;
        }
        Ok(())
    }

    fn expire_completed_operation_pins(&self, now: SystemTime) -> Result<(), HistoryStoreError> {
        let now = unix_seconds(now)?;
        let cutoff = now.saturating_sub(COMPLETED_RESULT_RETENTION.as_secs() as i64);
        let operation_ids = self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT idempotency_id FROM history_operations
                 WHERE state = 'completed' AND updated_at < ?1",
            )?;
            let rows = statement
                .query_map([cutoff], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        for operation_id in operation_ids {
            match self.reachability.release_operation_pin(&operation_id) {
                Ok(()) | Err(GcError::PinNotActive(_)) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    fn version_references(&self, version_id: &str) -> Result<ObjectReferences, HistoryStoreError> {
        self.with_connection(|connection| {
            let scene_hash = connection
                .query_row(
                    "SELECT scene_hash FROM history_versions WHERE id = ?1",
                    [version_id],
                    |row| row.get::<_, String>(0),
                )
                .ok();
            let mut objects = Vec::new();
            if let Some(scene_hash) = scene_hash {
                objects
                    .push(ObjectKey::scene(scene_hash).map_err(|_| rusqlite::Error::InvalidQuery)?);
            }
            let mut statement = connection.prepare(
                "SELECT asset_hash FROM version_assets WHERE version_id = ?1 ORDER BY sdk_file_id",
            )?;
            for row in statement.query_map([version_id], |row| row.get::<_, String>(0))? {
                objects.push(ObjectKey::asset(row?).map_err(|_| rusqlite::Error::InvalidQuery)?);
            }
            Ok(ObjectReferences::from_objects(objects))
        })
    }

    fn lock_connection(&self) -> Result<MutexGuard<'_, Connection>, HistoryStoreError> {
        self.connection
            .lock()
            .map_err(|_| HistoryStoreError::LockPoisoned)
    }
}

fn enumerate_object_directory(
    directory: &Path,
    kind: ObjectKind,
    extension: &str,
    registered: &BTreeSet<ObjectKey>,
    candidates: &mut Vec<GcCandidate>,
) -> Result<(), HistoryStoreError> {
    let prefixes = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(source) => {
            return Err(HistoryStoreError::EnumerateObjects {
                path: directory.to_path_buf(),
                source,
            })
        }
    };
    for prefix in prefixes {
        let prefix = prefix.map_err(|source| HistoryStoreError::EnumerateObjects {
            path: directory.to_path_buf(),
            source,
        })?;
        let prefix_path = prefix.path();
        if !prefix_path.is_dir() {
            continue;
        }
        for entry in
            fs::read_dir(&prefix_path).map_err(|source| HistoryStoreError::EnumerateObjects {
                path: prefix_path.clone(),
                source,
            })?
        {
            let entry = entry.map_err(|source| HistoryStoreError::EnumerateObjects {
                path: prefix_path.clone(),
                source,
            })?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some(extension) {
                continue;
            }
            let Some(hash) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            let Ok(object) = ObjectKey::new(kind, hash.to_owned()) else {
                continue;
            };
            let metadata =
                fs::metadata(&path).map_err(|source| HistoryStoreError::EnumerateObjects {
                    path: path.clone(),
                    source,
                })?;
            let created_at = metadata
                .modified()
                .or_else(|_| metadata.created())
                .unwrap_or(SystemTime::UNIX_EPOCH);
            candidates.push(if registered.contains(&object) {
                GcCandidate::registered(object, created_at)
            } else {
                GcCandidate::unregistered(object, created_at)
            });
        }
    }
    Ok(())
}

const OPERATION_METADATA_PREFIX: &str = "history-operation-metadata:v1:";

fn parse_operation_pins(raw: Option<&str>) -> Result<Vec<ObjectKey>, HistoryStoreError> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    let json = raw.strip_prefix(OPERATION_METADATA_PREFIX).unwrap_or(raw);
    let value: serde_json::Value = serde_json::from_str(json).map_err(|error| {
        HistoryStoreError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(error)))
    })?;
    let pins = value
        .get("target_object_pins")
        .and_then(serde_json::Value::as_array)
        .or_else(|| value.as_array())
        .ok_or_else(|| HistoryStoreError::Sqlite(rusqlite::Error::InvalidQuery))?;
    let mut objects = Vec::with_capacity(pins.len());
    for pin in pins {
        let Some(kind) = pin.get("kind").and_then(serde_json::Value::as_str) else {
            return Err(HistoryStoreError::Sqlite(rusqlite::Error::InvalidQuery));
        };
        let Some(hash) = pin.get("hash").and_then(serde_json::Value::as_str) else {
            return Err(HistoryStoreError::Sqlite(rusqlite::Error::InvalidQuery));
        };
        let object = match kind {
            "scene" => ObjectKey::scene(hash.to_owned()),
            "asset" => ObjectKey::asset(hash.to_owned()),
            _ => Err(GcError::InvalidHash),
        }?;
        objects.push(object);
    }
    Ok(objects)
}

fn unix_seconds(time: SystemTime) -> Result<i64, HistoryStoreError> {
    time.duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().min(i64::MAX as u64) as i64)
        .map_err(|_| HistoryStoreError::Sqlite(rusqlite::Error::InvalidQuery))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn fixture() -> (PathBuf, HistoryStore) {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-history-store-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        let store = HistoryStore::open_version_history_root(&root)
            .unwrap_or_else(|error| panic!("open history store: {error}"));
        (root, store)
    }

    #[test]
    fn opens_an_independent_history_database_with_required_pragmas() {
        let (root, store) = fixture();
        assert_eq!(store.database_path(), root.join("history.sqlite3"));
        assert!(store.database_path().is_file());
        let (journal_mode, synchronous, foreign_keys): (String, i64, i64) = store
            .with_connection(|connection| {
                Ok((
                    connection.pragma_query_value(None, "journal_mode", |row| row.get(0))?,
                    connection.pragma_query_value(None, "synchronous", |row| row.get(0))?,
                    connection.pragma_query_value(None, "foreign_keys", |row| row.get(0))?,
                ))
            })
            .unwrap_or_else(|error| panic!("read history pragmas: {error}"));
        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        assert_eq!(synchronous, 2);
        assert_eq!(foreign_keys, 1);
        drop(store);
        fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }

    #[test]
    fn persists_objects_before_registering_metadata() {
        let (root, store) = fixture();
        let object = store
            .persist_scene(b"scene bytes", 1, 10)
            .unwrap_or_else(|error| panic!("persist scene: {error}"));
        let row: (String, i64, String, i64) = store
            .with_connection(|connection| {
                connection.query_row(
                    "SELECT hash, schema_version, codec, raw_length FROM scene_objects",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
            })
            .unwrap_or_else(|error| panic!("read scene metadata: {error}"));
        assert_eq!(row, (object.hash, 1, "none".to_owned(), 11));
        drop(store);
        fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }

    #[test]
    fn foreign_keys_prevent_versions_from_referencing_missing_documents() {
        let (root, store) = fixture();
        let result = store.with_connection(|connection| {
            connection.execute(
                "INSERT INTO history_versions
                 (id, document_id, scene_hash, source, recorded_at, sequence)
                 VALUES ('v', 'missing', 'missing-scene', 'automatic', 1, 1)",
                [],
            )
        });
        assert!(result.is_err());
        drop(store);
        fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }

    #[test]
    fn injected_commit_failures_roll_back_callback_rows_and_clear_for_recovery() {
        struct FaultReset;
        impl Drop for FaultReset {
            fn drop(&mut self) {
                clear_transaction_fault();
            }
        }

        let _fault_reset = FaultReset;
        let (root, store) = fixture();
        for (index, fault) in [
            HistoryStoreFault::DiskFull,
            HistoryStoreFault::PermissionDenied,
            HistoryStoreFault::ReadOnly,
        ]
        .into_iter()
        .enumerate()
        {
            let document_id = format!("fault-document-{index}");
            set_transaction_fault(Some(fault));
            let result = store.with_transaction(|transaction| {
                transaction.execute(
                    "INSERT INTO history_documents
                     (id, canonical_path, created_at, state)
                     VALUES (?1, ?2, 1, 'active')",
                    rusqlite::params![&document_id, format!("/{document_id}.excalidraw")],
                )?;
                Ok::<_, rusqlite::Error>(())
            });
            clear_transaction_fault();

            assert!(matches!(
                result,
                Err(HistoryStoreError::InjectedTransactionFault(actual)) if actual == fault
            ));
            let rows: i64 = store
                .with_connection(|connection| {
                    connection.query_row(
                        "SELECT COUNT(*) FROM history_documents WHERE id = ?1",
                        [&document_id],
                        |row| row.get(0),
                    )
                })
                .unwrap_or_else(|error| panic!("check rolled-back row: {error}"));
            assert_eq!(rows, 0);
        }

        let recovered_id = "recovered-document";
        store
            .with_transaction(|transaction| {
                transaction.execute(
                    "INSERT INTO history_documents
                     (id, canonical_path, created_at, state)
                     VALUES (?1, ?2, 1, 'active')",
                    rusqlite::params![recovered_id, "/recovered-document.excalidraw"],
                )?;
                Ok::<_, rusqlite::Error>(())
            })
            .unwrap_or_else(|error| panic!("transaction recovery: {error}"));
        let rows: i64 = store
            .with_connection(|connection| {
                connection.query_row(
                    "SELECT COUNT(*) FROM history_documents WHERE id = ?1",
                    [recovered_id],
                    |row| row.get(0),
                )
            })
            .unwrap_or_else(|error| panic!("check recovered row: {error}"));
        assert_eq!(rows, 1);

        drop(store);
        fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }

    #[test]
    fn startup_rebuilds_committed_scene_and_asset_reachability() {
        let (root, store) = fixture();
        let scene = store
            .persist_scene(b"reachable scene", 1, 1)
            .unwrap_or_else(|error| panic!("persist scene: {error}"));
        let asset = store
            .persist_asset(b"reachable asset", "image/png", 1)
            .unwrap_or_else(|error| panic!("persist asset: {error}"));
        store
            .with_connection(|connection| {
                connection.execute(
                    "INSERT INTO history_documents
                     (id, canonical_path, created_at, state)
                     VALUES ('doc-reachability', '/tmp/reachability.excalidraw', 1, 'active')",
                    [],
                )?;
                connection.execute(
                    "INSERT INTO history_versions
                     (id, document_id, scene_hash, source, recorded_at, sequence)
                     VALUES ('version-reachability', 'doc-reachability', ?1, 'automatic', 1, 1)",
                    [&scene.hash],
                )?;
                connection.execute(
                    "INSERT INTO version_assets
                     (version_id, sdk_file_id, asset_hash, mime_type, byte_length)
                     VALUES ('version-reachability', 'file-1', ?1, 'image/png', ?2)",
                    rusqlite::params![&asset.hash, asset.byte_length],
                )?;
                Ok(())
            })
            .unwrap_or_else(|error| panic!("insert reachability metadata: {error}"));
        drop(store);

        let reopened = HistoryStore::open_version_history_root(&root)
            .unwrap_or_else(|error| panic!("reopen history store: {error}"));
        let live = reopened
            .reachability()
            .live_objects()
            .unwrap_or_else(|error| panic!("read rebuilt live set: {error}"));
        assert!(live.contains(&ObjectKey::scene(scene.hash).expect("scene hash")));
        assert!(live.contains(&ObjectKey::asset(asset.hash).expect("asset hash")));
        drop(reopened);
        fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }

    #[test]
    fn startup_rebuilds_incomplete_operation_scene_and_asset_pins() {
        let (root, store) = fixture();
        let scene = store
            .persist_scene(b"operation target", 1, 1)
            .unwrap_or_else(|error| panic!("persist operation scene: {error}"));
        let asset = store
            .persist_asset(b"operation asset", "image/png", 1)
            .unwrap_or_else(|error| panic!("persist operation asset: {error}"));
        store
            .with_connection(|connection| {
                connection.execute(
                    "INSERT INTO history_documents
                     (id, canonical_path, created_at, state)
                     VALUES ('doc-operation', '/tmp/operation.excalidraw', 1, 'active')",
                    [],
                )?;
                connection.execute(
                    "INSERT INTO history_operations
                     (idempotency_id, document_id, session_generation, revision, kind,
                      target_scene_hash, target_manifest_hash, state, created_at, updated_at)
                     VALUES ('operation-rehydrate', 'doc-operation', 1, 1, 'replace', ?1, ?2,
                             'intent_committed', 1, 1)",
                    rusqlite::params![
                        &scene.hash,
                        format!(
                            "history-operation-metadata:v1:{}",
                            serde_json::json!({
                                "target_manifest_hash": null,
                                "temp_file": null,
                                "target_object_pins": [{"kind": "asset", "hash": asset.hash}],
                            })
                        ),
                    ],
                )?;
                Ok(())
            })
            .unwrap_or_else(|error| panic!("insert operation metadata: {error}"));
        drop(store);

        let reopened = HistoryStore::open_version_history_root(&root)
            .unwrap_or_else(|error| panic!("reopen history store: {error}"));
        let live = reopened
            .reachability()
            .live_objects()
            .unwrap_or_else(|error| panic!("read rebuilt operation pins: {error}"));
        assert!(live.contains(&ObjectKey::scene(scene.hash).expect("scene hash")));
        assert!(live.contains(&ObjectKey::asset(asset.hash).expect("asset hash")));
        drop(reopened);
        fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }

    #[test]
    fn startup_rebuilds_recent_completed_result_roots_for_status_replay() {
        let (root, store) = fixture();
        let scene = store
            .persist_scene(b"completed target", 1, 1)
            .unwrap_or_else(|error| panic!("persist completed scene: {error}"));
        let asset = store
            .persist_asset(b"completed asset", "image/png", 1)
            .unwrap_or_else(|error| panic!("persist completed asset: {error}"));
        let now = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_secs() as i64;
        store
            .with_connection(|connection| {
                connection.execute(
                    "INSERT INTO history_documents
                     (id, canonical_path, created_at, state)
                     VALUES ('doc-completed', '/tmp/completed.excalidraw', ?1, 'active')",
                    [now],
                )?;
                connection.execute(
                    "INSERT INTO history_operations
                     (idempotency_id, document_id, session_generation, revision, kind,
                      target_scene_hash, target_object_pins_json, state, created_at, updated_at)
                     VALUES ('completed-replay', 'doc-completed', 1, 1, 'replace', ?1, ?2,
                             'completed', ?3, ?3)",
                    rusqlite::params![
                        &scene.hash,
                        serde_json::json!([{"kind":"asset","hash":asset.hash}]).to_string(),
                        now,
                    ],
                )?;
                Ok(())
            })
            .unwrap_or_else(|error| panic!("insert completed operation: {error}"));
        drop(store);

        let reopened = HistoryStore::open_version_history_root(&root)
            .unwrap_or_else(|error| panic!("reopen history store: {error}"));
        let live = reopened
            .reachability()
            .live_objects()
            .unwrap_or_else(|error| panic!("read completed result roots: {error}"));
        assert!(live.contains(&ObjectKey::scene(scene.hash).expect("scene hash")));
        assert!(live.contains(&ObjectKey::asset(asset.hash).expect("asset hash")));
        drop(reopened);
        fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }

    #[test]
    fn completed_result_roots_expire_before_gc_after_the_retention_ttl() {
        let (root, store) = fixture();
        let scene = store
            .persist_scene(b"expired completed target", 1, 1)
            .unwrap_or_else(|error| panic!("persist expired scene: {error}"));
        store
            .with_connection(|connection| {
                connection.execute(
                    "INSERT INTO history_documents
                     (id, canonical_path, created_at, state)
                     VALUES ('doc-expired', '/tmp/expired.excalidraw', 1, 'active')",
                    [],
                )?;
                connection.execute(
                    "INSERT INTO history_operations
                     (idempotency_id, document_id, session_generation, revision, kind,
                      target_scene_hash, state, created_at, updated_at)
                     VALUES ('completed-expired', 'doc-expired', 1, 1, 'replace', ?1,
                             'completed', 1, 1)",
                    [&scene.hash],
                )?;
                Ok(())
            })
            .unwrap_or_else(|error| panic!("insert expired operation: {error}"));
        store
            .reachability()
            .restore_operation_pin(
                "completed-expired",
                ObjectReferences::from_objects([
                    ObjectKey::scene(scene.hash.clone()).expect("scene hash")
                ]),
            )
            .expect("restore completed root");
        let now = SystemTime::now() + COMPLETED_RESULT_RETENTION + Duration::from_secs(1);
        let report = store
            .collect_garbage(now, Duration::from_secs(0))
            .unwrap_or_else(|error| panic!("collect expired completed root: {error}"));
        assert!(report
            .deleted
            .contains(&ObjectKey::scene(scene.hash.clone()).expect("scene hash")));
        assert!(!store
            .objects()
            .scene_path(&scene.hash)
            .expect("scene path")
            .exists());
        drop(store);
        fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }

    #[test]
    fn collect_garbage_enumerates_and_deletes_only_unreachable_verified_objects() {
        let (root, store) = fixture();
        let reachable = store
            .persist_scene(b"reachable", 1, 1)
            .unwrap_or_else(|error| panic!("persist reachable scene: {error}"));
        let orphan = store
            .persist_scene(b"orphan", 1, 1)
            .unwrap_or_else(|error| panic!("persist orphan scene: {error}"));
        store
            .with_connection(|connection| {
                connection.execute(
                    "INSERT INTO history_documents
                     (id, canonical_path, created_at, state)
                     VALUES ('doc-gc', '/tmp/gc.excalidraw', 1, 'active')",
                    [],
                )?;
                connection.execute(
                    "INSERT INTO history_versions
                     (id, document_id, scene_hash, source, recorded_at, sequence)
                     VALUES ('version-gc', 'doc-gc', ?1, 'automatic', 1, 1)",
                    [&reachable.hash],
                )?;
                Ok(())
            })
            .unwrap_or_else(|error| panic!("insert GC metadata: {error}"));
        store
            .reachability()
            .set_committed_version(
                "version-gc",
                ObjectReferences::from_objects([
                    ObjectKey::scene(reachable.hash.clone()).expect("reachable hash")
                ]),
            )
            .unwrap_or_else(|error| panic!("mark reachable object: {error}"));

        let report = store
            .collect_garbage(
                SystemTime::now() + Duration::from_secs(120),
                Duration::from_secs(0),
            )
            .unwrap_or_else(|error| panic!("collect history objects: {error}"));
        assert!(report
            .deleted
            .contains(&ObjectKey::scene(orphan.hash.clone()).expect("orphan hash")));
        assert!(report
            .retained
            .contains(&ObjectKey::scene(reachable.hash.clone()).expect("reachable hash")));
        assert!(!store
            .objects()
            .scene_path(&orphan.hash)
            .expect("orphan path")
            .exists());
        assert!(store
            .objects()
            .scene_path(&reachable.hash)
            .expect("reachable path")
            .exists());
        drop(store);
        fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }
}
