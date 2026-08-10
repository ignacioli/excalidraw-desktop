//! Content-addressed image asset deduplication (US7, FR-024, R12).
//!
//! The app's internal storage format keeps each `files` entry's `dataURL` as
//! the small internal reference `asset://<sha256hex>` instead of the full
//! base64 payload. The bytes live once on disk under the workspace
//! `.excalidraw_assets/<sha256>` directory, so reusing the same image (for
//! example pasting it ten times, SC-011) stores one physical copy. Targets
//! that must be official-format self-contained (Save As, recovery Save As)
//! re-embed the bytes into base64 `dataURL`s before writing.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

use super::atomic_write::{atomic_write_bytes, AtomicWriteError};

pub const ASSET_DIRECTORY_NAME: &str = ".excalidraw_assets";
pub const ASSET_REFERENCE_PREFIX: &str = "asset://";
/// Unreferenced asset files younger than this are never removed, so a
/// document that is being deleted, renamed, or conflict-resolved does not lose
/// images it still needs during the same session.
pub const ORPHAN_GRACE_PERIOD: Duration = Duration::from_secs(24 * 60 * 60);
const HASH_LENGTH: usize = 64;

#[derive(Debug, Error)]
pub enum AssetStoreError {
    #[error("asset scene is not valid JSON: {0}")]
    InvalidSceneJson(#[from] serde_json::Error),
    #[error("failed to {operation} asset path {path}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("atomic asset write failed for {path}: {source}")]
    AtomicWrite {
        path: PathBuf,
        #[source]
        source: AtomicWriteError,
    },
    #[error("asset reference is invalid: {0}")]
    InvalidReference(String),
    #[error("asset file referenced by {reference} is missing: {path}")]
    AssetNotFound { reference: String, path: PathBuf },
    #[error("SHA-256 collision for asset file {path}: existing bytes differ from the new payload")]
    HashCollision { path: PathBuf },
}

impl From<AtomicWriteError> for AssetStoreError {
    fn from(error: AtomicWriteError) -> Self {
        match error {
            AtomicWriteError::Io {
                operation,
                path,
                source,
            } => AssetStoreError::Io {
                operation,
                path,
                source,
            },
            other => AssetStoreError::AtomicWrite {
                path: PathBuf::from("<asset>"),
                source: other,
            },
        }
    }
}

impl From<AssetStoreError> for crate::commands::error::AppError {
    fn from(error: AssetStoreError) -> Self {
        match error {
            AssetStoreError::InvalidSceneJson(source) => Self::InvalidScene(source.to_string()),
            AssetStoreError::InvalidReference(reference) => {
                Self::InvalidScene(format!("invalid asset reference: {reference}"))
            }
            AssetStoreError::AssetNotFound { path, .. } => Self::FileNotFound(path),
            AssetStoreError::HashCollision { path } => Self::Internal(format!(
                "SHA-256 collision for asset file {}",
                path.display()
            )),
            AssetStoreError::Io { path, source, .. } => Self::Io {
                path: Some(path),
                source,
            },
            AssetStoreError::AtomicWrite { path, source } => Self::Internal(format!(
                "atomic asset write failed for {}: {source}",
                path.display()
            )),
        }
    }
}

/// Converts an asset-store error into the shared IPC error category. Kept
/// next to the domain module so command layers do not re-implement mapping.
pub fn asset_garbage_error(error: AssetStoreError) -> crate::commands::error::AppError {
    crate::commands::error::AppError::from(error)
}

/// Absolute directory that holds the asset store for a document. Inside a
/// mounted workspace this is `<workspace root>/.excalidraw_assets`; documents
/// opened outside a workspace keep their assets next to the document so the
/// references remain resolvable by both externalize and reembed.
pub fn asset_root_for(document_path: &Path, workspace_root: Option<&Path>) -> PathBuf {
    workspace_root
        .map(Path::to_path_buf)
        .unwrap_or_else(|| normalized_parent(document_path).to_path_buf())
}

pub fn assets_dir(workspace_root: &Path) -> PathBuf {
    workspace_root.join(ASSET_DIRECTORY_NAME)
}

pub fn is_asset_reference(data_url: &str) -> bool {
    data_url.starts_with(ASSET_REFERENCE_PREFIX)
}

pub fn reference_for_hash(hash: &str) -> String {
    format!("{ASSET_REFERENCE_PREFIX}{hash}")
}

pub fn hash_from_reference(reference: &str) -> Option<&str> {
    let hash = reference.strip_prefix(ASSET_REFERENCE_PREFIX)?;
    is_hex_hash(hash).then_some(hash)
}

pub fn is_hex_hash(value: &str) -> bool {
    value.len() == HASH_LENGTH && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Replaces base64 data-URL payloads in `files` with `asset://<hash>`
/// references and publishes the bytes once under `.excalidraw_assets`.
/// Idempotent: entries that are already internal references pass through, and
/// non-base64 data URLs (for example percent-encoded SVG) are left untouched.
/// When nothing changes, the original scene string is returned byte-for-byte.
pub fn externalize_files(
    scene_json: &str,
    workspace_root: &Path,
) -> Result<String, AssetStoreError> {
    let mut scene: Value = serde_json::from_str(scene_json)?;
    let files = match scene.get_mut("files") {
        Some(Value::Object(files)) => files,
        _ => return Ok(scene_json.to_owned()),
    };
    if files.is_empty() {
        return Ok(scene_json.to_owned());
    }

    let directory = assets_dir(workspace_root);
    let mut changed = false;
    for entry in files.values_mut() {
        let object = match entry.as_object_mut() {
            Some(object) => object,
            None => continue,
        };
        let data_url = match object.get("dataURL").and_then(Value::as_str) {
            Some(data_url) => data_url,
            None => continue,
        };
        if is_asset_reference(data_url) {
            continue;
        }
        let Some(bytes) = decode_base64_data_url(data_url) else {
            continue;
        };
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let target = directory.join(&hash);
        ensure_asset_file(&directory, &target, &bytes)?;
        object.insert(
            "dataURL".to_owned(),
            Value::String(reference_for_hash(&hash)),
        );
        changed = true;
    }

    if changed {
        Ok(serde_json::to_string(&scene)?)
    } else {
        Ok(scene_json.to_owned())
    }
}

/// Restores official-format base64 `dataURL`s for every `asset://<hash>`
/// reference, producing a self-contained scene for external targets.
/// Scenes without references are returned unchanged.
pub fn reembed_files(scene_json: &str, workspace_root: &Path) -> Result<String, AssetStoreError> {
    let mut scene: Value = serde_json::from_str(scene_json)?;
    let files = match scene.get_mut("files") {
        Some(Value::Object(files)) => files,
        _ => return Ok(scene_json.to_owned()),
    };
    if files.is_empty() {
        return Ok(scene_json.to_owned());
    }

    let mut changed = false;
    for entry in files.values_mut() {
        let object = match entry.as_object_mut() {
            Some(object) => object,
            None => continue,
        };
        let data_url = match object.get("dataURL").and_then(Value::as_str) {
            Some(data_url) => data_url,
            None => continue,
        };
        if !is_asset_reference(data_url) {
            continue;
        }
        let hash = hash_from_reference(data_url)
            .ok_or_else(|| AssetStoreError::InvalidReference(data_url.to_owned()))?;
        let path = assets_dir(workspace_root).join(hash);
        let bytes = fs::read(&path).map_err(|source| {
            if source.kind() == std::io::ErrorKind::NotFound {
                AssetStoreError::AssetNotFound {
                    reference: data_url.to_owned(),
                    path,
                }
            } else {
                AssetStoreError::Io {
                    operation: "read asset file",
                    path,
                    source,
                }
            }
        })?;
        let mime_type = object
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("application/octet-stream");
        object.insert(
            "dataURL".to_owned(),
            Value::String(format!(
                "data:{mime_type};base64,{}",
                STANDARD.encode(&bytes)
            )),
        );
        changed = true;
    }

    if changed {
        Ok(serde_json::to_string(&scene)?)
    } else {
        Ok(scene_json.to_owned())
    }
}

/// Extracts the `asset://` hashes referenced by a scene. Callers computing the
/// live reference set for garbage collection use this per document and merge
/// the results across the workspace.
pub fn collect_referenced_hashes(scene_json: &str) -> HashSet<String> {
    let mut hashes = HashSet::new();
    let Ok(scene) = serde_json::from_str::<Value>(scene_json) else {
        return hashes;
    };
    let Some(files) = scene.get("files").and_then(Value::as_object) else {
        return hashes;
    };
    for entry in files.values() {
        let Some(data_url) = entry.get("dataURL").and_then(Value::as_str) else {
            continue;
        };
        if let Some(hash) = hash_from_reference(data_url) {
            hashes.insert(hash.to_owned());
        }
    }
    hashes
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct GarbageCollectionSummary {
    pub scanned: usize,
    pub removed: usize,
    pub skipped_referenced: usize,
    pub skipped_recent: usize,
}

/// Delayed orphan cleanup: removes asset files that are (a) not referenced by
/// `referenced_hashes`, (b) older than the grace period, and (c) shaped like
/// one of our hashes, so foreign files are never touched. Missing directories
/// are a normal no-op, not an error.
pub fn collect_garbage(
    workspace_root: &Path,
    referenced_hashes: &HashSet<String>,
) -> Result<GarbageCollectionSummary, AssetStoreError> {
    let directory = assets_dir(workspace_root);
    let mut summary = GarbageCollectionSummary::default();
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(summary),
        Err(source) => {
            return Err(AssetStoreError::Io {
                operation: "read assets directory",
                path: directory,
                source,
            })
        }
    };

    let now = SystemTime::now();
    for entry in entries {
        let entry = entry.map_err(|source| AssetStoreError::Io {
            operation: "read asset directory entry",
            path: directory.clone(),
            source,
        })?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if !is_hex_hash(file_name) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        summary.scanned += 1;
        if referenced_hashes.contains(file_name) {
            summary.skipped_referenced += 1;
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            summary.skipped_recent += 1;
            continue;
        };
        match now.duration_since(modified) {
            Ok(age) if age >= ORPHAN_GRACE_PERIOD => {
                fs::remove_file(entry.path()).map_err(|source| AssetStoreError::Io {
                    operation: "remove orphan asset",
                    path: entry.path(),
                    source,
                })?;
                summary.removed += 1;
            }
            _ => summary.skipped_recent += 1,
        }
    }
    Ok(summary)
}

/// Scans every supported drawing file under a workspace and merges the
/// `asset://` hashes it references. Used by the delete/remove paths to compute
/// the live reference set before garbage collection; a missing or unreadable
/// workspace is treated as an empty set so collection is never fatal.
pub fn scan_referenced_hashes(workspace_root: &Path) -> HashSet<String> {
    let mut referenced = HashSet::new();
    let mut stack = vec![workspace_root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries {
            let Ok(entry) = entry else {
                continue;
            };
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            let file_type = metadata.file_type();
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if !file_type.is_file() || !is_supported_scene_path(&path) {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else {
                continue;
            };
            let Ok(scene) = String::from_utf8(bytes) else {
                continue;
            };
            referenced.extend(collect_referenced_hashes(&scene));
        }
    }
    referenced
}

fn is_supported_scene_path(path: &Path) -> bool {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("excalidraw") => true,
        Some("json") => path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(".excalidraw.json")),
        _ => false,
    }
}

fn ensure_asset_file(directory: &Path, target: &Path, bytes: &[u8]) -> Result<(), AssetStoreError> {
    fs::create_dir_all(directory).map_err(|source| AssetStoreError::Io {
        operation: "create assets directory",
        path: directory.to_path_buf(),
        source,
    })?;
    match fs::read(target) {
        Ok(existing) if existing == bytes => return Ok(()),
        Ok(_) => {
            return Err(AssetStoreError::HashCollision {
                path: target.to_path_buf(),
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(source) => {
            return Err(AssetStoreError::Io {
                operation: "read existing asset",
                path: target.to_path_buf(),
                source,
            })
        }
    }
    atomic_write_bytes(target, bytes).map_err(AssetStoreError::from)
}

fn decode_base64_data_url(data_url: &str) -> Option<Vec<u8>> {
    let rest = data_url.strip_prefix("data:")?;
    let (metadata, payload) = rest.split_once(',')?;
    if !metadata
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        return None;
    }
    let compact: String = payload
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect();
    STANDARD.decode(compact.as_bytes()).ok()
}

fn normalized_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}
