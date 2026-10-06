use std::{fs, path::PathBuf};

use uuid::Uuid;

use super::{
    super::{gc::ReachabilityGate, store::HistoryStore},
    HistoryOperationKind, HistoryOperationState, OperationObjectPin, OperationRequest,
    OperationStore, OperationUpdate,
};

fn fixture() -> (PathBuf, HistoryStore) {
    let root = std::env::temp_dir().join(format!(
        "excalidraw-history-operation-{}-{}",
        std::process::id(),
        Uuid::new_v4()
    ));
    let store = HistoryStore::open_version_history_root(&root)
        .unwrap_or_else(|error| panic!("open history store: {error}"));
    store
        .with_connection(|connection| {
            connection.execute(
                "INSERT INTO history_documents
                 (id, canonical_path, created_at, state)
                 VALUES ('doc', '/tmp/history-operation.excalidraw', 1, 'active')",
                [],
            )?;
            connection.execute(
                "INSERT INTO scene_objects
                 (hash, schema_version, codec, raw_length, relative_path, created_at)
                 VALUES (?1, 1, 'none', 0, 'objects/scenes/bb/fixture.json', 1)",
                [hash(b'b')],
            )?;
            connection.execute(
                "INSERT INTO history_versions
                 (id, document_id, scene_hash, source, protected_action, recorded_at, sequence)
                 VALUES ('protection-version', 'doc', ?1, 'protected', 'restore', 1, 1)",
                [hash(b'b')],
            )?;
            Ok(())
        })
        .unwrap_or_else(|error| panic!("insert history document: {error}"));
    (root, store)
}

fn hash(byte: u8) -> String {
    std::iter::repeat_n(byte as char, 64).collect()
}

fn request(id: &str) -> OperationRequest {
    OperationRequest {
        idempotency_id: id.to_owned(),
        document_id: "doc".to_owned(),
        session_generation: 7,
        revision: 11,
        kind: HistoryOperationKind::Replace,
        protection_version_id: None,
        expected_old_disk_hash: Some(hash(b'a')),
        expected_old_identity: Some("old-device:old-inode".to_owned()),
        prepared_target_identity: Some("target-device:target-inode".to_owned()),
        target_scene_hash: Some(hash(b'b')),
        target_manifest_hash: Some(hash(b'c')),
        temp_file: Some("/tmp/history-operation.target.tmp".to_owned()),
        target_object_pins: vec![
            OperationObjectPin::scene(hash(b'b')),
            OperationObjectPin::asset(hash(b'd')),
        ],
    }
}

