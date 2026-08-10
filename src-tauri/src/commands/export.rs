//! IPC entry for persisting frontend-rendered PNG/SVG exports.
//!
//! The frontend renders the export (scale, background, theme, embedded fonts)
//! and hands the finished bytes to `doc_export`. The backend validates the
//! scene payload, authorizes the user-chosen destination, and publishes the
//! bytes through the same atomic temp-write/fsync/rename pipeline used for
//! document checkpoints, so a failed export leaves no partial file.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use tauri::State;

use crate::{
    database::repository::{SqliteRepository, WorkspaceRepository},
    documents::{
        atomic_write::atomic_write_bytes,
        validation::{validate_scene, SceneValidationError},
    },
    security::{PathSecurityError, WorkspacePathPolicy},
};

use super::{
    documents::DirectFileGrant,
    dto::{ExportFormat, ExportOptions, ExportRequest, ExportResponse},
    error::{AppError, IpcError},
};

#[derive(Clone)]
pub struct ExportService {
    repository: Arc<SqliteRepository>,
    direct_file_grant: Arc<dyn DirectFileGrant>,
    scene_limit_bytes: usize,
}

impl ExportService {
    pub const DEFAULT_SCENE_LIMIT_BYTES: usize = 256 * 1024 * 1024;
    pub const MAX_EXPORT_BYTES: usize = 512 * 1024 * 1024;

    pub fn new(
        repository: Arc<SqliteRepository>,
        direct_file_grant: Arc<dyn DirectFileGrant>,
        scene_limit_bytes: usize,
    ) -> Self {
        Self {
            repository,
            direct_file_grant,
            scene_limit_bytes,
        }
    }

    pub async fn export(
        &self,
        request: ExportRequest,
        rendered_bytes: Vec<u8>,
    ) -> Result<ExportResponse, AppError> {
        if rendered_bytes.len() > Self::MAX_EXPORT_BYTES {
            return Err(AppError::FileTooLarge {
                actual_bytes: rendered_bytes.len() as u64,
                maximum_bytes: Self::MAX_EXPORT_BYTES as u64,
            });
        }
        let scene_bytes = request.scene_json.as_bytes();
        validate_export_scene(scene_bytes, self.scene_limit_bytes)?;
        validate_export_options(&request.options)?;

        let target = self
            .authorize_target(Path::new(&request.target_path))
            .await?;
        let write_path = target.clone();
        let payload = rendered_bytes;
        run_blocking(move || atomic_write_bytes(&write_path, &payload).map_err(AppError::from))
            .await?;

        Ok(ExportResponse {
            written_path: path_string(&target),
        })
    }

    async fn authorize_target(&self, target: &Path) -> Result<PathBuf, AppError> {
        let workspaces = self.repository.workspace_list().await?;
        let policy = WorkspacePathPolicy::new(
            workspaces
                .iter()
                .map(|workspace| Path::new(&workspace.root_path)),
        )?;
        let authorization = if target.exists() {
            policy.authorize_existing(target)
        } else {
            policy.authorize_for_creation(target)
        };
        match authorization {
            Ok(path) => Ok(path),
            Err(PathSecurityError::AccessDenied(_)) => self.authorize_granted_target(target),
            Err(error) => Err(error.into()),
        }
    }

    fn authorize_granted_target(&self, target: &Path) -> Result<PathBuf, AppError> {
        if self.direct_file_grant.is_allowed(target) {
            return normalize_granted_path(target, target.exists());
        }
        // The save dialog scopes the exact path the user selected; when the
        // frontend appends the standard extension, accept that deterministic
        // sibling so the selection stays authorized.
        if !target.exists()
            && self
                .direct_file_grant
                .is_allowed(&target.with_extension(""))
        {
            return normalize_granted_path(target, false);
        }
        Err(AppError::PathAccessDenied(target.to_path_buf()))
    }
}

#[derive(Clone)]
pub struct ExportState {
    service: ExportService,
}

impl ExportState {
    pub fn new(service: ExportService) -> Self {
        Self { service }
    }
}

