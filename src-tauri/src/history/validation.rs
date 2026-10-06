//! Validation for immutable version-history scene and image objects.
//!
//! History objects are a separate persistence boundary from the current
//! document/draft store.  This module deliberately validates both the object
//! metadata and the bytes before a record can become visible.  In particular,
//! a valid JSON scene with a missing or corrupt image is not a valid history
//! version.

use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
};

use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{
    commands::error::{AppError, IpcError},
    documents::validation::{validate_scene as validate_document_scene, SceneValidationError},
};

use super::types::{
    HistoryVersionAvailability, HISTORY_HASH_HEX_LENGTH, HISTORY_MAX_IDENTIFIER_LENGTH,
    HISTORY_MAX_SCENE_BYTES,
};

/// History object payloads use the existing document scene limit.  The limit
/// applies before JSON decoding; callers must not treat a small encoded value
/// as permission to allocate unbounded decoded resources.
pub const HISTORY_MAX_DECODED_RESOURCE_BYTES: usize = HISTORY_MAX_SCENE_BYTES;
pub const HISTORY_OBJECT_CODEC: &str = "none";
pub const HISTORY_OBJECT_SCHEMA_VERSION: u32 = 1;
const MAX_MIME_TYPE_LENGTH: usize = 127;

/// Metadata persisted for an immutable scene object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneObjectMetadata {
    pub schema_version: u32,
    pub codec: String,
    pub raw_length: u64,
    pub sha256: String,
    pub relative_path: PathBuf,
}

/// Metadata persisted for an immutable image object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetObjectMetadata {
    pub sha256: String,
    pub byte_length: u64,
    pub mime_type: String,
    pub relative_path: PathBuf,
}

/// An image object supplied when a scene is validated or hydrated.
///
/// The bytes are borrowed so validation never creates a second copy of a
/// potentially large image payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetObject<'a> {
    pub file_id: String,
    pub metadata: AssetObjectMetadata,
    pub bytes: &'a [u8],
}

/// A validated file reference extracted from a history scene.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedImageReference {
    pub file_id: String,
    pub asset_hash: String,
    pub mime_type: String,
}

/// The parsed scene and its image reachability map.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedScene {
    pub value: Value,
    pub sha256: String,
    pub image_files: BTreeMap<String, ValidatedImageReference>,
}

/// Typed errors for history object corruption or invalid publication input.
///
/// These errors are intentionally separate from request/input validation in
/// `history::types`: callers can map this error to an unavailable list item
/// while leaving other history records usable.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum HistoryObjectValidationError {
    #[error("scene is {actual_bytes} bytes, exceeding the {maximum_bytes} byte history limit")]
    SceneTooLarge {
        actual_bytes: usize,
        maximum_bytes: usize,
    },
    #[error("scene object raw length is {declared}, but payload has {actual} bytes")]
    SceneLengthMismatch { declared: u64, actual: u64 },
    #[error("scene object SHA-256 does not match its payload")]
    SceneDigestMismatch { expected: String, actual: String },
    #[error("scene object metadata is invalid: {0}")]
    InvalidSceneMetadata(String),
    #[error("scene is not a valid history scene: {0}")]
    InvalidScene(String),
    #[error("scene contains an invalid image reference: {0}")]
    InvalidImageReference(String),
    #[error("asset object metadata is invalid for {file_id}: {reason}")]
    InvalidAssetMetadata { file_id: String, reason: String },
    #[error("asset {file_id} is {actual_bytes} bytes, exceeding the {maximum_bytes} byte limit")]
    AssetTooLarge {
        file_id: String,
        actual_bytes: usize,
        maximum_bytes: usize,
    },
    #[error("decoded history assets total {actual_bytes} bytes, exceeding the {maximum_bytes} byte limit")]
    DecodedResourcesTooLarge {
        actual_bytes: usize,
        maximum_bytes: usize,
    },
    #[error("asset {file_id} length is {declared}, but payload has {actual} bytes")]
    AssetLengthMismatch {
        file_id: String,
        declared: u64,
        actual: u64,
    },
    #[error("asset {file_id} SHA-256 does not match its payload")]
    AssetDigestMismatch {
        file_id: String,
        expected: String,
        actual: String,
    },
    #[error("asset {file_id} has invalid image bytes for MIME type {mime_type}")]
    InvalidImageBytes { file_id: String, mime_type: String },
    #[error("scene requires image asset {file_id} ({asset_hash}), but it is unavailable")]
    MissingAsset { file_id: String, asset_hash: String },
    #[error(
        "scene file {file_id} references asset hash {scene_hash}, but the object has {object_hash}"
    )]
    AssetReferenceMismatch {
        file_id: String,
        scene_hash: String,
        object_hash: String,
    },
    #[error("duplicate asset object for file {0}")]
    DuplicateAsset(String),
}

