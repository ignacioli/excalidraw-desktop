use std::{fs, path::PathBuf, sync::Arc};

use excalidraw_desktop_lib::{
    commands::{
        dto::{WorkspaceAddRequest, WorkspaceEntryListRequest, WorkspaceRemoveRequest},
        error::ErrorCode,
        workspace::WorkspaceService,
    },
    database::repository::SqliteRepository,
    history::{
        identity::{IdentityError, IdentityStoreError},
        store::HistoryStore,
    },
    workspace_entries::{WorkspaceEntryService, WorkspaceMutationGate},
};

struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    outside: PathBuf,
    workspaces: WorkspaceService,
    entries: WorkspaceEntryService,
}

impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-workspace-contract-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let workspace = root.join("workspace");
        let outside = root.join("outside");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let repository = Arc::new(
            SqliteRepository::open(&root.join("state.sqlite3"))
                .await
                .unwrap(),
        );
        let workspaces = WorkspaceService::new(Arc::clone(&repository));
        let entries = WorkspaceEntryService::new(repository, WorkspaceMutationGate::default());
        Self {
            root,
            workspace,
            outside,
            workspaces,
            entries,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn workspace_contract_rejects_nested_roots_and_traversal() {
    let fixture = Fixture::new().await;
    let mounted = fixture
        .workspaces
        .add(WorkspaceAddRequest {
            root_path: fixture.workspace.display().to_string(),
            name: Some("Workspace".to_owned()),
        })
        .await
        .unwrap();
    assert_eq!(mounted.name, "Workspace");

    let nested = fixture.workspace.join("nested");
    fs::create_dir_all(&nested).unwrap();
    let overlap = fixture
        .workspaces
        .add(WorkspaceAddRequest {
            root_path: nested.display().to_string(),
            name: None,
        })
        .await
        .unwrap_err();
    assert_eq!(overlap.code, ErrorCode::WorkspaceOverlap);

    let traversal = fixture
        .entries
        .list(WorkspaceEntryListRequest {
            workspace_id: mounted.id,
            parent_relative_path: "../outside".to_owned(),
        })
        .await
        .unwrap_err();
    assert_eq!(traversal.code, ErrorCode::PathAccessDenied);
    assert!(!fixture.outside.join("drawing.excalidraw").exists());
}

#[tokio::test]
async fn workspace_contract_retains_unmounted_history_and_reuses_its_identity() {
    let fixture = Fixture::new().await;
    let drawing = fixture.workspace.join("drawing.excalidraw");
    fs::write(&drawing, "user bytes").unwrap();
    let mounted = fixture
        .workspaces
        .add(WorkspaceAddRequest {
            root_path: fixture.workspace.display().to_string(),
            name: Some("Workspace".to_owned()),
        })
        .await
        .unwrap();

    fixture
        .workspaces
        .remove(WorkspaceRemoveRequest {
            workspace_id: mounted.id.clone(),
        })
        .await
        .unwrap();
    assert!(fixture.workspaces.list().await.unwrap().is_empty());
    assert_eq!(
        fixture.workspaces.recent_list().await.unwrap(),
        vec![mounted.clone()]
    );
    assert_eq!(fs::read_to_string(&drawing).unwrap(), "user bytes");

    let unauthorized = fixture
        .entries
        .list(WorkspaceEntryListRequest {
            workspace_id: mounted.id.clone(),
            parent_relative_path: "".to_owned(),
        })
        .await
        .unwrap_err();
    assert_eq!(unauthorized.code, ErrorCode::WorkspaceNotFound);

    let remounted = fixture
        .workspaces
        .add(WorkspaceAddRequest {
            root_path: fixture.workspace.display().to_string(),
            name: None,
        })
        .await
        .unwrap();
    assert_eq!(remounted.id, mounted.id);
    assert_eq!(remounted.created_at, mounted.created_at);

    fixture
        .workspaces
        .remove(WorkspaceRemoveRequest {
            workspace_id: mounted.id.clone(),
        })
        .await
        .unwrap();
    let remounted = fixture
        .workspaces
        .remount(mounted.id.clone())
        .await
        .unwrap();
    assert_eq!(remounted.id, mounted.id);
}

#[tokio::test]
async fn workspace_contract_reauthorizes_remount_without_rebinding_history_identity() {
    let fixture = Fixture::new().await;
    let drawing = fixture.workspace.join("drawing.excalidraw");
    fs::write(&drawing, "scene-a").unwrap();
    let history =
        HistoryStore::open_version_history_root(&fixture.root.join("version-history")).unwrap();
    let original_identity = history
        .resolve_document_identity_for_open(&drawing, 1)
        .unwrap();

    let mounted = fixture
        .workspaces
        .add(WorkspaceAddRequest {
            root_path: fixture.workspace.display().to_string(),
            name: None,
        })
        .await
        .unwrap();
    fixture
        .workspaces
        .remove(WorkspaceRemoveRequest {
            workspace_id: mounted.id.clone(),
        })
        .await
        .unwrap();

    let remounted = fixture
        .workspaces
        .remount(mounted.id.clone())
        .await
        .unwrap();
    assert_eq!(remounted.id, mounted.id);

    let remounted_identity = history
        .resolve_document_identity_for_open(&drawing, 2)
        .unwrap();
    assert_eq!(
        remounted_identity.document_id,
        original_identity.document_id
    );
    assert_eq!(
        remounted_identity.canonical_path,
        original_identity.canonical_path
    );
    assert!(remounted_identity
        .filesystem_identity
        .refers_to_same_file(&original_identity.filesystem_identity));

    fixture
        .workspaces
        .remove(WorkspaceRemoveRequest {
            workspace_id: mounted.id,
        })
        .await
        .unwrap();
    let replacement = drawing.with_extension("tmp");
    fs::write(&replacement, "scene-a").unwrap();
    fs::rename(&replacement, &drawing).unwrap();

    fixture.workspaces.remount(remounted.id).await.unwrap();
    let error = history
        .resolve_document_identity_for_open(&drawing, 3)
        .expect_err("same-path replacement must not inherit remounted history");
    assert!(matches!(
        error,
        IdentityStoreError::Identity(IdentityError::ExternalReplacement { .. })
    ));
    let persisted = history
        .load_active_document_identity(&original_identity.canonical_path)
        .unwrap()
        .unwrap();
    assert_eq!(persisted.document_id, original_identity.document_id);
}

#[tokio::test]
async fn workspace_contract_preserves_inaccessible_recent_until_explicit_history_removal() {
    let fixture = Fixture::new().await;
    let mounted = fixture
        .workspaces
        .add(WorkspaceAddRequest {
            root_path: fixture.workspace.display().to_string(),
            name: None,
        })
        .await
        .unwrap();
    let still_mounted = fixture
        .workspaces
        .recent_remove(mounted.id.clone())
        .await
        .unwrap_err();
    assert_eq!(still_mounted.code, ErrorCode::WorkspaceMounted);
    fixture
        .workspaces
        .remove(WorkspaceRemoveRequest {
            workspace_id: mounted.id.clone(),
        })
        .await
        .unwrap();
    fs::remove_dir_all(&fixture.workspace).unwrap();

    let error = fixture
        .workspaces
        .remount(mounted.id.clone())
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::IoError);
    assert_eq!(
        fixture.workspaces.recent_list().await.unwrap(),
        vec![mounted.clone()]
    );

    fixture.workspaces.recent_remove(mounted.id).await.unwrap();
    assert!(fixture.workspaces.recent_list().await.unwrap().is_empty());
}
