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

fn delete_fixture() -> (std::path::PathBuf, crate::history::store::HistoryStore) {
    let root = std::env::temp_dir().join(format!("history-delete-{}", Uuid::new_v4()));
    let store = crate::history::store::HistoryStore::open_version_history_root(&root)
        .expect("open history store");
    store
        .with_connection(|connection| {
            connection.execute(
                "INSERT INTO history_documents (id, canonical_path, created_at, state)
                 VALUES ('doc', '/tmp/delete.excalidraw', 0, 'active')",
                [],
            )?;
            Ok(())
        })
        .expect("insert history document");
    (root, store)
}

fn publish_delete_version(
    store: &crate::history::store::HistoryStore,
    version_id: &str,
    source: crate::history::types::HistoryVersionSource,
) {
    crate::history::repository::HistoryRepository::new(store)
        .publish_scene(crate::history::repository::PublishSceneRequest {
            version_id: version_id.to_owned(),
            document_id: "doc".to_owned(),
            scene_bytes: br#"{"type":"excalidraw","elements":[],"appState":{},"files":{}}"#
                .to_vec(),
            schema_version: 1,
            source,
            protected_action: (source == crate::history::types::HistoryVersionSource::Protected)
                .then_some(crate::history::types::HistoryProtectedAction::Clear),
            recorded_at: 1,
            sequence: 1,
        })
        .expect("publish version");
}

#[test]
fn delete_removes_only_selected_version_and_is_idempotent() {
    let (root, store) = delete_fixture();
    publish_delete_version(
        &store,
        "manual-1",
        crate::history::types::HistoryVersionSource::Manual,
    );
    publish_delete_version(
        &store,
        "manual-2",
        crate::history::types::HistoryVersionSource::Manual,
    );

    let repository = crate::history::repository::HistoryRepository::new(&store);
    let deleted = repository
        .delete_version("delete-1", "doc", "manual-1", 2)
        .expect("delete selected version");
    assert_eq!(deleted.version_id, "manual-1");
    assert_eq!(
        store
            .with_connection(|connection| {
                connection.query_row(
                    "SELECT COUNT(*) FROM history_versions WHERE document_id = 'doc'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
            })
            .expect("count versions"),
        1
    );
    assert!(store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM history_versions WHERE id = 'manual-2')",
                [],
                |row| row.get::<_, bool>(0),
            )
        })
        .expect("read remaining version"));
    let retry = repository
        .delete_version("delete-1", "doc", "manual-1", 3)
        .expect("retry delete");
    assert_eq!(retry, deleted);
    drop(store);
    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn delete_refuses_a_version_referenced_by_an_incomplete_operation() {
    let (root, store) = delete_fixture();
    publish_delete_version(
        &store,
        "protected-1",
        crate::history::types::HistoryVersionSource::Protected,
    );
    store
        .with_connection(|connection| {
            connection.execute(
                "INSERT INTO history_operations
                 (idempotency_id, document_id, session_generation, revision, kind,
                  protection_version_id, target_object_pins_json, state, created_at, updated_at)
                 VALUES ('replace-1', 'doc', 0, 0, 'replace', 'protected-1', '[]',
                         'protected', 1, 1)",
                [],
            )?;
            Ok(())
        })
        .expect("insert active operation");

    let error = crate::history::repository::HistoryRepository::new(&store)
        .delete_version("delete-1", "doc", "protected-1", 2)
        .expect_err("active operation must protect version");
    assert!(matches!(
        error,
        crate::history::repository::HistoryRepositoryError::VersionInUse
    ));
    assert!(store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM history_versions WHERE id = 'protected-1')",
                [],
                |row| row.get::<_, bool>(0),
            )
        })
        .expect("read protected version"));
    drop(store);
    fs::remove_dir_all(root).expect("remove fixture");
}

#[test]
fn delete_keeps_objects_alive_when_an_operation_pin_still_references_them() {
    let (root, store) = delete_fixture();
    publish_delete_version(
        &store,
        "manual-1",
        crate::history::types::HistoryVersionSource::Manual,
    );
    let scene_hash = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT scene_hash FROM history_versions WHERE id = 'manual-1'",
                [],
                |row| row.get::<_, String>(0),
            )
        })
        .expect("read scene reference");
    let operation_pin = store
        .reachability()
        .acquire_operation_pin(
            "replace-1",
            crate::history::gc::ObjectReferences::new(scene_hash.clone(), std::iter::empty())
                .expect("build operation reference"),
        )
        .expect("pin scene object");

    crate::history::repository::HistoryRepository::new(&store)
        .delete_version("delete-1", "doc", "manual-1", 2)
        .expect("delete semantic version");
    let object = crate::history::gc::ObjectKey::scene(scene_hash).expect("scene object key");
    let report = store
        .reachability()
        .collect(
            [crate::history::gc::GcCandidate::registered(
                object.clone(),
                std::time::SystemTime::UNIX_EPOCH,
            )],
            std::time::SystemTime::now(),
            std::time::Duration::ZERO,
            |_| Ok::<(), String>(()),
        )
        .expect("collect pinned object");
    assert_eq!(report.retained, vec![object]);
    operation_pin.release().expect("release operation pin");
    drop(store);
    fs::remove_dir_all(root).expect("remove fixture");
}

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