impl HistoryObjectValidationError {
    /// Convert a resource failure into the stable typed error used by an
    /// unavailable history list item.  Details remain local to logs/tests;
    /// the IPC error carries only the safe category.
    pub fn unavailable_ipc_error(&self) -> IpcError {
        AppError::HistoryResourceMissing(self.kind().to_owned()).into_ipc()
    }

    pub fn unavailable(&self) -> HistoryVersionAvailability {
        HistoryVersionAvailability::Unavailable {
            error: self.unavailable_ipc_error(),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::SceneTooLarge { .. }
            | Self::AssetTooLarge { .. }
            | Self::DecodedResourcesTooLarge { .. } => "resource_too_large",
            Self::SceneLengthMismatch { .. }
            | Self::SceneDigestMismatch { .. }
            | Self::InvalidSceneMetadata(_)
            | Self::InvalidScene(_)
            | Self::InvalidImageReference(_)
            | Self::InvalidAssetMetadata { .. }
            | Self::AssetLengthMismatch { .. }
            | Self::AssetDigestMismatch { .. }
            | Self::InvalidImageBytes { .. }
            | Self::AssetReferenceMismatch { .. }
            | Self::DuplicateAsset(_) => "resource_corrupt",
            Self::MissingAsset { .. } => "resource_missing",
        }
    }
}

/// Validate an immutable scene object using the existing document scene
/// validator and the history object's metadata rules.
pub fn validate_scene_object(
    bytes: &[u8],
    metadata: &SceneObjectMetadata,
) -> Result<ValidatedScene, HistoryObjectValidationError> {
    validate_scene_object_with_limits(bytes, metadata, HISTORY_MAX_SCENE_BYTES)
}

fn validate_scene_object_with_limits(
    bytes: &[u8],
    metadata: &SceneObjectMetadata,
    maximum_scene_bytes: usize,
) -> Result<ValidatedScene, HistoryObjectValidationError> {
    validate_scene_metadata(metadata)?;
    if bytes.len() > maximum_scene_bytes {
        return Err(HistoryObjectValidationError::SceneTooLarge {
            actual_bytes: bytes.len(),
            maximum_bytes: maximum_scene_bytes,
        });
    }
    let actual_length = bytes.len() as u64;
    if metadata.raw_length != actual_length {
        return Err(HistoryObjectValidationError::SceneLengthMismatch {
            declared: metadata.raw_length,
            actual: actual_length,
        });
    }

    let actual_hash = sha256_hex(bytes);
    if metadata.sha256 != actual_hash {
        return Err(HistoryObjectValidationError::SceneDigestMismatch {
            expected: metadata.sha256.clone(),
            actual: actual_hash,
        });
    }

    let scene = validate_document_scene(bytes, maximum_scene_bytes).map_err(map_scene_error)?;
    let image_files = collect_image_files(&scene)?;
    Ok(ValidatedScene {
        value: scene,
        sha256: metadata.sha256.clone(),
        image_files,
    })
}

