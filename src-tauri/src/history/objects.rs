//! Immutable, content-addressed history objects.
//!
//! Object publication is independent from SQLite metadata publication.  A
//! caller writes and validates the object through this module first, then
//! inserts the corresponding metadata inside a history transaction.  An
//! object that is never registered is therefore only an orphan candidate and
//! cannot make a version visible by itself.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

#[cfg(all(feature = "e2e-harness", not(test)))]
use std::sync::{Mutex, OnceLock};

use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use super::types::HISTORY_MAX_SCENE_BYTES;

const SCENES_DIRECTORY: &str = "objects/scenes";
const ASSETS_DIRECTORY: &str = "objects/assets";
const HASH_LENGTH: usize = 64;

#[cfg(any(test, feature = "e2e-harness"))]
const ENOSPC_OS_ERROR: i32 = 28;
#[cfg(any(test, feature = "e2e-harness"))]
const EACCES_OS_ERROR: i32 = 13;

/// Deterministic publication boundaries used only by focused tests and the
/// test-only native harness.  Production builds do not contain a selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ObjectStoreFaultPoint {
    BeforeTempWrite,
    AfterTempSync,
    BeforeHardLink,
}

#[cfg(any(test, feature = "e2e-harness"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code, reason = "selected by the e2e harness fault scenario")]
pub(crate) enum ObjectStoreFaultKind {
    DiskFull,
    PermissionDenied,
}

#[cfg(any(test, feature = "e2e-harness"))]
type ConfiguredFault = (ObjectStoreFaultPoint, ObjectStoreFaultKind);

#[cfg(test)]
thread_local! {
    static CONFIGURED_FAULT_POINT: std::cell::RefCell<Option<ConfiguredFault>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(all(feature = "e2e-harness", not(test)))]
static CONFIGURED_FAULT_POINT: OnceLock<Mutex<Option<ConfiguredFault>>> = OnceLock::new();

#[cfg(any(test, feature = "e2e-harness"))]
#[allow(dead_code, reason = "called by focused tests and the e2e harness")]
pub(crate) fn set_fault(point: ObjectStoreFaultPoint, kind: ObjectStoreFaultKind) {
    #[cfg(test)]
    CONFIGURED_FAULT_POINT.with(|configured| configured.replace(Some((point, kind))));
    #[cfg(all(feature = "e2e-harness", not(test)))]
    {
        *configured_fault_point()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((point, kind));
    }
}

#[cfg(any(test, feature = "e2e-harness"))]
#[allow(dead_code, reason = "called by focused tests and the e2e harness")]
pub(crate) fn set_fault_point(point: Option<ObjectStoreFaultPoint>) {
    match point {
        Some(point) => set_fault(point, ObjectStoreFaultKind::DiskFull),
        None => {
            #[cfg(test)]
            CONFIGURED_FAULT_POINT.with(|configured| configured.replace(None));
            #[cfg(all(feature = "e2e-harness", not(test)))]
            {
                *configured_fault_point()
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
            }
        }
    }
}

#[cfg(any(test, feature = "e2e-harness"))]
#[allow(dead_code, reason = "called by focused tests and the e2e harness")]
pub(crate) fn clear_fault_point() {
    set_fault_point(None);
}

#[cfg(all(feature = "e2e-harness", not(test)))]
fn configured_fault_point() -> &'static Mutex<Option<ConfiguredFault>> {
    CONFIGURED_FAULT_POINT.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Error)]
