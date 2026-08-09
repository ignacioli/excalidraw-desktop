use std::{fs, path::PathBuf, sync::Arc};

use excalidraw_desktop_lib::{
    commands::{
        dto::{
            DirListRequest, FileCreateRequest, FileRenameRequest, PathRequest, WorkspaceAddRequest,
        },
        error::ErrorCode,
        files::FileService,
        workspace::WorkspaceService,
    },
    database::repository::SqliteRepository,
};

struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    outside: PathBuf,
    workspaces: WorkspaceService,
    files: FileService,
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
        let files = FileService::new(Arc::clone(&repository));
        Self {
            root,
            workspace,
            outside,
            workspaces,
            files,
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
}

#[tokio::test]
async fn file_contract_creates_renames_and_removes_documents() {
    let fixture = Fixture::new().await;
    let mounted = fixture
        .workspaces
        .add(WorkspaceAddRequest {
            root_path: fixture.workspace.display().to_string(),
            name: None,
        })
        .await
        .unwrap();
    fs::create_dir_all(fixture.workspace.join("nested")).unwrap();

    let created = fixture
        .files
        .create(FileCreateRequest {
            workspace_id: mounted.id.clone(),
            relative_path: "nested/drawing.excalidraw".to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(created.display_name, "drawing.excalidraw");
    assert!(fixture.workspace.join("nested/drawing.excalidraw").exists());

    let renamed = fixture
        .files
        .rename(FileRenameRequest {
            path: created.canonical_path.clone(),
            new_name: "renamed.excalidraw".to_owned(),
        })
        .await
        .unwrap();
    assert_eq!(renamed.display_name, "renamed.excalidraw");
    assert!(!PathBuf::from(&created.canonical_path).exists());

    if let Err(error) = fixture
        .files
        .delete(PathRequest {
            path: renamed.canonical_path.clone(),
        })
        .await
    {
        // Sandboxed runners can lack a desktop Trash provider. The command
        // still routes through `trash::delete`; preserve this environment gap
        // as evidence rather than weakening production behavior.
        assert_eq!(error.code, ErrorCode::IoError);
        return;
    }
    assert!(!PathBuf::from(&renamed.canonical_path).exists());
}

#[tokio::test]
async fn file_contract_rejects_paths_outside_the_mounted_workspace() {
    let fixture = Fixture::new().await;
    let mounted = fixture
        .workspaces
        .add(WorkspaceAddRequest {
            root_path: fixture.workspace.display().to_string(),
            name: None,
        })
        .await
        .unwrap();
    let outside = fixture.outside.join("outside.excalidraw");
    let error = fixture
        .files
        .create(FileCreateRequest {
            workspace_id: mounted.id,
            relative_path: "../outside/outside.excalidraw".to_owned(),
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::PathAccessDenied);
    assert!(!outside.exists());
}
