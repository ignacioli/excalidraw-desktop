#![allow(
    dead_code,
    reason = "Phase 2 establishes repository boundaries before later user stories consume each table API"
)]

use std::{future::Future, path::Path, pin::Pin};

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::writer::{DatabaseWriter, DatabaseWriterError};

pub const DEFAULT_WRITER_QUEUE_CAPACITY: usize = 64;

pub type RepositoryFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, RepositoryError>> + Send + 'a>>;

#[derive(Debug, Error)]
pub enum RepositoryError {
    #[error(transparent)]
    Writer(#[from] DatabaseWriterError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexRecord {
    pub canonical_path: String,
    pub workspace_id: String,
    pub display_name: String,
    pub relative_path: String,
    pub mtime: i64,
    pub file_size: i64,
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftRecord {
    pub file_path: String,
    pub scene_json: String,
    pub content_hash: String,
    pub base_hash: Option<String>,
    pub updated_at: i64,
    pub is_dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMetaRecord {
    pub canonical_path: String,
    pub thumbnail_key: String,
    pub thumbnail_path: String,
    pub generated_at: i64,
    pub renderer_version: String,
    pub theme: String,
}

pub trait WorkspaceRepository: Send + Sync {
    fn workspace_upsert(&self, workspace: WorkspaceRecord) -> RepositoryFuture<'_, ()>;
    fn workspace_get(&self, id: String) -> RepositoryFuture<'_, Option<WorkspaceRecord>>;
    fn workspace_list(&self) -> RepositoryFuture<'_, Vec<WorkspaceRecord>>;
    fn workspace_delete(&self, id: String) -> RepositoryFuture<'_, ()>;
}

pub trait FileIndexRepository: Send + Sync {
    fn file_index_upsert(&self, file: FileIndexRecord) -> RepositoryFuture<'_, ()>;
    fn file_index_get(&self, path: String) -> RepositoryFuture<'_, Option<FileIndexRecord>>;
    fn file_index_list(&self, workspace_id: String) -> RepositoryFuture<'_, Vec<FileIndexRecord>>;
    fn file_index_delete(&self, path: String) -> RepositoryFuture<'_, ()>;
}

pub trait DraftRepository: Send + Sync {
    fn draft_upsert(&self, draft: DraftRecord) -> RepositoryFuture<'_, ()>;
    fn draft_get(&self, path: String) -> RepositoryFuture<'_, Option<DraftRecord>>;
    fn draft_list_dirty(&self) -> RepositoryFuture<'_, Vec<DraftRecord>>;
    fn draft_mark_clean(&self, path: String, base_hash: String) -> RepositoryFuture<'_, ()>;
    fn draft_delete(&self, path: String) -> RepositoryFuture<'_, ()>;
}

pub trait DocumentRepository: Send + Sync {
    fn document_checkpoint_commit(
        &self,
        draft: DraftRecord,
        indexed_file: Option<FileIndexRecord>,
    ) -> RepositoryFuture<'_, ()>;
}

pub trait FileMetaRepository: Send + Sync {
    fn file_meta_upsert(&self, metadata: FileMetaRecord) -> RepositoryFuture<'_, ()>;
    fn file_meta_get(&self, path: String) -> RepositoryFuture<'_, Option<FileMetaRecord>>;
    fn file_meta_delete(&self, path: String) -> RepositoryFuture<'_, ()>;
}

#[derive(Clone)]
pub struct SqliteRepository {
    writer: DatabaseWriter,
}

impl SqliteRepository {
    pub async fn open(path: &Path) -> Result<Self, RepositoryError> {
        let writer = DatabaseWriter::open(path, DEFAULT_WRITER_QUEUE_CAPACITY).await?;
        Ok(Self { writer })
    }
}

impl WorkspaceRepository for SqliteRepository {
    fn workspace_upsert(&self, workspace: WorkspaceRecord) -> RepositoryFuture<'_, ()> {
        Box::pin(async move {
            self.writer.execute(move |connection| {
                connection.execute(
                    "INSERT INTO workspaces (id, name, root_path, created_at) VALUES (?1, ?2, ?3, ?4) \
                     ON CONFLICT(id) DO UPDATE SET name=excluded.name, root_path=excluded.root_path",
                    params![workspace.id, workspace.name, workspace.root_path, workspace.created_at],
                )?;
                Ok(())
            }).await?;
            Ok(())
        })
    }

    fn workspace_get(&self, id: String) -> RepositoryFuture<'_, Option<WorkspaceRecord>> {
        Box::pin(async move {
            Ok(self
                .writer
                .execute(move |connection| {
                    connection
                        .query_row(
                            "SELECT id, name, root_path, created_at FROM workspaces WHERE id=?1",
                            [id],
                            workspace_from_row,
                        )
                        .optional()
                })
                .await?)
        })
    }

    fn workspace_list(&self) -> RepositoryFuture<'_, Vec<WorkspaceRecord>> {
        Box::pin(async move {
            Ok(self
                .writer
                .execute(|connection| {
                    let mut statement = connection.prepare(
                    "SELECT id, name, root_path, created_at FROM workspaces ORDER BY created_at, id"
                )?;
                    let records = statement.query_map([], workspace_from_row)?.collect();
                    records
                })
                .await?)
        })
    }

