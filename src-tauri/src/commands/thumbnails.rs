//! IPC commands for the thumbnail cache (`thumb_lookup`, `thumb_store`).
//!
//! Paths must live inside a mounted workspace (same authorization as
//! `dir_list`). The lookup key is derived from the file content on disk and
//! the requested theme, so a stale thumbnail only hits when the content and
//! renderer version still match.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::State;

use crate::{
    database::repository::{FileMetaRecord, FileMetaRepository, SqliteRepository},
    thumbnails::{ThumbnailCache, ThumbnailError, RENDERER_VERSION},
};

use super::{
    dto::{
        Theme, ThumbnailLookupRequest, ThumbnailLookupResponse, ThumbnailStoreRequest,
        ThumbnailStoreResponse,
    },
    error::{AppError, IpcError},
    workspace::policy_for_repository,
};

/// Upper bound when reading a document to derive its thumbnail cache key.
pub const MAX_DOCUMENT_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone)]
pub struct ThumbnailService {
    repository: Arc<SqliteRepository>,
    cache: Arc<ThumbnailCache>,
}

impl ThumbnailService {
    pub fn new(repository: Arc<SqliteRepository>, cache: Arc<ThumbnailCache>) -> Self {
        Self { repository, cache }
    }

    pub async fn lookup(
        &self,
        request: ThumbnailLookupRequest,
    ) -> Result<ThumbnailLookupResponse, IpcError> {
        self.lookup_inner(request).await.map_err(Into::into)
    }

    async fn lookup_inner(
        &self,
        request: ThumbnailLookupRequest,
    ) -> Result<ThumbnailLookupResponse, AppError> {
        let path = self.authorize_document(Path::new(&request.path)).await?;
        let theme = theme_name(request.theme);
        let canonical_path = path.display().to_string();
        let read_path = path.clone();
        let content = run_blocking(move || read_bounded(&read_path, MAX_DOCUMENT_BYTES)).await?;
        let key = ThumbnailCache::compute_key(&content, RENDERER_VERSION, theme);
        let metadata = self.repository.file_meta_get(canonical_path).await?;
        let key_matches = metadata
            .as_ref()
            .is_some_and(|meta| meta.thumbnail_key == key);
        let file_exists = self.cache.contains(&key);
        if key_matches && file_exists {
            Ok(ThumbnailLookupResponse {
                hit: true,
                webp_path: Some(self.cache.path_for_key(&key).display().to_string()),
            })
        } else {
            Ok(ThumbnailLookupResponse {
                hit: false,
                webp_path: None,
            })
        }
    }

    pub async fn store(
        &self,
        request: ThumbnailStoreRequest,
    ) -> Result<ThumbnailStoreResponse, IpcError> {
        self.store_inner(request).await.map_err(Into::into)
    }

    async fn store_inner(
        &self,
        request: ThumbnailStoreRequest,
    ) -> Result<ThumbnailStoreResponse, AppError> {
        let path = self.authorize_document(Path::new(&request.path)).await?;
        ThumbnailCache::validate_theme(&request.theme).map_err(thumbnail_error_to_app_error)?;
        ThumbnailCache::validate_key(&request.key).map_err(thumbnail_error_to_app_error)?;
        let cache = Arc::clone(&self.cache);
        let key = request.key.clone();
        let bytes = request.webp_bytes;
        let webp_path = run_blocking(move || {
            cache
                .store(&key, &bytes)
                .map_err(thumbnail_error_to_app_error)
        })
        .await?;
        self.repository
            .file_meta_upsert(FileMetaRecord {
                canonical_path: path.display().to_string(),
                thumbnail_key: request.key,
                thumbnail_path: webp_path.display().to_string(),
                generated_at: unix_timestamp()?,
                renderer_version: RENDERER_VERSION.to_owned(),
                theme: request.theme.clone(),
            })
            .await?;
        Ok(ThumbnailStoreResponse {
            webp_path: webp_path.display().to_string(),
        })
    }

    async fn authorize_document(&self, requested: &Path) -> Result<PathBuf, AppError> {
        let policy = policy_for_repository(&self.repository).await?;
        policy.authorize_existing(requested).map_err(Into::into)
    }
}

#[derive(Clone)]
pub struct ThumbnailState {
    service: ThumbnailService,
}

impl ThumbnailState {
    pub fn new(service: ThumbnailService) -> Self {
        Self { service }
    }
}

#[tauri::command]
pub async fn thumb_lookup(
    path: String,
    theme: Theme,
    state: State<'_, ThumbnailState>,
) -> Result<ThumbnailLookupResponse, IpcError> {
    state
        .service
        .lookup(ThumbnailLookupRequest { path, theme })
        .await
}

#[tauri::command]
pub async fn thumb_store(
    path: String,
    theme: String,
    key: String,
    webp_bytes: Vec<u8>,
    state: State<'_, ThumbnailState>,
) -> Result<ThumbnailStoreResponse, IpcError> {
    state
        .service
        .store(ThumbnailStoreRequest {
            path,
            theme,
            key,
            webp_bytes,
        })
        .await
}

fn theme_name(theme: Theme) -> &'static str {
    match theme {
        Theme::Light => "light",
        Theme::Dark => "dark",
    }
}

fn thumbnail_error_to_app_error(error: ThumbnailError) -> AppError {
    match error {
        // Malformed request input maps to INVALID_SCENE: it is the closest
        // existing category for "the caller supplied data the API cannot
        // interpret" (theme, key, and WebP payload are all caller input).
        ThumbnailError::InvalidTheme(message)
        | ThumbnailError::InvalidKey(message)
        | ThumbnailError::InvalidWebp(message) => AppError::InvalidScene(message),
        ThumbnailError::TooLarge {
            actual_bytes,
            maximum_bytes,
        } => AppError::FileTooLarge {
            actual_bytes,
            maximum_bytes,
        },
        ThumbnailError::AtomicWrite(inner) => AppError::from(inner),
        ThumbnailError::Io { path, source } => AppError::Io {
            path: Some(path),
            source,
        },
    }
}

fn read_bounded(path: &Path, maximum_bytes: usize) -> Result<Vec<u8>, AppError> {
    let metadata = fs::metadata(path).map_err(|source| AppError::Io {
        path: Some(path.to_path_buf()),
        source,
    })?;
    if metadata.len() > maximum_bytes as u64 {
        return Err(AppError::FileTooLarge {
            actual_bytes: metadata.len(),
            maximum_bytes: maximum_bytes as u64,
        });
    }
    fs::read(path).map_err(|source| AppError::Io {
        path: Some(path.to_path_buf()),
        source,
    })
}

fn unix_timestamp() -> Result<i64, AppError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .map_err(|_| AppError::Internal("system clock is before Unix epoch".to_owned()))
}

async fn run_blocking<T, F>(operation: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| AppError::Internal(format!("blocking thumbnail task failed: {error}")))?
}