/// Validate a scene and every supplied asset before making the version
/// visible.  Every `files` entry is checked, and every image reference must
/// have a matching object; a missing image is therefore an error rather than
/// an empty/partially hydrated scene.
pub fn validate_scene_and_assets(
    scene_bytes: &[u8],
    scene_metadata: &SceneObjectMetadata,
    assets: &[AssetObject<'_>],
) -> Result<ValidatedScene, HistoryObjectValidationError> {
    validate_scene_and_assets_with_limits(
        scene_bytes,
        scene_metadata,
        assets,
        HISTORY_MAX_SCENE_BYTES,
        HISTORY_MAX_DECODED_RESOURCE_BYTES,
    )
}

fn validate_scene_and_assets_with_limits(
    scene_bytes: &[u8],
    scene_metadata: &SceneObjectMetadata,
    assets: &[AssetObject<'_>],
    maximum_scene_bytes: usize,
    maximum_decoded_resource_bytes: usize,
) -> Result<ValidatedScene, HistoryObjectValidationError> {
    let scene =
        validate_scene_object_with_limits(scene_bytes, scene_metadata, maximum_scene_bytes)?;
    let mut by_file_id = BTreeMap::new();
    let mut total_bytes = 0usize;
    for asset in assets {
        if by_file_id.insert(asset.file_id.clone(), asset).is_some() {
            return Err(HistoryObjectValidationError::DuplicateAsset(
                asset.file_id.clone(),
            ));
        }
        validate_asset_object(asset, maximum_decoded_resource_bytes)?;
        total_bytes = total_bytes.checked_add(asset.bytes.len()).ok_or(
            HistoryObjectValidationError::DecodedResourcesTooLarge {
                actual_bytes: usize::MAX,
                maximum_bytes: maximum_decoded_resource_bytes,
            },
        )?;
        if total_bytes > maximum_decoded_resource_bytes {
            return Err(HistoryObjectValidationError::DecodedResourcesTooLarge {
                actual_bytes: total_bytes,
                maximum_bytes: maximum_decoded_resource_bytes,
            });
        }
    }

    for reference in scene.image_files.values() {
        let Some(asset) = by_file_id.get(&reference.file_id) else {
            return Err(HistoryObjectValidationError::MissingAsset {
                file_id: reference.file_id.clone(),
                asset_hash: reference.asset_hash.clone(),
            });
        };
        if asset.metadata.sha256 != reference.asset_hash {
            return Err(HistoryObjectValidationError::AssetReferenceMismatch {
                file_id: reference.file_id.clone(),
                scene_hash: reference.asset_hash.clone(),
                object_hash: asset.metadata.sha256.clone(),
            });
        }
        if !asset
            .metadata
            .mime_type
            .eq_ignore_ascii_case(&reference.mime_type)
        {
            return Err(HistoryObjectValidationError::InvalidImageReference(
                format!("MIME type mismatch for {}", reference.file_id),
            ));
        }
    }

    Ok(scene)
}

/// Validate one image object independently.  The total decoded-resource
/// bound is enforced by `validate_scene_and_assets`; this function enforces
/// the per-object bound and all object metadata/checksum rules.
pub fn validate_asset_object(
    asset: &AssetObject<'_>,
    maximum_decoded_resource_bytes: usize,
) -> Result<(), HistoryObjectValidationError> {
    validate_asset_metadata(asset)?;
    if asset.bytes.len() > maximum_decoded_resource_bytes {
        return Err(HistoryObjectValidationError::AssetTooLarge {
            file_id: asset.file_id.clone(),
            actual_bytes: asset.bytes.len(),
            maximum_bytes: maximum_decoded_resource_bytes,
        });
    }
    let actual_length = asset.bytes.len() as u64;
    if asset.metadata.byte_length != actual_length {
        return Err(HistoryObjectValidationError::AssetLengthMismatch {
            file_id: asset.file_id.clone(),
            declared: asset.metadata.byte_length,
            actual: actual_length,
        });
    }
    let actual_hash = sha256_hex(asset.bytes);
    if asset.metadata.sha256 != actual_hash {
        return Err(HistoryObjectValidationError::AssetDigestMismatch {
            file_id: asset.file_id.clone(),
            expected: asset.metadata.sha256.clone(),
            actual: actual_hash,
        });
    }
    if !image_bytes_match_mime(&asset.metadata.mime_type, asset.bytes) {
        return Err(HistoryObjectValidationError::InvalidImageBytes {
            file_id: asset.file_id.clone(),
            mime_type: asset.metadata.mime_type.clone(),
        });
    }
    Ok(())
}

/// Validate an object path read from metadata.  Object paths are storage-
/// relative and may contain normal nested components, but never absolute,
/// parent, current-directory, prefix or non-UTF-8 components.
pub fn validate_relative_object_path(
    path: &Path,
    field: &'static str,
) -> Result<(), HistoryObjectValidationError> {
    let text = path.to_str().ok_or_else(|| {
        HistoryObjectValidationError::InvalidSceneMetadata(format!("{field} must be valid UTF-8"))
    })?;
    if text.is_empty() || text.contains('\0') {
        return Err(HistoryObjectValidationError::InvalidSceneMetadata(format!(
            "{field} must be a non-empty relative path"
        )));
    }
    if path.is_absolute() {
        return Err(HistoryObjectValidationError::InvalidSceneMetadata(format!(
            "{field} must be relative"
        )));
    }
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(HistoryObjectValidationError::InvalidSceneMetadata(format!(
            "{field} contains a non-normal path component"
        )));
    }
    Ok(())
}

/// Validate a lower-case SHA-256 digest used as an object identity.
pub fn validate_object_hash(
    value: &str,
    field: &'static str,
) -> Result<(), HistoryObjectValidationError> {
    if value.len() != HISTORY_HASH_HEX_LENGTH
        || !value.bytes().all(|byte| byte.is_ascii_hexdigit())
        || value.bytes().any(|byte| byte.is_ascii_uppercase())
    {
        return Err(HistoryObjectValidationError::InvalidSceneMetadata(format!(
            "{field} must be a lowercase SHA-256 hex digest"
        )));
    }
    Ok(())
}

fn validate_scene_metadata(
    metadata: &SceneObjectMetadata,
) -> Result<(), HistoryObjectValidationError> {
    if metadata.schema_version != HISTORY_OBJECT_SCHEMA_VERSION {
        return Err(HistoryObjectValidationError::InvalidSceneMetadata(
            "schemaVersion is unsupported".to_owned(),
        ));
    }
    if metadata.codec != HISTORY_OBJECT_CODEC {
        return Err(HistoryObjectValidationError::InvalidSceneMetadata(
            "codec must be none".to_owned(),
        ));
    }
    validate_object_hash(&metadata.sha256, "scene.sha256")?;
    validate_relative_object_path(&metadata.relative_path, "scene.relativePath")
}

fn validate_asset_metadata(asset: &AssetObject<'_>) -> Result<(), HistoryObjectValidationError> {
    if let Err(error) = crate::history::types::validate_text(
        &asset.file_id,
        "asset.fileId",
        HISTORY_MAX_IDENTIFIER_LENGTH,
    ) {
        return Err(HistoryObjectValidationError::InvalidAssetMetadata {
            file_id: asset.file_id.clone(),
            reason: error.to_string(),
        });
    }
    validate_object_hash(&asset.metadata.sha256, "asset.sha256").map_err(|error| {
        HistoryObjectValidationError::InvalidAssetMetadata {
            file_id: asset.file_id.clone(),
            reason: error.to_string(),
        }
    })?;
    validate_relative_object_path(&asset.metadata.relative_path, "asset.relativePath").map_err(
        |error| HistoryObjectValidationError::InvalidAssetMetadata {
            file_id: asset.file_id.clone(),
            reason: error.to_string(),
        },
    )?;
    validate_image_mime(&asset.metadata.mime_type).map_err(|reason| {
        HistoryObjectValidationError::InvalidAssetMetadata {
            file_id: asset.file_id.clone(),
            reason,
        }
    })
}

fn validate_image_mime(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_MIME_TYPE_LENGTH || !value.is_ascii() {
        return Err("mimeType must be a short ASCII image MIME type".to_owned());
    }
    let lower = value.to_ascii_lowercase();
    let Some(subtype) = lower.strip_prefix("image/") else {
        return Err("mimeType must use the image/* media type".to_owned());
    };
    if subtype.is_empty()
        || subtype.contains(';')
        || !subtype
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&byte))
    {
        return Err("mimeType contains invalid media-type characters".to_owned());
    }
    Ok(())
}