    fn workspace_delete(&self, id: String) -> RepositoryFuture<'_, ()> {
        Box::pin(async move {
            self.writer
                .execute(move |connection| {
                    connection.execute("DELETE FROM workspaces WHERE id=?1", [id])?;
                    Ok(())
                })
                .await?;
            Ok(())
        })
    }
}

impl FileIndexRepository for SqliteRepository {
    fn file_index_upsert(&self, file: FileIndexRecord) -> RepositoryFuture<'_, ()> {
        Box::pin(async move {
            self.writer.execute(move |connection| {
                connection.execute(
                    "INSERT INTO file_index (canonical_path, workspace_id, display_name, relative_path, mtime, file_size, content_hash) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(canonical_path) DO UPDATE SET \
                     workspace_id=excluded.workspace_id, display_name=excluded.display_name, relative_path=excluded.relative_path, \
                     mtime=excluded.mtime, file_size=excluded.file_size, content_hash=excluded.content_hash",
                    params![file.canonical_path, file.workspace_id, file.display_name, file.relative_path, file.mtime, file.file_size, file.content_hash],
                )?;
                Ok(())
            }).await?;
            Ok(())
        })
    }

    fn file_index_get(&self, path: String) -> RepositoryFuture<'_, Option<FileIndexRecord>> {
        Box::pin(async move {
            Ok(self.writer.execute(move |connection| {
                connection.query_row(
                    "SELECT canonical_path, workspace_id, display_name, relative_path, mtime, file_size, content_hash FROM file_index WHERE canonical_path=?1",
                    [path], file_index_from_row,
                ).optional()
            }).await?)
        })
    }

    fn file_index_list(&self, workspace_id: String) -> RepositoryFuture<'_, Vec<FileIndexRecord>> {
        Box::pin(async move {
            Ok(self.writer.execute(move |connection| {
                let mut statement = connection.prepare(
                    "SELECT canonical_path, workspace_id, display_name, relative_path, mtime, file_size, content_hash \
                     FROM file_index WHERE workspace_id=?1 ORDER BY relative_path"
                )?;
                let records = statement
                    .query_map([workspace_id], file_index_from_row)?
                    .collect();
                records
            }).await?)
        })
    }

    fn file_index_delete(&self, path: String) -> RepositoryFuture<'_, ()> {
        delete_by_path(
            &self.writer,
            "DELETE FROM file_index WHERE canonical_path=?1",
            path,
        )
    }
}

