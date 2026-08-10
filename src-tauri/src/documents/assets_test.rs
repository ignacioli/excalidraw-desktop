use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::assets::{
    asset_root_for, collect_garbage, collect_referenced_hashes, externalize_files, reembed_files,
    AssetStoreError, ASSET_DIRECTORY_NAME, ASSET_REFERENCE_PREFIX, ORPHAN_GRACE_PERIOD,
};

const PNG_BYTES: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDRfake-image-bytes";

fn test_directory(label: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "excalidraw-desktop-assets-{label}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&directory).unwrap_or_else(|error| panic!("create test directory: {error}"));
    directory
}

fn data_url(mime_type: &str, bytes: &[u8]) -> String {
    format!("data:{mime_type};base64,{}", STANDARD.encode(bytes))
}

fn scene_with_files(entries: &[(&str, &str, &str)]) -> String {
    let mut files = serde_json::Map::new();
    for (id, data_url, mime_type) in entries {
        files.insert(
            (*id).to_owned(),
            json!({
                "id": id,
                "dataURL": data_url,
                "mimeType": mime_type,
                "created": 123,
            }),
        );
    }
    serde_json::to_string(&json!({
        "type": "excalidraw",
        "version": 2,
        "elements": [],
        "files": files,
    }))
    .expect("serialize test scene")
}

fn parse_scene(scene_json: &str) -> Value {
    serde_json::from_str(scene_json).expect("parse test scene")
}

fn asset_files(workspace: &Path) -> Vec<PathBuf> {
    let directory = workspace.join(ASSET_DIRECTORY_NAME);
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect()
}

#[test]
fn externalize_and_reembed_round_trip_preserves_the_official_payload() {
    let workspace = test_directory("round-trip");
    let original_data_url = data_url("image/png", PNG_BYTES);
    let original = scene_with_files(&[("file-1", &original_data_url, "image/png")]);

    let externalized = externalize_files(&original, &workspace).expect("externalize scene");
    let scene = parse_scene(&externalized);
    let reference = scene["files"]["file-1"]["dataURL"]
        .as_str()
        .expect("reference");
    assert!(
        reference.starts_with(ASSET_REFERENCE_PREFIX),
        "dataURL was not replaced with an internal reference: {reference}"
    );
    assert_eq!(scene["files"]["file-1"]["mimeType"], "image/png");
    assert_eq!(scene["files"]["file-1"]["created"], 123);
    assert_eq!(asset_files(&workspace).len(), 1);

    let reembedded = reembed_files(&externalized, &workspace).expect("reembed scene");
    let restored = parse_scene(&reembedded);
    assert_eq!(
        restored["files"]["file-1"]["dataURL"].as_str(),
        Some(original_data_url.as_str())
    );
    assert_eq!(restored["files"]["file-1"]["id"], "file-1");
    assert_eq!(restored["files"]["file-1"]["mimeType"], "image/png");
    assert_eq!(restored["files"]["file-1"]["created"], 123);

    fs::remove_dir_all(workspace).unwrap_or_else(|error| panic!("remove test directory: {error}"));
}

#[test]
fn externalize_is_idempotent_and_keeps_a_single_asset_file() {
    let workspace = test_directory("idempotent");
    let original = scene_with_files(&[("file-1", &data_url("image/png", PNG_BYTES), "image/png")]);

    let first = externalize_files(&original, &workspace).expect("first externalize");
    let second = externalize_files(&first, &workspace).expect("second externalize");
    assert_eq!(
        first, second,
        "externalizing an already-externalized scene changed it"
    );
    assert_eq!(asset_files(&workspace).len(), 1);

    fs::remove_dir_all(workspace).unwrap_or_else(|error| panic!("remove test directory: {error}"));
}

#[test]
fn identical_bytes_from_two_entries_dedup_to_one_asset_file() {
    let workspace = test_directory("dedup");
    let first_url = data_url("image/png", PNG_BYTES);
    let original = scene_with_files(&[
        ("file-a", &first_url, "image/png"),
        ("file-b", &first_url, "image/png"),
    ]);

    let externalized = externalize_files(&original, &workspace).expect("externalize scene");
    let scene = parse_scene(&externalized);
    let reference_a = scene["files"]["file-a"]["dataURL"]
        .as_str()
        .expect("reference a");
    let reference_b = scene["files"]["file-b"]["dataURL"]
        .as_str()
        .expect("reference b");
    assert_eq!(
        reference_a, reference_b,
        "identical bytes must share one reference"
    );
    assert_eq!(asset_files(&workspace).len(), 1);

    fs::remove_dir_all(workspace).unwrap_or_else(|error| panic!("remove test directory: {error}"));
}

#[test]
fn non_base64_data_urls_and_foreign_urls_pass_through() {
    let workspace = test_directory("passthrough");
    let svg = "data:image/svg+xml,%3Csvg%3E%3C/svg%3E";
    let blob = "blob:http://localhost/uuid";
    let original = scene_with_files(&[
        ("svg-file", svg, "image/svg+xml"),
        ("blob-file", blob, "image/png"),
    ]);

    let externalized = externalize_files(&original, &workspace).expect("externalize scene");
    assert_eq!(
        externalized, original,
        "unrecognized data URLs must not be rewritten"
    );
    assert_eq!(asset_files(&workspace).len(), 0);

    fs::remove_dir_all(workspace).unwrap_or_else(|error| panic!("remove test directory: {error}"));
}

