use std::{
    fs::{self, File},
    io,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};

use crate::{
    commands::{
        dto::{WorkspaceEntryDeleteRequest, WorkspaceEntryRenameRequest},
        recovery::RecoveryService,
    },
    database::repository::{
        DraftRecord, DraftRepository, FileIndexRecord, FileIndexRepository, SqliteRepository,
        WorkspaceRecord, WorkspaceRepository,
    },
    documents::recovery::{document_id_for_path, RecoveryStore},
    workspace_entries::{
        mutation_journal::{
            journal_directory, load_journals, reconcile_pending_mutations, save_journal,
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
        ),
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

    fixture
        .entries
        .delete(WorkspaceEntryDeleteRequest {
            workspace_id: fixture.workspace_id.clone(),
            relative_path: "drawing.excalidraw".to_owned(),
            expected_open_document: None,
        })
        .await
        .expect("Trash commit must still succeed");

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
