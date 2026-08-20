use std::{fs, path::PathBuf, sync::Arc};

use excalidraw_desktop_lib::{
    commands::{
        dto::{DirListRequest, WorkspaceAddRequest},
        error::ErrorCode,
        workspace::WorkspaceService,
    },
    database::repository::SqliteRepository,
};

struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    outside: PathBuf,
    workspaces: WorkspaceService,
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
        let workspaces = WorkspaceService::new(repository);
        Self {
            root,
            workspace,
            outside,
            workspaces,
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
        .workspaces
        .dir_list(DirListRequest {
            workspace_id: mounted.id,
            relative_path: "../outside".to_owned(),
        })
        .await
        .unwrap_err();
    assert_eq!(traversal.code, ErrorCode::PathAccessDenied);
    assert!(!fixture.outside.join("drawing.excalidraw").exists());
}
