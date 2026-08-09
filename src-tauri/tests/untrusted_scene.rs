mod support;

use std::fs;

use excalidraw_desktop_lib::{
    commands::{
        dto::{CheckpointReason, CheckpointRequest, PathRequest, SaveDraftRequest},
        error::ErrorCode,
    },
    database::repository::DraftRepository,
};
use support::{read_scene, valid_scene, DocumentHarness};

#[tokio::test]
async fn embedded_script_fields_are_rejected_without_mutating_disk_or_drafts() {
    let harness = DocumentHarness::new(1024 * 1024).await;
    let original = valid_scene("safe");
    let path = harness.write_scene("drawing.excalidraw", &original);
    let path_string = path.display().to_string();
    let malicious =
        r#"{"type":"excalidraw","version":2,"elements":[],"script":"fetch('file:///etc/passwd')"}"#;

    assert_eq!(
        harness
            .service
            .doc_save_draft(SaveDraftRequest {
                path: path_string.clone(),
                scene_json: malicious.to_owned(),
            })
            .await
            .expect_err("script-bearing draft must fail")
            .code,
        ErrorCode::InvalidScene
    );
    assert_eq!(read_scene(&path), original);

    let canonical = path
        .canonicalize()
        .unwrap_or_else(|error| panic!("canonicalize fixture: {error}"))
        .display()
        .to_string();
    assert!(harness
        .repository
        .draft_get(canonical)
        .await
        .unwrap_or_else(|error| panic!("read draft after rejection: {error}"))
        .is_none());

    fs::write(&path, malicious).unwrap_or_else(|error| panic!("write malicious fixture: {error}"));
    assert_eq!(
        harness
            .service
            .doc_open(PathRequest { path: path_string })
            .await
            .expect_err("script-bearing file must fail")
            .code,
        ErrorCode::FileCorrupted
    );
    assert_eq!(read_scene(&path), malicious);
}

#[tokio::test]
async fn traversal_and_malformed_payloads_cannot_create_side_effect_files() {
    let harness = DocumentHarness::new(1024 * 1024).await;
    let original = valid_scene("safe");
    let path = harness.write_scene("drawing.excalidraw", &original);
    let escaped = harness.workspace.join("../outside/escaped.excalidraw");

    assert_eq!(
        harness
            .service
            .doc_checkpoint(CheckpointRequest {
                path: escaped.display().to_string(),
                scene_json: valid_scene("escaped"),
                reason: CheckpointReason::ManualSave,
            })
            .await
            .expect_err("traversal checkpoint must fail")
            .code,
        ErrorCode::PathAccessDenied
    );
    assert!(!escaped.exists());

    assert_eq!(
        harness
            .service
            .doc_checkpoint(CheckpointRequest {
                path: path.display().to_string(),
                scene_json: r#"{"type":"excalidraw","version":2,"elements":["#.to_owned(),
                reason: CheckpointReason::ManualSave,
            })
            .await
            .expect_err("malformed checkpoint must fail")
            .code,
        ErrorCode::InvalidScene
    );
    assert_eq!(read_scene(&path), original);
}

#[tokio::test]
async fn oversized_untrusted_scene_is_rejected_before_persistence() {
    let harness = DocumentHarness::new(128).await;
    let path = harness.write_scene("drawing.excalidraw", &valid_scene("safe"));
    let oversized = format!(
        r#"{{"type":"excalidraw","version":2,"elements":[],"padding":"{}"}}"#,
        "x".repeat(512)
    );

    assert_eq!(
        harness
            .service
            .doc_save_draft(SaveDraftRequest {
                path: path.display().to_string(),
                scene_json: oversized,
            })
            .await
            .expect_err("oversized draft must fail")
            .code,
        ErrorCode::FileTooLarge
    );
    let canonical = path
        .canonicalize()
        .unwrap_or_else(|error| panic!("canonicalize fixture: {error}"))
        .display()
        .to_string();
    assert!(harness
        .repository
        .draft_get(canonical)
        .await
        .unwrap_or_else(|error| panic!("read oversized draft result: {error}"))
        .is_none());
}