fn collect_image_files(
    scene: &Value,
) -> Result<BTreeMap<String, ValidatedImageReference>, HistoryObjectValidationError> {
    let mut files = BTreeMap::new();
    if let Some(files_value) = scene.get("files") {
        let file_map = files_value.as_object().ok_or_else(|| {
            HistoryObjectValidationError::InvalidScene(
                "files must be an object when present".to_owned(),
            )
        })?;
        for (file_id, file_value) in file_map {
            if let Err(error) = crate::history::types::validate_text(
                file_id,
                "fileId",
                HISTORY_MAX_IDENTIFIER_LENGTH,
            ) {
                return Err(HistoryObjectValidationError::InvalidImageReference(
                    error.to_string(),
                ));
            }
            let file = file_value.as_object().ok_or_else(|| {
                HistoryObjectValidationError::InvalidImageReference(file_id.clone())
            })?;
            if let Some(declared_id) = file.get("id") {
                if declared_id.as_str() != Some(file_id.as_str()) {
                    return Err(HistoryObjectValidationError::InvalidImageReference(
                        format!("file id mismatch for {file_id}"),
                    ));
                }
            }
            let data_url = file.get("dataURL").and_then(Value::as_str).ok_or_else(|| {
                HistoryObjectValidationError::InvalidImageReference(format!(
                    "file {file_id} has no dataURL"
                ))
            })?;
            let asset_hash = data_url.strip_prefix("asset://").ok_or_else(|| {
                HistoryObjectValidationError::InvalidImageReference(format!(
                    "file {file_id} does not use an asset reference"
                ))
            })?;
            validate_object_hash(asset_hash, "file.dataURL")?;
            let mime_type = file
                .get("mimeType")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    HistoryObjectValidationError::InvalidImageReference(format!(
                        "file {file_id} has no mimeType"
                    ))
                })?;
            validate_image_mime(mime_type).map_err(|reason| {
                HistoryObjectValidationError::InvalidImageReference(format!(
                    "file {file_id}: {reason}"
                ))
            })?;
            if files
                .insert(
                    file_id.clone(),
                    ValidatedImageReference {
                        file_id: file_id.clone(),
                        asset_hash: asset_hash.to_owned(),
                        mime_type: mime_type.to_ascii_lowercase(),
                    },
                )
                .is_some()
            {
                return Err(HistoryObjectValidationError::InvalidImageReference(
                    file_id.clone(),
                ));
            }
        }
    }

    let elements = scene
        .get("elements")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            HistoryObjectValidationError::InvalidScene("elements must be an array".to_owned())
        })?;
    for element in elements {
        let Some(object) = element.as_object() else {
            continue;
        };
        if object.get("type").and_then(Value::as_str) != Some("image") {
            continue;
        }
        let file_id = object
            .get("fileId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                HistoryObjectValidationError::InvalidImageReference(
                    "image element has no fileId".to_owned(),
                )
            })?;
        if !files.contains_key(file_id) {
            return Err(HistoryObjectValidationError::MissingAsset {
                file_id: file_id.to_owned(),
                asset_hash: "<unresolved>".to_owned(),
            });
        }
    }
    Ok(files)
}

