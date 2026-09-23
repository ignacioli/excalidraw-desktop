use super::repository::{
    HistoryRepository, HistoryRepositoryError, PublishSceneRequest, RETAINED_VERSION_LIMIT,
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

#[test]
fn retains_nineteen_twenty_and_only_the_newest_twenty_first_record() {
    let (root, store) = fixture();
    let repository = HistoryRepository::new(&store);

    for index in 0..19 {
        publish(
            &repository,
            &format!("automatic-{index:02}"),
            HistoryVersionSource::Automatic,
            index,
            index as u64,
        );
    }
    assert_eq!(count(&store, Some("automatic")), 19);

    publish(
        &repository,
        "automatic-19",
        HistoryVersionSource::Automatic,
        19,
        19,
    );
    assert_eq!(count(&store, Some("automatic")), 20);

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

    assert_eq!(count(&store, Some("automatic")), RETAINED_VERSION_LIMIT);
    assert_eq!(result.evicted_version_ids, vec!["automatic-00"]);
    assert!(!ids(&store, Some("automatic")).contains(&"automatic-00".to_owned()));
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