#[tauri::command]
pub async fn doc_export(
    path: Option<String>,
    scene_json: String,
    format: ExportFormat,
    target_path: String,
    options: ExportOptions,
    bytes: Vec<u8>,
    state: State<'_, ExportState>,
) -> Result<ExportResponse, IpcError> {
    state
        .service
        .export(
            ExportRequest {
                path,
                scene_json,
                format,
                target_path,
                options,
            },
            bytes,
        )
        .await
        .map_err(Into::into)
}

fn validate_export_scene(bytes: &[u8], maximum_bytes: usize) -> Result<(), AppError> {
    validate_scene(bytes, maximum_bytes)
        .map(|_| ())
        .map_err(|error| match error {
            SceneValidationError::TooLarge {
                actual_bytes,
                maximum_bytes,
            } => AppError::FileTooLarge {
                actual_bytes,
                maximum_bytes,
            },
            other => AppError::InvalidScene(other.to_string()),
        })
}

fn validate_export_options(options: &ExportOptions) -> Result<(), AppError> {
    if options.scale.is_some_and(|scale| !(1..=3).contains(&scale)) {
        return Err(AppError::InvalidScene(
            "export scale must be 1, 2, or 3".to_owned(),
        ));
    }
    Ok(())
}

fn normalize_granted_path(target: &Path, exists: bool) -> Result<PathBuf, AppError> {
    if exists {
        return target.canonicalize().map_err(|source| AppError::Io {
            path: Some(target.to_path_buf()),
            source,
        });
    }
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = target
        .file_name()
        .ok_or_else(|| AppError::PathAccessDenied(target.to_path_buf()))?;
    let canonical_parent = parent.canonicalize().map_err(|source| AppError::Io {
        path: Some(parent.to_path_buf()),
        source,
    })?;
    Ok(canonical_parent.join(file_name))
}

fn path_string(path: &Path) -> String {
    path.display().to_string()
}