fn image_bytes_match_mime(mime_type: &str, bytes: &[u8]) -> bool {
    let mime_type = mime_type.to_ascii_lowercase();
    match mime_type.as_str() {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" | "image/jpg" => bytes.starts_with(b"\xff\xd8\xff"),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        "image/svg+xml" => {
            let text = String::from_utf8_lossy(bytes);
            let trimmed = text.trim_start();
            trimmed.starts_with("<svg")
                || (trimmed.starts_with("<?xml") && trimmed.contains("<svg"))
        }
        _ => !bytes.is_empty(),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn map_scene_error(error: SceneValidationError) -> HistoryObjectValidationError {
    match error {
        SceneValidationError::TooLarge {
            actual_bytes,
            maximum_bytes,
        } => HistoryObjectValidationError::SceneTooLarge {
            actual_bytes: actual_bytes as usize,
            maximum_bytes: maximum_bytes as usize,
        },
        SceneValidationError::Malformed(source) => {
            HistoryObjectValidationError::InvalidScene(source.to_string())
        }
        SceneValidationError::InvalidStructure(reason) => {
            HistoryObjectValidationError::InvalidScene(reason.to_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture";

    fn metadata_for_scene(bytes: &[u8]) -> SceneObjectMetadata {
        SceneObjectMetadata {
            schema_version: HISTORY_OBJECT_SCHEMA_VERSION,
            codec: HISTORY_OBJECT_CODEC.to_owned(),
            raw_length: bytes.len() as u64,
            sha256: sha256_hex(bytes),
            relative_path: PathBuf::from("scenes/scene-object"),
        }
    }

    fn metadata_for_asset(bytes: &[u8], mime_type: &str) -> AssetObjectMetadata {
        AssetObjectMetadata {
            sha256: sha256_hex(bytes),
            byte_length: bytes.len() as u64,
            mime_type: mime_type.to_owned(),
            relative_path: PathBuf::from("assets/asset-object"),
        }
    }

    fn scene_with_asset(hash: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "type": "excalidraw",
            "version": 2,
            "elements": [{ "type": "image", "fileId": "image-1" }],
            "files": {
                "image-1": {
                    "id": "image-1",
                    "dataURL": format!("asset://{hash}"),
                    "mimeType": "image/png"
                }
            }
        }))
        .expect("serialize scene")
    }

    #[test]
    fn validates_scene_structure_metadata_and_digest() {
        let bytes = br#"{"type":"excalidraw","version":2,"elements":[]}"#;
        let validated =
            validate_scene_object(bytes, &metadata_for_scene(bytes)).expect("valid history scene");
        assert_eq!(validated.sha256, sha256_hex(bytes));

        let mut bad = metadata_for_scene(bytes);
        bad.sha256 = "a".repeat(64);
        assert!(matches!(
            validate_scene_object(bytes, &bad),
            Err(HistoryObjectValidationError::SceneDigestMismatch { .. })
        ));
    }

    #[test]
    fn rejects_bad_object_metadata_and_paths() {
        let bytes = br#"{"type":"excalidraw","version":2,"elements":[]}"#;
        let mut metadata = metadata_for_scene(bytes);
        metadata.relative_path = PathBuf::from("../escape");
        assert!(matches!(
            validate_scene_object(bytes, &metadata),
            Err(HistoryObjectValidationError::InvalidSceneMetadata(_))
        ));
        assert!(validate_relative_object_path(Path::new("/absolute"), "path").is_err());
        assert!(validate_relative_object_path(Path::new("./current"), "path").is_err());
        assert!(validate_relative_object_path(Path::new("nested/object"), "path").is_ok());
        assert!(validate_object_hash(&"A".repeat(64), "hash").is_err());
    }

    #[test]
    fn validates_reachable_assets_and_rejects_missing_or_corrupt_images() {
        let hash = sha256_hex(PNG);
        let scene_bytes = scene_with_asset(&hash);
        let scene_metadata = metadata_for_scene(&scene_bytes);
        let asset = AssetObject {
            file_id: "image-1".to_owned(),
            metadata: metadata_for_asset(PNG, "image/png"),
            bytes: PNG,
        };
        assert!(validate_scene_and_assets(&scene_bytes, &scene_metadata, &[asset]).is_ok());

        let missing = validate_scene_and_assets(&scene_bytes, &scene_metadata, &[])
            .expect_err("missing image must be observable");
        assert!(matches!(
            missing,
            HistoryObjectValidationError::MissingAsset { .. }
        ));

        let corrupt_bytes = b"\x89PNG\r\n\x1a\nother";
        let corrupt = AssetObject {
            file_id: "image-1".to_owned(),
            metadata: metadata_for_asset(PNG, "image/png"),
            bytes: corrupt_bytes,
        };
        let error = validate_scene_and_assets(&scene_bytes, &scene_metadata, &[corrupt])
            .expect_err("corrupt image must be unavailable");
        assert!(matches!(
            error,
            HistoryObjectValidationError::AssetLengthMismatch { .. }
                | HistoryObjectValidationError::AssetDigestMismatch { .. }
        ));
        assert_eq!(
            error.unavailable_ipc_error().code,
            crate::commands::error::ErrorCode::HistoryResourceMissing
        );
    }

    #[test]
    fn rejects_non_image_mime_and_embedded_image_references() {
        let bytes = br#"{"type":"excalidraw","version":2,"elements":[]}"#;
        let asset_bytes = PNG;
        let asset = AssetObject {
            file_id: "image-1".to_owned(),
            metadata: metadata_for_asset(asset_bytes, "text/plain"),
            bytes: asset_bytes,
        };
        assert!(matches!(
            validate_asset_object(&asset, 1024),
            Err(HistoryObjectValidationError::InvalidAssetMetadata { .. })
        ));

        let embedded = serde_json::to_vec(&json!({
            "type": "excalidraw",
            "version": 2,
            "elements": [],
            "files": { "image-1": { "dataURL": "data:image/png;base64,AA==", "mimeType": "image/png" } }
        }))
        .expect("serialize scene");
        assert!(matches!(
            validate_scene_object(&embedded, &metadata_for_scene(&embedded)),
            Err(HistoryObjectValidationError::InvalidImageReference(_))
        ));
        let _ = bytes;
    }

    #[test]
    fn enforces_decoded_resource_bound_before_visibility() {
        let hash = sha256_hex(PNG);
        let scene_bytes = scene_with_asset(&hash);
        let scene_metadata = metadata_for_scene(&scene_bytes);
        let asset = AssetObject {
            file_id: "image-1".to_owned(),
            metadata: metadata_for_asset(PNG, "image/png"),
            bytes: PNG,
        };
        let error = validate_scene_and_assets_with_limits(
            &scene_bytes,
            &scene_metadata,
            &[asset],
            HISTORY_MAX_SCENE_BYTES,
            4,
        )
        .expect_err("decoded assets must be bounded");
        assert!(matches!(
            error,
            HistoryObjectValidationError::AssetTooLarge { .. }
                | HistoryObjectValidationError::DecodedResourcesTooLarge { .. }
        ));
    }
}
