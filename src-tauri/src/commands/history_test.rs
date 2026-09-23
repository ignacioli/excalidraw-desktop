use super::history::{
    action_for_target, empty_scene_bytes, observe_published_target,
    replacement_fingerprint_from_parts, status_to_replace_response,
};
use crate::{
    commands::dto::{HistoryOperationStatusResponse, HistoryReplaceResponse},
    history::{
        replacement::PreparedTarget,
        types::{HistoryOperationState, HistoryProtectedAction, HistoryReplaceTarget},
    },
};
use sha2::{Digest, Sha256};
use std::fs;
use uuid::Uuid;

#[test]
fn clear_target_uses_the_protected_clear_action_and_valid_scene() {
    assert_eq!(
        action_for_target(&HistoryReplaceTarget::Clear),
        HistoryProtectedAction::Clear
    );
    let scene = empty_scene_bytes();
    assert!(serde_json::from_slice::<serde_json::Value>(&scene).is_ok());
}

#[test]
fn completed_status_is_replayable_without_running_replacement_again() {
    let response = status_to_replace_response(HistoryOperationStatusResponse {
        request_id: "request-1".to_owned(),
        state: HistoryOperationState::Completed,
        replacement_committed: Some(true),
        protection_version_id: Some("protected-1".to_owned()),
        adopted_scene: Some(serde_json::json!({"type": "excalidraw"})),
        new_base_hash: Some("a".repeat(64)),
        new_session_generation: Some(3),
    })
    .expect("completed status should be replayable");
    assert!(matches!(
        response,
        HistoryReplaceResponse::Completed {
            replacement_committed: true,
            ..
        }
    ));
}

#[test]
fn uncertain_status_never_claims_a_committed_replacement() {
    let response = status_to_replace_response(HistoryOperationStatusResponse {
        request_id: "request-2".to_owned(),
        state: HistoryOperationState::Reconcile,
        replacement_committed: None,
        protection_version_id: None,
        adopted_scene: None,
        new_base_hash: None,
        new_session_generation: None,
    })
    .expect("reconcile status should remain pending");
    assert!(matches!(
        response,
        HistoryReplaceResponse::PendingReconciliation {
            replacement_committed: None,
            operation_state: HistoryOperationState::PendingReconciliation,
            ..
        }
    ));
}

#[test]
fn replacement_fingerprint_binds_target_kind_and_payload_digest() {
    let clear = replacement_fingerprint_from_parts(
        &HistoryReplaceTarget::Clear,
        1,
        2,
        &"a".repeat(64),
        "device:inode",
    );
    let restore = replacement_fingerprint_from_parts(
        &HistoryReplaceTarget::Restore {
            version_id: "version-1".to_owned(),
        },
        1,
        2,
        &"a".repeat(64),
        "device:inode",
    );
    let import = replacement_fingerprint_from_parts(
        &HistoryReplaceTarget::Import {
            candidate_scene_json: "{\"type\":\"excalidraw\"}".to_owned(),
        },
        1,
        2,
        &"a".repeat(64),
        "device:inode",
    );
    assert_ne!(clear, restore);
    assert_ne!(restore, import);
}

#[test]
fn published_target_observation_rejects_bytes_changed_after_rename() {
    let path = std::env::temp_dir().join(format!(
        "excalidraw-history-published-target-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    let scene =
        br#"{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}"#.to_vec();
    fs::write(&path, &scene).expect("write target");
    let target_hash = format!("{:x}", Sha256::digest(&scene));
    let target = PreparedTarget {
        scene_json: scene.clone(),
        target_scene_hash: target_hash,
        object_pins: Vec::new(),
    };

    let (first_identity, first_hash) =
        observe_published_target(&path, &target).expect("observe published target");
    let replacement = path.with_extension("replacement");
    fs::write(&replacement, &scene).expect("write replacement target");
    fs::rename(&replacement, &path).expect("rename replacement target");
    let (second_identity, second_hash) =
        observe_published_target(&path, &target).expect("observe renamed target");
    assert_ne!(first_identity, second_identity);
    assert_eq!(first_hash, second_hash);
    fs::write(&path, b"changed-after-rename").expect("mutate target");
    let error = observe_published_target(&path, &target).expect_err("changed bytes must fail");
    assert!(error.contains("differ from the prepared scene"));
    fs::remove_file(path).expect("remove target");
}
