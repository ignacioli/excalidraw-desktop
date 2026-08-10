//! Thumbnail cache domain: content-addressed WebP storage under the app data
//! directory, addressed by `SHA256(content | renderer_version | theme)`.
//!
//! The IPC layer owns authorization and the `file_meta` SQLite row; this
//! module owns the cache key, disk layout, payload validation, and the atomic
//! publish of thumbnail bytes.

use std::{
    fs,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::documents::atomic_write::atomic_write_bytes;

/// Renderer version that participates in the content-addressed key. Bump when
/// the frontend thumbnail renderer changes so stale thumbnails miss the cache.
pub const RENDERER_VERSION: &str = "excalidraw-0.18.1";

/// Maximum accepted WebP payload written through `thumb_store`.
pub const MAX_THUMBNAIL_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum ThumbnailError {
    #[error("theme must be \"light\" or \"dark\": {0}")]
    InvalidTheme(String),
    #[error("thumbnail key must be 64 lowercase hex characters: {0}")]
    InvalidKey(String),
    #[error("payload is not a valid WebP image: {0}")]
    InvalidWebp(String),
    #[error("thumbnail is too large: {actual_bytes} bytes exceeds {maximum_bytes} bytes")]
    TooLarge {
        actual_bytes: u64,
        maximum_bytes: u64,
    },
    #[error(transparent)]
    AtomicWrite(#[from] crate::documents::atomic_write::AtomicWriteError),
    #[error("thumbnail cache I/O failed for {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

#[derive(Debug, Clone)]
pub struct ThumbnailCache {
    root: PathBuf,
}

impl ThumbnailCache {
    /// Cache root is `<app_data_dir>/cache/thumbnails`.
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            root: app_data_dir.join("cache").join("thumbnails"),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// `hex(sha256(content + "|" + renderer_version + "|" + theme))`. The
    /// content is treated as lossy UTF-8 so the key matches the text the
    /// frontend worker hashes.
    pub fn compute_key(content: &[u8], renderer_version: &str, theme: &str) -> String {
        let mut input =
            String::with_capacity(content.len() + renderer_version.len() + theme.len() + 2);
        input.push_str(&String::from_utf8_lossy(content));
        input.push('|');
        input.push_str(renderer_version);
        input.push('|');
        input.push_str(theme);
        format!("{:x}", Sha256::digest(input.as_bytes()))
    }

    /// Cache file layout: `<root>/<key[0..2]>/<key[2..4]>/<key>.webp`.
    pub fn path_for_key(&self, key: &str) -> PathBuf {
        self.root
            .join(&key[0..2])
            .join(&key[2..4])
            .join(format!("{key}.webp"))
    }

    pub fn contains(&self, key: &str) -> bool {
        self.path_for_key(key).is_file()
    }

    pub fn validate_theme(theme: &str) -> Result<(), ThumbnailError> {
        match theme {
            "light" | "dark" => Ok(()),
            other => Err(ThumbnailError::InvalidTheme(other.to_owned())),
        }
    }

    pub fn validate_key(key: &str) -> Result<(), ThumbnailError> {
        let valid = key.len() == 64 && key.bytes().all(is_lowercase_hex);
        if valid {
            Ok(())
        } else {
            Err(ThumbnailError::InvalidKey(key.to_owned()))
        }
    }

    pub fn validate_webp(bytes: &[u8]) -> Result<(), ThumbnailError> {
        if bytes.len() > MAX_THUMBNAIL_BYTES {
            return Err(ThumbnailError::TooLarge {
                actual_bytes: bytes.len() as u64,
                maximum_bytes: MAX_THUMBNAIL_BYTES as u64,
            });
        }
        let valid = bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP";
        if valid {
            Ok(())
        } else {
            Err(ThumbnailError::InvalidWebp(
                "missing RIFF/WEBP magic bytes".to_owned(),
            ))
        }
    }

    /// Validate, create the sharded parent directories, and atomically publish
    /// the WebP payload (temp write + fsync + rename).
    pub fn store(&self, key: &str, bytes: &[u8]) -> Result<PathBuf, ThumbnailError> {
        Self::validate_key(key)?;
        Self::validate_webp(bytes)?;
        let parent = self.root.join(&key[0..2]).join(&key[2..4]);
        fs::create_dir_all(&parent).map_err(|source| ThumbnailError::Io {
            path: parent.clone(),
            source,
        })?;
        let target = self.path_for_key(key);
        atomic_write_bytes(&target, bytes)?;
        Ok(target)
    }
}

fn is_lowercase_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_content_addressed_key() {
        assert_eq!(
            ThumbnailCache::compute_key(b"hello", RENDERER_VERSION, "light"),
            "892061985e4ba6ae7bb0cff136ad4af37fb7bf5a2b5088909d25082a0211f9b1"
        );
        assert_eq!(
            ThumbnailCache::compute_key(b"", RENDERER_VERSION, "dark"),
            "8b93299ce45f85f3f0270800fb602b8d01c1022400d9e8f2859bac3ebdd574f8"
        );
    }

    #[test]
    fn layouts_cache_path_by_key_prefixes() {
        let cache = ThumbnailCache::new(Path::new("/app-data"));
        let key = test_thumbnail_key();
        let expected = PathBuf::from(format!(
            "/app-data/cache/thumbnails/{}/{}/{}.webp",
            &key[0..2],
            &key[2..4],
            key
        ));
        assert_eq!(cache.path_for_key(&key), expected);
    }

    #[test]
    fn validates_theme_and_key_format() {
        assert!(ThumbnailCache::validate_theme("light").is_ok());
        assert!(ThumbnailCache::validate_theme("dark").is_ok());
        assert!(matches!(
            ThumbnailCache::validate_theme("blue"),
            Err(ThumbnailError::InvalidTheme(_))
        ));

        let valid_key = test_thumbnail_key();
        assert!(ThumbnailCache::validate_key(&valid_key).is_ok());
        assert!(matches!(
            ThumbnailCache::validate_key(&valid_key.to_ascii_uppercase()),
            Err(ThumbnailError::InvalidKey(_))
        ));
        assert!(matches!(
            ThumbnailCache::validate_key(&valid_key[..63]),
            Err(ThumbnailError::InvalidKey(_))
        ));
    }

    #[test]
    fn validates_webp_payload() {
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBP");
        assert!(ThumbnailCache::validate_webp(&webp).is_ok());
        assert!(matches!(
            ThumbnailCache::validate_webp(b"not a webp"),
            Err(ThumbnailError::InvalidWebp(_))
        ));
        assert!(matches!(
            ThumbnailCache::validate_webp(b""),
            Err(ThumbnailError::InvalidWebp(_))
        ));
        let oversized = vec![0u8; MAX_THUMBNAIL_BYTES + 1];
        assert!(matches!(
            ThumbnailCache::validate_webp(&oversized),
            Err(ThumbnailError::TooLarge { .. })
        ));
    }

    #[test]
    fn stores_webp_at_sharded_layout_path() {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-thumbnail-cache-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let cache = ThumbnailCache::new(&root);
        let key = test_thumbnail_key();
        let mut webp = b"RIFF".to_vec();
        webp.extend_from_slice(&[4, 0, 0, 0]);
        webp.extend_from_slice(b"WEBP");

        let path = cache
            .store(&key, &webp)
            .unwrap_or_else(|error| panic!("store webp: {error}"));
        assert_eq!(path, cache.path_for_key(&key));
        assert!(path.is_file());
        assert_eq!(fs::read(&path).unwrap(), webp);

        assert!(matches!(
            cache.store("not-a-key", &webp),
            Err(ThumbnailError::InvalidKey(_))
        ));
        fs::remove_dir_all(&root).unwrap();
    }

    /// 64 lowercase hex characters with low entropy, used only to exercise
    /// key validation and cache layout without resembling a real secret.
    fn test_thumbnail_key() -> String {
        "ab".repeat(32)
    }
}
