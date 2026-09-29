use super::repository::{
    HistoryRepository, HistoryRepositoryError, PublishAsset, PublishSceneRequest,
    RETAINED_VERSION_LIMIT,
};
use crate::history::{store::HistoryStore, types::HistoryVersionSource};
use std::{fs, path::PathBuf};
use uuid::Uuid;

fn fixture() -> (PathBuf, HistoryStore) {
    let root = std::env::temp_dir().join(format!(
        "excalidraw-history-repository-{}-{}",
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
                 VALUES ('doc', '/tmp/doc.excalidraw', 0, 'active')",
                [],
            )?;
            Ok(())
        })
        .unwrap_or_else(|error| panic!("insert fixture document: {error}"));
    (root, store)
}

fn publish(
    repository: &HistoryRepository<'_>,
    version_id: &str,
    source: HistoryVersionSource,
    recorded_at: i64,
    sequence: u64,
) {
    repository
        .publish_scene(PublishSceneRequest {
            version_id: version_id.to_owned(),
            document_id: "doc".to_owned(),
            scene_bytes: format!("scene:{version_id}").into_bytes(),
            schema_version: 1,
            source,
            protected_action: (source == HistoryVersionSource::Protected)
                .then_some(crate::history::types::HistoryProtectedAction::Restore),
            recorded_at,
            sequence,
        })
        .unwrap_or_else(|error| panic!("publish {version_id}: {error}"));
}

fn ids(store: &HistoryStore, source: Option<&str>) -> Vec<String> {
    store
        .with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id FROM history_versions
                 WHERE document_id = 'doc'
                   AND (?1 IS NULL OR source = ?1)
                 ORDER BY id",
            )?;
            let rows = statement
                .query_map([source], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .unwrap_or_else(|error| panic!("read version ids: {error}"))
}

fn count(store: &HistoryStore, source: Option<&str>) -> i64 {
    store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT COUNT(*) FROM history_versions
                 WHERE document_id = 'doc'
                   AND (?1 IS NULL OR source = ?1)",
                [source],
                |row| row.get(0),
            )
        })
        .unwrap_or_else(|error| panic!("count versions: {error}"))
}

fn mark_current(
    repository: &HistoryRepository<'_>,
    version_id: &str,
    document_id: &str,
    scene: &[u8],
    assets: Vec<PublishAsset>,
) -> (super::repository::PublishedVersion, bool) {
    repository
        .mark_current_scene_with_assets(
            PublishSceneRequest {
                version_id: version_id.to_owned(),
                document_id: document_id.to_owned(),
                scene_bytes: scene.to_vec(),
                schema_version: 1,
                source: HistoryVersionSource::Manual,
                protected_action: None,
                recorded_at: 100,
                sequence: 1,
            },
            assets,
        )
        .unwrap_or_else(|error| panic!("mark current {version_id}: {error}"))
}

