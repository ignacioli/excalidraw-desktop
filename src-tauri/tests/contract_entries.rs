use std::{fs, io, path::Path, path::PathBuf, sync::Arc, time::Duration};

use excalidraw_desktop_lib::{
    commands::{
        dto::{
            ExpectedOpenDocument, WorkspaceAddRequest, WorkspaceEntryCreateRequest,
            WorkspaceEntryDeleteRequest, WorkspaceEntryKind, WorkspaceEntryListRequest,
            WorkspaceEntryPathRequest, WorkspaceEntryRenameRequest, IPC_CONTRACT_VERSION,
        },
        error::{AppError, ErrorCode},
        workspace::WorkspaceService,
    },
    database::repository::{
        DraftRecord, DraftRepository, FileIndexRecord, FileIndexRepository, FileMetaRecord,
        FileMetaRepository, SqliteRepository,
    },
    workspace_entries::{TrashOperator, WorkspaceEntryService, WorkspaceMutationGate},
};
use sha2::{Digest, Sha256};

struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    outside: PathBuf,
    workspace_id: String,
    repository: Arc<SqliteRepository>,
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
        let entries =
            WorkspaceEntryService::new(Arc::clone(&repository), WorkspaceMutationGate::default());
        Self {
            root,
            workspace,
            outside,
            workspace_id,
            repository,
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
        IPC_CONTRACT_VERSION, 2,
        "handshake advertises IPC contract version 2 after the listing and thumbnail cutover"
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
async fn create_rename_and_delete_use_the_v2_entry_boundary() {
    let fixture = Fixture::new().await;
    let created = fixture
        .entries
        .create(WorkspaceEntryCreateRequest {
            workspace_id: fixture.workspace_id.clone(),
            parent_relative_path: String::new(),
            kind: WorkspaceEntryKind::Drawing,
            base_name: "Untitled".to_owned(),
        })
        .await
        .unwrap_or_else(|error| panic!("create drawing: {error:?}"));
    assert_eq!(created.entry.name, "Untitled.excalidraw");
    assert!(fixture.workspace.join("Untitled.excalidraw").is_file());

    let collision = fixture
        .entries
        .create(WorkspaceEntryCreateRequest {
            workspace_id: fixture.workspace_id.clone(),
            parent_relative_path: String::new(),
            kind: WorkspaceEntryKind::Drawing,
            base_name: "drawing".to_owned(),
        })
        .await
        .expect_err("same sibling must not be overwritten");
    assert_eq!(collision.code, ErrorCode::NameConflict);

    let renamed = fixture
        .entries
        .rename(WorkspaceEntryRenameRequest {
            workspace_id: fixture.workspace_id.clone(),
            relative_path: "Untitled.excalidraw".to_owned(),
            base_name: "Renamed".to_owned(),
            expected_open_documents: Vec::new(),
        })
        .await
        .unwrap_or_else(|error| panic!("rename drawing: {error:?}"));
    assert_eq!(renamed.entry.name, "Renamed.excalidraw");
    assert_eq!(renamed.old_relative_path, "Untitled.excalidraw");
    assert_eq!(renamed.new_relative_path, "Renamed.excalidraw");
    assert!(!fixture.workspace.join("Untitled.excalidraw").exists());

    let preflight = fixture
        .entries
        .delete_preflight(WorkspaceEntryPathRequest {
            workspace_id: fixture.workspace_id.clone(),
            relative_path: "Renamed.excalidraw".to_owned(),
        })
        .await
        .unwrap_or_else(|error| panic!("delete preflight: {error:?}"));
    assert!(matches!(
        preflight,
        excalidraw_desktop_lib::commands::dto::WorkspaceEntryDeletePreflightResult::Confirmable { .. }
    ));
}

#[tokio::test]
async fn names_protected_entries_and_symlinks_are_rejected_without_mutation() {
    let fixture = Fixture::new().await;
    for name in ["", ".hidden", "CON", "bad/name", "trailing."] {
        let error = fixture
            .entries
            .create(WorkspaceEntryCreateRequest {
                workspace_id: fixture.workspace_id.clone(),
                parent_relative_path: String::new(),
                kind: WorkspaceEntryKind::Directory,
                base_name: name.to_owned(),
            })
            .await
            .expect_err("invalid name must fail");
        assert_eq!(error.code, ErrorCode::InvalidName, "{name:?}");
    }

    let managed = fixture.workspace.join(".excalidraw_assets");
    fs::create_dir(&managed).unwrap_or_else(|error| panic!("create managed dir: {error}"));
    let protected = fixture
        .entries
        .delete_preflight(WorkspaceEntryPathRequest {
            workspace_id: fixture.workspace_id.clone(),
            relative_path: ".excalidraw_assets".to_owned(),
        })
        .await
        .expect_err("managed directory must be protected");
    assert_eq!(protected.code, ErrorCode::EntryProtected);

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&fixture.outside, fixture.workspace.join("escape"))
            .unwrap_or_else(|error| panic!("create symlink: {error}"));
        let error = fixture
            .entries
            .delete_preflight(WorkspaceEntryPathRequest {
                workspace_id: fixture.workspace_id.clone(),
                relative_path: "escape".to_owned(),
            })
            .await
            .expect_err("symlink must be protected");
        assert_eq!(error.code, ErrorCode::EntryProtected);
    }
}

