use std::{fs, path::PathBuf, sync::Arc};

use excalidraw_desktop_lib::{
    commands::{
        dto::{Theme, ThumbnailLookupRequest, ThumbnailStoreRequest, WorkspaceAddRequest},
        error::ErrorCode,
        thumbnails::ThumbnailService,
        workspace::WorkspaceService,
    },
    database::repository::SqliteRepository,
    thumbnails::{ThumbnailCache, MAX_THUMBNAIL_BYTES, RENDERER_VERSION},
};

fn valid_webp() -> Vec<u8> {
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&[0, 0, 0, 0]);
    bytes.extend_from_slice(b"WEBP");
    bytes
}

/// 64 lowercase hex characters with low entropy, used only as a validation
/// fixture so secret scanners never mistake it for a credential.
fn test_thumbnail_key() -> String {
    "ab".repeat(32)
}

struct Fixture {
    root: PathBuf,
    workspace: PathBuf,
    outside: PathBuf,
    cache: Arc<ThumbnailCache>,
    service: ThumbnailService,
}

impl Fixture {
    async fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-thumbnail-contract-{}-{}",
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
        WorkspaceService::new(Arc::clone(&repository))
            .add(WorkspaceAddRequest {
                root_path: workspace.display().to_string(),
                name: Some("Workspace".to_owned()),
            })
            .await
            .unwrap();
        let cache = Arc::new(ThumbnailCache::new(&root));
        let service = ThumbnailService::new(Arc::clone(&repository), Arc::clone(&cache));
        Self {
            root,
            workspace,
            outside,
            cache,
            service,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn thumbnail_lookup_misses_until_content_and_theme_match() {
    let fixture = Fixture::new().await;
    let drawing = fixture.workspace.join("drawing.excalidraw");
    let content = br#"{"type":"excalidraw","version":2}"#;
    fs::write(&drawing, content).unwrap();

    let miss = fixture
        .service
        .lookup(ThumbnailLookupRequest {
            path: drawing.display().to_string(),
            theme: Theme::Light,
        })
        .await
        .unwrap();
    assert!(!miss.hit);
    assert!(miss.webp_path.is_none());

    let key = ThumbnailCache::compute_key(content, RENDERER_VERSION, "light");
    let stored = fixture
        .service
        .store(ThumbnailStoreRequest {
            path: drawing.display().to_string(),
            theme: "light".to_owned(),
            key: key.clone(),
            webp_bytes: valid_webp(),
        })
        .await
        .unwrap();
    assert!(PathBuf::from(&stored.webp_path).is_file());
    assert_eq!(
        stored.webp_path,
        fixture.cache.path_for_key(&key).display().to_string()
    );

    let hit = fixture
        .service
        .lookup(ThumbnailLookupRequest {
            path: drawing.display().to_string(),
            theme: Theme::Light,
        })
        .await
        .unwrap();
    assert!(hit.hit);
    assert_eq!(hit.webp_path.as_deref(), Some(stored.webp_path.as_str()));

    let dark_miss = fixture
        .service
        .lookup(ThumbnailLookupRequest {
            path: drawing.display().to_string(),
            theme: Theme::Dark,
        })
        .await
        .unwrap();
    assert!(!dark_miss.hit);
    assert!(dark_miss.webp_path.is_none());
}

#[tokio::test]
async fn thumbnail_store_rejects_paths_outside_the_workspace() {
    let fixture = Fixture::new().await;
    let outside = fixture.outside.join("secret.excalidraw");
    fs::write(&outside, b"{}").unwrap();
    let error = fixture
        .service
        .store(ThumbnailStoreRequest {
            path: outside.display().to_string(),
            theme: "light".to_owned(),
            key: test_thumbnail_key(),
            webp_bytes: valid_webp(),
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::PathAccessDenied);
}

#[tokio::test]
async fn thumbnail_store_validates_theme_key_and_payload() {
    let fixture = Fixture::new().await;
    let drawing = fixture.workspace.join("drawing.excalidraw");
    fs::write(&drawing, b"{}").unwrap();
    let path = drawing.display().to_string();
    let valid_key = test_thumbnail_key();

    let invalid_theme = fixture
        .service
        .store(ThumbnailStoreRequest {
            path: path.clone(),
            theme: "blue".to_owned(),
            key: valid_key.to_owned(),
            webp_bytes: valid_webp(),
        })
        .await
        .unwrap_err();
    assert_eq!(invalid_theme.code, ErrorCode::InvalidScene);

    let invalid_key = fixture
        .service
        .store(ThumbnailStoreRequest {
            path: path.clone(),
            theme: "light".to_owned(),
            key: valid_key.to_ascii_uppercase(),
            webp_bytes: valid_webp(),
        })
        .await
        .unwrap_err();
    assert_eq!(invalid_key.code, ErrorCode::InvalidScene);

    let non_webp = fixture
        .service
        .store(ThumbnailStoreRequest {
            path: path.clone(),
            theme: "light".to_owned(),
            key: valid_key.to_owned(),
            webp_bytes: b"definitely not webp".to_vec(),
        })
        .await
        .unwrap_err();
    assert_eq!(non_webp.code, ErrorCode::InvalidScene);
    assert!(!fixture.cache.path_for_key(&valid_key).exists());

    let mut oversized = b"RIFF".to_vec();
    oversized.resize(MAX_THUMBNAIL_BYTES + 1, 0);
    oversized.extend_from_slice(b"WEBP");
    let too_large = fixture
        .service
        .store(ThumbnailStoreRequest {
            path,
            theme: "light".to_owned(),
            key: valid_key.to_owned(),
            webp_bytes: oversized,
        })
        .await
        .unwrap_err();
    assert_eq!(too_large.code, ErrorCode::FileTooLarge);
}

#[tokio::test]
async fn thumbnail_metadata_survives_service_recreation() {
    let root = std::env::temp_dir().join(format!(
        "excalidraw-thumbnail-restart-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let workspace = root.join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let drawing = workspace.join("drawing.excalidraw");
    let content = br#"{"type":"excalidraw","version":2}"#;
    fs::write(&drawing, content).unwrap();

    let first_repository;
    let stored_path = {
        let repository = Arc::new(
            SqliteRepository::open(&root.join("state.sqlite3"))
                .await
                .unwrap(),
        );
        first_repository = Arc::clone(&repository);
        WorkspaceService::new(Arc::clone(&repository))
            .add(WorkspaceAddRequest {
                root_path: workspace.display().to_string(),
                name: None,
            })
            .await
            .unwrap();
        let cache = Arc::new(ThumbnailCache::new(&root));
        let service = ThumbnailService::new(repository, Arc::clone(&cache));
        let key = ThumbnailCache::compute_key(content, RENDERER_VERSION, "light");
        let stored = service
            .store(ThumbnailStoreRequest {
                path: drawing.display().to_string(),
                theme: "light".to_owned(),
                key,
                webp_bytes: valid_webp(),
            })
            .await
            .unwrap();
        assert!(PathBuf::from(&stored.webp_path).is_file());
        stored.webp_path
    };
    drop(first_repository);

    let repository = Arc::new(
        SqliteRepository::open(&root.join("state.sqlite3"))
            .await
            .unwrap(),
    );
    let service = ThumbnailService::new(repository, Arc::new(ThumbnailCache::new(&root)));
    let hit = service
        .lookup(ThumbnailLookupRequest {
            path: drawing.display().to_string(),
            theme: Theme::Light,
        })
        .await
        .unwrap();
    assert!(hit.hit);
    assert_eq!(hit.webp_path.as_deref(), Some(stored_path.as_str()));

    fs::remove_dir_all(&root).unwrap();
}