#[test]
fn mark_current_reuses_complete_snapshot_sequentially_concurrently_and_after_restart() {
    let (root, store) = fixture();
    let repository = HistoryRepository::new(&store);
    let asset = || PublishAsset {
        file_id: "image-1".to_owned(),
        bytes: b"image bytes".to_vec(),
        mime_type: "image/png".to_owned(),
    };
    let (original, reused) = mark_current(
        &repository,
        "manual-original",
        "doc",
        b"complete scene",
        vec![asset()],
    );
    assert!(!reused);
    for index in 0..10 {
        let (same, reused) = mark_current(
            &repository,
            &format!("manual-repeat-{index}"),
            "doc",
            b"complete scene",
            vec![asset()],
        );
        assert!(reused);
        assert_eq!(same, original);
    }
    let simultaneous = std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            mark_current(
                &HistoryRepository::new(&store),
                "manual-concurrent-1",
                "doc",
                b"complete scene",
                vec![asset()],
            )
        });
        let second = scope.spawn(|| {
            mark_current(
                &HistoryRepository::new(&store),
                "manual-concurrent-2",
                "doc",
                b"complete scene",
                vec![asset()],
            )
        });
        (first.join().unwrap(), second.join().unwrap())
    });
    for (same, reused) in [simultaneous.0, simultaneous.1] {
        assert!(reused);
        assert_eq!(same, original);
    }
    assert_eq!(count(&store, Some("manual")), 1);
    drop(store);
    let reopened = HistoryStore::open_version_history_root(&root)
        .unwrap_or_else(|error| panic!("reopen history store: {error}"));
    let (same, reused) = mark_current(
        &HistoryRepository::new(&reopened),
        "manual-after-restart",
        "doc",
        b"complete scene",
        vec![asset()],
    );
    assert!(reused);
    assert_eq!(same, original);
    assert_eq!(count(&reopened, Some("manual")), 1);
    drop(reopened);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn simultaneous_first_marks_publish_one_row() {
    let (root, store) = fixture();
    let (first, second) = std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            mark_current(
                &HistoryRepository::new(&store),
                "manual-first-1",
                "doc",
                b"same initial scene",
                Vec::new(),
            )
        });
        let second = scope.spawn(|| {
            mark_current(
                &HistoryRepository::new(&store),
                "manual-first-2",
                "doc",
                b"same initial scene",
                Vec::new(),
            )
        });
        (first.join().unwrap(), second.join().unwrap())
    });
    assert_eq!(first.0, second.0);
    assert_ne!(first.1, second.1);
    assert_eq!(count(&store, Some("manual")), 1);
    drop(store);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn mark_current_reuses_a_row_marked_automatic_version_without_changing_source() {
    let (root, store) = fixture();
    let repository = HistoryRepository::new(&store);
    repository
        .publish_scene(PublishSceneRequest {
            version_id: "automatic-existing".to_owned(),
            document_id: "doc".to_owned(),
            scene_bytes: b"same scene".to_vec(),
            schema_version: 1,
            source: HistoryVersionSource::Automatic,
            protected_action: None,
            recorded_at: 42,
            sequence: 1,
        })
        .unwrap_or_else(|error| panic!("publish automatic version: {error}"));
    assert!(repository
        .set_marked("mark-automatic", "doc", "automatic-existing", true)
        .unwrap_or_else(|error| panic!("mark automatic version: {error}")));
    let (version, reused) = mark_current(
        &repository,
        "new-manual-candidate",
        "doc",
        b"same scene",
        Vec::new(),
    );
    assert!(reused);
    assert_eq!(version.version_id, "automatic-existing");
    assert_eq!(version.source, HistoryVersionSource::Automatic);
    assert_eq!(version.recorded_at, 42);
    assert_eq!(count(&store, None), 1);
    drop(store);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn mark_current_compares_assets_and_document_and_row_mark_preserves_snapshot() {
    let (root, store) = fixture();
    store
        .with_connection(|connection| {
            connection.execute(
                "INSERT INTO history_documents (id, canonical_path, created_at, state)
                 VALUES ('other-doc', '/tmp/other.excalidraw', 0, 'active')",
                [],
            )?;
            Ok(())
        })
        .unwrap_or_else(|error| panic!("insert second document: {error}"));
    let repository = HistoryRepository::new(&store);
    let asset = |bytes: &[u8]| PublishAsset {
        file_id: "image-1".to_owned(),
        bytes: bytes.to_vec(),
        mime_type: "image/png".to_owned(),
    };
    let (first, _) = mark_current(&repository, "first", "doc", b"scene", vec![asset(b"A")]);
    let (different_asset, reused) =
        mark_current(&repository, "second", "doc", b"scene", vec![asset(b"B")]);
    assert!(!reused);
    assert_ne!(different_asset.version_id, first.version_id);
    let (different_scene, reused) = mark_current(
        &repository,
        "third",
        "doc",
        b"changed scene",
        vec![asset(b"A")],
    );
    assert!(!reused);
    assert_ne!(different_scene.version_id, first.version_id);
    let (other_doc, reused) = mark_current(
        &repository,
        "fourth",
        "other-doc",
        b"scene",
        vec![asset(b"A")],
    );
    assert!(!reused);
    assert_ne!(other_doc.version_id, first.version_id);

    assert!(repository
        .set_marked("unmark-first", "doc", "first", false)
        .unwrap_or_else(|error| panic!("unmark first row: {error}")));
    let (remarked, reused) = mark_current(&repository, "fifth", "doc", b"scene", vec![asset(b"A")]);
    assert!(!reused);
    assert_ne!(remarked.version_id, first.version_id);
    assert!(repository
        .set_marked("mark-first", "doc", "first", true)
        .unwrap_or_else(|error| panic!("remark first row: {error}")));
    let (source, scene_hash, recorded_at): (String, String, i64) = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT source, scene_hash, recorded_at FROM history_versions WHERE id = 'first'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
        })
        .unwrap_or_else(|error| panic!("read remarked row: {error}"));
    assert_eq!(source, "manual");
    assert_eq!(scene_hash, first.scene_hash);
    assert_eq!(recorded_at, first.recorded_at);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn marking_preserves_source_and_unmarking_reenters_retention_pool() {
    let (root, store) = fixture();
    let repository = HistoryRepository::new(&store);
    publish(
        &repository,
        "automatic-00",
        HistoryVersionSource::Automatic,
        0,
        0,
    );
    assert!(repository
        .set_marked("mark-1", "doc", "automatic-00", true)
        .unwrap_or_else(|error| panic!("mark existing version: {error}")));
    assert!(repository
        .set_marked("mark-1", "doc", "automatic-00", true)
        .unwrap_or_else(|error| panic!("retry mark: {error}")));
    let (source, marked): (String, bool) = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT source, marked FROM history_versions WHERE id = 'automatic-00'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap_or_else(|error| panic!("read marked version: {error}"));
    assert_eq!(source, "automatic");
    assert!(marked);

    for index in 1..=RETAINED_VERSION_LIMIT {
        publish(
            &repository,
            &format!("automatic-{index:02}"),
            HistoryVersionSource::Automatic,
            index,
            index as u64,
        );
    }
    assert_eq!(count(&store, None), RETAINED_VERSION_LIMIT + 1);
    assert!(!repository
        .set_marked("unmark-1", "doc", "automatic-00", false)
        .unwrap_or_else(|error| panic!("unmark version: {error}")));
    assert!(!ids(&store, None).contains(&"automatic-00".to_owned()));
    drop(store);
    let reopened = HistoryStore::open_version_history_root(&root)
        .unwrap_or_else(|error| panic!("reopen after lost response: {error}"));
    assert!(!HistoryRepository::new(&reopened)
        .set_marked("unmark-1", "doc", "automatic-00", false)
        .unwrap_or_else(|error| panic!("retry pruned unmark: {error}")));
    assert_eq!(count(&reopened, None), RETAINED_VERSION_LIMIT);
    assert!(matches!(
        HistoryRepository::new(&reopened).set_marked("mark-1", "doc", "automatic-00", false),
        Err(HistoryRepositoryError::MarkRequestConflict)
    ));
    drop(reopened);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn manual_unmark_retains_historical_source() {
    let (root, store) = fixture();
    let repository = HistoryRepository::new(&store);
    publish(&repository, "manual-1", HistoryVersionSource::Manual, 1, 1);
    assert!(repository
        .set_marked("unmark-manual", "doc", "manual-1", false)
        .unwrap_or_else(|error| panic!("unmark manual version: {error}")));
    let (source, marked): (String, bool) = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT source, marked FROM history_versions WHERE id = 'manual-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap_or_else(|error| panic!("read manual version: {error}"));
    assert_eq!(source, "manual");
    assert!(!marked);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn unmark_pruning_preserves_pending_protection_and_assets_across_reopen() {
    let (root, store) = fixture();
    let repository = HistoryRepository::new(&store);
    repository
        .publish_scene_with_assets(
            PublishSceneRequest {
                version_id: "pending-protection".to_owned(),
                document_id: "doc".to_owned(),
                scene_bytes: b"protected scene".to_vec(),
                schema_version: 1,
                source: HistoryVersionSource::Protected,
                protected_action: Some(crate::history::types::HistoryProtectedAction::Restore),
                recorded_at: 0,
                sequence: 0,
            },
            vec![PublishAsset {
                file_id: "asset-1".to_owned(),
                bytes: b"protected asset".to_vec(),
                mime_type: "image/png".to_owned(),
            }],
        )
        .unwrap_or_else(|error| panic!("publish protected version: {error}"));
    let (scene_hash, asset_hash): (String, String) = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT hv.scene_hash, va.asset_hash FROM history_versions hv
                 JOIN version_assets va ON va.version_id = hv.id
                 WHERE hv.id = 'pending-protection'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .unwrap_or_else(|error| panic!("read protected hashes: {error}"));
    store
        .with_connection(|connection| {
            connection.execute(
                "INSERT INTO history_operations
             (idempotency_id, document_id, session_generation, revision, kind,
              protection_version_id, target_object_pins_json, state, created_at, updated_at)
             VALUES ('replace-pending', 'doc', 0, 0, 'replace',
                     'pending-protection', '[]', 'protected', 1, 1)",
                [],
            )?;
            Ok(())
        })
        .unwrap_or_else(|error| panic!("insert pending operation: {error}"));

    publish(&repository, "manual-1", HistoryVersionSource::Manual, 1, 1);
    for index in 2..=RETAINED_VERSION_LIMIT + 1 {
        publish(
            &repository,
            &format!("automatic-{index:02}"),
            HistoryVersionSource::Automatic,
            index,
            index as u64,
        );
    }
    assert_eq!(count(&store, None), RETAINED_VERSION_LIMIT + 2);
    assert!(!repository
        .set_marked("unmark-manual-pending", "doc", "manual-1", false)
        .unwrap_or_else(|error| panic!("unmark under pending operation: {error}")));
    assert_eq!(count(&store, None), RETAINED_VERSION_LIMIT + 1);
    assert!(ids(&store, None).contains(&"pending-protection".to_owned()));
    drop(store);

    let reopened = HistoryStore::open_version_history_root(&root)
        .unwrap_or_else(|error| panic!("reopen pending operation: {error}"));
    let live = reopened
        .reachability()
        .live_objects()
        .unwrap_or_else(|error| panic!("read rehydrated live set: {error}"));
    assert!(live.contains(
        &crate::history::gc::ObjectKey::scene(scene_hash)
            .unwrap_or_else(|error| panic!("protected scene key: {error}"))
    ));
    assert!(live.contains(
        &crate::history::gc::ObjectKey::asset(asset_hash)
            .unwrap_or_else(|error| panic!("protected asset key: {error}"))
    ));
    assert!(ids(&reopened, None).contains(&"pending-protection".to_owned()));
    assert!(!HistoryRepository::new(&reopened)
        .set_marked("unmark-manual-pending", "doc", "manual-1", false)
        .unwrap_or_else(|error| panic!("retry pruned unmark: {error}")));
    drop(reopened);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn retains_mixed_nineteen_twenty_and_only_the_newest_twenty_first_record() {
    let (root, store) = fixture();
    let repository = HistoryRepository::new(&store);

    for index in 0..19 {
        publish(
            &repository,
            &format!("automatic-{index:02}"),
            if index % 2 == 0 {
                HistoryVersionSource::Protected
            } else {
                HistoryVersionSource::Automatic
            },
            index,
            index as u64,
        );
    }
    assert_eq!(count(&store, None), 19);

    publish(
        &repository,
        "automatic-19",
        HistoryVersionSource::Protected,
        19,
        19,
    );
    assert_eq!(count(&store, None), 20);

    let result = repository
        .publish_scene(PublishSceneRequest {
            version_id: "automatic-20".to_owned(),
            document_id: "doc".to_owned(),
            scene_bytes: b"scene:automatic-20".to_vec(),
            schema_version: 1,
            source: HistoryVersionSource::Automatic,
            protected_action: None,
            recorded_at: 20,
            sequence: 20,
        })
        .unwrap_or_else(|error| panic!("publish 21st version: {error}"));

    assert_eq!(count(&store, None), RETAINED_VERSION_LIMIT);
    assert_eq!(result.evicted_version_ids, vec!["automatic-00"]);
    assert!(!ids(&store, None).contains(&"automatic-00".to_owned()));
    let live = store
        .reachability()
        .live_objects()
        .unwrap_or_else(|error| panic!("read repository reachability: {error}"));
    assert_eq!(
        live.iter()
            .filter(|object| object.kind == crate::history::gc::ObjectKind::Scene)
            .count(),
        RETAINED_VERSION_LIMIT as usize
    );
    assert!(live.iter().any(|object| object.hash == result.scene_hash));

    drop(store);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn equal_time_and_sequence_use_id_as_the_final_retention_tie_breaker() {
    let (root, store) = fixture();
    let repository = HistoryRepository::new(&store);

    for index in 0..20 {
        publish(
            &repository,
            &format!("tie-{index:02}"),
            HistoryVersionSource::Automatic,
            123,
            7,
        );
    }

    let result = repository
        .publish_scene(PublishSceneRequest {
            version_id: "tie-20".to_owned(),
            document_id: "doc".to_owned(),
            scene_bytes: b"scene:tie-20".to_vec(),
            schema_version: 1,
            source: HistoryVersionSource::Protected,
            protected_action: Some(crate::history::types::HistoryProtectedAction::Clear),
            recorded_at: 123,
            sequence: 7,
        })
        .unwrap_or_else(|error| panic!("publish tie version: {error}"));

    assert_eq!(result.evicted_version_ids, vec!["tie-00"]);
    assert!(!ids(&store, None).contains(&"tie-00".to_owned()));
    assert!(ids(&store, None).contains(&"tie-20".to_owned()));
    assert_eq!(count(&store, None), RETAINED_VERSION_LIMIT);

    drop(store);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn manual_versions_are_deduplicated_by_object_but_excluded_from_retention() {
    let (root, store) = fixture();
    let repository = HistoryRepository::new(&store);

    for index in 0..20 {
        publish(
            &repository,
            &format!("automatic-{index:02}"),
            HistoryVersionSource::Automatic,
            index,
            index as u64,
        );
    }

    let first = repository
        .publish_scene(PublishSceneRequest {
            version_id: "manual-old".to_owned(),
            document_id: "doc".to_owned(),
            scene_bytes: b"same-scene".to_vec(),
            schema_version: 1,
            source: HistoryVersionSource::Manual,
            protected_action: None,
            recorded_at: -86_400 * 30,
            sequence: 1,
        })
        .unwrap_or_else(|error| panic!("publish manual version: {error}"));
    let second = repository
        .publish_scene(PublishSceneRequest {
            version_id: "manual-new".to_owned(),
            document_id: "doc".to_owned(),
            scene_bytes: b"same-scene".to_vec(),
            schema_version: 1,
            source: HistoryVersionSource::Manual,
            protected_action: None,
            recorded_at: 1,
            sequence: 2,
        })
        .unwrap_or_else(|error| panic!("publish second manual version: {error}"));

    assert_eq!(first.scene_hash, second.scene_hash);
    assert_eq!(count(&store, Some("automatic")), 20);
    assert_eq!(count(&store, Some("manual")), 2);
    assert_eq!(count(&store, None), 22);
    let object_count: i64 = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT COUNT(*) FROM scene_objects WHERE hash = ?1",
                [&first.scene_hash],
                |row| row.get(0),
            )
        })
        .unwrap_or_else(|error| panic!("count scene objects: {error}"));
    assert_eq!(object_count, 1, "equal content must reuse one object");

    drop(store);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn scene_assets_are_published_after_the_version_row_and_kept_reachable() {
    let (root, store) = fixture();
    let published = HistoryRepository::new(&store)
        .publish_scene_with_assets(
            PublishSceneRequest {
                version_id: "manual-with-asset".to_owned(),
                document_id: "doc".to_owned(),
                scene_bytes: br#"{"files":{"image":{"dataURL":"asset://placeholder","mimeType":"image/png"}}}"#.to_vec(),
                schema_version: 1,
                source: HistoryVersionSource::Manual,
                protected_action: None,
                recorded_at: 1,
                sequence: 1,
            },
            vec![PublishAsset {
                file_id: "image".to_owned(),
                bytes: b"png-bytes".to_vec(),
                mime_type: "image/png".to_owned(),
            }],
        )
        .unwrap_or_else(|error| panic!("publish scene with asset: {error}"));

    let (asset_count, reachable_asset) = store
        .with_connection(|connection| {
            let count = connection.query_row(
                "SELECT COUNT(*) FROM version_assets WHERE version_id = ?1",
                [&published.version_id],
                |row| row.get::<_, i64>(0),
            )?;
            let hash = connection.query_row(
                "SELECT asset_hash FROM version_assets WHERE version_id = ?1",
                [&published.version_id],
                |row| row.get::<_, String>(0),
            )?;
            Ok((count, hash))
        })
        .unwrap_or_else(|error| panic!("read published asset: {error}"));
    assert_eq!(asset_count, 1);
    assert!(store
        .reachability()
        .live_objects()
        .unwrap_or_else(|error| panic!("read live objects: {error}"))
        .iter()
        .any(|object| object.hash == reachable_asset));

    drop(store);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn old_records_are_not_expired_by_age_and_failed_publication_does_not_evict() {
    let (root, store) = fixture();
    let repository = HistoryRepository::new(&store);

    publish(
        &repository,
        "ancient",
        HistoryVersionSource::Automatic,
        -86_400 * 365,
        0,
    );
    assert_eq!(count(&store, Some("automatic")), 1);

    for index in 0..19 {
        publish(
            &repository,
            &format!("old-{index:02}"),
            HistoryVersionSource::Automatic,
            -86_400 * 30 + index,
            index as u64,
        );
    }
    assert_eq!(count(&store, Some("automatic")), 20);

    let scene = store
        .put_scene(b"failed-publication", 1)
        .unwrap_or_else(|error| panic!("put failed publication scene: {error}"));
    let error = repository
        .publish(super::repository::PublishVersionRequest {
            version_id: "failed".to_owned(),
            document_id: "missing-document".to_owned(),
            scene,
            source: HistoryVersionSource::Automatic,
            protected_action: None,
            recorded_at: i64::MAX,
            sequence: 0,
        })
        .expect_err("missing document must fail publication");
    assert!(matches!(error, HistoryRepositoryError::Store(_)));
    assert_eq!(count(&store, Some("automatic")), 20);
    assert!(!ids(&store, None).contains(&"failed".to_owned()));

    drop(store);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn deleting_document_history_removes_all_semantic_rows_and_is_idempotent() {
    let (root, store) = fixture();
    let repository = HistoryRepository::new(&store);
    publish(
        &repository,
        "automatic-to-delete",
        HistoryVersionSource::Automatic,
        1,
        1,
    );
    publish(
        &repository,
        "manual-to-delete",
        HistoryVersionSource::Manual,
        2,
        2,
    );

    let deleted = repository
        .delete_document_history("document-delete-1", "doc", 3)
        .expect("delete document history");
    assert_eq!(deleted.deleted_version_ids.len(), 2);
    assert_eq!(count(&store, None), 0);
    assert_eq!(
        store
            .with_connection(|connection| {
                connection.query_row(
                    "SELECT state FROM history_documents WHERE id = 'doc'",
                    [],
                    |row| row.get::<_, String>(0),
                )
            })
            .expect("read document state"),
        "deleting"
    );
    assert_eq!(
        store
            .with_connection(|connection| {
                connection.query_row(
                    "SELECT state FROM history_operations
                     WHERE idempotency_id = 'document-delete-1'",
                    [],
                    |row| row.get::<_, String>(0),
                )
            })
            .expect("read delete operation state"),
        "completed"
    );

    let retry = repository
        .delete_document_history("document-delete-1", "doc", 4)
        .expect("retry document history delete");
    assert!(retry.deleted_version_ids.is_empty());
    drop(store);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn bulk_delete_refuses_pending_operation_and_restart_rehydrates_its_pin() {
    let (root, store) = fixture();
    let repository = HistoryRepository::new(&store);
    publish(
        &repository,
        "pending-protection",
        HistoryVersionSource::Protected,
        1,
        1,
    );
    let scene_hash = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT scene_hash FROM history_versions WHERE id = 'pending-protection'",
                [],
                |row| row.get::<_, String>(0),
            )
        })
        .expect("read pending protection hash");
    store
        .with_connection(|connection| {
            connection.execute(
                "INSERT INTO history_operations
                 (idempotency_id, document_id, session_generation, revision, kind,
                  protection_version_id, target_object_pins_json, state, created_at, updated_at)
                 VALUES ('replace-pending', 'doc', 0, 0, 'replace',
                         'pending-protection', '[]', 'protected', 2, 2)",
                [],
            )?;
            Ok(())
        })
        .expect("insert pending operation");

    let error = repository
        .delete_document_history("document-delete-pending", "doc", 3)
        .expect_err("pending operation must block bulk deletion");
    assert!(matches!(error, HistoryRepositoryError::DeletePending));
    assert_eq!(count(&store, None), 1);
    assert_eq!(
        store
            .with_connection(|connection| {
                connection.query_row(
                    "SELECT state FROM history_documents WHERE id = 'doc'",
                    [],
                    |row| row.get::<_, String>(0),
                )
            })
            .expect("read document state"),
        "active"
    );
    drop(store);

    // Reopening the same history root proves the semantic row remains the
    // durable source for rehydrating the pending operation's object pin.
    let reopened = HistoryStore::open_version_history_root(&root).expect("reopen history store");
    let scene_key = crate::history::gc::ObjectKey::scene(scene_hash).expect("scene key");
    assert!(reopened
        .reachability()
        .live_objects()
        .expect("read rehydrated live set")
        .contains(&scene_key));
    drop(reopened);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn bulk_delete_preserves_shared_objects_and_operation_pins() {
    let (root, store) = fixture();
    store
        .with_connection(|connection| {
            connection.execute(
                "INSERT INTO history_documents
                 (id, canonical_path, created_at, state)
                 VALUES ('doc-2', '/tmp/doc-2.excalidraw', 0, 'active')",
                [],
            )?;
            Ok(())
        })
        .expect("insert second document");
    let scene = br#"{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}"#;
    let repository = HistoryRepository::new(&store);
    for (document_id, version_id) in [("doc", "shared-1"), ("doc-2", "shared-2")] {
        let object = store.put_scene(scene, 1).expect("write shared scene");
        repository
            .publish(crate::history::repository::PublishVersionRequest {
                version_id: version_id.to_owned(),
                document_id: document_id.to_owned(),
                scene: object,
                source: HistoryVersionSource::Manual,
                protected_action: None,
                recorded_at: 1,
                sequence: 1,
            })
            .expect("publish shared scene");
    }
    let scene_hash = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT scene_hash FROM history_versions WHERE id = 'shared-1'",
                [],
                |row| row.get::<_, String>(0),
            )
        })
        .expect("read shared scene hash");
    let pin = store
        .reachability()
        .acquire_operation_pin(
            "restore-shared",
            crate::history::gc::ObjectReferences::new(scene_hash.clone(), std::iter::empty())
                .expect("build shared pin"),
        )
        .expect("pin shared scene");

    let deleted = repository
        .delete_document_history("document-delete-shared", "doc", 2)
        .expect("delete first document history");
    assert_eq!(deleted.deleted_version_ids, vec!["shared-1"]);
    assert!(deleted.gc.retained_objects >= 1);
    assert!(store
        .objects()
        .scene_path(&scene_hash)
        .expect("shared scene path")
        .is_file());
    assert_eq!(count_for_document(&store, "doc-2"), 1);
    pin.release().expect("release shared pin");
    drop(store);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn bulk_delete_preserves_an_asset_shared_by_another_document() {
    let (root, store) = fixture();
    store
        .with_connection(|connection| {
            connection.execute(
                "INSERT INTO history_documents
                 (id, canonical_path, created_at, state)
                 VALUES ('doc-2', '/tmp/doc-2.excalidraw', 0, 'active')",
                [],
            )?;
            Ok(())
        })
        .expect("insert second document");
    let scene = br#"{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}"#;
    let repository = HistoryRepository::new(&store);
    for (document_id, version_id) in [("doc", "asset-shared-1"), ("doc-2", "asset-shared-2")] {
        repository
            .publish_scene_with_assets(
                PublishSceneRequest {
                    version_id: version_id.to_owned(),
                    document_id: document_id.to_owned(),
                    scene_bytes: scene.to_vec(),
                    schema_version: 1,
                    source: HistoryVersionSource::Manual,
                    protected_action: None,
                    recorded_at: 1,
                    sequence: 1,
                },
                vec![PublishAsset {
                    file_id: "image".to_owned(),
                    bytes: b"shared-png".to_vec(),
                    mime_type: "image/png".to_owned(),
                }],
            )
            .expect("publish shared asset");
    }
    let asset_hash = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT asset_hash FROM version_assets WHERE version_id = 'asset-shared-1'",
                [],
                |row| row.get::<_, String>(0),
            )
        })
        .expect("read shared asset hash");

    let deleted = repository
        .delete_document_history("document-delete-assets", "doc", 2)
        .expect("delete first document history");
    assert_eq!(deleted.deleted_version_ids, vec!["asset-shared-1"]);
    assert!(store
        .objects()
        .asset_path(&asset_hash)
        .expect("shared asset path")
        .is_file());
    assert_eq!(count_for_document(&store, "doc-2"), 1);
    let asset_count = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT COUNT(*) FROM version_assets WHERE version_id = 'asset-shared-2'",
                [],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("count retained asset reference");
    assert_eq!(asset_count, 1);
    drop(store);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn deleting_an_unavailable_version_does_not_block_other_versions() {
    let (root, store) = fixture();
    let repository = HistoryRepository::new(&store);
    publish(
        &repository,
        "unavailable-version",
        HistoryVersionSource::Manual,
        1,
        1,
    );
    publish(
        &repository,
        "available-version",
        HistoryVersionSource::Manual,
        2,
        2,
    );
    let unavailable_hash = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT scene_hash FROM history_versions WHERE id = 'unavailable-version'",
                [],
                |row| row.get::<_, String>(0),
            )
        })
        .expect("read unavailable scene hash");
    fs::remove_file(
        store
            .objects()
            .scene_path(&unavailable_hash)
            .expect("unavailable scene path"),
    )
    .expect("remove unavailable scene object");

    repository
        .delete_version("delete-unavailable", "doc", "unavailable-version", 3)
        .expect("delete unavailable version");
    assert_eq!(count(&store, None), 1);
    assert!(store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM history_versions WHERE id = 'available-version')",
                [],
                |row| row.get::<_, bool>(0),
            )
        })
        .expect("read available version"));
    drop(store);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

