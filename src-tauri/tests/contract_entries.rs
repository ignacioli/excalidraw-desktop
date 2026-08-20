use std::{fs, path::PathBuf, sync::Arc, time::Duration};

use excalidraw_desktop_lib::{
    commands::{
        dto::{
            WorkspaceAddRequest, WorkspaceEntryKind, WorkspaceEntryListRequest,
            IPC_CONTRACT_VERSION,
        },
        error::{AppError, ErrorCode},
        workspace::WorkspaceService,
    },
    database::repository::SqliteRepository,
    workspace_entries::{WorkspaceEntryService, WorkspaceMutationGate},
};

struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    outside: PathBuf,
    workspace_id: String,
    entries: WorkspaceEntryService,
}

impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-entry-contract-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let workspace = root.join("workspace");
        let outside = root.join("outside");
        fs::create_dir_all(&workspace).unwrap_or_else(|error| panic!("create workspace: {error}"));
        fs::create_dir_all(&outside).unwrap_or_else(|error| panic!("create outside: {error}"));
        fs::write(workspace.join("drawing.excalidraw"), b"{}")
            .unwrap_or_else(|error| panic!("write drawing: {error}"));
        fs::create_dir(workspace.join("folder"))
            .unwrap_or_else(|error| panic!("create folder: {error}"));
        let repository = Arc::new(
            SqliteRepository::open(&root.join("state.sqlite3"))
                .await
                .unwrap_or_else(|error| panic!("open repository: {error}")),
        );
        let workspace_id = WorkspaceService::new(Arc::clone(&repository))
            .add(WorkspaceAddRequest {
                root_path: workspace.display().to_string(),
                name: Some("Workspace".to_owned()),
            })
            .await
            .unwrap_or_else(|error| panic!("mount workspace: {error:?}"))
            .id;
        let entries = WorkspaceEntryService::new(repository, WorkspaceMutationGate::default());
        Self {
            root,
            workspace,
            outside,
            workspace_id,
            entries,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn workspace_entry_dto_and_error_codes_match_the_v2_wire_contract() {
    assert_eq!(
        IPC_CONTRACT_VERSION, 1,
        "legacy handshake remains during migration"
    );
    assert_eq!(
        serde_json::to_value(WorkspaceEntryKind::Drawing)
            .unwrap_or_else(|error| panic!("serialize kind: {error}")),
        "drawing"
    );

    let cases = [
        (
            AppError::InvalidName("bad/name".to_owned()),
            ErrorCode::InvalidName,
        ),
        (
            AppError::NameConflict(PathBuf::from("taken")),
            ErrorCode::NameConflict,
        ),
        (
            AppError::EntryProtected(PathBuf::from(".managed")),
            ErrorCode::EntryProtected,
        ),
        (
            AppError::DirectoryNotEmpty(PathBuf::from("folder")),
            ErrorCode::DirectoryNotEmpty,
        ),
        (
            AppError::EntryChanged(PathBuf::from("drawing")),
            ErrorCode::EntryChanged,
        ),
    ];
    for (error, expected) in cases {
        let ipc = error.into_ipc();
        assert_eq!(ipc.code, expected);
        assert!(!ipc.message.is_empty());
    }
}

#[tokio::test]
async fn list_is_authorized_by_workspace_and_returns_shared_entry_dtos() {
    let fixture = Fixture::new().await;
    let entries = fixture
        .entries
        .list(WorkspaceEntryListRequest {
            workspace_id: fixture.workspace_id.clone(),
            parent_relative_path: String::new(),
        })
        .await
        .unwrap_or_else(|error| panic!("list entries: {error:?}"));

    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].kind, WorkspaceEntryKind::Directory);
    assert_eq!(entries[0].workspace_id, fixture.workspace_id);
    assert!(entries.iter().any(|entry| {
        entry.kind == WorkspaceEntryKind::Drawing
            && entry.relative_path == "drawing.excalidraw"
            && entry.parent_relative_path.is_empty()
    }));

    let error = fixture
        .entries
        .list(WorkspaceEntryListRequest {
            workspace_id: fixture.workspace_id.clone(),
            parent_relative_path: "../outside".to_owned(),
        })
        .await
        .expect_err("traversal must fail");
    assert_eq!(error.code, ErrorCode::PathAccessDenied);
    assert!(!fixture.outside.join("drawing.excalidraw").exists());
    assert!(fixture.workspace.join("drawing.excalidraw").exists());
}

#[tokio::test]
async fn mutation_gate_serializes_operations_per_workspace_only() {
    let gate = WorkspaceMutationGate::default();
    let first = gate.acquire("workspace-a").await;
    let same_workspace = tokio::spawn({
        let gate = gate.clone();
        async move {
            let _guard = gate.acquire("workspace-a").await;
        }
    });
    let other_workspace = tokio::spawn({
        let gate = gate.clone();
        async move {
            let _guard = gate.acquire("workspace-b").await;
        }
    });

    tokio::time::timeout(Duration::from_millis(100), other_workspace)
        .await
        .expect("another Workspace must not be blocked")
        .unwrap_or_else(|error| panic!("other workspace task: {error}"));
    assert!(
        tokio::time::timeout(Duration::from_millis(25), same_workspace)
            .await
            .is_err(),
        "the same Workspace must remain locked"
    );
    drop(first);
}
