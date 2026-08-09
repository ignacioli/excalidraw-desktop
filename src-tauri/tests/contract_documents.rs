mod support;

use std::fs;
use std::{path::Path, sync::Arc};

use excalidraw_desktop_lib::{
    commands::{
        documents::{DirectFileGrant, DocumentService},
        dto::{
            CheckpointReason, CheckpointRequest, CloseDocumentRequest, PathRequest,
            SaveDraftRequest,
        },
        error::ErrorCode,
    },
    database::repository::{DraftRepository, FileIndexRepository},
};
use support::{read_scene, valid_scene, DocumentHarness};

#[tokio::test]
async fn document_contract_round_trips_open_draft_checkpoint_and_close() {
    let harness = DocumentHarness::new(1024 * 1024).await;
    let original = valid_scene("original");
    let updated = valid_scene("updated");
    let path = harness.write_scene("drawing.excalidraw", &original);
    let path_string = path.display().to_string();

    let opened = harness
        .service
        .doc_open(PathRequest {
            path: path_string.clone(),
        })
        .await
        .unwrap_or_else(|error| panic!("open document: {error:?}"));
    assert_eq!(opened.scene["type"], "excalidraw");
    assert!(!opened.base_hash.is_empty());
    assert!(!opened.has_newer_draft);

    let draft = harness
        .service
        .doc_save_draft(SaveDraftRequest {
            path: path_string.clone(),
            scene_json: updated.clone(),
        })
        .await
        .unwrap_or_else(|error| panic!("save draft: {error:?}"));
    assert!(!draft.content_hash.is_empty());
    assert!(draft.saved_at > 0);
    assert_eq!(read_scene(&path), original);

    let reopened = harness
        .service
        .doc_open(PathRequest {
            path: path_string.clone(),
        })
        .await
        .unwrap_or_else(|error| panic!("reopen document: {error:?}"));
    assert!(reopened.has_newer_draft);

    let checkpoint = harness
        .service
        .doc_checkpoint(CheckpointRequest {
            path: path_string.clone(),
            scene_json: updated.clone(),
            reason: CheckpointReason::ManualSave,
        })
        .await
        .unwrap_or_else(|error| panic!("checkpoint document: {error:?}"));
    assert_eq!(read_scene(&path), updated);
    assert_eq!(checkpoint.new_base_hash, draft.content_hash);
    assert!(checkpoint.mtime > 0);

    let canonical_path = path
        .canonicalize()
        .unwrap_or_else(|error| panic!("canonicalize document: {error}"))
        .display()
        .to_string();
    let stored_draft = harness
        .repository
        .draft_get(canonical_path.clone())
        .await
        .unwrap_or_else(|error| panic!("read checkpointed draft: {error}"))
        .unwrap_or_else(|| panic!("checkpointed draft is missing"));
    assert!(!stored_draft.is_dirty);
    assert_eq!(
        stored_draft.base_hash.as_deref(),
        Some(checkpoint.new_base_hash.as_str())
    );

    let indexed = harness
        .repository
        .file_index_get(canonical_path)
        .await
        .unwrap_or_else(|error| panic!("read file index: {error}"));
    assert_eq!(
        indexed.and_then(|record| record.content_hash),
        Some(checkpoint.new_base_hash)
    );

    harness
        .service
        .doc_close(CloseDocumentRequest {
            path: path_string,
            discard_draft: false,
        })
        .await
        .unwrap_or_else(|error| panic!("close checkpointed document: {error:?}"));
}