#[test]
fn bulk_delete_reports_gc_failure_as_maintenance_debt_after_semantic_commit() {
    let (root, store) = fixture();
    let repository = HistoryRepository::new(&store);
    publish(
        &repository,
        "corrupt-object",
        HistoryVersionSource::Manual,
        1,
        1,
    );
    let scene_hash = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT scene_hash FROM history_versions WHERE id = 'corrupt-object'",
                [],
                |row| row.get::<_, String>(0),
            )
        })
        .expect("read corrupt scene hash");
    fs::write(
        store
            .objects()
            .scene_path(&scene_hash)
            .expect("corrupt scene path"),
        b"corrupt",
    )
    .expect("corrupt scene object");

    let deleted = repository
        .delete_document_history("document-delete-corrupt", "doc", 2)
        .expect("semantic delete remains successful");
    assert_eq!(deleted.deleted_version_ids, vec!["corrupt-object"]);
    assert!(deleted.gc.error.is_some());
    assert!(deleted.gc.maintenance_record_error.is_none());
    assert_eq!(count(&store, None), 0);
    assert_eq!(
        store
            .with_connection(|connection| {
                connection.query_row(
                    "SELECT issue_code FROM maintenance_state WHERE document_id = 'doc'",
                    [],
                    |row| row.get::<_, String>(0),
                )
            })
            .expect("read GC maintenance issue"),
        "HISTORY_GC_FAILED"
    );
    fs::write(
        store
            .objects()
            .scene_path(&scene_hash)
            .expect("repair scene path"),
        b"scene:corrupt-object",
    )
    .expect("repair scene object");
    let retried = repository
        .delete_document_history("document-delete-corrupt", "doc", 3)
        .expect("retry cleanup after repair");
    assert!(retried.gc.error.is_none());
    let remaining_issues: i64 = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT COUNT(*) FROM maintenance_state WHERE document_id = 'doc'",
                [],
                |row| row.get(0),
            )
        })
        .expect("count cleared GC maintenance issues");
    assert_eq!(remaining_issues, 0);
    drop(store);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}