async fn run_blocking<T, F>(operation: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| AppError::Internal(format!("blocking export task failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::Arc,
    };

    use crate::{
        database::repository::{SqliteRepository, WorkspaceRecord, WorkspaceRepository},
        documents::atomic_write::{atomic_write_bytes, atomic_write_bytes_with_injector},
    };

    use super::*;

    struct AllowGrant(PathBuf);

    impl DirectFileGrant for AllowGrant {
        fn is_allowed(&self, path: &Path) -> bool {
            path == self.0
        }
    }

    #[tokio::test]
    async fn export_publishes_bytes_to_an_authorized_workspace_path() {
        let fixture = Fixture::new("workspace-export").await;
        let target = fixture.workspace.join("export.png");
        let payload = b"\x89PNG fake bytes";

        let response = fixture
            .service
            .export(fixture.request(&target, valid_scene()), payload.to_vec())
            .await
            .unwrap_or_else(|error| panic!("export drawing: {error:?}"));

        let canonical_target = target
            .canonicalize()
            .unwrap_or_else(|error| panic!("canonicalize export target: {error}"));
        assert_eq!(
            response.written_path,
            canonical_target.display().to_string()
        );
        assert_eq!(
            fs::read(&target).unwrap_or_else(|error| panic!("read export: {error}")),
            payload
        );
        assert!(tmp_files(&fixture.root).is_empty());
        fixture.cleanup();
    }

    #[tokio::test]
    async fn export_publishes_bytes_to_a_grant_only_dialog_path() {
        let fixture = Fixture::new("grant-export").await;
        let target = fixture.root.join("granted.svg");
        let grant = Arc::new(AllowGrant(target.clone()));
        let service = ExportService::new(
            Arc::clone(&fixture.repository),
            grant,
            ExportService::DEFAULT_SCENE_LIMIT_BYTES,
        );
        let payload = b"<svg/>";

        let response = service
            .export(fixture.request(&target, valid_scene()), payload.to_vec())
            .await
            .unwrap_or_else(|error| panic!("export drawing: {error:?}"));

        let canonical_target = target
            .canonicalize()
            .unwrap_or_else(|error| panic!("canonicalize export target: {error}"));
        assert_eq!(
            response.written_path,
            canonical_target.display().to_string()
        );
        assert_eq!(
            fs::read(&target).unwrap_or_else(|error| panic!("read export: {error}")),
            payload
        );
        assert!(tmp_files(&fixture.root).is_empty());
        fixture.cleanup();
    }

    #[tokio::test]
    async fn export_accepts_the_scoped_extension_sibling_when_the_frontend_adds_the_extension() {
        let fixture = Fixture::new("extension-sibling").await;
        let target = fixture.root.join("drawing.png");
        let grant = Arc::new(AllowGrant(target.with_extension("")));
        let service = ExportService::new(
            Arc::clone(&fixture.repository),
            grant,
            ExportService::DEFAULT_SCENE_LIMIT_BYTES,
        );

        let response = service
            .export(fixture.request(&target, valid_scene()), b"png".to_vec())
            .await
            .unwrap_or_else(|error| panic!("export drawing: {error:?}"));

        let canonical_target = target
            .canonicalize()
            .unwrap_or_else(|error| panic!("canonicalize export target: {error}"));
        assert_eq!(
            response.written_path,
            canonical_target.display().to_string()
        );
        fixture.cleanup();
    }

    #[tokio::test]
    async fn export_rejects_paths_outside_workspaces_and_the_dialog_grant() {
        let fixture = Fixture::new("denied-export").await;
        let outside_directory = fixture.root.join("outside");
        fs::create_dir_all(&outside_directory)
            .unwrap_or_else(|error| panic!("create outside fixture: {error}"));
        let outside = outside_directory.join("sneak.png");

        let error = fixture
            .service
            .export(fixture.request(&outside, valid_scene()), b"png".to_vec())
            .await
            .expect_err("outside path must be denied");

        match error {
            AppError::PathAccessDenied(_) => {}
            other => panic!("expected path denial, got: {other:?}"),
        }
        assert!(!outside.exists());
        assert!(tmp_files(&fixture.root).is_empty());
        fixture.cleanup();
    }

    #[tokio::test]
    async fn export_rejects_invalid_scene_and_invalid_scale() {
        let fixture = Fixture::new("invalid-export").await;
        let target = fixture.root.join("drawing.png");

        let mut request = fixture.request(&target, valid_scene());
        request.options.scale = Some(4);
        let scene_error = fixture
            .service
            .export(request, b"png".to_vec())
            .await
            .expect_err("out-of-range scale must be rejected");
        assert!(matches!(scene_error, AppError::InvalidScene(_)));

        let invalid_scene_error = fixture
            .service
            .export(
                fixture.request(&target, br#"{"not":"a scene"}"#),
                b"png".to_vec(),
            )
            .await
            .expect_err("invalid scene must be rejected");
        assert!(matches!(invalid_scene_error, AppError::InvalidScene(_)));
        assert!(!target.exists());
        assert!(tmp_files(&fixture.root).is_empty());
        fixture.cleanup();
    }

    #[tokio::test]
    async fn export_failure_leaves_no_temporary_file() {
        let fixture = Fixture::new("failed-export").await;
        // A file occupying the parent slot makes every temp write fail with an
        // I/O error; the atomic writer must clean its temp path and report a
        // stable IO_ERROR instead of leaving residue.
        let blocker_directory = fixture.workspace.join("blocked-dir");
        fs::write(&blocker_directory, "not a directory")
            .unwrap_or_else(|error| panic!("write blocker: {error}"));
        let blocker = blocker_directory.join("export.png");

        let error = fixture
            .service
            .export(fixture.request(&blocker, valid_scene()), b"png".to_vec())
            .await
            .expect_err("write into a non-directory must fail");
        match error {
            AppError::Io { .. } => {}
            other => panic!("expected I/O error, got: {other:?}"),
        }
        assert!(!blocker.exists());
        assert!(tmp_files(&fixture.root).is_empty());
        fixture.cleanup();
    }

    #[tokio::test]
    async fn export_bytes_variant_survives_fault_points_without_partial_target() {
        let directory = test_directory("export-fault");
        let target = directory.join("drawing.svg");
        let old = b"<svg>old</svg>";
        let new = b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>";
        fs::write(&target, old).unwrap_or_else(|error| panic!("write fixture: {error}"));

        for point in [
            crate::documents::atomic_write::AtomicWriteFaultPoint::TempCreated,
            crate::documents::atomic_write::AtomicWriteFaultPoint::MidWrite,
            crate::documents::atomic_write::AtomicWriteFaultPoint::TempSynced,
            crate::documents::atomic_write::AtomicWriteFaultPoint::JsonValidated,
            crate::documents::atomic_write::AtomicWriteFaultPoint::BeforeRename,
            crate::documents::atomic_write::AtomicWriteFaultPoint::AfterRename,
            crate::documents::atomic_write::AtomicWriteFaultPoint::BeforeParentSync,
            crate::documents::atomic_write::AtomicWriteFaultPoint::ParentSynced,
        ] {
            let result = atomic_write_bytes_with_injector(&target, new, &InterruptAt(point));
            assert!(matches!(
                result,
                Err(crate::documents::atomic_write::AtomicWriteError::FaultInjected(
                    actual
                )) if actual == point
            ));
            let persisted = fs::read(&target)
                .unwrap_or_else(|error| panic!("read target after {point}: {error}"));
            assert!(
                persisted == old || persisted == new,
                "unexpected bytes after {point}"
            );
            assert!(
                tmp_files(&directory).is_empty(),
                "temporary files remain after {point}"
            );
        }
        fs::remove_dir_all(&directory)
            .unwrap_or_else(|error| panic!("remove fault directory: {error}"));
    }

    #[test]
    fn bytes_variant_skips_json_validation() {
        let directory = test_directory("bytes-validation");
        let target = directory.join("export.bin");
        let payload = b"\x00\x01not json at all";

        atomic_write_bytes(&target, payload)
            .unwrap_or_else(|error| panic!("atomic byte write: {error}"));
        assert_eq!(
            fs::read(&target).unwrap_or_else(|error| panic!("read target: {error}")),
            payload
        );
        fs::remove_dir_all(&directory).unwrap_or_else(|error| panic!("remove directory: {error}"));
    }

    struct InterruptAt(crate::documents::atomic_write::AtomicWriteFaultPoint);

    impl crate::documents::atomic_write::AtomicWriteFaultInjector for InterruptAt {
        fn interrupt(
            &self,
            point: crate::documents::atomic_write::AtomicWriteFaultPoint,
        ) -> Result<(), crate::documents::atomic_write::AtomicWriteError> {
            if point == self.0 {
                return Err(crate::documents::atomic_write::AtomicWriteError::FaultInjected(point));
            }
            Ok(())
        }
    }

    struct Fixture {
        root: PathBuf,
        workspace: PathBuf,
        repository: Arc<SqliteRepository>,
        service: ExportService,
    }

    impl Fixture {
        async fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "excalidraw-export-{label}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            let workspace = root.join("workspace");
            fs::create_dir_all(&workspace)
                .unwrap_or_else(|error| panic!("create workspace fixture: {error}"));
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
            let service = ExportService::new(
                Arc::clone(&repository),
                Arc::new(AllowGrant(root.join("granted.svg"))),
                ExportService::DEFAULT_SCENE_LIMIT_BYTES,
            );
            Self {
                root,
                workspace,
                repository,
                service,
            }
        }

        fn request(&self, target: &Path, scene: &[u8]) -> ExportRequest {
            ExportRequest {
                path: Some("unused-source.excalidraw".to_owned()),
                scene_json: String::from_utf8_lossy(scene).into_owned(),
                format: ExportFormat::Png,
                target_path: target.display().to_string(),
                options: ExportOptions {
                    scale: Some(2),
                    background: None,
                    theme: None,
                },
            }
        }

        fn cleanup(&self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn test_directory(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "excalidraw-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory)
            .unwrap_or_else(|error| panic!("create test directory: {error}"));
        directory
    }

    fn valid_scene() -> &'static [u8] {
        br#"{"type":"excalidraw","version":2,"source":"desktop-test","elements":[],"appState":{},"files":{}}"#
    }

    fn tmp_files(directory: &Path) -> Vec<PathBuf> {
        fs::read_dir(directory)
            .unwrap_or_else(|error| panic!("read test directory: {error}"))
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|extension| extension == "tmp"))
            .collect()
    }
}