impl DraftRepository for SqliteRepository {
    fn draft_upsert(&self, draft: DraftRecord) -> RepositoryFuture<'_, ()> {
        Box::pin(async move {
            self.writer.execute(move |connection| {
                connection.execute(
                    "INSERT INTO drafts (file_path, scene_json, content_hash, base_hash, updated_at, is_dirty) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(file_path) DO UPDATE SET \
                     scene_json=excluded.scene_json, content_hash=excluded.content_hash, base_hash=excluded.base_hash, \
                     updated_at=excluded.updated_at, is_dirty=excluded.is_dirty",
                    params![draft.file_path, draft.scene_json, draft.content_hash, draft.base_hash, draft.updated_at, draft.is_dirty],
                )?;
                Ok(())
            }).await?;
            Ok(())
        })
    }

    fn draft_get(&self, path: String) -> RepositoryFuture<'_, Option<DraftRecord>> {
        Box::pin(async move {
            Ok(self.writer.execute(move |connection| {
                connection.query_row(
                    "SELECT file_path, scene_json, content_hash, base_hash, updated_at, is_dirty FROM drafts WHERE file_path=?1",
                    [path], draft_from_row,
                ).optional()
            }).await?)
        })
    }

    fn draft_list_dirty(&self) -> RepositoryFuture<'_, Vec<DraftRecord>> {
        Box::pin(async move {
            Ok(self.writer.execute(|connection| {
                let mut statement = connection.prepare(
                    "SELECT file_path, scene_json, content_hash, base_hash, updated_at, is_dirty FROM drafts WHERE is_dirty=1 ORDER BY updated_at DESC"
                )?;
                let records = statement.query_map([], draft_from_row)?.collect();
                records
            }).await?)
        })
    }

    fn draft_mark_clean(&self, path: String, base_hash: String) -> RepositoryFuture<'_, ()> {
        Box::pin(async move {
            self.writer
                .execute(move |connection| {
                    connection.execute(
                        "UPDATE drafts SET is_dirty=0, base_hash=?2 WHERE file_path=?1",
                        params![path, base_hash],
                    )?;
                    Ok(())
                })
                .await?;
            Ok(())
        })
    }

    fn draft_delete(&self, path: String) -> RepositoryFuture<'_, ()> {
        delete_by_path(&self.writer, "DELETE FROM drafts WHERE file_path=?1", path)
    }
}

impl DocumentRepository for SqliteRepository {
    fn document_checkpoint_commit(
        &self,
        draft: DraftRecord,
        indexed_file: Option<FileIndexRecord>,
    ) -> RepositoryFuture<'_, ()> {
        Box::pin(async move {
            self.writer
                .execute(move |connection| {
                    let transaction = connection.transaction()?;
                    transaction.execute(
                        "INSERT INTO drafts (file_path, scene_json, content_hash, base_hash, updated_at, is_dirty) \
                         VALUES (?1, ?2, ?3, ?4, ?5, 0) ON CONFLICT(file_path) DO UPDATE SET \
                         scene_json=excluded.scene_json, content_hash=excluded.content_hash, \
                         base_hash=excluded.base_hash, updated_at=excluded.updated_at, is_dirty=0",
                        params![
                            draft.file_path,
                            draft.scene_json,
                            draft.content_hash,
                            draft.base_hash,
                            draft.updated_at
                        ],
                    )?;
                    if let Some(file) = indexed_file {
                        transaction.execute(
                            "INSERT INTO file_index (canonical_path, workspace_id, display_name, relative_path, mtime, file_size, content_hash) \
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(canonical_path) DO UPDATE SET \
                             workspace_id=excluded.workspace_id, display_name=excluded.display_name, \
                             relative_path=excluded.relative_path, mtime=excluded.mtime, \
                             file_size=excluded.file_size, content_hash=excluded.content_hash",
                            params![
                                file.canonical_path,
                                file.workspace_id,
                                file.display_name,
                                file.relative_path,
                                file.mtime,
                                file.file_size,
                                file.content_hash
                            ],
                        )?;
                    }
                    transaction.commit()
                })
                .await?;
            Ok(())
        })
    }
}

impl FileMetaRepository for SqliteRepository {
    fn file_meta_upsert(&self, metadata: FileMetaRecord) -> RepositoryFuture<'_, ()> {
        Box::pin(async move {
            self.writer.execute(move |connection| {
                connection.execute(
                    "INSERT INTO file_meta (canonical_path, thumbnail_key, thumbnail_path, generated_at, renderer_version, theme) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(canonical_path) DO UPDATE SET \
                     thumbnail_key=excluded.thumbnail_key, thumbnail_path=excluded.thumbnail_path, generated_at=excluded.generated_at, \
                     renderer_version=excluded.renderer_version, theme=excluded.theme",
                    params![metadata.canonical_path, metadata.thumbnail_key, metadata.thumbnail_path, metadata.generated_at, metadata.renderer_version, metadata.theme],
                )?;
                Ok(())
            }).await?;
            Ok(())
        })
    }

    fn file_meta_get(&self, path: String) -> RepositoryFuture<'_, Option<FileMetaRecord>> {
        Box::pin(async move {
            Ok(self.writer.execute(move |connection| {
                connection.query_row(
                    "SELECT canonical_path, thumbnail_key, thumbnail_path, generated_at, renderer_version, theme FROM file_meta WHERE canonical_path=?1",
                    [path], file_meta_from_row,
                ).optional()
            }).await?)
        })
    }

    fn file_meta_delete(&self, path: String) -> RepositoryFuture<'_, ()> {
        delete_by_path(
            &self.writer,
            "DELETE FROM file_meta WHERE canonical_path=?1",
            path,
        )
    }
}

