use std::{
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

use super::*;
use crate::database::repository::{
    DraftRepository, FileIndexRepository, SqliteRepository, WorkspaceRecord, WorkspaceRepository,
};
use crate::history::{
    gc::{ObjectKey, ObjectReferences},
    identity::FileSystemIdentity,
    operation::{OperationObjectPin, OperationRequest},
    store::HistoryStore,
    types::{HistoryOperationKind, HistoryOperationState},
};

fn fixture() -> (PathBuf, PathBuf, HistoryStore, String, String, String) {
    let root = std::env::temp_dir().join(format!("history-reconcile-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&root).expect("create fixture");
    let document = root.join("drawing.excalidraw");
    let old = br#"{"type":"excalidraw","version":2,"elements":[]}"#;
    fs::write(&document, old).expect("write old file");
    let store = HistoryStore::open_version_history_root(&root.join("history")).expect("open store");
    let old_identity = FileSystemIdentity::from_path(&document)
        .expect("old identity")
        .to_string();
    store
        .with_connection(|connection| {
            connection.execute(
            "INSERT INTO history_documents (id, canonical_path, filesystem_device, filesystem_inode,
             filesystem_file_size, filesystem_modified_seconds, filesystem_modified_nanos,
             filesystem_reliable, last_self_written_hash, created_at, state)
             VALUES ('doc', ?1, NULL, NULL, 0, 0, 0, 0, NULL, 1, 'active')",
            [&document.to_string_lossy().to_string()],
        )?;
            Ok(())
        })
        .expect("insert document");
    (
        root,
        document,
        store,
        sha256_hex(old),
        old_identity,
        "doc".to_owned(),
    )
}

fn canonical_path(path: &Path) -> String {
    path.canonicalize()
        .expect("canonical path")
        .display()
        .to_string()
}

fn begin_operation(
    store: &HistoryStore,
    id: &str,
    old_hash: Option<String>,
    old_identity: Option<String>,
    new_hash: Option<String>,
    new_identity: Option<String>,
    scene_hash: Option<String>,
) {
    let operations = OperationStore::new(store);
    operations
        .begin(
            OperationRequest {
                idempotency_id: id.to_owned(),
                document_id: "doc".to_owned(),
                session_generation: 1,
                revision: 1,
                kind: HistoryOperationKind::Replace,
                protection_version_id: None,
                expected_old_disk_hash: old_hash,
                expected_old_identity: old_identity,
                prepared_target_identity: new_identity.clone(),
                target_scene_hash: scene_hash.clone(),
                target_manifest_hash: new_hash.clone(),
                temp_file: None,
                target_object_pins: scene_hash
                    .as_ref()
                    .map(|hash| vec![OperationObjectPin::scene(hash.clone())])
                    .unwrap_or_default(),
            },
            1,
        )
        .expect("begin operation");
    operations
        .transition(
            id,
            HistoryOperationState::Reconcile,
            OperationUpdate {
                observed_published_identity: new_identity,
                actual_target_byte_hash: new_hash,
                ..OperationUpdate::default()
            },
            2,
        )
        .expect("mark reconcile");
}

fn begin_operation_before_publish_observation(
    store: &HistoryStore,
    id: &str,
    old_hash: String,
    old_identity: String,
    target_scene_hash: String,
) {
    let operations = OperationStore::new(store);
    operations
        .begin(
            OperationRequest {
                idempotency_id: id.to_owned(),
                document_id: "doc".to_owned(),
                session_generation: 1,
                revision: 1,
                kind: HistoryOperationKind::Replace,
                protection_version_id: Some("protected-version".to_owned()),
                expected_old_disk_hash: Some(old_hash),
                expected_old_identity: Some(old_identity),
                prepared_target_identity: Some("replacement-target-fingerprint".to_owned()),
                target_scene_hash: Some(target_scene_hash.clone()),
                target_manifest_hash: None,
                temp_file: None,
                target_object_pins: vec![OperationObjectPin::scene(target_scene_hash)],
            },
            1,
        )
        .expect("begin operation before publish observation");
    operations
        .transition(
            id,
            HistoryOperationState::Reconcile,
            OperationUpdate::default(),
            2,
        )
        .expect("mark operation for restart reconciliation");
}

#[test]
fn old_identity_and_hash_abort_without_touching_file() {
    let (root, _document, store, old_hash, old_identity, _) = fixture();
    begin_operation(
        &store,
        "old",
        Some(old_hash),
        Some(old_identity),
        None,
        None,
        None,
    );
    let report = reconcile_incomplete_operations(&store).expect("reconcile");
    assert!(matches!(
        report.outcomes.as_slice(),
        [ReconciliationOutcome::Aborted { .. }]
    ));
    assert_eq!(
        OperationStore::new(&store)
            .load("old")
            .expect("load")
            .expect("row")
            .state,
        HistoryOperationState::Aborted
    );
    drop(store);
    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn new_hash_without_durable_published_identity_is_conflict() {
    let (root, document, store, old_hash, old_identity, _) = fixture();
    let new = br#"{"type":"excalidraw","version":2,"elements":[{"id":"new"}]}"#;
    fs::write(&document, new).expect("write new file");
    begin_operation(
        &store,
        "new",
        Some(old_hash),
        Some(old_identity),
        Some(sha256_hex(new)),
        None,
        None,
    );
    let report = reconcile_incomplete_operations(&store).expect("reconcile");
    assert!(matches!(
        report.outcomes.as_slice(),
        [ReconciliationOutcome::Conflict { .. }]
    ));
    drop(store);
    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn rename_completed_before_publish_observation_recovers_from_durable_target() {
    let (root, document, store, old_hash, old_identity, _) = fixture();
    let new = br#"{"type":"excalidraw","version":2,"elements":[{"id":"durable-target"}]}"#;
    fs::write(&document, new).expect("write renamed target");
    let scene = store
        .persist_scene(new, 1, 1)
        .expect("persist durable target scene");
    let target_scene_hash = scene.hash.clone();
    begin_operation_before_publish_observation(
        &store,
        "after-rename",
        old_hash,
        old_identity,
        target_scene_hash.clone(),
    );
    store
        .reachability()
        .restore_operation_pin(
            "after-rename".to_owned(),
            ObjectReferences::from_objects(vec![
                ObjectKey::scene(target_scene_hash.clone()).expect("target scene key")
            ]),
        )
        .expect("retain completed target");

    let report = reconcile_incomplete_operations(&store).expect("reconcile renamed target");
    assert!(matches!(
        report.outcomes.as_slice(),
        [ReconciliationOutcome::Completed { .. }]
    ));
    let operation = OperationStore::new(&store)
        .load("after-rename")
        .expect("load operation")
        .expect("operation row");
    assert_eq!(operation.state, HistoryOperationState::Completed);
    assert_eq!(operation.actual_target_byte_hash, Some(sha256_hex(new)));
    assert!(operation.observed_published_identity.is_some());
    let garbage = store
        .collect_garbage(SystemTime::now(), std::time::Duration::ZERO)
        .expect("collect after completed reconciliation");
    assert!(!garbage
        .deleted
        .iter()
        .any(|object| object.hash == target_scene_hash));
    assert!(store
        .objects()
        .scene_path(&target_scene_hash)
        .expect("target scene path")
        .is_file());
    drop(store);
    let reopened = HistoryStore::open_version_history_root(&root.join("history"))
        .expect("reopen completed history store");
    let restart_garbage = reopened
        .collect_garbage(SystemTime::now(), std::time::Duration::ZERO)
        .expect("collect after restart");
    assert!(!restart_garbage
        .deleted
        .iter()
        .any(|object| object.hash == target_scene_hash));
    assert!(reopened
        .objects()
        .scene_path(&target_scene_hash)
        .expect("reopened target scene path")
        .is_file());
    drop(reopened);
    fs::remove_dir_all(root).expect("cleanup");
}

#[tokio::test]
async fn late_external_write_after_main_metadata_stays_pending() {
    let (root, document, store, old_hash, old_identity, _) = fixture();
    let repository = SqliteRepository::open(&root.join("main.sqlite3"))
        .await
        .expect("open main repository");
    repository
        .workspace_upsert(WorkspaceRecord {
            id: "workspace".to_owned(),
            name: "Workspace".to_owned(),
            root_path: root.display().to_string(),
            created_at: 1,
            mounted: true,
        })
        .await
        .expect("workspace");
    repository
        .draft_upsert(crate::database::repository::DraftRecord {
            file_path: canonical_path(&document),
            scene_json: "{\"stale\":true}".to_owned(),
            content_hash: "stale".to_owned(),
            base_hash: None,
            updated_at: 1,
            is_dirty: true,
        })
        .await
        .expect("stale draft");
    let new = br#"{"type":"excalidraw","version":2,"elements":[{"id":"new"}]}"#;
    let late = br#"{"type":"excalidraw","version":2,"elements":[{"id":"late-external"}]}"#;
    fs::write(&document, new).expect("write new file");
    let scene = store
        .persist_scene(new, 1, 1)
        .expect("persist target scene");
    begin_operation_before_publish_observation(
        &store,
        "late-external-write",
        old_hash,
        old_identity,
        scene.hash,
    );
    install_late_external_write("late-external-write", late.to_vec());

    let report = reconcile_incomplete_operations_with_repository(&store, &repository)
        .await
        .expect("cross-db reconcile");
    assert!(matches!(
        report.outcomes.as_slice(),
        [ReconciliationOutcome::Pending { .. }]
    ));
    assert_eq!(
        OperationStore::new(&store)
            .load("late-external-write")
            .expect("load operation")
            .expect("operation row")
            .state,
        HistoryOperationState::Reconcile
    );
    assert_eq!(fs::read(&document).expect("read late target"), late);
    drop(repository);
    drop(store);
    fs::remove_dir_all(root).expect("cleanup");
}

#[tokio::test]
async fn identity_drift_before_history_metadata_transaction_stays_pending() {
    let (root, document, store, old_hash, old_identity, _) = fixture();
    let repository = SqliteRepository::open(&root.join("main.sqlite3"))
        .await
        .expect("open main repository");
    repository
        .workspace_upsert(WorkspaceRecord {
            id: "workspace".to_owned(),
            name: "Workspace".to_owned(),
            root_path: root.display().to_string(),
            created_at: 1,
            mounted: true,
        })
        .await
        .expect("workspace");
    repository
        .draft_upsert(crate::database::repository::DraftRecord {
            file_path: canonical_path(&document),
            scene_json: "{\"stale\":true}".to_owned(),
            content_hash: "stale".to_owned(),
            base_hash: None,
            updated_at: 1,
            is_dirty: true,
        })
        .await
        .expect("stale draft");
    let new = br#"{"type":"excalidraw","version":2,"elements":[{"id":"new"}]}"#;
    let late = br#"{"type":"excalidraw","version":2,"elements":[{"id":"identity-drift"}]}"#;
    fs::write(&document, new).expect("write new file");
    let scene = store
        .persist_scene(new, 1, 1)
        .expect("persist target scene");
    begin_operation_before_publish_observation(
        &store,
        "identity-drift",
        old_hash,
        old_identity,
        scene.hash,
    );
    install_precommit_external_write("identity-drift", late.to_vec());

    let report = reconcile_incomplete_operations_with_repository(&store, &repository)
        .await
        .expect("cross-db reconcile");
    assert!(matches!(
        report.outcomes.as_slice(),
        [ReconciliationOutcome::Pending { .. }]
    ));
    assert_eq!(
        OperationStore::new(&store)
            .load("identity-drift")
            .expect("load operation")
            .expect("operation row")
            .state,
        HistoryOperationState::Reconcile
    );
    let history_hash = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT last_self_written_hash FROM history_documents WHERE id = 'doc'",
                [],
                |row| row.get::<_, Option<String>>(0),
            )
        })
        .expect("read history identity");
    assert!(history_hash.is_none());
    assert_eq!(
        fs::read(&document).expect("read identity-drift target"),
        late
    );
    drop(repository);
    drop(store);
    fs::remove_dir_all(root).expect("cleanup");
}

#[tokio::test]
async fn repository_reconciliation_recovers_durable_rename_gap() {
    let (root, document, store, old_hash, old_identity, _) = fixture();
    let repository = SqliteRepository::open(&root.join("main.sqlite3"))
        .await
        .expect("open main repository");
    repository
        .workspace_upsert(WorkspaceRecord {
            id: "workspace".to_owned(),
            name: "Workspace".to_owned(),
            root_path: root.display().to_string(),
            created_at: 1,
            mounted: true,
        })
        .await
        .expect("workspace");
    repository
        .draft_upsert(crate::database::repository::DraftRecord {
            file_path: canonical_path(&document),
            scene_json: "{\"stale\":true}".to_owned(),
            content_hash: "stale".to_owned(),
            base_hash: None,
            updated_at: 1,
            is_dirty: true,
        })
        .await
        .expect("stale draft");
    let new = br#"{"type":"excalidraw","version":2,"elements":[{"id":"repository-gap"}]}"#;
    fs::write(&document, new).expect("write new file");
    let scene = store
        .persist_scene(new, 1, 1)
        .expect("persist target scene");
    begin_operation_before_publish_observation(
        &store,
        "repository-gap",
        old_hash,
        old_identity,
        scene.hash,
    );

    let report = reconcile_incomplete_operations_with_repository(&store, &repository)
        .await
        .expect("cross-db reconcile");
    assert!(matches!(
        report.outcomes.as_slice(),
        [ReconciliationOutcome::Completed { .. }]
    ));
    let draft = repository
        .draft_get(canonical_path(&document))
        .await
        .expect("draft get")
        .expect("draft row");
    assert_eq!(draft.content_hash, sha256_hex(new));
    assert!(!draft.is_dirty);
    assert_eq!(
        OperationStore::new(&store)
            .load("repository-gap")
            .expect("load operation")
            .expect("operation row")
            .state,
        HistoryOperationState::Completed
    );
    drop(repository);
    drop(store);
    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn durable_target_mismatch_remains_conflict_after_rename() {
    let (root, document, store, old_hash, old_identity, _) = fixture();
    let expected = br#"{"type":"excalidraw","version":2,"elements":[{"id":"expected"}]}"#;
    let attacker = br#"{"type":"excalidraw","version":2,"elements":[{"id":"attacker"}]}"#;
    let scene = store
        .persist_scene(expected, 1, 1)
        .expect("persist expected target scene");
    fs::write(&document, attacker).expect("write unrelated new bytes");
    begin_operation_before_publish_observation(
        &store,
        "after-rename-mismatch",
        old_hash,
        old_identity,
        scene.hash,
    );

    let report = reconcile_incomplete_operations(&store).expect("reconcile mismatch");
    assert!(matches!(
        report.outcomes.as_slice(),
        [ReconciliationOutcome::Conflict { .. }]
    ));
    assert_eq!(
        OperationStore::new(&store)
            .load("after-rename-mismatch")
            .expect("load operation")
            .expect("operation row")
            .state,
        HistoryOperationState::Conflict
    );
    drop(store);
    fs::remove_dir_all(root).expect("cleanup");
}

#[test]
fn published_target_is_validated_synced_and_completed_without_rewriting_bytes() {
    let (root, document, store, old_hash, old_identity, _) = fixture();
    let new = br#"{"type":"excalidraw","version":2,"elements":[{"id":"new"}]}"#;
    fs::write(&document, new).expect("write new file");
    let target_identity = FileSystemIdentity::from_path(&document)
        .expect("target identity")
        .to_string();
    let scene = store
        .persist_scene(new, 1, 1)
        .expect("persist target scene");
    begin_operation(
        &store,
        "complete",
        Some(old_hash),
        Some(old_identity),
        Some(sha256_hex(new)),
        Some(target_identity),
        Some(scene.hash),
    );
    let before = fs::read(&document).expect("read target");
    let report = reconcile_incomplete_operations(&store).expect("reconcile");
    assert!(matches!(
        report.outcomes.as_slice(),
        [ReconciliationOutcome::Completed { .. }]
    ));
    assert_eq!(fs::read(&document).expect("read target"), before);
    assert_eq!(
        OperationStore::new(&store)
            .load("complete")
            .expect("load")
            .expect("row")
            .state,
        HistoryOperationState::Completed
    );
    drop(store);
    fs::remove_dir_all(root).expect("cleanup");
}

#[tokio::test]
async fn new_state_repairs_main_sqlite_before_completed() {
    let (root, document, store, old_hash, old_identity, _) = fixture();
    let repository = SqliteRepository::open(&root.join("main.sqlite3"))
        .await
        .expect("open main repository");
    repository
        .workspace_upsert(WorkspaceRecord {
            id: "workspace".to_owned(),
            name: "Workspace".to_owned(),
            root_path: root.display().to_string(),
            created_at: 1,
            mounted: true,
        })
        .await
        .expect("workspace");
    repository
        .draft_upsert(crate::database::repository::DraftRecord {
            file_path: canonical_path(&document),
            scene_json: "{\"stale\":true}".to_owned(),
            content_hash: "stale".to_owned(),
            base_hash: None,
            updated_at: 1,
            is_dirty: true,
        })
        .await
        .expect("stale draft");
    let new = br#"{"type":"excalidraw","version":2,"elements":[{"id":"new"}]}"#;
    fs::write(&document, new).expect("write new file");
    let target_identity = FileSystemIdentity::from_path(&document)
        .expect("target identity")
        .to_string();
    let scene = store
        .persist_scene(new, 1, 1)
        .expect("persist target scene");
    begin_operation(
        &store,
        "cross-db-new",
        Some(old_hash),
        Some(old_identity),
        Some(sha256_hex(new)),
        Some(target_identity),
        Some(scene.hash),
    );

    let report = reconcile_incomplete_operations_with_repository(&store, &repository)
        .await
        .expect("cross-db reconcile");
    assert!(matches!(
        report.outcomes.as_slice(),
        [ReconciliationOutcome::Completed { .. }]
    ));
    let draft = repository
        .draft_get(canonical_path(&document))
        .await
        .expect("draft get")
        .expect("draft row");
    assert_eq!(
        draft.scene_json,
        String::from_utf8(new.to_vec()).expect("utf8")
    );
    assert!(!draft.is_dirty);
    assert_eq!(draft.base_hash, Some(sha256_hex(new)));
    let index = repository
        .file_index_get(canonical_path(&document))
        .await
        .expect("index get")
        .expect("index row");
    assert_eq!(index.content_hash, Some(sha256_hex(new)));
    assert_eq!(index.file_size, new.len() as i64);
    assert_eq!(
        OperationStore::new(&store)
            .load("cross-db-new")
            .expect("load")
            .expect("row")
            .state,
        HistoryOperationState::Completed
    );
    drop(repository);
    drop(store);
    fs::remove_dir_all(root).expect("cleanup");
}

#[tokio::test]
async fn old_state_cleans_stale_post_operation_draft_before_aborted() {
    let (root, document, store, old_hash, old_identity, _) = fixture();
    let repository = SqliteRepository::open(&root.join("main.sqlite3"))
        .await
        .expect("open main repository");
    repository
        .workspace_upsert(WorkspaceRecord {
            id: "workspace".to_owned(),
            name: "Workspace".to_owned(),
            root_path: root.display().to_string(),
            created_at: 1,
            mounted: true,
        })
        .await
        .expect("workspace");
    repository
        .draft_upsert(crate::database::repository::DraftRecord {
            file_path: canonical_path(&document),
            scene_json: "{\"stale\":true}".to_owned(),
            content_hash: "stale".to_owned(),
            base_hash: None,
            updated_at: 2,
            is_dirty: true,
        })
        .await
        .expect("stale draft");
    begin_operation(
        &store,
        "cross-db-old",
        Some(old_hash.clone()),
        Some(old_identity),
        None,
        None,
        None,
    );
    let report = reconcile_incomplete_operations_with_repository(&store, &repository)
        .await
        .expect("cross-db reconcile");
    assert!(matches!(
        report.outcomes.as_slice(),
        [ReconciliationOutcome::Aborted { .. }]
    ));
    let draft = repository
        .draft_get(canonical_path(&document))
        .await
        .expect("draft get")
        .expect("draft row");
    assert_eq!(draft.content_hash, old_hash);
    assert!(!draft.is_dirty);
    assert_eq!(
        OperationStore::new(&store)
            .load("cross-db-old")
            .expect("load")
            .expect("row")
            .state,
        HistoryOperationState::Aborted
    );
    drop(repository);
    drop(store);
    fs::remove_dir_all(root).expect("cleanup");
}

#[tokio::test]
async fn new_state_without_workspace_authority_stays_pending() {
    let (root, document, store, old_hash, old_identity, _) = fixture();
    let repository = SqliteRepository::open(&root.join("main.sqlite3"))
        .await
        .expect("open main repository");
    repository
        .draft_upsert(crate::database::repository::DraftRecord {
            file_path: canonical_path(&document),
            scene_json: "{\"stale\":true}".to_owned(),
            content_hash: "stale".to_owned(),
            base_hash: None,
            updated_at: 2,
            is_dirty: true,
        })
        .await
        .expect("stale draft");
    let new = br#"{"type":"excalidraw","version":2,"elements":[{"id":"new"}]}"#;
    fs::write(&document, new).expect("write new file");
    let target_identity = FileSystemIdentity::from_path(&document)
        .expect("target identity")
        .to_string();
    let scene = store
        .persist_scene(new, 1, 1)
        .expect("persist target scene");
    begin_operation(
        &store,
        "cross-db-pending",
        Some(old_hash),
        Some(old_identity),
        Some(sha256_hex(new)),
        Some(target_identity),
        Some(scene.hash),
    );
    let report = reconcile_incomplete_operations_with_repository(&store, &repository)
        .await
        .expect("cross-db reconcile");
    assert!(matches!(
        report.outcomes.as_slice(),
        [ReconciliationOutcome::Pending { .. }]
    ));
    assert_eq!(
        OperationStore::new(&store)
            .load("cross-db-pending")
            .expect("load")
            .expect("row")
            .state,
        HistoryOperationState::Reconcile
    );
    let draft = repository
        .draft_get(canonical_path(&document))
        .await
        .expect("draft get")
        .expect("draft row");
    assert_eq!(draft.content_hash, "stale");
    drop(repository);
    drop(store);
    fs::remove_dir_all(root).expect("cleanup");
}

#[cfg(feature = "e2e-harness")]
#[test]
fn e2e_history_reconcile_hook_reaches_rename_delete_repair_boundary() {
    use crate::e2e_harness::{
        history_fault_test_hits, history_fault_test_scope, HistoryFaultStage,
    };

    let scope = history_fault_test_scope(HistoryFaultStage::RenameDeleteRepair);
    let (root, document, store, old_hash, old_identity, _) = fixture();
    let new = br#"{"type":"excalidraw","version":2,"elements":[{"id":"new"}]}"#;
    fs::write(&document, new).expect("write new file");
    let target_identity = FileSystemIdentity::from_path(&document)
        .expect("target identity")
        .to_string();
    let scene = store
        .persist_scene(new, 1, 1)
        .expect("persist target scene");
    begin_operation(
        &store,
        "repair-boundary",
        Some(old_hash),
        Some(old_identity),
        Some(sha256_hex(new)),
        Some(target_identity),
        Some(scene.hash),
    );
    let report = reconcile_incomplete_operations(&store).expect("reconcile");
    assert!(matches!(
        report.outcomes.as_slice(),
        [ReconciliationOutcome::Completed { .. }]
    ));
    assert_eq!(
        history_fault_test_hits(),
        vec![HistoryFaultStage::RenameDeleteRepair]
    );
    drop(scope);
    drop(store);
    fs::remove_dir_all(root).expect("cleanup");
}