#[test]
fn repeated_request_id_is_one_durable_operation() {
    let (root, store) = fixture();
    let operations = OperationStore::new(&store);
    let first = operations
        .create_or_get(request("request-1"), 10)
        .unwrap_or_else(|error| panic!("create operation: {error}"));
    let prepared = operations
        .transition(
            "request-1",
            HistoryOperationState::Protected,
            OperationUpdate {
                protection_version_id: Some("protection-version".to_owned()),
                ..OperationUpdate::default()
            },
            11,
        )
        .unwrap_or_else(|error| panic!("protect operation: {error}"));
    let retry = operations
        .create_or_get(request("request-1"), 12)
        .unwrap_or_else(|error| panic!("retry operation: {error}"));

    assert_eq!(first.idempotency_id, retry.idempotency_id);
    assert_eq!(retry.state, HistoryOperationState::Protected);
    assert_eq!(retry.temp_file, first.temp_file);
    assert_ne!(first.updated_at, prepared.updated_at);
    let raw_metadata: (String, String, String) = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT target_manifest_hash, temp_file, target_object_pins_json
                 FROM history_operations WHERE idempotency_id = 'request-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .unwrap_or_else(|error| panic!("read operation metadata: {error}"));
    assert_eq!(raw_metadata.0, hash(b'c'));
    assert_eq!(raw_metadata.1, "/tmp/history-operation.target.tmp");
    assert!(raw_metadata.2.starts_with('['));
    let count: i64 = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT COUNT(*) FROM history_operations WHERE idempotency_id = 'request-1'",
                [],
                |row| row.get(0),
            )
        })
        .unwrap_or_else(|error| panic!("count operations: {error}"));
    assert_eq!(count, 1);
    drop(store);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn lifecycle_is_monotonic_and_durable_across_reopen() {
    let (root, store) = fixture();
    {
        let operations = OperationStore::new(&store);
        operations
            .begin(request("request-2"), 20)
            .unwrap_or_else(|error| panic!("begin operation: {error}"));
        for (state, update) in [
            (
                HistoryOperationState::Protected,
                OperationUpdate {
                    protection_version_id: Some("protection-version".to_owned()),
                    ..OperationUpdate::default()
                },
            ),
            (
                HistoryOperationState::IntentCommitted,
                OperationUpdate {
                    temp_file: Some("/tmp/history-operation.target.tmp".to_owned()),
                    ..OperationUpdate::default()
                },
            ),
            (
                HistoryOperationState::TargetObserved,
                OperationUpdate {
                    observed_published_identity: Some("observed-device:observed-inode".to_owned()),
                    actual_target_byte_hash: Some(hash(b'e')),
                    ..OperationUpdate::default()
                },
            ),
            (
                HistoryOperationState::TargetPublished,
                OperationUpdate::default(),
            ),
            (
                HistoryOperationState::MetadataCommitted,
                OperationUpdate::default(),
            ),
            (HistoryOperationState::Completed, OperationUpdate::default()),
        ] {
            operations
                .transition("request-2", state, update, 21)
                .unwrap_or_else(|error| panic!("transition to {state:?}: {error}"));
        }
        let completed = operations
            .load("request-2")
            .unwrap_or_else(|error| panic!("load completed operation: {error}"))
            .unwrap_or_else(|| panic!("completed operation missing"));
        assert_eq!(completed.state, HistoryOperationState::Completed);
        assert_eq!(completed.actual_target_byte_hash, Some(hash(b'e')));
    }
    drop(store);

    let reopened = HistoryStore::open_version_history_root(&root)
        .unwrap_or_else(|error| panic!("reopen history store: {error}"));
    let operations = OperationStore::new(&reopened);
    let completed = operations
        .load("request-2")
        .unwrap_or_else(|error| panic!("load after reopen: {error}"))
        .unwrap_or_else(|| panic!("operation missing after reopen"));
    assert_eq!(completed.state, HistoryOperationState::Completed);
    assert_eq!(completed.target_object_pins.len(), 2);
    drop(reopened);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn invalid_transition_and_idempotency_conflict_are_rejected() {
    let (root, store) = fixture();
    let operations = OperationStore::new(&store);
    operations
        .begin(request("request-3"), 30)
        .unwrap_or_else(|error| panic!("begin operation: {error}"));
    let error = operations
        .transition(
            "request-3",
            HistoryOperationState::TargetPublished,
            OperationUpdate::default(),
            31,
        )
        .unwrap_err();
    assert!(matches!(
        error,
        super::OperationError::InvalidTransition { .. }
    ));

    let mut conflicting = request("request-3");
    conflicting.revision += 1;
    let error = operations.create_or_get(conflicting, 32).unwrap_err();
    assert!(matches!(
        error,
        super::OperationError::IdempotencyConflict(_)
    ));
    drop(store);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn recovery_rebuilds_pins_for_every_incomplete_operation() {
    let (root, store) = fixture();
    let operations = OperationStore::new(&store);
    operations
        .begin(request("request-4"), 40)
        .unwrap_or_else(|error| panic!("begin operation: {error}"));
    operations
        .transition(
            "request-4",
            HistoryOperationState::Protected,
            OperationUpdate::default(),
            41,
        )
        .unwrap_or_else(|error| panic!("protect operation: {error}"));
    operations
        .transition(
            "request-4",
            HistoryOperationState::IntentCommitted,
            OperationUpdate::default(),
            42,
        )
        .unwrap_or_else(|error| panic!("commit intent: {error}"));
    let gate = ReachabilityGate::new();
    let recovered = operations
        .rehydrate_incomplete_pins(&gate)
        .unwrap_or_else(|error| panic!("rehydrate operation pins: {error}"));
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].pin.operation_id(), "request-4");
    let live = gate
        .live_objects()
        .unwrap_or_else(|error| panic!("read live objects: {error}"));
    assert_eq!(live.iter().count(), 2);
    drop(recovered);
    drop(store);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn reconcile_and_conflict_are_durable_terminal_boundaries() {
    let (root, store) = fixture();
    let operations = OperationStore::new(&store);
    operations
        .begin(request("request-5"), 50)
        .unwrap_or_else(|error| panic!("begin operation: {error}"));
    operations
        .transition(
            "request-5",
            HistoryOperationState::Reconcile,
            OperationUpdate {
                error_classification: Some("target_unknown".to_owned()),
                ..OperationUpdate::default()
            },
            51,
        )
        .unwrap_or_else(|error| panic!("mark reconcile: {error}"));
    let error = operations
        .transition(
            "request-5",
            HistoryOperationState::Conflict,
            OperationUpdate::default(),
            52,
        )
        .unwrap_or_else(|error| panic!("mark conflict: {error}"));
    assert_eq!(error.state, HistoryOperationState::Conflict);
    let error = operations
        .transition(
            "request-5",
            HistoryOperationState::Completed,
            OperationUpdate::default(),
            53,
        )
        .unwrap_err();
    assert!(matches!(
        error,
        super::OperationError::InvalidTransition { .. }
    ));
    drop(store);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}
