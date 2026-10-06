use std::{
    fs::{self, File},
    io,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};

use crate::{
    commands::error::AppError,
    commands::{
        dto::{WorkspaceEntryDeleteRequest, WorkspaceEntryRenameRequest},
        recovery::RecoveryService,
    },
    database::repository::{
        DraftRecord, DraftRepository, FileIndexRecord, FileIndexRepository, SqliteRepository,
        WorkspaceRecord, WorkspaceRepository,
    },
    documents::recovery::{document_id_for_path, RecoveryStore},
    history::{
        repository::{HistoryRepository, PublishSceneRequest},
        store::HistoryStore,
        types::HistoryVersionSource,
    },
    workspace_entries::{
        history_replay_for_store,
        mutation_journal::{
            apply_committed_record_with_history, filesystem_identity_for_path, journal_directory,
            load_journals, reconcile_pending_mutations, save_journal, HistoryReplay,
            MutationJournalRecord, UNCOMMITTED_JOURNAL_TTL,
        },
        DerivedStateFault, TrashOperator, WorkspaceEntryService, WorkspaceMutationGate,
    },
};

struct RemovingTrash;

impl TrashOperator for RemovingTrash {
    fn delete(&self, path: &Path) -> Result<(), io::Error> {
        if path.is_dir() {
            fs::remove_dir(path)
        } else {
            fs::remove_file(path)
        }
    }
}

struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    workspace_id: String,
    repository: Arc<SqliteRepository>,
    recovery: Arc<RecoveryStore>,
    entries: WorkspaceEntryService,
}

impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-entry-mutation-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let data = root.join("data");
        let workspace = root.join("workspace");
        fs::create_dir_all(&data).expect("create data directory");
        fs::create_dir_all(&workspace).expect("create workspace");
        let workspace = workspace.canonicalize().expect("canonicalize workspace");
        let repository = Arc::new(
            SqliteRepository::open(&data.join("state.sqlite3"))
                .await
                .expect("open repository"),
        );
        let workspace_id = "mutation-workspace".to_owned();
        repository
            .workspace_upsert(WorkspaceRecord {
                id: workspace_id.clone(),
                name: "Mutation".to_owned(),
                root_path: workspace.display().to_string(),
                created_at: 1,
                mounted: true,
            })
            .await
            .expect("mount workspace");
        let recovery = Arc::new(RecoveryStore::with_app_version(&data, "0.1.0"));
        let entries = WorkspaceEntryService::with_trash_and_recovery(
            Arc::clone(&repository),
            WorkspaceMutationGate::default(),
            Arc::new(RemovingTrash),
            Arc::clone(&recovery),
        );
        Self {
            root,
            workspace,
            workspace_id,
            repository,
            recovery,
            entries,
        }
    }

    fn drawing_path(&self, name: &str) -> PathBuf {
        self.workspace.join(name)
    }

    async fn seed_drawing(&self, name: &str, scene_label: &str) -> PathBuf {
        let path = self.drawing_path(name);
        let scene = scene_json(scene_label);
        fs::write(&path, scene.as_bytes()).expect("write drawing");
        let canonical = path.display().to_string();
        self.repository
            .file_index_upsert(FileIndexRecord {
                canonical_path: canonical.clone(),
                workspace_id: self.workspace_id.clone(),
                display_name: name.to_owned(),
                relative_path: name.to_owned(),
                mtime: 1,
                file_size: 2,
                content_hash: None,
            })
            .await
            .expect("seed file index");
        self.repository
            .draft_upsert(DraftRecord {
                file_path: canonical,
                scene_json: scene.clone(),
                content_hash: "hash".to_owned(),
                base_hash: None,
                updated_at: 1,
                is_dirty: false,
            })
            .await
            .expect("seed draft");
        let document_id = document_id_for_path(&path);
        self.recovery
            .write_snapshot(
                &document_id,
                Some(&path),
                "base-hash",
                crate::documents::recovery::unix_timestamp().expect("clock") + 8,
                &scene,
            )
            .expect("write recovery snapshot");
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
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

fn journal_files(recovery: &RecoveryStore) -> Vec<PathBuf> {
    let directory = journal_directory(recovery);
    match fs::read_dir(&directory) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                path.extension().and_then(|extension| extension.to_str()) == Some("json")
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[tokio::test]
async fn rename_parent_sync_failure_keeps_committed_journal_until_replay() {
    let fixture = Fixture::new().await;
    let source = fixture.seed_drawing("source.excalidraw", "source").await;
    let target = fixture.drawing_path("target.excalidraw");
    fixture
        .entries
        .set_derived_fault(Some(DerivedStateFault::ParentSync));

    let result = fixture
        .entries
        .rename(WorkspaceEntryRenameRequest {
            workspace_id: fixture.workspace_id.clone(),
            relative_path: "source.excalidraw".to_owned(),
            base_name: "target".to_owned(),
            expected_open_documents: Vec::new(),
        })
        .await
        .expect("rename result remains successful after a post-commit sync failure");
    fixture.entries.set_derived_fault(None);

    assert_eq!(result.entry.relative_path, "target.excalidraw");
    assert!(!source.exists());
    assert!(target.exists());
    let pending = load_journals(&fixture.recovery)
        .expect("load pending parent-sync journal")
        .pop()
        .expect("parent sync failure remains durable");
    assert!(pending.filesystem_committed);
    assert!(!pending.parent_sync_applied);
    assert!(!pending.sqlite_applied);
    assert!(!pending.recovery_applied);

    reconcile_pending_mutations(&fixture.repository, &fixture.recovery)
        .await
        .expect("replay retries parent sync before derived state");
    assert!(load_journals(&fixture.recovery)
        .expect("load completed journal")
        .is_empty());
}

#[tokio::test]
async fn rename_replay_syncs_distinct_old_and_new_parent_directories() {
    let fixture = Fixture::new().await;
    let old_parent = fixture.workspace.join("old");
    let new_parent = fixture.workspace.join("new");
    fs::create_dir_all(&old_parent).expect("create old parent");
    fs::create_dir_all(&new_parent).expect("create new parent");
    let source = old_parent.join("source.excalidraw");
    let target = new_parent.join("target.excalidraw");
    fs::write(&source, scene_json("source")).expect("write source");
    fs::rename(&source, &target).expect("commit cross-parent rename");

    let mut record = MutationJournalRecord::rename(
        "distinct-parent-sync".to_owned(),
        fixture.workspace_id.clone(),
        source.display().to_string(),
        target.display().to_string(),
        "old/source.excalidraw".to_owned(),
        "new/target.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
    )
    .with_filesystem_committed(true);
    record.sqlite_applied = true;
    record.recovery_applied = true;
    save_journal(&fixture.recovery, &record).expect("save committed cross-parent journal");

    apply_committed_record_with_history(
        &fixture.repository,
        &fixture.recovery,
        &mut record,
        true,
        true,
        None,
    )
    .await
    .expect("replay syncs both parent directories");
    assert!(record.parent_sync_applied);
    assert!(load_journals(&fixture.recovery)
        .expect("load completed cross-parent journal")
        .is_empty());
}

#[tokio::test]
async fn rename_sqlite_failure_after_filesystem_commit_keeps_new_path_and_journals() {
    let fixture = Fixture::new().await;
    let source = fixture.seed_drawing("source.excalidraw", "source").await;
    let target = fixture.drawing_path("target.excalidraw");
    fixture
        .entries
        .set_derived_fault(Some(DerivedStateFault::Sqlite));

    let result = fixture
        .entries
        .rename(WorkspaceEntryRenameRequest {
            workspace_id: fixture.workspace_id.clone(),
            relative_path: "source.excalidraw".to_owned(),
            base_name: "target".to_owned(),
            expected_open_documents: Vec::new(),
        })
        .await
        .expect("filesystem rename must still succeed");

    assert_eq!(result.entry.relative_path, "target.excalidraw");
    assert!(!source.exists());
    assert!(target.exists());
    assert!(fixture
        .repository
        .file_index_get(source.display().to_string())
        .await
        .expect("read old index")
        .is_some());
    assert!(fixture
        .repository
        .file_index_get(target.display().to_string())
        .await
        .expect("read new index")
        .is_none());
    assert_eq!(journal_files(&fixture.recovery).len(), 1);
    let snapshots = fixture.recovery.list_snapshots().expect("list snapshots");
    assert!(snapshots.iter().all(|(_, snapshot)| {
        snapshot.original_path.as_deref() == Some(target.display().to_string().as_str())
    }));
    assert!(!fixture
        .recovery
        .snapshot_directory_for_path(&source)
        .exists());
}

#[tokio::test]
async fn rename_journal_reconciles_sqlite_and_hides_stale_recovery_candidates() {
    let fixture = Fixture::new().await;
    let source = fixture.seed_drawing("source.excalidraw", "source").await;
    let target = fixture.drawing_path("target.excalidraw");
    fixture
        .entries
        .set_derived_fault(Some(DerivedStateFault::Sqlite));
    fixture
        .entries
        .rename(WorkspaceEntryRenameRequest {
            workspace_id: fixture.workspace_id.clone(),
            relative_path: "source.excalidraw".to_owned(),
            base_name: "target".to_owned(),
            expected_open_documents: Vec::new(),
        })
        .await
        .expect("filesystem rename must still succeed");
    fixture.entries.set_derived_fault(None);

    reconcile_pending_mutations(&fixture.repository, &fixture.recovery)
        .await
        .expect("reconcile pending rename");

    assert!(load_journals(&fixture.recovery)
        .expect("load journals")
        .is_empty());
    assert!(fixture
        .repository
        .file_index_get(source.display().to_string())
        .await
        .expect("read old index")
        .is_none());
    assert!(fixture
        .repository
        .file_index_get(target.display().to_string())
        .await
        .expect("read new index")
        .is_some());

    let service = RecoveryService::new(
        Arc::clone(&fixture.repository),
        Arc::clone(&fixture.recovery),
    );
    let candidates = service.list().await.expect("list recovery candidates");
    assert!(candidates.iter().all(|candidate| {
        candidate.original_path.as_deref() != Some(source.display().to_string().as_str())
    }));
}

#[tokio::test]
async fn rename_reconcile_keeps_sqlite_rows_when_already_migrated_but_journal_flag_is_false() {
    let fixture = Fixture::new().await;
    let source = fixture.seed_drawing("source.excalidraw", "source").await;
    let target = fixture.drawing_path("target.excalidraw");
    fs::rename(&source, &target).expect("commit filesystem rename");
    fixture
        .repository
        .migrate_entry_paths(
            source.display().to_string(),
            target.display().to_string(),
            "source.excalidraw".to_owned(),
            "target.excalidraw".to_owned(),
            "target.excalidraw".to_owned(),
        )
        .await
        .expect("first sqlite migrate");

    save_journal(
        &fixture.recovery,
        &MutationJournalRecord::rename(
            "op-retry-sqlite".to_owned(),
            fixture.workspace_id.clone(),
            source.display().to_string(),
            target.display().to_string(),
            "source.excalidraw".to_owned(),
            "target.excalidraw".to_owned(),
            "target.excalidraw".to_owned(),
        )
        .with_filesystem_committed(true),
    )
    .expect("journal still claims sqlite is pending");

    reconcile_pending_mutations(&fixture.repository, &fixture.recovery)
        .await
        .expect("retry must not drop the already-migrated rows");

    assert!(load_journals(&fixture.recovery)
        .expect("load journals")
        .is_empty());
    assert!(fixture
        .repository
        .file_index_get(source.display().to_string())
        .await
        .expect("read old index")
        .is_none());
    let migrated = fixture
        .repository
        .file_index_get(target.display().to_string())
        .await
        .expect("read new index")
        .expect("destination index row must survive reconcile");
    assert_eq!(migrated.relative_path, "target.excalidraw");
    assert!(fixture
        .repository
        .draft_get(target.display().to_string())
        .await
        .expect("read destination draft")
        .is_some());
}

#[tokio::test]
async fn delete_sqlite_failure_after_trash_journals_then_reconciles() {
    let fixture = Fixture::new().await;
    let path = fixture.seed_drawing("drawing.excalidraw", "deleted").await;
    fixture
        .entries
        .set_derived_fault(Some(DerivedStateFault::Sqlite));

    let result = fixture
        .entries
        .delete(WorkspaceEntryDeleteRequest {
            workspace_id: fixture.workspace_id.clone(),
            relative_path: "drawing.excalidraw".to_owned(),
            expected_open_document: None,
        })
        .await
        .expect("Trash commit must still succeed");
    assert_eq!(
        result.history_maintenance,
        Some(crate::commands::dto::EntryHistoryMaintenance::PendingReplay)
    );

    assert!(!path.exists());
    assert!(fixture
        .repository
        .file_index_get(path.display().to_string())
        .await
        .expect("read index after trash")
        .is_some());
    assert_eq!(journal_files(&fixture.recovery).len(), 1);
    assert!(
        !fixture.recovery.snapshot_directory_for_path(&path).exists()
            || fixture
                .recovery
                .list_snapshots()
                .expect("list snapshots")
                .is_empty()
    );

    fixture.entries.set_derived_fault(None);
    reconcile_pending_mutations(&fixture.repository, &fixture.recovery)
        .await
        .expect("reconcile pending delete");
    assert!(load_journals(&fixture.recovery)
        .expect("load journals")
        .is_empty());
    assert!(fixture
        .repository
        .file_index_get(path.display().to_string())
        .await
        .expect("read index after reconcile")
        .is_none());

    let service = RecoveryService::new(
        Arc::clone(&fixture.repository),
        Arc::clone(&fixture.recovery),
    );
    let candidates = service.list().await.expect("list recovery candidates");
    assert!(
        candidates.is_empty(),
        "deleted drawing must not become a recovery candidate: {candidates:?}"
    );
}

#[tokio::test]
async fn delete_removes_recovery_snapshots_without_doc_close() {
    let fixture = Fixture::new().await;
    let path = fixture.seed_drawing("drawing.excalidraw", "closed").await;
    fixture
        .entries
        .delete(WorkspaceEntryDeleteRequest {
            workspace_id: fixture.workspace_id.clone(),
            relative_path: "drawing.excalidraw".to_owned(),
            expected_open_document: None,
        })
        .await
        .expect("delete drawing");

    assert!(!path.exists());
    assert!(fixture
        .recovery
        .list_snapshots()
        .expect("list snapshots")
        .is_empty());
    let service = RecoveryService::new(
        Arc::clone(&fixture.repository),
        Arc::clone(&fixture.recovery),
    );
    let candidates = service.list().await.expect("list recovery candidates");
    assert!(candidates.is_empty());
}

#[tokio::test]
async fn reconcile_preserves_an_in_flight_rename_journal() {
    let fixture = Fixture::new().await;
    let source = fixture.seed_drawing("source.excalidraw", "source").await;
    let target = fixture.drawing_path("target.excalidraw");
    save_journal(
        &fixture.recovery,
        &MutationJournalRecord::rename(
            "op-in-flight".to_owned(),
            fixture.workspace_id.clone(),
            source.display().to_string(),
            target.display().to_string(),
            "source.excalidraw".to_owned(),
            "target.excalidraw".to_owned(),
            "target.excalidraw".to_owned(),
        ),
    )
    .expect("journal intent before filesystem commit");

    reconcile_pending_mutations(&fixture.repository, &fixture.recovery)
        .await
        .expect("in-flight journal must be skipped, not deleted");

    assert_eq!(
        load_journals(&fixture.recovery)
            .expect("load journals")
            .len(),
        1
    );
    assert!(source.exists());
    assert!(!target.exists());
    assert!(fixture
        .repository
        .file_index_get(source.display().to_string())
        .await
        .expect("read source index")
        .is_some());
}

#[tokio::test]
async fn reconcile_drops_a_stale_uncommitted_journal() {
    let fixture = Fixture::new().await;
    let source = fixture.seed_drawing("source.excalidraw", "source").await;
    let target = fixture.drawing_path("target.excalidraw");
    save_journal(
        &fixture.recovery,
        &MutationJournalRecord::rename(
            "op-stale".to_owned(),
            fixture.workspace_id.clone(),
            source.display().to_string(),
            target.display().to_string(),
            "source.excalidraw".to_owned(),
            "target.excalidraw".to_owned(),
            "target.excalidraw".to_owned(),
        ),
    )
    .expect("journal crash leftover");
    let journal = journal_directory(&fixture.recovery).join("op-stale.json");
    let file = File::open(&journal).expect("open journal");
    file.set_modified(SystemTime::now() - (UNCOMMITTED_JOURNAL_TTL + Duration::from_secs(5)))
        .expect("age the uncommitted journal");

    reconcile_pending_mutations(&fixture.repository, &fixture.recovery)
        .await
        .expect("stale uncommitted journal can be dropped");

    assert!(load_journals(&fixture.recovery)
        .expect("load journals")
        .is_empty());
    assert!(source.exists());
    assert!(fixture
        .repository
        .file_index_get(source.display().to_string())
        .await
        .expect("read source index")
        .is_some());
}

#[tokio::test]
async fn v2_post_filesystem_pre_marker_crash_is_retained_for_repair() {
    let fixture = Fixture::new().await;
    let source = fixture.seed_drawing("source.excalidraw", "source").await;
    let target = fixture.drawing_path("target.excalidraw");
    fs::rename(&source, &target).expect("commit filesystem rename");
    let record = MutationJournalRecord::rename(
        "post-filesystem-pre-marker".to_owned(),
        fixture.workspace_id.clone(),
        source.display().to_string(),
        target.display().to_string(),
        "source.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
    );
    save_journal(&fixture.recovery, &record).expect("save pre-marker journal");
    let journal = journal_directory(&fixture.recovery).join("post-filesystem-pre-marker.json");
    let file = File::open(&journal).expect("open pre-marker journal");
    file.set_modified(SystemTime::now() - (UNCOMMITTED_JOURNAL_TTL + Duration::from_secs(5)))
        .expect("age pre-marker journal");

    let error = reconcile_pending_mutations(&fixture.repository, &fixture.recovery)
        .await
        .expect_err("ambiguous v2 marker must remain pending");
    assert!(
        matches!(error, crate::commands::error::AppError::HistoryOperationPending(operation) if operation == "post-filesystem-pre-marker")
    );
    assert!(journal.exists());
    assert!(fixture
        .repository
        .file_index_get(source.display().to_string())
        .await
        .expect("read old index")
        .is_some());
}

#[tokio::test]
async fn v3_post_filesystem_pre_marker_replay_promotes_only_matching_identity() {
    let fixture = Fixture::new().await;
    let source = fixture.seed_drawing("source.excalidraw", "source").await;
    let target = fixture.drawing_path("target.excalidraw");
    let identity = filesystem_identity_for_path(&source).expect("capture source identity");
    fs::rename(&source, &target).expect("commit filesystem rename");
    let record = MutationJournalRecord::rename(
        "post-filesystem-proven".to_owned(),
        fixture.workspace_id.clone(),
        source.display().to_string(),
        target.display().to_string(),
        "source.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
    )
    .with_filesystem_identity(Some(identity));
    save_journal(&fixture.recovery, &record).expect("save pre-marker journal");

    reconcile_pending_mutations(&fixture.repository, &fixture.recovery)
        .await
        .expect("matching target identity must promote the rename");

    assert!(load_journals(&fixture.recovery)
        .expect("load completed journal")
        .is_empty());
    assert!(fixture
        .repository
        .file_index_get(target.display().to_string())
        .await
        .expect("read target index")
        .is_some());
}

#[tokio::test]
async fn v3_post_filesystem_pre_marker_replay_retains_unrelated_target() {
    let fixture = Fixture::new().await;
    let source = fixture.seed_drawing("source.excalidraw", "source").await;
    let target = fixture.drawing_path("target.excalidraw");
    let identity = filesystem_identity_for_path(&source).expect("capture source identity");
    fs::rename(&source, &target).expect("commit filesystem rename");
    fs::remove_file(&target).expect("remove committed target");
    fs::write(&target, scene_json("unrelated")).expect("replace target path independently");
    let record = MutationJournalRecord::rename(
        "post-filesystem-unrelated-target".to_owned(),
        fixture.workspace_id.clone(),
        source.display().to_string(),
        target.display().to_string(),
        "source.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
    )
    .with_filesystem_identity(Some(identity));
    save_journal(&fixture.recovery, &record).expect("save ambiguous journal");

    let error = reconcile_pending_mutations(&fixture.repository, &fixture.recovery)
        .await
        .expect_err("replacement must remain pending");
    assert!(matches!(
        error,
        crate::commands::error::AppError::HistoryOperationPending(operation)
            if operation == "post-filesystem-unrelated-target"
    ));
    assert_eq!(journal_files(&fixture.recovery).len(), 1);
}

#[tokio::test]
async fn v3_post_filesystem_pre_marker_replay_retains_recreated_old_path() {
    let fixture = Fixture::new().await;
    let source = fixture.seed_drawing("source.excalidraw", "source").await;
    let target = fixture.drawing_path("target.excalidraw");
    let identity = filesystem_identity_for_path(&source).expect("capture source identity");
    fs::rename(&source, &target).expect("commit filesystem rename");
    fs::write(&source, scene_json("unrelated-old-path")).expect("recreate old path");
    let record = MutationJournalRecord::rename(
        "post-filesystem-recreated-old-path".to_owned(),
        fixture.workspace_id.clone(),
        source.display().to_string(),
        target.display().to_string(),
        "source.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
    )
    .with_filesystem_identity(Some(identity));
    save_journal(&fixture.recovery, &record).expect("save ambiguous journal");

    let error = reconcile_pending_mutations(&fixture.repository, &fixture.recovery)
        .await
        .expect_err("recreated old path must remain pending");
    assert!(matches!(
        error,
        crate::commands::error::AppError::HistoryOperationPending(operation)
            if operation == "post-filesystem-recreated-old-path"
    ));
    assert_eq!(journal_files(&fixture.recovery).len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn v3_post_filesystem_pre_marker_replay_retains_symlink_replacement() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new().await;
    let source = fixture.seed_drawing("source.excalidraw", "source").await;
    let target = fixture.drawing_path("target.excalidraw");
    let identity = filesystem_identity_for_path(&source).expect("capture source identity");
    fs::rename(&source, &target).expect("commit filesystem rename");
    symlink(&target, &source).expect("replace old path with symlink");
    let record = MutationJournalRecord::rename(
        "post-filesystem-symlink-replacement".to_owned(),
        fixture.workspace_id.clone(),
        source.display().to_string(),
        target.display().to_string(),
        "source.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
    )
    .with_filesystem_identity(Some(identity));
    save_journal(&fixture.recovery, &record).expect("save ambiguous journal");

    let error = reconcile_pending_mutations(&fixture.repository, &fixture.recovery)
        .await
        .expect_err("symlink replacement must remain pending");
    assert!(matches!(
        error,
        crate::commands::error::AppError::HistoryOperationPending(operation)
            if operation == "post-filesystem-symlink-replacement"
    ));
    assert_eq!(journal_files(&fixture.recovery).len(), 1);
}

#[tokio::test]
async fn v2_post_filesystem_pre_marker_never_uses_path_inference() {
    let fixture = Fixture::new().await;
    let source = fixture.seed_drawing("source.excalidraw", "source").await;
    let target = fixture.drawing_path("target.excalidraw");
    fs::rename(&source, &target).expect("commit filesystem rename");
    let mut record = MutationJournalRecord::rename(
        "v2-post-filesystem-ambiguous".to_owned(),
        fixture.workspace_id.clone(),
        source.display().to_string(),
        target.display().to_string(),
        "source.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
    );
    record.version = 2;
    save_journal(&fixture.recovery, &record).expect("save legacy v2 journal");

    let error = reconcile_pending_mutations(&fixture.repository, &fixture.recovery)
        .await
        .expect_err("legacy v2 ambiguity must remain pending");
    assert!(matches!(
        error,
        crate::commands::error::AppError::HistoryOperationPending(operation)
            if operation == "v2-post-filesystem-ambiguous"
    ));
    assert_eq!(journal_files(&fixture.recovery).len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn marked_rename_replay_rejects_target_symlink() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new().await;
    let source = fixture.seed_drawing("source.excalidraw", "source").await;
    let target = fixture.drawing_path("target.excalidraw");
    let outside = fixture.root.join("outside.excalidraw");
    fs::write(&outside, scene_json("outside")).expect("write outside target");
    symlink(&outside, &target).expect("create target symlink");
    let history_store = Arc::new(
        HistoryStore::open_version_history_root(&fixture.root.join("version-history"))
            .expect("open history store"),
    );
    let mut record = MutationJournalRecord::rename(
        "marked-target-symlink".to_owned(),
        fixture.workspace_id.clone(),
        source.display().to_string(),
        target.display().to_string(),
        "source.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
    )
    .with_filesystem_committed(true)
    .with_history_required(true);
    record.parent_sync_applied = true;
    record.sqlite_applied = true;
    record.recovery_applied = true;
    save_journal(&fixture.recovery, &record).expect("save marked journal");
    let replay = history_replay_for_store(history_store);

    let error = apply_committed_record_with_history(
        &fixture.repository,
        &fixture.recovery,
        &mut record,
        true,
        true,
        Some(&replay),
    )
    .await
    .expect_err("target symlink must not be canonicalized");
    assert!(matches!(
        error,
        crate::commands::error::AppError::HistoryOperationPending(operation)
            if operation == "marked-target-symlink"
    ));
    assert_eq!(journal_files(&fixture.recovery).len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn marked_directory_rename_replay_rejects_descendant_symlink() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new().await;
    let source = fixture.workspace.join("source-directory");
    let target = fixture.workspace.join("target-directory");
    let outside = fixture.root.join("outside-descendant.excalidraw");
    fs::create_dir(&source).expect("create source directory");
    fs::write(&outside, scene_json("outside")).expect("write outside descendant");
    fs::rename(&source, &target).expect("commit directory rename");
    symlink(&outside, target.join("linked.excalidraw")).expect("create descendant symlink");
    let history_store = Arc::new(
        HistoryStore::open_version_history_root(&fixture.root.join("version-history-descendant"))
            .expect("open history store"),
    );
    let mut record = MutationJournalRecord::rename(
        "marked-descendant-symlink".to_owned(),
        fixture.workspace_id.clone(),
        source.display().to_string(),
        target.display().to_string(),
        "source-directory".to_owned(),
        "target-directory".to_owned(),
        "target-directory".to_owned(),
    )
    .with_filesystem_committed(true)
    .with_history_required(true);
    record.parent_sync_applied = true;
    record.sqlite_applied = true;
    record.recovery_applied = true;
    save_journal(&fixture.recovery, &record).expect("save marked directory journal");
    let replay = history_replay_for_store(history_store);

    let error = apply_committed_record_with_history(
        &fixture.repository,
        &fixture.recovery,
        &mut record,
        true,
        true,
        Some(&replay),
    )
    .await
    .expect_err("descendant symlink must not be followed");
    assert!(matches!(
        error,
        crate::commands::error::AppError::HistoryOperationPending(operation)
            if operation == "marked-descendant-symlink"
    ));
    assert_eq!(journal_files(&fixture.recovery).len(), 1);
}

#[test]
fn legacy_journal_defaults_history_phase_to_unrequired_and_unapplied() {
    let record = MutationJournalRecord::delete(
        "legacy-op".to_owned(),
        "workspace".to_owned(),
        "/tmp/legacy.excalidraw".to_owned(),
        "legacy.excalidraw".to_owned(),
    );
    let mut value = serde_json::to_value(record).expect("serialize journal fixture");
    let object = value.as_object_mut().expect("journal object");
    object.remove("historyRequired");
    object.remove("historyApplied");
    let decoded: MutationJournalRecord =
        serde_json::from_value(value).expect("decode v1 journal fixture");

    assert!(!decoded.history_required);
    assert!(!decoded.history_applied);
    assert!(!decoded.is_complete());
    assert!(MutationJournalRecord {
        sqlite_applied: true,
        recovery_applied: true,
        ..decoded
    }
    .is_complete());
}

#[tokio::test]
async fn legacy_journal_is_probed_by_history_replay_when_available() {
    let fixture = Fixture::new().await;
    let source = fixture.seed_drawing("source.excalidraw", "source").await;
    let target = fixture.drawing_path("target.excalidraw");
    fs::rename(&source, &target).expect("commit filesystem rename");
    let mut record = MutationJournalRecord::rename(
        "legacy-history-op".to_owned(),
        fixture.workspace_id.clone(),
        source.display().to_string(),
        target.display().to_string(),
        "source.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
    )
    .with_filesystem_committed(true);
    record.version = 1;
    save_journal(&fixture.recovery, &record).expect("save legacy journal");
    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let attempts_for_replay = Arc::clone(&attempts);
    let history_replay: HistoryReplay = Arc::new(move |_record| {
        attempts_for_replay.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    });

    apply_committed_record_with_history(
        &fixture.repository,
        &fixture.recovery,
        &mut record,
        false,
        false,
        Some(&history_replay),
    )
    .await
    .expect("legacy history probe succeeds");
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(load_journals(&fixture.recovery)
        .expect("load completed legacy journal")
        .is_empty());
}

#[tokio::test]
async fn required_history_phase_keeps_journal_until_replay_succeeds() {
    let fixture = Fixture::new().await;
    let source = fixture.seed_drawing("source.excalidraw", "source").await;
    let target = fixture.drawing_path("target.excalidraw");
    fs::rename(&source, &target).expect("commit filesystem rename");
    let mut record = MutationJournalRecord::rename(
        "history-required-op".to_owned(),
        fixture.workspace_id.clone(),
        source.display().to_string(),
        target.display().to_string(),
        "source.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
    )
    .with_filesystem_committed(true)
    .with_history_required(true);
    save_journal(&fixture.recovery, &record).expect("save history journal");

    let error = apply_committed_record_with_history(
        &fixture.repository,
        &fixture.recovery,
        &mut record,
        false,
        false,
        None,
    )
    .await
    .expect_err("history phase must remain pending without an owner");
    assert!(
        matches!(error, AppError::HistoryOperationPending(operation) if operation == "history-required-op")
    );
    let persisted = load_journals(&fixture.recovery)
        .expect("load pending history journal")
        .pop()
        .expect("journal remains");
    assert!(persisted.sqlite_applied);
    assert!(persisted.recovery_applied);
    assert!(!persisted.history_applied);
    assert_eq!(journal_files(&fixture.recovery).len(), 1);

    let history_replay: HistoryReplay = Arc::new(|record| {
        Box::pin(async move {
            assert_eq!(record.operation_id, "history-required-op");
            Ok(())
        })
    });
    let mut reopened = persisted;
    apply_committed_record_with_history(
        &fixture.repository,
        &fixture.recovery,
        &mut reopened,
        false,
        false,
        Some(&history_replay),
    )
    .await
    .expect("history replay completes");
    assert!(reopened.is_complete());
    assert!(load_journals(&fixture.recovery)
        .expect("load completed journals")
        .is_empty());
}

#[tokio::test]
async fn committed_trash_replay_targets_captured_identity_after_same_path_reappears() {
    let fixture = Fixture::new().await;
    let path = fixture.seed_drawing("drawing.excalidraw", "original").await;
    let mut record = MutationJournalRecord::delete(
        "delete-reappeared-op".to_owned(),
        fixture.workspace_id.clone(),
        path.display().to_string(),
        "drawing.excalidraw".to_owned(),
    )
    .with_history_document_id("original-document-id")
    .with_filesystem_committed(true);
    record.sqlite_applied = true;
    record.recovery_applied = true;
    save_journal(&fixture.recovery, &record).expect("save committed delete journal");

    fs::write(&path, scene_json("unrelated-replacement")).expect("recreate same path");
    let history_replay: HistoryReplay = Arc::new(|record| {
        Box::pin(async move {
            assert_eq!(
                record.history_document_id.as_deref(),
                Some("original-document-id")
            );
            Ok(())
        })
    });
    apply_committed_record_with_history(
        &fixture.repository,
        &fixture.recovery,
        &mut record,
        true,
        true,
        Some(&history_replay),
    )
    .await
    .expect("committed delete replay succeeds");
    assert!(load_journals(&fixture.recovery)
        .expect("load completed delete journal")
        .is_empty());
}

#[tokio::test]
async fn failed_history_replay_is_retryable_after_reloading_journal() {
    let fixture = Fixture::new().await;
    let source = fixture.seed_drawing("source.excalidraw", "source").await;
    let target = fixture.drawing_path("target.excalidraw");
    fs::rename(&source, &target).expect("commit filesystem rename");
    let mut record = MutationJournalRecord::rename(
        "history-retry-op".to_owned(),
        fixture.workspace_id.clone(),
        source.display().to_string(),
        target.display().to_string(),
        "source.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
        "target.excalidraw".to_owned(),
    )
    .with_filesystem_committed(true)
    .with_history_required(true);
    save_journal(&fixture.recovery, &record).expect("save history journal");

    let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let attempts_for_replay = Arc::clone(&attempts);
    let history_replay: HistoryReplay = Arc::new(move |_record| {
        let attempt = attempts_for_replay.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async move {
            if attempt == 0 {
                Err(AppError::HistoryUnavailable("injected failure".to_owned()))
            } else {
                Ok(())
            }
        })
    });

    let first_error = apply_committed_record_with_history(
        &fixture.repository,
        &fixture.recovery,
        &mut record,
        false,
        false,
        Some(&history_replay),
    )
    .await
    .expect_err("injected history failure must remain pending");
    assert!(matches!(first_error, AppError::HistoryUnavailable(_)));
    let mut reopened = load_journals(&fixture.recovery)
        .expect("load journal after failed history replay")
        .pop()
        .expect("failed replay remains durable");
    assert!(reopened.sqlite_applied);
    assert!(reopened.recovery_applied);
    assert!(!reopened.history_applied);

    apply_committed_record_with_history(
        &fixture.repository,
        &fixture.recovery,
        &mut reopened,
        false,
        false,
        Some(&history_replay),
    )
    .await
    .expect("reloaded history replay succeeds");
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert!(load_journals(&fixture.recovery)
        .expect("load completed retry journal")
        .is_empty());
}

#[test]
fn malformed_journal_fails_closed_without_deleting_the_file() {
    let root = std::env::temp_dir().join(format!(
        "excalidraw-entry-malformed-journal-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&root).expect("create malformed journal root");
    let recovery = RecoveryStore::with_app_version(&root, "0.1.0");
    let directory = journal_directory(&recovery);
    fs::create_dir_all(&directory).expect("create journal directory");
    let path = directory.join("corrupt.json");
    fs::write(&path, b"{not-json").expect("write corrupt journal");

    let error = load_journals(&recovery).expect_err("corrupt journal must fail closed");
    assert!(matches!(error, AppError::Internal(message) if message.contains("corrupt.json")));
    assert!(path.exists());
    fs::remove_dir_all(root).expect("remove malformed journal root");
}

#[tokio::test]
async fn drawing_delete_removes_history_only_after_trash_commits() {
    let fixture = Fixture::new().await;
    let path = fixture.seed_drawing("history.excalidraw", "history").await;
    let store = Arc::new(HistoryStore::open(&fixture.root.join("data")).expect("open history"));
    let identity = store
        .resolve_document_identity_for_open(&path, 1)
        .expect("establish drawing identity");
    HistoryRepository::new(&store)
        .publish_scene(PublishSceneRequest {
            version_id: "manual-before-delete".to_owned(),
            document_id: identity.document_id.clone(),
            scene_bytes: scene_json("history").into_bytes(),
            schema_version: 1,
            source: HistoryVersionSource::Manual,
            protected_action: None,
            recorded_at: 1,
            sequence: 1,
        })
        .expect("publish manual history");

    let entries = fixture
        .entries
        .clone()
        .with_history_store(Arc::clone(&store));
    let result = entries
        .delete(WorkspaceEntryDeleteRequest {
            workspace_id: fixture.workspace_id.clone(),
            relative_path: "history.excalidraw".to_owned(),
            expected_open_document: None,
        })
        .await
        .expect("delete drawing through Trash");
    assert!(!path.exists());
    assert!(load_journals(&fixture.recovery)
        .expect("load entry journal")
        .is_empty());
    let (state, version_count): (String, i64) = store
        .with_connection(|connection| {
            let state = connection.query_row(
                "SELECT state FROM history_documents WHERE id = ?1",
                [&identity.document_id],
                |row| row.get(0),
            )?;
            let version_count = connection.query_row(
                "SELECT COUNT(*) FROM history_versions WHERE document_id = ?1",
                [&identity.document_id],
                |row| row.get(0),
            )?;
            Ok((state, version_count))
        })
        .expect("inspect deleted document history");
    assert_eq!(state, "deleting");
    assert_eq!(version_count, 0);
    assert!(!result.operation_id.is_empty());
}
