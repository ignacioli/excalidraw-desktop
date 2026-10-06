use std::{fs, path::PathBuf, sync::Arc};

use excalidraw_desktop_lib::{
    commands::{
        documents::DocumentService,
        dto::{CheckpointReason, CheckpointRequest, PathRequest, SaveDraftRequest},
        error::ErrorCode,
    },
    database::repository::{SqliteRepository, WorkspaceRecord, WorkspaceRepository},
    documents::recovery::{document_id_for_path, RecoveryStore},
    history::store::HistoryStore,
};
use sha2::Digest;

fn scene(label: &str) -> String {
    format!(
        r#"{{"type":"excalidraw","version":2,"source":"identity-test","elements":[{{"id":"{label}","type":"rectangle"}}],"appState":{{}},"files":{{}}}}"#
    )
}

struct Fixture {
    root: PathBuf,
    document: PathBuf,
    service: DocumentService,
    store: Arc<HistoryStore>,
    recovery: Arc<RecoveryStore>,
}

impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-history-document-{}",
            uuid::Uuid::new_v4()
        ));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).expect("create workspace");
        let document = workspace.join("drawing.excalidraw");
        fs::write(&document, scene("original")).expect("write document");

        let repository = Arc::new(
            SqliteRepository::open(&root.join("state.sqlite3"))
                .await
                .expect("open repository"),
        );
        let canonical_workspace = workspace.canonicalize().expect("canonicalize workspace");
        repository
            .workspace_upsert(WorkspaceRecord {
                id: "workspace-1".to_owned(),
                name: "Workspace".to_owned(),
                root_path: canonical_workspace.display().to_string(),
                created_at: 1,
                mounted: true,
            })
            .await
            .expect("register workspace");
        let store = Arc::new(HistoryStore::open(&root).expect("open history store"));
        let recovery = Arc::new(RecoveryStore::with_app_version(&root, "identity-test"));
        let mut service = DocumentService::with_recovery(Arc::clone(&repository), recovery.clone());
        service.attach_history_store(Arc::clone(&store));

        Self {
            root,
            document,
            service,
            store,
            recovery,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn open_persists_identity_and_rejects_same_path_replacement_on_draft_save() {
    let fixture = Fixture::new().await;
    let path = fixture.document.display().to_string();
    fixture
        .service
        .doc_open(PathRequest { path: path.clone() })
        .await
        .expect("open document");

    let original_id: String = fixture
        .store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT id FROM history_documents WHERE state = 'active'",
                [],
                |row| row.get(0),
            )
        })
        .expect("read persisted document identity");

    let replacement = fixture.document.with_extension("tmp");
    fs::write(&replacement, scene("original")).expect("write replacement");
    fs::rename(&replacement, &fixture.document).expect("replace document");

    let error = fixture
        .service
        .doc_save_draft(SaveDraftRequest {
            path: path.clone(),
            scene_json: scene("draft"),
        })
        .await
        .expect_err("same-path replacement must not inherit the old identity");
    assert_eq!(error.code, ErrorCode::HistoryStaleDocument);

    let open_error = fixture
        .service
        .doc_open(PathRequest { path })
        .await
        .expect_err("open replacement must fail closed");
    assert_eq!(open_error.code, ErrorCode::HistoryStaleDocument);
    let rows: Vec<(String, String)> = fixture
        .store
        .with_connection(|connection| {
            let mut statement = connection
                .prepare("SELECT id, state FROM history_documents ORDER BY created_at, id")?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .expect("read identity rows");
    assert_eq!(rows, vec![(original_id, "active".to_owned())]);
}

#[tokio::test]
async fn first_checkpoint_persists_identity_and_self_write_hash() {
    let fixture = Fixture::new().await;
    let new_document = fixture.document.with_file_name("new-document.excalidraw");
    let path = new_document.display().to_string();
    let payload = scene("checkpoint");
    let expected_hash = format!("{:x}", sha2::Sha256::digest(payload.as_bytes()));

    fixture
        .service
        .doc_checkpoint(CheckpointRequest {
            path,
            scene_json: payload,
            reason: CheckpointReason::ManualSave,
        })
        .await
        .expect("checkpoint new document");

    let row: (String, String, String, String) = fixture
        .store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT id, canonical_path, last_self_written_hash, state
                 FROM history_documents WHERE state = 'active'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
        })
        .expect("read checkpoint identity");
    assert!(!row.0.is_empty());
    assert_eq!(
        row.1,
        new_document
            .canonicalize()
            .expect("canonicalize new document")
            .display()
            .to_string()
    );
    assert_eq!(row.2, expected_hash);
    assert_eq!(row.3, "active");
}

#[tokio::test]
async fn history_store_failure_does_not_block_draft_recovery_or_checkpoint() {
    let fixture = Fixture::new().await;
    let path = fixture.document.display().to_string();
    fixture
        .store
        .with_connection(|connection| connection.pragma_update(None, "query_only", 1))
        .expect("make history store read-only");

    let draft_payload = scene("draft");
    fixture
        .service
        .doc_save_draft(SaveDraftRequest {
            path: path.clone(),
            scene_json: draft_payload,
        })
        .await
        .expect("history failure must not block draft save");
    let canonical = fixture
        .document
        .canonicalize()
        .expect("canonicalize document");
    let document_id = document_id_for_path(&canonical);
    assert!(fixture
        .recovery
        .latest_valid_snapshot(&document_id)
        .expect("read recovery snapshot")
        .is_some());
    assert_eq!(
        fixture.service.history_issue_for_path(&canonical).await,
        Some(ErrorCode::HistoryUnavailable)
    );

    fixture
        .service
        .doc_checkpoint(CheckpointRequest {
            path,
            scene_json: scene("checkpoint-after-history-failure"),
            reason: CheckpointReason::ManualSave,
        })
        .await
        .expect("history failure must not report a successful current write as failed");
    assert_eq!(
        fs::read_to_string(&fixture.document).expect("read checkpointed document"),
        scene("checkpoint-after-history-failure")
    );
}