#[tokio::test]
async fn every_document_command_rejects_paths_outside_mounted_workspaces() {
    let harness = DocumentHarness::new(1024 * 1024).await;
    let outside_path = harness.outside.join("outside.excalidraw");
    fs::write(&outside_path, valid_scene("outside"))
        .unwrap_or_else(|error| panic!("write outside fixture: {error}"));
    let outside = outside_path.display().to_string();

    assert_eq!(
        harness
            .service
            .doc_open(PathRequest {
                path: outside.clone()
            })
            .await
            .expect_err("outside open must fail")
            .code,
        ErrorCode::PathAccessDenied
    );
    assert_eq!(
        harness
            .service
            .doc_save_draft(SaveDraftRequest {
                path: outside.clone(),
                scene_json: valid_scene("draft"),
            })
            .await
            .expect_err("outside draft must fail")
            .code,
        ErrorCode::PathAccessDenied
    );
    assert_eq!(
        harness
            .service
            .doc_checkpoint(CheckpointRequest {
                path: outside.clone(),
                scene_json: valid_scene("checkpoint"),
                reason: CheckpointReason::ManualSave,
            })
            .await
            .expect_err("outside checkpoint must fail")
            .code,
        ErrorCode::PathAccessDenied
    );
    assert_eq!(
        harness
            .service
            .doc_close(CloseDocumentRequest {
                path: outside,
                discard_draft: true,
            })
            .await
            .expect_err("outside close must fail")
            .code,
        ErrorCode::PathAccessDenied
    );
}

#[tokio::test]
async fn document_commands_cannot_replace_unsupported_workspace_files() {
    let harness = DocumentHarness::new(1024 * 1024).await;
    let path = harness.workspace.join("notes.txt");
    let original = b"private notes";
    fs::write(&path, original).unwrap_or_else(|error| panic!("write unsupported fixture: {error}"));
    let path_string = path.display().to_string();

    assert_eq!(
        harness
            .service
            .doc_open(PathRequest {
                path: path_string.clone(),
            })
            .await
            .expect_err("unsupported open must fail")
            .code,
        ErrorCode::PathAccessDenied
    );
    assert_eq!(
        harness
            .service
            .doc_save_draft(SaveDraftRequest {
                path: path_string.clone(),
                scene_json: valid_scene("draft"),
            })
            .await
            .expect_err("unsupported draft must fail")
            .code,
        ErrorCode::PathAccessDenied
    );
    assert_eq!(
        harness
            .service
            .doc_checkpoint(CheckpointRequest {
                path: path_string.clone(),
                scene_json: valid_scene("checkpoint"),
                reason: CheckpointReason::ManualSave,
            })
            .await
            .expect_err("unsupported checkpoint must fail")
            .code,
        ErrorCode::PathAccessDenied
    );
    assert_eq!(
        fs::read(&path).unwrap_or_else(|error| panic!("read unsupported fixture: {error}")),
        original
    );
}

#[tokio::test]
async fn invalid_and_oversized_scenes_have_stable_error_codes() {
    let harness = DocumentHarness::new(160).await;
    let malformed_path = harness.write_scene("malformed.excalidraw", "{not-json");
    assert_eq!(
        harness
            .service
            .doc_open(PathRequest {
                path: malformed_path.display().to_string(),
            })
            .await
            .expect_err("malformed file must fail")
            .code,
        ErrorCode::FileCorrupted
    );

    let path = harness.write_scene("drawing.excalidraw", &valid_scene("base"));
    let path_string = path.display().to_string();
    assert_eq!(
        harness
            .service
            .doc_save_draft(SaveDraftRequest {
                path: path_string.clone(),
                scene_json: "{}".to_owned(),
            })
            .await
            .expect_err("invalid draft must fail")
            .code,
        ErrorCode::InvalidScene
    );

    let oversized = format!(
        r#"{{"type":"excalidraw","version":2,"elements":[],"padding":"{}"}}"#,
        "x".repeat(256)
    );
    assert_eq!(
        harness
            .service
            .doc_checkpoint(CheckpointRequest {
                path: path_string,
                scene_json: oversized,
                reason: CheckpointReason::ManualSave,
            })
            .await
            .expect_err("oversized checkpoint must fail")
            .code,
        ErrorCode::FileTooLarge
    );

    let oversized_file = harness.write_scene(
        "oversized.excalidraw",
        &format!(
            r#"{{"type":"excalidraw","version":2,"elements":[],"padding":"{}"}}"#,
            "x".repeat(256)
        ),
    );
    assert_eq!(
        harness
            .service
            .doc_open(PathRequest {
                path: oversized_file.display().to_string(),
            })
            .await
            .expect_err("oversized file must fail")
            .code,
        ErrorCode::FileTooLarge
    );
}

#[test]
fn production_scene_limit_is_256_mib() {
    assert_eq!(
        DocumentService::DEFAULT_SCENE_LIMIT_BYTES,
        256 * 1024 * 1024
    );
}

