use std::{collections::HashMap, fs, path::PathBuf, sync::Arc};

use excalidraw_desktop_lib::{
    commands::{
        dto::{WorkspaceAddRequest, WorkspaceEntryKind, WorkspaceEntryListRequest},
        workspace::WorkspaceService,
    },
    database::repository::SqliteRepository,
    workspace_entries::{WorkspaceEntryService, WorkspaceMutationGate},
};

struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    workspace_id: String,
    entries: WorkspaceEntryService,
}

impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-workspace-tree-contract-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap_or_else(|error| panic!("create workspace: {error}"));

        // The root fixture deliberately contains every class the tree must
        // distinguish: ordinary directories, unsupported content, protected
        // names, links, and the two supported Drawing suffixes.
        fs::create_dir(workspace.join("empty"))
            .unwrap_or_else(|error| panic!("create empty directory: {error}"));
        fs::create_dir(workspace.join("unsupported-only"))
            .unwrap_or_else(|error| panic!("create unsupported directory: {error}"));
        fs::write(workspace.join("unsupported-only/readme.txt"), b"ignored")
            .unwrap_or_else(|error| panic!("write unsupported fixture: {error}"));
        fs::create_dir(workspace.join(".hidden"))
            .unwrap_or_else(|error| panic!("create hidden directory: {error}"));
        fs::create_dir(workspace.join(".excalidraw_assets"))
            .unwrap_or_else(|error| panic!("create managed directory: {error}"));
        fs::write(workspace.join("drawing.excalidraw"), b"{}")
            .unwrap_or_else(|error| panic!("write drawing fixture: {error}"));
        fs::write(workspace.join("drawing.excalidraw.json"), b"{}")
            .unwrap_or_else(|error| panic!("write suffixed drawing fixture: {error}"));
        fs::write(workspace.join("unique.excalidraw"), b"{}")
            .unwrap_or_else(|error| panic!("write unique drawing fixture: {error}"));
        fs::write(workspace.join("ignored.bin"), b"ignored")
            .unwrap_or_else(|error| panic!("write unsupported root fixture: {error}"));

        #[cfg(unix)]
        std::os::unix::fs::symlink(
            workspace.join("drawing.excalidraw"),
            workspace.join("drawing-link.excalidraw"),
        )
        .unwrap_or_else(|error| panic!("create symlink fixture: {error}"));

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
            workspace_id,
            entries,
        }
    }

    async fn list(
        &self,
        parent_relative_path: &str,
    ) -> Vec<excalidraw_desktop_lib::commands::dto::WorkspaceEntry> {
        self.entries
            .list(WorkspaceEntryListRequest {
                workspace_id: self.workspace_id.clone(),
                parent_relative_path: parent_relative_path.to_owned(),
            })
            .await
            .unwrap_or_else(|error| panic!("list {parent_relative_path:?}: {error:?}"))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn list_filters_dot_managed_unsupported_and_symlink_entries() {
    let fixture = Fixture::new().await;
    let entries = fixture.list("").await;

    let names = entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect::<Vec<_>>();
    assert!(names.contains(&"empty"));
    assert!(names.contains(&"unsupported-only"));
    assert!(names.contains(&"drawing.excalidraw"));
    assert!(names.contains(&"drawing.excalidraw.json"));
    assert!(names.contains(&"unique.excalidraw"));
    assert!(!names.contains(&".hidden"));
    assert!(!names.contains(&".excalidraw_assets"));
    assert!(!names.contains(&"ignored.bin"));
    #[cfg(unix)]
    assert!(!names.contains(&"drawing-link.excalidraw"));

    let canonical_workspace = fixture
        .workspace
        .canonicalize()
        .unwrap_or_else(|error| panic!("canonicalize workspace: {error}"));
    for entry in entries {
        assert_eq!(entry.workspace_id, fixture.workspace_id);
        assert_eq!(entry.parent_relative_path, "");
        assert!(PathBuf::from(&entry.canonical_path).starts_with(&canonical_workspace));
        assert!(!entry.relative_path.starts_with('/'));
        if entry.kind == WorkspaceEntryKind::Directory {
            assert_eq!(entry.file_size, 0);
        }
    }
}

#[tokio::test]
async fn empty_and_unsupported_only_directories_remain_visible_but_list_empty() {
    let fixture = Fixture::new().await;
    let root_entries = fixture.list("").await;
    let by_name = root_entries
        .iter()
        .map(|entry| (entry.name.as_str(), entry))
        .collect::<HashMap<_, _>>();

    assert_eq!(by_name["empty"].kind, WorkspaceEntryKind::Directory);
    assert_eq!(
        by_name["unsupported-only"].kind,
        WorkspaceEntryKind::Directory
    );
    assert!(fixture.list("empty").await.is_empty());
    assert!(fixture.list("unsupported-only").await.is_empty());
}

#[tokio::test]
async fn sibling_supported_suffix_collisions_show_full_names_only_for_colliding_drawings() {
    let fixture = Fixture::new().await;
    let entries = fixture.list("").await;
    let display_names = entries
        .iter()
        .filter(|entry| entry.kind == WorkspaceEntryKind::Drawing)
        .map(|entry| (entry.name.clone(), entry.display_name.clone()))
        .collect::<HashMap<_, _>>();

    assert_eq!(
        display_names.get("drawing.excalidraw"),
        Some(&"drawing.excalidraw".to_owned())
    );
    assert_eq!(
        display_names.get("drawing.excalidraw.json"),
        Some(&"drawing.excalidraw.json".to_owned())
    );
    assert_eq!(
        display_names.get("unique.excalidraw"),
        Some(&"unique".to_owned())
    );
}