#[test]
fn scene_without_files_is_returned_byte_for_byte() {
    let workspace = test_directory("no-files");
    let original = r#"{"type":"excalidraw","version":2,"elements":[{"id":"x"}]}"#;

    let externalized = externalize_files(original, &workspace).expect("externalize scene");
    assert_eq!(externalized, original);
    let reembedded = reembed_files(original, &workspace).expect("reembed scene");
    assert_eq!(reembedded, original);

    fs::remove_dir_all(workspace).unwrap_or_else(|error| panic!("remove test directory: {error}"));
}

#[test]
fn reembed_reports_missing_asset_files() {
    let workspace = test_directory("missing");
    let reference = format!("{ASSET_REFERENCE_PREFIX}{}", "a".repeat(64));
    let scene = scene_with_files(&[("file-1", &reference, "image/png")]);

    let error = reembed_files(&scene, &workspace).expect_err("missing asset must fail");
    assert!(matches!(error, AssetStoreError::AssetNotFound { .. }));

    fs::remove_dir_all(workspace).unwrap_or_else(|error| panic!("remove test directory: {error}"));
}

#[test]
fn reembed_rejects_malformed_references() {
    let workspace = test_directory("malformed");
    let scene = scene_with_files(&[("file-1", "asset://not-a-hex-hash", "image/png")]);

    let error = reembed_files(&scene, &workspace).expect_err("malformed reference must fail");
    assert!(matches!(error, AssetStoreError::InvalidReference(_)));

    fs::remove_dir_all(workspace).unwrap_or_else(|error| panic!("remove test directory: {error}"));
}

#[test]
fn externalize_detects_a_hash_collision() {
    let workspace = test_directory("collision");
    let hash = format!("{:x}", Sha256::digest(PNG_BYTES));
    let asset_path = workspace.join(ASSET_DIRECTORY_NAME).join(&hash);
    fs::create_dir_all(asset_path.parent().expect("assets directory"))
        .unwrap_or_else(|error| panic!("create assets directory: {error}"));
    fs::write(&asset_path, b"different-bytes")
        .unwrap_or_else(|error| panic!("write colliding asset: {error}"));

    let scene = scene_with_files(&[("file-1", &data_url("image/png", PNG_BYTES), "image/png")]);
    let error = externalize_files(&scene, &workspace).expect_err("collision must fail");
    assert!(matches!(error, AssetStoreError::HashCollision { .. }));

    fs::remove_dir_all(workspace).unwrap_or_else(|error| panic!("remove test directory: {error}"));
}

#[test]
fn collect_garbage_removes_only_old_unreferenced_hashes() {
    let workspace = test_directory("garbage");
    let directory = workspace.join(ASSET_DIRECTORY_NAME);
    fs::create_dir_all(&directory)
        .unwrap_or_else(|error| panic!("create assets directory: {error}"));
    let old = SystemTime::now() - ORPHAN_GRACE_PERIOD - Duration::from_secs(60);
    let recent = SystemTime::now();

    let referenced = "b".repeat(64);
    let orphan = "c".repeat(64);
    let young = "d".repeat(64);
    let foreign = "not-a-hash.txt";
    for (name, mtime) in [
        (referenced.as_str(), old),
        (orphan.as_str(), old),
        (young.as_str(), recent),
        (foreign, old),
    ] {
        let path = directory.join(name);
        fs::write(&path, b"x").unwrap_or_else(|error| panic!("write fixture {name}: {error}"));
        let file = fs::File::options()
            .write(true)
            .open(&path)
            .unwrap_or_else(|error| panic!("open fixture {name}: {error}"));
        file.set_modified(mtime)
            .unwrap_or_else(|error| panic!("set mtime for {name}: {error}"));
    }

    let summary =
        collect_garbage(&workspace, &HashSet::from([referenced.clone()])).expect("collect garbage");
    assert_eq!(summary.scanned, 3, "foreign file is not counted");
    assert_eq!(summary.removed, 1);
    assert_eq!(summary.skipped_referenced, 1);
    assert_eq!(summary.skipped_recent, 1);
    assert!(
        directory.join(&referenced).exists(),
        "referenced asset was removed"
    );
    assert!(!directory.join(&orphan).exists(), "orphan was not removed");
    assert!(directory.join(&young).exists(), "young asset was removed");
    assert!(directory.join(foreign).exists(), "foreign file was removed");

    fs::remove_dir_all(workspace).unwrap_or_else(|error| panic!("remove test directory: {error}"));
}

#[test]
fn collect_garbage_on_a_missing_directory_is_a_noop() {
    let workspace = test_directory("garbage-missing");
    let summary = collect_garbage(&workspace, &HashSet::new()).expect("collect garbage");
    assert_eq!(summary, Default::default());
    fs::remove_dir_all(workspace).unwrap_or_else(|error| panic!("remove test directory: {error}"));
}

#[test]
fn collect_referenced_hashes_extracts_only_internal_references() {
    let reference = format!("{ASSET_REFERENCE_PREFIX}{}", "e".repeat(64));
    let scene = scene_with_files(&[
        ("file-1", &reference, "image/png"),
        ("file-2", &data_url("image/png", PNG_BYTES), "image/png"),
    ]);
    let hashes = collect_referenced_hashes(&scene);
    assert_eq!(hashes, HashSet::from(["e".repeat(64)]));
}

#[test]
fn asset_root_falls_back_to_the_document_parent_outside_workspaces() {
    let document = Path::new("/tmp/docs/drawing.excalidraw");
    assert_eq!(
        asset_root_for(document, Some(Path::new("/tmp/workspace"))),
        PathBuf::from("/tmp/workspace")
    );
    assert_eq!(asset_root_for(document, None), PathBuf::from("/tmp/docs"));
}