pub enum ObjectStoreError {
    #[error("object store root must be a directory: {0}")]
    InvalidRoot(PathBuf),
    #[error("object hash must be a lowercase SHA-256 digest")]
    InvalidHash,
    #[error("scene object must not be empty")]
    EmptyScene,
    #[error("scene object exceeds the maximum size of {maximum} bytes")]
    SceneTooLarge { maximum: usize },
    #[error("asset object exceeds the maximum size of {maximum} bytes")]
    AssetTooLarge { maximum: usize },
    #[error("scene schema version must be greater than zero")]
    InvalidSchemaVersion,
    #[error("MIME type must be non-empty and must not contain NUL")]
    InvalidMimeType,
    #[error("object relative path does not match its content-addressed location")]
    InvalidRelativePath,
    #[error("object length cannot be represented by SQLite: {0}")]
    LengthOverflow(usize),
    #[error("immutable object at {path} does not match its content hash")]
    ExistingObjectMismatch { path: PathBuf },
    #[error("object at {path} failed integrity verification")]
    IntegrityMismatch { path: PathBuf },
    #[error("failed to {operation} object at {path}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSceneObject {
    pub hash: String,
    pub schema_version: i64,
    pub raw_length: i64,
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredAssetObject {
    pub hash: String,
    pub byte_length: i64,
    pub mime_type: String,
    pub relative_path: String,
}

#[derive(Debug, Clone)]
pub struct ObjectStore {
    root: PathBuf,
}

impl ObjectStore {
    /// Create the history-private object directories below a
    /// `<app-data>/version-history` root.
    pub fn new(version_history_root: &Path) -> Result<Self, ObjectStoreError> {
        if version_history_root.exists() && !version_history_root.is_dir() {
            return Err(ObjectStoreError::InvalidRoot(
                version_history_root.to_path_buf(),
            ));
        }

        let store = Self {
            root: version_history_root.to_path_buf(),
        };
        for directory in [store.scene_directory(), store.asset_directory()] {
            fs::create_dir_all(&directory).map_err(|source| ObjectStoreError::Io {
                operation: "create object directory",
                path: directory,
                source,
            })?;
        }
        Ok(store)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn scene_path(&self, hash: &str) -> Result<PathBuf, ObjectStoreError> {
        validate_hash(hash)?;
        Ok(self
            .scene_directory()
            .join(&hash[..2])
            .join(format!("{hash}.json")))
    }

    pub fn asset_path(&self, hash: &str) -> Result<PathBuf, ObjectStoreError> {
        validate_hash(hash)?;
        Ok(self
            .asset_directory()
            .join(&hash[..2])
            .join(format!("{hash}.bin")))
    }

    pub fn scene_relative_path(hash: &str) -> Result<String, ObjectStoreError> {
        validate_hash(hash)?;
        Ok(format!("{SCENES_DIRECTORY}/{}/{hash}.json", &hash[..2]))
    }

    pub fn asset_relative_path(hash: &str) -> Result<String, ObjectStoreError> {
        validate_hash(hash)?;
        Ok(format!("{ASSETS_DIRECTORY}/{}/{hash}.bin", &hash[..2]))
    }

    /// Persist a complete scene object before its SQLite metadata is committed.
    pub fn put_scene(
        &self,
        bytes: &[u8],
        schema_version: i64,
    ) -> Result<StoredSceneObject, ObjectStoreError> {
        if bytes.is_empty() {
            return Err(ObjectStoreError::EmptyScene);
        }
        if bytes.len() > HISTORY_MAX_SCENE_BYTES {
            return Err(ObjectStoreError::SceneTooLarge {
                maximum: HISTORY_MAX_SCENE_BYTES,
            });
        }
        if schema_version <= 0 {
            return Err(ObjectStoreError::InvalidSchemaVersion);
        }
        let raw_length = i64::try_from(bytes.len())
            .map_err(|_| ObjectStoreError::LengthOverflow(bytes.len()))?;
        let hash = sha256_hex(bytes);
        let relative_path = Self::scene_relative_path(&hash)?;
        let path = self.scene_path(&hash)?;
        write_immutable(&path, bytes)?;
        Ok(StoredSceneObject {
            hash,
            schema_version,
            raw_length,
            relative_path,
        })
    }

    /// Persist an immutable image/object payload before its SQLite metadata is
    /// committed.  The MIME type is metadata, while the address is always
    /// derived from the bytes and never accepted from a caller.
    pub fn put_asset(
        &self,
        bytes: &[u8],
        mime_type: &str,
    ) -> Result<StoredAssetObject, ObjectStoreError> {
        if mime_type.is_empty() || mime_type.contains('\0') {
            return Err(ObjectStoreError::InvalidMimeType);
        }
        if bytes.len() > HISTORY_MAX_SCENE_BYTES {
            return Err(ObjectStoreError::AssetTooLarge {
                maximum: HISTORY_MAX_SCENE_BYTES,
            });
        }
        let byte_length = i64::try_from(bytes.len())
            .map_err(|_| ObjectStoreError::LengthOverflow(bytes.len()))?;
        let hash = sha256_hex(bytes);
        let path = self.asset_path(&hash)?;
        write_immutable(&path, bytes)?;
        Ok(StoredAssetObject {
            relative_path: Self::asset_relative_path(&hash)?,
            hash,
            byte_length,
            mime_type: mime_type.to_owned(),
        })
    }

    pub fn read_scene(&self, hash: &str) -> Result<Vec<u8>, ObjectStoreError> {
        let path = self.scene_path(hash)?;
        read_verified(&path, hash)
    }

    pub fn read_asset(&self, hash: &str) -> Result<Vec<u8>, ObjectStoreError> {
        let path = self.asset_path(hash)?;
        read_verified(&path, hash)
    }

    pub fn verify_scene(&self, object: &StoredSceneObject) -> Result<(), ObjectStoreError> {
        if object.schema_version <= 0 || object.raw_length < 0 {
            return Err(ObjectStoreError::IntegrityMismatch {
                path: self.scene_path(&object.hash)?,
            });
        }
        if object.relative_path != Self::scene_relative_path(&object.hash)? {
            return Err(ObjectStoreError::InvalidRelativePath);
        }
        let path = self.scene_path(&object.hash)?;
        let metadata = fs::metadata(&path).map_err(|source| ObjectStoreError::Io {
            operation: "stat scene object",
            path: path.clone(),
            source,
        })?;
        if metadata.len() != u64::try_from(object.raw_length).unwrap_or(u64::MAX) {
            return Err(ObjectStoreError::IntegrityMismatch { path });
        }
        let _ = read_verified(&path, &object.hash)?;
        Ok(())
    }

    pub fn verify_asset(&self, object: &StoredAssetObject) -> Result<(), ObjectStoreError> {
        if object.byte_length < 0 || object.mime_type.is_empty() || object.mime_type.contains('\0')
        {
            return Err(ObjectStoreError::IntegrityMismatch {
                path: self.asset_path(&object.hash)?,
            });
        }
        if object.relative_path != Self::asset_relative_path(&object.hash)? {
            return Err(ObjectStoreError::InvalidRelativePath);
        }
        let path = self.asset_path(&object.hash)?;
        let metadata = fs::metadata(&path).map_err(|source| ObjectStoreError::Io {
            operation: "stat asset object",
            path: path.clone(),
            source,
        })?;
        if metadata.len() != u64::try_from(object.byte_length).unwrap_or(u64::MAX) {
            return Err(ObjectStoreError::IntegrityMismatch { path });
        }
        let _ = read_verified(&path, &object.hash)?;
        Ok(())
    }

    fn scene_directory(&self) -> PathBuf {
        self.root.join(SCENES_DIRECTORY)
    }

    fn asset_directory(&self) -> PathBuf {
        self.root.join(ASSETS_DIRECTORY)
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn validate_hash(hash: &str) -> Result<(), ObjectStoreError> {
    if hash.len() != HASH_LENGTH
        || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        || hash.bytes().any(|byte| byte.is_ascii_uppercase())
    {
        return Err(ObjectStoreError::InvalidHash);
    }
    Ok(())
}

fn write_immutable(path: &Path, bytes: &[u8]) -> Result<(), ObjectStoreError> {
    if path.exists() {
        return verify_existing(path, bytes);
    }

    let parent = path.parent().ok_or_else(|| ObjectStoreError::Io {
        operation: "resolve object parent",
        path: path.to_path_buf(),
        source: io::Error::new(io::ErrorKind::InvalidInput, "object has no parent"),
    })?;
    fs::create_dir_all(parent).map_err(|source| ObjectStoreError::Io {
        operation: "create object prefix directory",
        path: parent.to_path_buf(),
        source,
    })?;

    let temp_path = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut temporary = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|source| ObjectStoreError::Io {
                operation: "create temporary object",
                path: temp_path.clone(),
                source,
            })?;
        inject_fault(ObjectStoreFaultPoint::BeforeTempWrite, &temp_path)?;
        temporary
            .write_all(bytes)
            .and_then(|_| temporary.flush())
            .and_then(|_| temporary.sync_all())
            .map_err(|source| ObjectStoreError::Io {
                operation: "write and sync temporary object",
                path: temp_path.clone(),
                source,
            })?;
        inject_fault(ObjectStoreFaultPoint::AfterTempSync, &temp_path)?;
        drop(temporary);
        // Re-read the synced inode before publication.  This makes the
        // write/validate/sync ordering explicit and protects metadata from a
        // short write that was not surfaced by the initial write call.
        let expected_hash = sha256_hex(bytes);
        let _ = read_verified(&temp_path, &expected_hash)?;

        // A hard link publishes the already-synced temporary inode without
        // replacing a concurrently-created object at the same content path.
        inject_fault(ObjectStoreFaultPoint::BeforeHardLink, path)?;
        match fs::hard_link(&temp_path, path) {
            Ok(()) => {
                fs::remove_file(&temp_path).map_err(|source| ObjectStoreError::Io {
                    operation: "remove temporary object",
                    path: temp_path.clone(),
                    source,
                })?;
                sync_directory(parent)?;
                if let Some(directory_parent) = parent.parent() {
                    // The first object under a prefix creates that prefix
                    // directory.  Sync its parent as well so the new
                    // directory entry is durable after a crash.
                    sync_directory(directory_parent)?;
                }
                Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let _ = fs::remove_file(&temp_path);
                verify_existing(path, bytes)
            }
            Err(source) => Err(ObjectStoreError::Io {
                operation: "publish immutable object",
                path: path.to_path_buf(),
                source,
            }),
        }
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn inject_fault(
    #[allow(unused_variables)] point: ObjectStoreFaultPoint,
    #[allow(unused_variables)] path: &Path,
) -> Result<(), ObjectStoreError> {
    #[cfg(any(test, feature = "e2e-harness"))]
    {
        #[cfg(test)]
        let configured = CONFIGURED_FAULT_POINT.with(|configured| *configured.borrow());
        #[cfg(all(feature = "e2e-harness", not(test)))]
        let configured = *configured_fault_point()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((configured_point, kind)) = configured {
            if configured_point != point {
                return Ok(());
            }
            return Err(ObjectStoreError::Io {
                operation: match point {
                    ObjectStoreFaultPoint::BeforeTempWrite => "write temporary object",
                    ObjectStoreFaultPoint::AfterTempSync => "sync temporary object",
                    ObjectStoreFaultPoint::BeforeHardLink => "publish immutable object",
                },
                path: path.to_path_buf(),
                source: io::Error::from_raw_os_error(match kind {
                    ObjectStoreFaultKind::DiskFull => ENOSPC_OS_ERROR,
                    ObjectStoreFaultKind::PermissionDenied => EACCES_OS_ERROR,
                }),
            });
        }
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), ObjectStoreError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| ObjectStoreError::Io {
            operation: "sync object directory",
            path: path.to_path_buf(),
            source,
        })
}

fn verify_existing(path: &Path, expected: &[u8]) -> Result<(), ObjectStoreError> {
    let mut actual = Vec::new();
    File::open(path)
        .and_then(|mut file| file.read_to_end(&mut actual))
        .map_err(|source| ObjectStoreError::Io {
            operation: "read existing object",
            path: path.to_path_buf(),
            source,
        })?;
    if actual == expected {
        Ok(())
    } else {
        Err(ObjectStoreError::ExistingObjectMismatch {
            path: path.to_path_buf(),
        })
    }
}

fn read_verified(path: &Path, expected_hash: &str) -> Result<Vec<u8>, ObjectStoreError> {
    let mut bytes = Vec::new();
    File::open(path)
        .and_then(|mut file| file.read_to_end(&mut bytes))
        .map_err(|source| ObjectStoreError::Io {
            operation: "read object",
            path: path.to_path_buf(),
            source,
        })?;
    if sha256_hex(&bytes) != expected_hash {
        return Err(ObjectStoreError::IntegrityMismatch {
            path: path.to_path_buf(),
        });
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture() -> (PathBuf, ObjectStore) {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-history-objects-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        let store = ObjectStore::new(&root).unwrap_or_else(|error| panic!("create store: {error}"));
        (root, store)
    }

    fn cleanup(root: &Path) {
        fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }

    #[test]
    fn scene_and_asset_objects_are_content_addressed_and_reused() {
        let (root, store) = fixture();
        let scene = store
            .put_scene(br#"{"elements":[],"appState":{}}"#, 1)
            .unwrap_or_else(|error| panic!("put scene: {error}"));
        let same_scene = store
            .put_scene(br#"{"elements":[],"appState":{}}"#, 1)
            .unwrap_or_else(|error| panic!("put same scene: {error}"));
        assert_eq!(scene, same_scene);
        assert_eq!(
            store.read_scene(&scene.hash).unwrap(),
            br#"{"elements":[],"appState":{}}"#
        );
        assert!(store.scene_path(&scene.hash).unwrap().is_file());

        let asset = store
            .put_asset(b"png bytes", "image/png")
            .unwrap_or_else(|error| panic!("put asset: {error}"));
        assert_eq!(store.read_asset(&asset.hash).unwrap(), b"png bytes");
        assert!(store.asset_path(&asset.hash).unwrap().is_file());
        cleanup(&root);
    }

    #[test]
    fn object_reads_fail_closed_when_bytes_are_corrupted() {
        let (root, store) = fixture();
        let scene = store
            .put_scene(b"original", 1)
            .unwrap_or_else(|error| panic!("put scene: {error}"));
        fs::write(store.scene_path(&scene.hash).unwrap(), b"corrupt")
            .unwrap_or_else(|error| panic!("corrupt fixture: {error}"));
        assert!(matches!(
            store.read_scene(&scene.hash),
            Err(ObjectStoreError::IntegrityMismatch { .. })
        ));
        cleanup(&root);
    }

    #[test]
    fn injected_object_publish_failures_remove_the_temporary_inode() {
        struct FaultReset;
        impl Drop for FaultReset {
            fn drop(&mut self) {
                clear_fault_point();
            }
        }

        let _fault_reset = FaultReset;
        let (root, store) = fixture();
        let bytes = br#"{"elements":[{"id":"fault"}]}"#;
        let object_path = store
            .scene_path(&sha256_hex(bytes))
            .unwrap_or_else(|error| panic!("resolve object path: {error}"));
        let parent = object_path
            .parent()
            .unwrap_or_else(|| panic!("object parent missing"));

        for point in [
            ObjectStoreFaultPoint::BeforeTempWrite,
            ObjectStoreFaultPoint::AfterTempSync,
            ObjectStoreFaultPoint::BeforeHardLink,
        ] {
            for (kind, expected_os_error) in [
                (ObjectStoreFaultKind::DiskFull, ENOSPC_OS_ERROR),
                (ObjectStoreFaultKind::PermissionDenied, EACCES_OS_ERROR),
            ] {
                set_fault(point, kind);
                let result = store.put_scene(bytes, 1);
                clear_fault_point();

                match result {
                    Err(ObjectStoreError::Io { source, .. }) => {
                        assert_eq!(source.raw_os_error(), Some(expected_os_error));
                    }
                    other => panic!("expected injected {kind:?} at {point:?}, got {other:?}"),
                }
                let entries = fs::read_dir(parent)
                    .unwrap_or_else(|error| panic!("read object parent: {error}"));
                assert!(entries
                    .flatten()
                    .all(|entry| { !entry.file_name().to_string_lossy().ends_with(".tmp") }));
                assert!(!object_path.exists());
            }
        }

        store
            .put_scene(bytes, 1)
            .unwrap_or_else(|error| panic!("publish after clearing fault: {error}"));
        assert!(object_path.is_file());
        cleanup(&root);
    }
}
