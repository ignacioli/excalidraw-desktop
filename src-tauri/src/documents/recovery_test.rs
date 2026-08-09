use std::{fs, path::PathBuf, sync::Arc};

use crate::{
    commands::{
        dto::{RecoveryAction, RecoveryApplyRequest},
        recovery::RecoveryService,
    },
    database::repository::{SqliteRepository, WorkspaceRecord, WorkspaceRepository},
};

use super::recovery::{RecoverySnapshot, RecoveryStore, RECOVERY_SNAPSHOT_COUNT};

fn fixture_root(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "excalidraw-recovery-{name}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

fn scene_json(label: &str) -> String {
    serde_json::json!({
        "type": "excalidraw",
        "version": 2,
        "elements": [],
        "appState": {"name": label},
        "files": {}
    })
    .to_string()
}

#[test]
fn rotates_a_five_snapshot_ring_and_overwrites_the_oldest_entry() {
    let root = fixture_root("ring");
    let path = root.join("workspace").join("drawing.excalidraw");
    fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture parent");
    let store = RecoveryStore::with_app_version(&root, "0.1.0");
    let document_id = "document-ring";

    for saved_at in 1..=(RECOVERY_SNAPSHOT_COUNT as i64 + 1) {
        store
            .write_snapshot(
                document_id,
                Some(&path),
                "base-hash",
                saved_at,
                &scene_json(&format!("scene-{saved_at}")),
            )
            .expect("write recovery snapshot");
    }

    let snapshots = store
        .snapshots_for_document(document_id)
        .expect("list recovery snapshots");
    assert_eq!(snapshots.len(), RECOVERY_SNAPSHOT_COUNT);
    assert!(snapshots.iter().all(|snapshot| snapshot.saved_at >= 2));
    assert_eq!(
        store
            .latest_valid_snapshot(document_id)
            .expect("find latest snapshot")
            .expect("latest snapshot")
            .saved_at,
        6
    );

    fs::remove_dir_all(root).expect("remove recovery fixture");
}

#[test]
fn skips_a_corrupted_latest_snapshot_and_returns_the_next_newest() {
    let root = fixture_root("corruption");
    let path = root.join("workspace").join("drawing.excalidraw");
    fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture parent");
    let store = RecoveryStore::with_app_version(&root, "0.1.0");
    let document_id = "document-corruption";

    for saved_at in 1..=3 {
        store
            .write_snapshot(
                document_id,
                Some(&path),
                "base-hash",
                saved_at,
                &scene_json(&format!("scene-{saved_at}")),
            )
            .expect("write recovery snapshot");
    }
    let latest_path = store
        .latest_snapshot_path(document_id)
        .expect("find latest snapshot path")
        .expect("latest snapshot path");
    fs::write(&latest_path, b"{\"broken\":").expect("corrupt latest snapshot");

    let latest = store
        .latest_valid_snapshot(document_id)
        .expect("find fallback snapshot")
        .expect("fallback snapshot");
    assert_eq!(latest.saved_at, 2);
    assert_eq!(latest.scene["appState"]["name"], "scene-2");

    fs::remove_dir_all(root).expect("remove recovery fixture");
}

#[test]
fn skips_a_metadata_valid_snapshot_with_an_invalid_scene_shape() {
    let root = fixture_root("invalid-scene");
    let path = root.join("workspace").join("drawing.excalidraw");
    fs::create_dir_all(path.parent().expect("fixture parent")).expect("create fixture parent");
    let store = RecoveryStore::with_app_version(&root, "0.1.0");
    let document_id = "document-invalid-scene";

    for saved_at in 1..=2 {
        store
            .write_snapshot(
                document_id,
                Some(&path),
                "base-hash",
                saved_at,
                &scene_json(&format!("scene-{saved_at}")),
            )
            .expect("write recovery snapshot");
    }
    let latest_path = store
        .latest_snapshot_path(document_id)
        .expect("find latest snapshot path")
        .expect("latest snapshot path");
    let mut latest: serde_json::Value =
        serde_json::from_slice(&fs::read(&latest_path).expect("read latest snapshot"))
            .expect("parse latest snapshot");
    latest["scene"] = serde_json::json!({"elements": []});
    fs::write(
        &latest_path,
        serde_json::to_vec(&latest).expect("serialize invalid scene snapshot"),
    )
    .expect("write invalid scene snapshot");

    let fallback = store
        .latest_valid_snapshot(document_id)
        .expect("find fallback snapshot")
        .expect("fallback snapshot");
    assert_eq!(fallback.saved_at, 1);

    fs::remove_dir_all(root).expect("remove recovery fixture");
}

#[test]
fn serializes_snapshot_metadata_with_the_ipc_field_names() {
    let snapshot = RecoverySnapshot {
        document_id: "document-1".to_owned(),
        original_path: Some("/workspace/drawing.excalidraw".to_owned()),
        base_file_hash: "abc".to_owned(),
        saved_at: 42,
        app_version: "0.1.0".to_owned(),
        scene: serde_json::json!({"elements": []}),
    };

    let value = serde_json::to_value(snapshot).expect("serialize snapshot");
    assert_eq!(value["documentId"], "document-1");
    assert_eq!(value["originalPath"], "/workspace/drawing.excalidraw");
    assert_eq!(value["baseFileHash"], "abc");
    assert_eq!(value["savedAt"], 42);
}

#[tokio::test]
async fn lists_and_restores_a_newer_scene_then_cleans_up_the_ring() {
    let root = fixture_root("service");
    let data = root.join("data");
    let workspace = root.join("workspace");
    fs::create_dir_all(&data).expect("create data directory");
    fs::create_dir_all(&workspace).expect("create workspace");
    let workspace = workspace.canonicalize().expect("canonicalize workspace");
    let target = workspace.join("drawing.excalidraw");
    let on_disk = scene_json("on-disk");
    let recovered = scene_json("recovered");
    fs::write(&target, &on_disk).expect("write cold document");

    let repository = Arc::new(
        SqliteRepository::open(&data.join("recovery.sqlite3"))
            .await
            .expect("open repository"),
    );
    repository
        .workspace_upsert(WorkspaceRecord {
            id: "recovery-workspace".to_owned(),
            name: "Recovery".to_owned(),
            root_path: workspace.display().to_string(),
            created_at: 1,
        })
        .await
        .expect("mount workspace");
    let store = Arc::new(RecoveryStore::with_app_version(&data, "0.1.0"));
    let document_id = super::recovery::document_id_for_path(&target);
    store
        .write_snapshot(
            &document_id,
            Some(&target),
            "different-base",
            super::recovery::unix_timestamp().expect("read clock") + 2,
            &recovered,
        )
        .expect("write recovery snapshot");
    let service = RecoveryService::new(Arc::clone(&repository), Arc::clone(&store));

    let candidates = service.list().await.expect("list recovery candidates");
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].document_id, document_id);
    assert!(candidates[0].snapshot_newer);

    let response = service
        .apply(RecoveryApplyRequest {
            document_id,
            action: RecoveryAction::Restore,
            save_as_path: None,
        })
        .await
        .expect("restore recovery scene");
    assert_eq!(
        response.scene.expect("restore scene")["appState"]["name"],
        "recovered"
    );
    assert!(store
        .list_snapshots()
        .expect("list remaining snapshots")
        .is_empty());

    fs::remove_dir_all(root).expect("remove recovery fixture");
}