fn delete_by_path<'a>(
    writer: &'a DatabaseWriter,
    sql: &'static str,
    path: String,
) -> RepositoryFuture<'a, ()> {
    Box::pin(async move {
        writer
            .execute(move |connection| {
                connection.execute(sql, [path])?;
                Ok(())
            })
            .await?;
        Ok(())
    })
}

fn workspace_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceRecord> {
    Ok(WorkspaceRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        root_path: row.get(2)?,
        created_at: row.get(3)?,
    })
}

fn file_index_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileIndexRecord> {
    Ok(FileIndexRecord {
        canonical_path: row.get(0)?,
        workspace_id: row.get(1)?,
        display_name: row.get(2)?,
        relative_path: row.get(3)?,
        mtime: row.get(4)?,
        file_size: row.get(5)?,
        content_hash: row.get(6)?,
    })
}

fn draft_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DraftRecord> {
    Ok(DraftRecord {
        file_path: row.get(0)?,
        scene_json: row.get(1)?,
        content_hash: row.get(2)?,
        base_hash: row.get(3)?,
        updated_at: row.get(4)?,
        is_dirty: row.get(5)?,
    })
}

fn file_meta_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileMetaRecord> {
    Ok(FileMetaRecord {
        canonical_path: row.get(0)?,
        thumbnail_key: row.get(1)?,
        thumbnail_path: row.get(2)?,
        generated_at: row.get(3)?,
        renderer_version: row.get(4)?,
        theme: row.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sqlite_repository_round_trips_all_four_tables() {
        let path = std::env::temp_dir().join(format!(
            "excalidraw-repository-{}-{}.sqlite3",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let repository = SqliteRepository::open(&path)
            .await
            .unwrap_or_else(|error| panic!("open repository: {error}"));
        let workspace = WorkspaceRecord {
            id: "workspace-1".to_owned(),
            name: "Workspace".to_owned(),
            root_path: "/workspace".to_owned(),
            created_at: 1,
        };
        repository
            .workspace_upsert(workspace.clone())
            .await
            .unwrap_or_else(|error| panic!("upsert workspace: {error}"));
        assert_eq!(
            repository
                .workspace_get(workspace.id.clone())
                .await
                .unwrap_or_else(|error| panic!("get workspace: {error}")),
            Some(workspace.clone())
        );

        let file = FileIndexRecord {
            canonical_path: "/workspace/drawing.excalidraw".to_owned(),
            workspace_id: workspace.id,
            display_name: "drawing.excalidraw".to_owned(),
            relative_path: "drawing.excalidraw".to_owned(),
            mtime: 2,
            file_size: 128,
            content_hash: Some("abc".to_owned()),
        };
        repository
            .file_index_upsert(file.clone())
            .await
            .unwrap_or_else(|error| panic!("upsert file index: {error}"));
        assert_eq!(
            repository
                .file_index_get(file.canonical_path.clone())
                .await
                .unwrap_or_else(|error| panic!("get file index: {error}")),
            Some(file.clone())
        );

        let draft = DraftRecord {
            file_path: file.canonical_path.clone(),
            scene_json: "{}".to_owned(),
            content_hash: "def".to_owned(),
            base_hash: None,
            updated_at: 3,
            is_dirty: true,
        };
        repository
            .draft_upsert(draft.clone())
            .await
            .unwrap_or_else(|error| panic!("upsert draft: {error}"));
        assert_eq!(
            repository
                .draft_list_dirty()
                .await
                .unwrap_or_else(|error| panic!("list dirty drafts: {error}")),
            vec![draft]
        );

        let metadata = FileMetaRecord {
            canonical_path: file.canonical_path,
            thumbnail_key: "key".to_owned(),
            thumbnail_path: "/cache/key.webp".to_owned(),
            generated_at: 4,
            renderer_version: "1".to_owned(),
            theme: "light".to_owned(),
        };
        repository
            .file_meta_upsert(metadata.clone())
            .await
            .unwrap_or_else(|error| panic!("upsert metadata: {error}"));
        assert_eq!(
            repository
                .file_meta_get(metadata.canonical_path.clone())
                .await
                .unwrap_or_else(|error| panic!("get metadata: {error}")),
            Some(metadata)
        );

        drop(repository);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }
}