#[tokio::test]
async fn hidden_and_unsupported_children_make_directory_non_empty() {
    let fixture = Fixture::new().await;
    let hidden = fixture.workspace.join("folder").join(".hidden");
    let unsupported = fixture.workspace.join("folder").join("notes.txt");
    fs::write(&hidden, b"hidden").unwrap_or_else(|error| panic!("write hidden child: {error}"));
    fs::write(&unsupported, b"notes")
        .unwrap_or_else(|error| panic!("write unsupported child: {error}"));
    let result = fixture
        .entries
        .delete_preflight(WorkspaceEntryPathRequest {
            workspace_id: fixture.workspace_id.clone(),
            relative_path: "folder".to_owned(),
        })
        .await
        .unwrap_or_else(|error| panic!("directory preflight: {error:?}"));
    assert!(matches!(
        result,
        excalidraw_desktop_lib::commands::dto::WorkspaceEntryDeletePreflightResult::DirectoryNotEmpty {
            ..
        }
    ));
    assert!(fixture.workspace.join("folder").exists());
}

#[tokio::test]
async fn directory_rename_returns_expected_path_migrations_for_one_ten_and_hundred_documents() {
    for count in [1_usize, 10, 100] {
        let fixture = Fixture::new().await;
        let source = fixture.workspace.join("folder");
        for index in 0..count {
            let path = source.join(format!("drawing-{index}.excalidraw"));
            fs::write(&path, b"{}").unwrap_or_else(|error| panic!("write descendant: {error}"));
        }
        let expected_open_documents = (0..count)
            .map(|index| {
                let relative_path = format!("folder/drawing-{index}.excalidraw");
                ExpectedOpenDocument {
                    relative_path,
                    base_hash: format!("{:x}", Sha256::digest(b"{}")),
                }
            })
            .collect();
        let renamed = fixture
            .entries
            .rename(WorkspaceEntryRenameRequest {
                workspace_id: fixture.workspace_id.clone(),
                relative_path: "folder".to_owned(),
                base_name: "renamed-folder".to_owned(),
                expected_open_documents,
            })
            .await
            .unwrap_or_else(|error| panic!("rename {count} descendants: {error:?}"));
        assert_eq!(renamed.path_migrations.len(), count);
        assert!(fixture.workspace.join("renamed-folder").is_dir());
        assert!(!fixture.workspace.join("folder").exists());
    }
}

#[tokio::test]
async fn rename_migrates_index_draft_and_thumbnail_metadata_to_the_exact_new_path() {
    let fixture = Fixture::new().await;
    let source = fixture.workspace.join("drawing.excalidraw");
    let old_path = source
        .canonicalize()
        .unwrap_or_else(|error| panic!("canonicalize source: {error}"));
    let old_canonical = old_path.display().to_string();
    fixture
        .repository
        .file_index_upsert(FileIndexRecord {
            canonical_path: old_canonical.clone(),
            workspace_id: fixture.workspace_id.clone(),
            display_name: "drawing.excalidraw".to_owned(),
            relative_path: "drawing.excalidraw".to_owned(),
            mtime: 1,
            file_size: 2,
            content_hash: None,
        })
        .await
        .unwrap_or_else(|error| panic!("seed index: {error:?}"));
    fixture
        .repository
        .draft_upsert(DraftRecord {
            file_path: old_canonical.clone(),
            scene_json: "{}".to_owned(),
            content_hash: "hash".to_owned(),
            base_hash: None,
            updated_at: 1,
            is_dirty: false,
        })
        .await
        .unwrap_or_else(|error| panic!("seed draft: {error:?}"));
    fixture
        .repository
        .file_meta_upsert(FileMetaRecord {
            canonical_path: old_canonical.clone(),
            thumbnail_key: "key".to_owned(),
            thumbnail_path: "/tmp/key.webp".to_owned(),
            generated_at: 1,
            renderer_version: "1".to_owned(),
            theme: "light".to_owned(),
        })
        .await
        .unwrap_or_else(|error| panic!("seed metadata: {error:?}"));

    let result = fixture
        .entries
        .rename(WorkspaceEntryRenameRequest {
            workspace_id: fixture.workspace_id.clone(),
            relative_path: "drawing.excalidraw".to_owned(),
            base_name: "renamed".to_owned(),
            expected_open_documents: Vec::new(),
        })
        .await
        .unwrap_or_else(|error| panic!("rename drawing: {error:?}"));
    let new_canonical = fixture
        .workspace
        .join("renamed.excalidraw")
        .canonicalize()
        .unwrap_or_else(|error| panic!("canonicalize target: {error}"))
        .display()
        .to_string();
    assert_eq!(
        fixture
            .repository
            .file_index_get(old_canonical.clone())
            .await
            .unwrap_or_else(|error| panic!("read old index: {error:?}")),
        None
    );
    assert_eq!(
        fixture
            .repository
            .file_index_get(new_canonical.clone())
            .await
            .unwrap_or_else(|error| panic!("read new index: {error:?}"))
            .map(|record| record.relative_path),
        Some("renamed.excalidraw".to_owned())
    );
    assert_eq!(
        fixture
            .repository
            .draft_get(new_canonical.clone())
            .await
            .unwrap_or_else(|error| panic!("read new draft: {error:?}"))
            .map(|record| record.file_path),
        Some(new_canonical.clone())
    );
    assert_eq!(
        fixture
            .repository
            .file_meta_get(new_canonical)
            .await
            .unwrap_or_else(|error| panic!("read new metadata: {error:?}"))
            .map(|record| record.canonical_path),
        Some(
            fixture
                .workspace
                .join("renamed.excalidraw")
                .canonicalize()
                .unwrap()
                .display()
                .to_string()
        )
    );
    assert_eq!(result.path_migrations.len(), 0);
}

