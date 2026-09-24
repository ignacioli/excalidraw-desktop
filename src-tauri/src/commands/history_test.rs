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
fn accepted_restore_target_survives_retention_and_releases_its_temporary_pin() {
    use crate::history::{
        gc::{GcCandidate, ObjectKey},
        repository::{HistoryRepository, PublishSceneRequest},
        store::HistoryStore,
        types::HistoryVersionSource,
    };
    use std::time::{Duration, SystemTime};
    let root = std::env::temp_dir().join(format!("history-target-pin-{}", Uuid::new_v4()));
    let store = HistoryStore::open_version_history_root(&root).unwrap();
    store.with_connection(|connection| {
        connection.execute("INSERT INTO history_documents (id, canonical_path, created_at, state) VALUES ('doc', '/tmp/drawing.excalidraw', 0, 'active')", [])?;
        Ok(())
    }).unwrap();
    let repository = HistoryRepository::new(&store);
    let mut original = Vec::new();
    for index in 0..20 {
        let scene = serde_json::to_vec(&serde_json::json!({
            "type": "excalidraw", "version": 2, "elements": [],
            "appState": {"viewBackgroundColor": format!("#{index:06x}")}, "files": {}
        }))
        .unwrap();
        if index == 0 {
            original = scene.clone();
        }
        repository
            .publish_scene(PublishSceneRequest {
                version_id: format!("v{index}"),
                document_id: "doc".to_owned(),
                scene_bytes: scene,
                schema_version: 1,
                source: HistoryVersionSource::Automatic,
                protected_action: None,
                recorded_at: index,
                sequence: index as u64,
            })
            .unwrap();
    }
    let target = super::history::load_history_scene(&store, "doc", "v0").unwrap();
    repository
        .publish_scene(PublishSceneRequest {
            version_id: "protection".to_owned(),
            document_id: "doc".to_owned(),
            scene_bytes: empty_scene_bytes(),
            schema_version: 1,
            source: HistoryVersionSource::Protected,
            protected_action: Some(HistoryProtectedAction::Restore),
            recorded_at: 20,
            sequence: 20,
        })
        .unwrap();
    assert!(super::history::load_history_scene(&store, "doc", "v0").is_err());
    assert_eq!(target.scene, original);
    assert!(target.assets.is_empty());
    let key = ObjectKey::scene(format!("{:x}", Sha256::digest(&original))).unwrap();
    let candidate = GcCandidate {
        object: key.clone(),
        registered: true,
        created_at: SystemTime::UNIX_EPOCH,
    };
    let before = store
        .reachability()
        .collect(
            [candidate.clone()],
            SystemTime::now(),
            Duration::ZERO,
            |_| Ok::<(), String>(()),
        )
        .unwrap();
    assert_eq!(before.retained, vec![key.clone()]);
    drop(target);
    let after = store
        .reachability()
        .collect([candidate], SystemTime::now(), Duration::ZERO, |_| {
            Ok::<(), String>(())
        })
        .unwrap();
    assert_eq!(after.deleted, vec![key]);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn invalid_restore_target_releases_hydration_pin_on_error() {
    use crate::history::{
        gc::{GcCandidate, ObjectKey},
        repository::{HistoryRepository, PublishSceneRequest},
        store::HistoryStore,
        types::HistoryVersionSource,
    };
    use std::time::{Duration, SystemTime};
    let root = std::env::temp_dir().join(format!("history-target-error-{}", Uuid::new_v4()));
    let store = HistoryStore::open_version_history_root(&root).unwrap();
    store.with_connection(|connection| {
        connection.execute("INSERT INTO history_documents (id, canonical_path, created_at, state) VALUES ('doc', '/tmp/drawing.excalidraw', 0, 'active')", [])?;
        Ok(())
    }).unwrap();
    let bytes = b"invalid scene";
    HistoryRepository::new(&store)
        .publish_scene(PublishSceneRequest {
            version_id: "invalid".to_owned(),
            document_id: "doc".to_owned(),
            scene_bytes: bytes.to_vec(),
            schema_version: 1,
            source: HistoryVersionSource::Automatic,
            protected_action: None,
            recorded_at: 1,
            sequence: 1,
        })
        .unwrap();
    assert!(super::history::load_history_scene(&store, "doc", "invalid").is_err());
    store
        .reachability()
        .remove_committed_version("invalid")
        .unwrap();
    let key = ObjectKey::scene(format!("{:x}", Sha256::digest(bytes))).unwrap();
    let report = store
        .reachability()
        .collect(
            [GcCandidate::registered(key.clone(), SystemTime::UNIX_EPOCH)],
            SystemTime::now(),
            Duration::ZERO,
            |_| Ok::<(), String>(()),
        )
        .unwrap();
    assert_eq!(report.deleted, vec![key]);
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

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
