use std::{fs, path::PathBuf, sync::Arc};

use excalidraw_desktop_lib::{
    commands::{
        documents::DirectFileGrant,
        dto::{HistoryListRequest, HistoryPreviewRequest},
        error::ErrorCode,
    },
    database::repository::{SqliteRepository, WorkspaceRecord, WorkspaceRepository},
    history::{
        identity::DocumentIdentity,
        query::HistoryQueryService,
        repository::{HistoryRepository, PublishSceneRequest},
        store::HistoryStore,
        types::{HistoryDocumentLocator, HistoryVersionSource},
    },
};

fn scene() -> Vec<u8> {
    br#"{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}"#.to_vec()
}

struct Fixture {
    root: PathBuf,
    document: PathBuf,
    document_id: String,
    service: HistoryQueryService,
}

impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-history-query-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).expect("create workspace");
        let document = workspace.join("drawing.excalidraw");
        fs::write(&document, scene()).expect("write document");
        let repository = Arc::new(
            SqliteRepository::open(&root.join("state.sqlite3"))
                .await
                .expect("open repository"),
        );
        repository
            .workspace_upsert(WorkspaceRecord {
                id: "workspace-1".to_owned(),
                name: "Workspace".to_owned(),
                root_path: workspace
                    .canonicalize()
                    .expect("canonical workspace")
                    .display()
                    .to_string(),
                created_at: 1,
                mounted: true,
            })
            .await
            .expect("mount workspace");
        let store = Arc::new(HistoryStore::open(&root).expect("open history store"));
        let identity = DocumentIdentity::establish(&document).expect("establish identity");
        let document_id = identity.document_id.clone();
        store
            .persist_document_identity(&identity, 1)
            .expect("persist identity");
        let service = HistoryQueryService::with_direct_file_grant(
            repository,
            Some(store.clone()),
            Arc::new(DenyGrant),
        );
        HistoryRepository::new(&store)
            .publish_scene(PublishSceneRequest {
                version_id: "version-a".to_owned(),
                document_id: document_id.clone(),
                scene_bytes: scene(),
                schema_version: 1,
                source: HistoryVersionSource::Manual,
                protected_action: None,
                recorded_at: 10,
                sequence: 1,
            })
            .expect("publish version");
        Self {
            root,
            document,
            document_id,
            service,
        }
    }
}

struct DenyGrant;

impl DirectFileGrant for DenyGrant {
    fn is_allowed(&self, _path: &std::path::Path) -> bool {
        false
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn list_and_preview_resolve_the_persistent_identity() {
    let fixture = Fixture::new().await;
    let response = fixture
        .service
        .list(HistoryListRequest {
            document: HistoryDocumentLocator::Path {
                path: fixture.document.display().to_string(),
            },
            cursor: None,
            limit: None,
        })
        .await
        .expect("list history");
    assert_eq!(response.document_id, fixture.document_id);
    assert_eq!(response.items.len(), 1);
    assert_eq!(response.items[0].version_id, "version-a");
    assert!(matches!(
        response.items[0].availability,
        excalidraw_desktop_lib::history::types::HistoryVersionAvailability::Available
    ));

    let preview = fixture
        .service
        .preview(HistoryPreviewRequest {
            document: HistoryDocumentLocator::Handle {
                document_id: fixture.document_id.clone(),
            },
            version_id: "version-a".to_owned(),
        })
        .await
        .expect("preview history");
    assert_eq!(preview.version_id, "version-a");
    assert_eq!(preview.scene["type"], "excalidraw");
}

#[tokio::test]
async fn wrong_document_and_stale_version_fail_closed() {
    let fixture = Fixture::new().await;
    let outside = fixture.root.join("outside.excalidraw");
    fs::write(&outside, scene()).expect("write outside document");
    let wrong_document = fixture
        .service
        .preview(HistoryPreviewRequest {
            document: HistoryDocumentLocator::Path {
                path: outside.display().to_string(),
            },
            version_id: "version-a".to_owned(),
        })
        .await
        .expect_err("unmounted path must be rejected");
    assert_eq!(wrong_document.code, ErrorCode::HistoryStaleDocument);

    let stale = fixture
        .service
        .preview(HistoryPreviewRequest {
            document: HistoryDocumentLocator::Handle {
                document_id: fixture.document_id.clone(),
            },
            version_id: "missing-version".to_owned(),
        })
        .await
        .expect_err("unknown version must be rejected");
    assert_eq!(stale.code, ErrorCode::HistoryStaleDocument);
}