struct FailingTrash;

impl TrashOperator for FailingTrash {
    fn delete(&self, _path: &Path) -> Result<(), io::Error> {
        Err(io::Error::other("injected Trash failure"))
    }
}

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

#[tokio::test]
async fn trash_failure_preserves_disk_and_clean_metadata_is_removed_after_success() {
    let fixture = Fixture::new().await;
    let path = fixture.workspace.join("drawing.excalidraw");
    let canonical = path
        .canonicalize()
        .unwrap_or_else(|error| panic!("canonicalize drawing: {error}"))
        .display()
        .to_string();
    fixture
        .repository
        .file_index_upsert(FileIndexRecord {
            canonical_path: canonical.clone(),
            workspace_id: fixture.workspace_id.clone(),
            display_name: "drawing.excalidraw".to_owned(),
            relative_path: "drawing.excalidraw".to_owned(),
            mtime: 1,
            file_size: 2,
            content_hash: None,
        })
        .await
        .unwrap_or_else(|error| panic!("seed index: {error:?}"));
    fixture
        .repository
        .draft_upsert(DraftRecord {
            file_path: canonical.clone(),
            scene_json: "{}".to_owned(),
            content_hash: "hash".to_owned(),
            base_hash: None,
            updated_at: 1,
            is_dirty: false,
        })
        .await
        .unwrap_or_else(|error| panic!("seed draft: {error:?}"));
    fixture
        .repository
        .file_meta_upsert(FileMetaRecord {
            canonical_path: canonical.clone(),
            thumbnail_key: "key".to_owned(),
            thumbnail_path: "/tmp/key.webp".to_owned(),
            generated_at: 1,
            renderer_version: "1".to_owned(),
            theme: "light".to_owned(),
        })
        .await
        .unwrap_or_else(|error| panic!("seed metadata: {error:?}"));

    let failing = WorkspaceEntryService::with_trash(
        Arc::clone(&fixture.repository),
        WorkspaceMutationGate::default(),
        Arc::new(FailingTrash),
    );
    let error = failing
        .delete(WorkspaceEntryDeleteRequest {
            workspace_id: fixture.workspace_id.clone(),
            relative_path: "drawing.excalidraw".to_owned(),
            expected_open_document: None,
        })
        .await
        .expect_err("injected Trash failure must fail");
    assert_eq!(error.code, ErrorCode::IoError);
    assert!(path.exists());
    assert!(fixture
        .repository
        .file_index_get(canonical.clone())
        .await
        .unwrap_or_else(|error| panic!("read index after failure: {error:?}"))
        .is_some());

    let successful = WorkspaceEntryService::with_trash(
        Arc::clone(&fixture.repository),
        WorkspaceMutationGate::default(),
        Arc::new(RemovingTrash),
    );
    successful
        .delete(WorkspaceEntryDeleteRequest {
            workspace_id: fixture.workspace_id.clone(),
            relative_path: "drawing.excalidraw".to_owned(),
            expected_open_document: None,
        })
        .await
        .unwrap_or_else(|error| panic!("delete after injected failure: {error:?}"));
    assert!(!path.exists());
    assert!(fixture
        .repository
        .file_index_get(canonical.clone())
        .await
        .unwrap_or_else(|error| panic!("read index after success: {error:?}"))
        .is_none());
    assert!(fixture
        .repository
        .draft_get(canonical.clone())
        .await
        .unwrap_or_else(|error| panic!("read draft after success: {error:?}"))
        .is_none());
    assert!(fixture
        .repository
        .file_meta_get(canonical)
        .await
        .unwrap_or_else(|error| panic!("read metadata after success: {error:?}"))
        .is_none());
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
