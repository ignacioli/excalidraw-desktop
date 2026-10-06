//! Exact asset-protocol grants for scenes returned by authorized services.

use super::error::AppError;
use crate::documents::assets::ASSET_DIRECTORY_NAME;
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

pub(super) fn grant_response_assets(
    app: &AppHandle,
    asset_root: &Path,
    scene: &serde_json::Value,
) -> Result<(), AppError> {
    let scope = app.asset_protocol_scope();
    grant_scene_assets(asset_root, scene, |path| {
        scope
            .allow_file(path)
            .map_err(|error| AppError::Internal(format!("asset scope grant failed: {error}")))
    })
}

/// Call only after the owning service has authorized the document. Validate
/// all existing paths before granting any; never grant a directory pattern.
fn grant_scene_assets(
    asset_root: &Path,
    scene: &serde_json::Value,
    mut grant: impl FnMut(&Path) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let hashes = scene
        .get("files")
        .and_then(serde_json::Value::as_object)
        .into_iter()
        .flat_map(|files| files.values())
        .filter_map(|file| file.get("dataURL").and_then(serde_json::Value::as_str))
        .filter_map(|url| url.strip_prefix("asset://"))
        .filter(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .collect::<BTreeSet<_>>();
    if hashes.is_empty() {
        return Ok(());
    }
    let root = canonical_existing(asset_root)?;
    let Some(root) = root else {
        return Ok(());
    };
    let directory = root.join(ASSET_DIRECTORY_NAME);
    let Some(canonical_directory) = canonical_existing(&directory)? else {
        return Ok(());
    };
    if canonical_directory != directory {
        return Err(AppError::PathAccessDenied(directory));
    }
    let mut paths = Vec::new();
    for hash in hashes {
        let path = directory.join(hash);
        let Some(canonical) = canonical_existing(&path)? else {
            continue;
        };
        if canonical != path || !canonical.is_file() {
            return Err(AppError::PathAccessDenied(path));
        }
        paths.push(canonical);
    }
    for path in paths {
        grant(&path)?;
    }
    Ok(())
}

fn canonical_existing(path: &Path) -> Result<Option<PathBuf>, AppError> {
    match fs::canonicalize(path) {
        Ok(path) => Ok(Some(path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(AppError::Io {
            path: Some(path.to_path_buf()),
            source,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    fn fixture() -> (PathBuf, String) {
        let root = std::env::temp_dir().join(format!("asset-scope-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".excalidraw_assets")).unwrap();
        (root.canonicalize().unwrap(), "a".repeat(64))
    }

    fn scene(reference: &str) -> serde_json::Value {
        serde_json::json!({"files": {"image": {"dataURL": reference}}})
    }

    #[test]
    fn grants_only_the_referenced_file_outside_home() {
        let (root, hash) = fixture();
        let target = root.join(".excalidraw_assets").join(&hash);
        fs::write(&target, b"asset").unwrap();
        fs::write(
            root.join(".excalidraw_assets").join("b".repeat(64)),
            b"neighbor",
        )
        .unwrap();
        let mut grants = Vec::new();
        grant_scene_assets(&root, &scene(&format!("asset://{hash}")), |path| {
            grants.push(path.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(grants, vec![target]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_hashes_and_missing_assets_never_grant() {
        let (root, hash) = fixture();
        for reference in [
            "asset://../secret",
            "asset://short",
            "asset://%2e%2e/secret",
            &format!("asset://{hash}"),
        ] {
            grant_scene_assets(&root, &scene(reference), |_| panic!("unexpected grant")).unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn grant_errors_propagate() {
        let (root, hash) = fixture();
        fs::write(root.join(".excalidraw_assets").join(&hash), b"asset").unwrap();
        assert!(
            grant_scene_assets(&root, &scene(&format!("asset://{hash}")), |_| {
                Err(super::AppError::Internal("scope grant failed".to_owned()))
            })
            .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_never_grants() {
        use std::os::unix::fs::symlink;
        let (root, hash) = fixture();
        let outside = root.join("secret");
        fs::write(&outside, b"secret").unwrap();
        symlink(&outside, root.join(".excalidraw_assets").join(&hash)).unwrap();
        assert!(
            grant_scene_assets(&root, &scene(&format!("asset://{hash}")), |_| panic!(
                "unexpected grant"
            ))
            .is_err()
        );
        fs::remove_file(root.join(".excalidraw_assets").join(&hash)).unwrap();
        fs::remove_dir(root.join(".excalidraw_assets")).unwrap();
        fs::create_dir(root.join("outside-assets")).unwrap();
        fs::write(root.join("outside-assets").join(&hash), b"secret").unwrap();
        symlink(root.join("outside-assets"), root.join(".excalidraw_assets")).unwrap();
        assert!(
            grant_scene_assets(&root, &scene(&format!("asset://{hash}")), |_| panic!(
                "unexpected grant"
            ))
            .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }
}
