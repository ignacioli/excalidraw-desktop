use std::{fs, path::PathBuf, sync::Arc};

use excalidraw_desktop_lib::{
    commands::documents::DocumentService,
    database::repository::{SqliteRepository, WorkspaceRecord, WorkspaceRepository},
};

pub struct DocumentHarness {
    pub root: PathBuf,
    pub workspace: PathBuf,
    #[allow(
        dead_code,
        reason = "the shared integration fixture is compiled per test crate"
    )]
    pub outside: PathBuf,
    pub repository: Arc<SqliteRepository>,
    pub service: DocumentService,
}

impl DocumentHarness {
    pub async fn new(scene_limit: usize) -> Self {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-document-contract-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let workspace = root.join("workspace");
        let outside = root.join("outside");
        fs::create_dir_all(&workspace)
            .unwrap_or_else(|error| panic!("create workspace fixture: {error}"));
        fs::create_dir_all(&outside)
            .unwrap_or_else(|error| panic!("create outside fixture: {error}"));

        let repository = Arc::new(
            SqliteRepository::open(&root.join("state.sqlite3"))
                .await
                .unwrap_or_else(|error| panic!("open fixture repository: {error}")),
        );
        let canonical_workspace = workspace
            .canonicalize()
            .unwrap_or_else(|error| panic!("canonicalize workspace fixture: {error}"));
        repository
            .workspace_upsert(WorkspaceRecord {
                id: "workspace-1".to_owned(),
                name: "Workspace".to_owned(),
                root_path: canonical_workspace.display().to_string(),
                created_at: 1,
            })
            .await
            .unwrap_or_else(|error| panic!("register workspace fixture: {error}"));

        let service = DocumentService::with_scene_limit(Arc::clone(&repository), scene_limit);
        Self {
            root,
            workspace,
            outside,
            repository,
            service,
        }
    }

    pub fn document_path(&self, name: &str) -> PathBuf {
        self.workspace.join(name)
    }

    pub fn write_scene(&self, name: &str, scene: &str) -> PathBuf {
        let path = self.document_path(name);
        fs::write(&path, scene).unwrap_or_else(|error| panic!("write scene fixture: {error}"));
        path
    }
}

impl Drop for DocumentHarness {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub fn valid_scene(label: &str) -> String {
    format!(
        r#"{{"type":"excalidraw","version":2,"source":"desktop-test","elements":[{{"id":"{label}","type":"rectangle"}}],"appState":{{}},"files":{{}}}}"#
    )
}

pub fn read_scene(path: &std::path::Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|error| panic!("read scene fixture: {error}"))
}