#[tokio::test]
async fn dialog_selected_file_grant_authorizes_a_file_outside_workspaces() {
    struct ExactFileGrant(std::path::PathBuf);

    impl DirectFileGrant for ExactFileGrant {
        fn is_allowed(&self, path: &Path) -> bool {
            path == self.0
        }
    }

    let harness = DocumentHarness::new(1024 * 1024).await;
    let selected = harness.outside.join("selected.excalidraw");
    fs::write(&selected, valid_scene("selected"))
        .unwrap_or_else(|error| panic!("write selected file fixture: {error}"));
    let service = DocumentService::with_grant_and_scene_limit(
        Arc::clone(&harness.repository),
        Arc::new(ExactFileGrant(selected.clone())),
        1024 * 1024,
    );

    let opened = service
        .doc_open(PathRequest {
            path: selected.display().to_string(),
        })
        .await
        .unwrap_or_else(|error| panic!("open dialog-selected document: {error:?}"));
    assert_eq!(opened.scene["type"], "excalidraw");
}

#[tokio::test]
async fn save_dialog_grant_allows_only_the_standard_extension_appended_by_the_frontend() {
    struct ExactFileGrant(std::path::PathBuf);

    impl DirectFileGrant for ExactFileGrant {
        fn is_allowed(&self, path: &Path) -> bool {
            path == self.0
        }
    }

    let harness = DocumentHarness::new(1024 * 1024).await;
    let selected = harness.outside.join("new-drawing");
    let target = harness.outside.join("new-drawing.excalidraw");
    let service = DocumentService::with_grant_and_scene_limit(
        Arc::clone(&harness.repository),
        Arc::new(ExactFileGrant(selected)),
        1024 * 1024,
    );

    service
        .doc_checkpoint(CheckpointRequest {
            path: target.display().to_string(),
            scene_json: valid_scene("new"),
            reason: CheckpointReason::ManualSave,
        })
        .await
        .unwrap_or_else(|error| panic!("save dialog-selected document: {error:?}"));

    assert_eq!(read_scene(&target), valid_scene("new"));
}

#[tokio::test]
async fn concurrent_checkpoints_leave_disk_draft_and_index_on_one_version() {
    let harness = DocumentHarness::new(1024 * 1024).await;
    let path = harness.write_scene("concurrent.excalidraw", &valid_scene("base"));
    let path_string = path.display().to_string();
    let mut tasks = Vec::new();
    for index in 0..16 {
        let service = harness.service.clone();
        let path = path_string.clone();
        tasks.push(tokio::spawn(async move {
            service
                .doc_checkpoint(CheckpointRequest {
                    path,
                    scene_json: valid_scene(&format!("version-{index}")),
                    reason: CheckpointReason::ManualSave,
                })
                .await
        }));
    }
    for task in tasks {
        task.await
            .unwrap_or_else(|error| panic!("join checkpoint task: {error}"))
            .unwrap_or_else(|error| panic!("run concurrent checkpoint: {error:?}"));
    }

    let opened = harness
        .service
        .doc_open(PathRequest {
            path: path_string.clone(),
        })
        .await
        .unwrap_or_else(|error| panic!("open concurrent result: {error:?}"));
    let canonical = path
        .canonicalize()
        .unwrap_or_else(|error| panic!("canonicalize concurrent result: {error}"))
        .display()
        .to_string();
    let draft = harness
        .repository
        .draft_get(canonical.clone())
        .await
        .unwrap_or_else(|error| panic!("read concurrent draft: {error}"))
        .unwrap_or_else(|| panic!("concurrent draft is missing"));
    let indexed = harness
        .repository
        .file_index_get(canonical)
        .await
        .unwrap_or_else(|error| panic!("read concurrent file index: {error}"))
        .unwrap_or_else(|| panic!("concurrent file index is missing"));

    assert_eq!(draft.content_hash, opened.base_hash);
    assert_eq!(draft.base_hash.as_deref(), Some(opened.base_hash.as_str()));
    assert_eq!(
        indexed.content_hash.as_deref(),
        Some(opened.base_hash.as_str())
    );
    assert!(!draft.is_dirty);
}