fn count_for_document(store: &HistoryStore, document_id: &str) -> i64 {
    store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT COUNT(*) FROM history_versions WHERE document_id = ?1",
                [document_id],
                |row| row.get(0),
            )
        })
        .expect("count document versions")
}

#[cfg(feature = "e2e-harness")]
#[test]
fn e2e_history_repository_hooks_reach_object_and_eviction_gc_boundaries() {
    use crate::e2e_harness::{
        history_fault_test_hits, history_fault_test_scope, HistoryFaultStage,
    };

    {
        let scope = history_fault_test_scope(HistoryFaultStage::ObjectPublish);
        let (root, store) = fixture();
        publish(
            &HistoryRepository::new(&store),
            "object-boundary",
            HistoryVersionSource::Automatic,
            1,
            1,
        );
        assert_eq!(
            history_fault_test_hits(),
            vec![HistoryFaultStage::ObjectPublish]
        );
        drop(scope);
        drop(store);
        fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }

    {
        let scope = history_fault_test_scope(HistoryFaultStage::EvictionDeleteGc);
        let (root, store) = fixture();
        let repository = HistoryRepository::new(&store);
        for index in 0..=RETAINED_VERSION_LIMIT {
            publish(
                &repository,
                &format!("eviction-boundary-{index:02}"),
                HistoryVersionSource::Automatic,
                index,
                index as u64,
            );
        }
        assert_eq!(
            history_fault_test_hits().len(),
            (RETAINED_VERSION_LIMIT + 1) as usize
        );
        assert!(history_fault_test_hits()
            .iter()
            .all(|stage| *stage == HistoryFaultStage::EvictionDeleteGc));
        drop(scope);
        drop(store);
        fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }
}

#[cfg(feature = "e2e-harness")]
#[test]
fn reused_manual_mark_skips_post_commit_fault_boundary() {
    use crate::e2e_harness::{
        history_fault_test_hits, history_fault_test_scope, HistoryFaultStage,
    };

    let (root, store) = fixture();
    let repository = HistoryRepository::new(&store);
    let (original, reused) = mark_current(
        &repository,
        "manual-original",
        "doc",
        b"same scene",
        Vec::new(),
    );
    assert!(!reused);

    let scope = history_fault_test_scope(HistoryFaultStage::EvictionDeleteGc);
    let (same, reused) = mark_current(
        &repository,
        "manual-repeat",
        "doc",
        b"same scene",
        Vec::new(),
    );
    assert!(reused);
    assert_eq!(same, original);
    assert!(history_fault_test_hits().is_empty());

    let (_, reused) = mark_current(
        &repository,
        "manual-new",
        "doc",
        b"changed scene",
        Vec::new(),
    );
    assert!(!reused);
    assert_eq!(
        history_fault_test_hits(),
        vec![HistoryFaultStage::EvictionDeleteGc]
    );
    drop(scope);
    drop(store);
    fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
}
