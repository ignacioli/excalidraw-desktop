//! Automatic history scheduling at the cold-checkpoint boundary.
//!
//! There is intentionally no background task here.  The coordinator is called
//! only after a current-file checkpoint has committed successfully, which
//! means an idle application cannot manufacture a history version.

use sha2::{Digest, Sha256};
use uuid::Uuid;

#[cfg(feature = "e2e-harness")]
use std::sync::atomic::{AtomicU64, Ordering};

use super::{
    repository::{
        HistoryRepository, HistoryRepositoryError, PublishAsset, PublishSceneRequest,
        AUTOMATIC_INTERVAL_SECONDS,
    },
    store::HistoryStore,
    types::HistoryVersionSource,
};

#[cfg(feature = "e2e-harness")]
static E2E_AUTOMATIC_CALLBACKS: AtomicU64 = AtomicU64::new(0);

#[cfg(feature = "e2e-harness")]
pub(crate) fn reset_e2e_automatic_callback_count() {
    E2E_AUTOMATIC_CALLBACKS.store(0, Ordering::SeqCst);
}

#[cfg(feature = "e2e-harness")]
pub(crate) fn e2e_automatic_callback_count() -> u64 {
    E2E_AUTOMATIC_CALLBACKS.load(Ordering::SeqCst)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutomaticCheckpointOutcome {
    /// The first successful cold checkpoint starts the durable interval.
    BaselineEstablished,
    /// The checkpoint did not contain a change relative to the last saved
    /// state/history snapshot, so no ordinary version was created.
    NoChange,
    /// A changed checkpoint occurred before the 30-minute boundary.
    Waiting { remaining_seconds: i64 },
    /// A new ordinary version was durably published from this checkpoint.
    Published {
        version_id: String,
        scene_hash: String,
    },
}

/// Process one successful cold checkpoint.  `previous_base_hash` must be the
/// hash observed before the checkpoint starts; the bytes passed here must be
/// the exact immutable payload that the checkpoint published.
pub fn after_successful_checkpoint(
    store: &HistoryStore,
    document_id: &str,
    scene_bytes: &[u8],
    previous_base_hash: Option<&str>,
    recorded_at: i64,
) -> Result<AutomaticCheckpointOutcome, HistoryRepositoryError> {
    after_successful_checkpoint_with_assets(
        store,
        document_id,
        scene_bytes,
        Vec::new(),
        previous_base_hash,
        recorded_at,
    )
}

/// Asset-aware form used by the document checkpoint hook. The scene and
/// these bytes are captured from the same successful checkpoint and are
/// published in one metadata transaction.
pub fn after_successful_checkpoint_with_assets(
    store: &HistoryStore,
    document_id: &str,
    scene_bytes: &[u8],
    assets: Vec<PublishAsset>,
    previous_base_hash: Option<&str>,
    recorded_at: i64,
) -> Result<AutomaticCheckpointOutcome, HistoryRepositoryError> {
    #[cfg(feature = "e2e-harness")]
    E2E_AUTOMATIC_CALLBACKS.fetch_add(1, Ordering::SeqCst);

    let repository = HistoryRepository::new(store);
    let last_automatic_at = repository.automatic_baseline(document_id)?;
    let scene_hash = format!("{:x}", Sha256::digest(scene_bytes));

    let Some(last_automatic_at) = last_automatic_at else {
        repository.establish_automatic_baseline(document_id, recorded_at)?;
        return Ok(AutomaticCheckpointOutcome::BaselineEstablished);
    };

    // Only the immediately preceding cold-file base decides whether this save
    // contains a change. Returning to bytes seen in an older automatic version
    // is still a new semantic event; object dedup must not collapse its row.
    if previous_base_hash.is_some_and(|hash| hash == scene_hash) {
        return Ok(AutomaticCheckpointOutcome::NoChange);
    }

    let elapsed = recorded_at.saturating_sub(last_automatic_at);
    if elapsed < AUTOMATIC_INTERVAL_SECONDS {
        return Ok(AutomaticCheckpointOutcome::Waiting {
            remaining_seconds: AUTOMATIC_INTERVAL_SECONDS - elapsed,
        });
    }

    let sequence = store
        .with_connection(|connection| {
            connection.query_row(
                "SELECT COALESCE(MAX(sequence), 0) + 1 FROM history_versions WHERE document_id = ?1",
                [document_id],
                |row| row.get::<_, i64>(0),
            )
        })
        .map_err(HistoryRepositoryError::Store)?;
    let sequence = u64::try_from(sequence)
        .map_err(|_| HistoryRepositoryError::SequenceOverflow(sequence.max(0) as u64))?;
    let version_id = format!("automatic-{}", Uuid::new_v4());
    let published = repository.publish_scene_with_assets(
        PublishSceneRequest {
            version_id,
            document_id: document_id.to_owned(),
            scene_bytes: scene_bytes.to_vec(),
            schema_version: 1,
            source: HistoryVersionSource::Automatic,
            protected_action: None,
            recorded_at,
            sequence,
        },
        assets,
    )?;
    Ok(AutomaticCheckpointOutcome::Published {
        version_id: published.version_id,
        scene_hash: published.scene_hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    fn fixture() -> (PathBuf, HistoryStore, String) {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-history-automatic-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        let store = HistoryStore::open_version_history_root(&root)
            .unwrap_or_else(|error| panic!("open history store: {error}"));
        store
            .with_connection(|connection| {
                connection.execute(
                    "INSERT INTO history_documents (id, canonical_path, created_at, state)
                     VALUES ('doc', '/tmp/doc.excalidraw', 0, 'active')",
                    [],
                )?;
                Ok(())
            })
            .unwrap_or_else(|error| panic!("insert document: {error}"));
        (root, store, "doc".to_owned())
    }

    #[test]
    fn first_checkpoint_only_establishes_the_baseline() {
        let (root, store, document_id) = fixture();
        let outcome = after_successful_checkpoint(&store, &document_id, b"a", None, 100)
            .unwrap_or_else(|error| panic!("automatic checkpoint: {error}"));
        assert_eq!(outcome, AutomaticCheckpointOutcome::BaselineEstablished);
        let count: i64 = store
            .with_connection(|connection| {
                connection.query_row("SELECT COUNT(*) FROM history_versions", [], |row| {
                    row.get(0)
                })
            })
            .unwrap_or_else(|error| panic!("count versions: {error}"));
        assert_eq!(count, 0);
        drop(store);
        fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }

    #[test]
    fn no_change_and_manual_history_do_not_advance_the_baseline() {
        let (root, store, document_id) = fixture();
        after_successful_checkpoint(&store, &document_id, b"a", None, 100)
            .unwrap_or_else(|error| panic!("baseline: {error}"));
        let no_change = after_successful_checkpoint(
            &store,
            &document_id,
            b"a",
            Some(&format!("{:x}", Sha256::digest(b"a"))),
            2_000,
        )
        .unwrap_or_else(|error| panic!("no change: {error}"));
        assert_eq!(no_change, AutomaticCheckpointOutcome::NoChange);
        let baseline: Option<i64> = store
            .with_connection(|connection| {
                connection.query_row(
                    "SELECT last_automatic_at FROM history_documents WHERE id='doc'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap_or_else(|error| panic!("read baseline: {error}"));
        assert_eq!(baseline, Some(100));
        drop(store);
        fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }

    #[test]
    fn changed_checkpoint_publishes_only_after_thirty_minutes() {
        let (root, store, document_id) = fixture();
        after_successful_checkpoint(&store, &document_id, b"a", None, 100)
            .unwrap_or_else(|error| panic!("baseline: {error}"));
        let waiting = after_successful_checkpoint(
            &store,
            &document_id,
            b"b",
            Some("old"),
            100 + AUTOMATIC_INTERVAL_SECONDS - 1,
        )
        .unwrap_or_else(|error| panic!("waiting: {error}"));
        assert!(matches!(
            waiting,
            AutomaticCheckpointOutcome::Waiting { .. }
        ));
        let published = after_successful_checkpoint(
            &store,
            &document_id,
            b"b",
            Some("old"),
            100 + AUTOMATIC_INTERVAL_SECONDS,
        )
        .unwrap_or_else(|error| panic!("publish: {error}"));
        assert!(matches!(
            published,
            AutomaticCheckpointOutcome::Published { .. }
        ));
        let baseline: Option<i64> = store
            .with_connection(|connection| {
                connection.query_row(
                    "SELECT last_automatic_at FROM history_documents WHERE id='doc'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap_or_else(|error| panic!("read automatic baseline: {error}"));
        assert_eq!(baseline, Some(100 + AUTOMATIC_INTERVAL_SECONDS));
        drop(store);
        fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }

    #[test]
    fn returning_to_older_content_publishes_a_new_semantic_record() {
        let (root, store, document_id) = fixture();
        let hash_a = format!("{:x}", Sha256::digest(b"a"));
        let hash_b = format!("{:x}", Sha256::digest(b"b"));
        after_successful_checkpoint(&store, &document_id, b"a", None, 100)
            .unwrap_or_else(|error| panic!("baseline: {error}"));
        after_successful_checkpoint(
            &store,
            &document_id,
            b"b",
            Some(&hash_a),
            100 + AUTOMATIC_INTERVAL_SECONDS,
        )
        .unwrap_or_else(|error| panic!("publish b: {error}"));
        let returned = after_successful_checkpoint(
            &store,
            &document_id,
            b"a",
            Some(&hash_b),
            100 + 2 * AUTOMATIC_INTERVAL_SECONDS,
        )
        .unwrap_or_else(|error| panic!("publish returned a: {error}"));
        assert!(matches!(
            returned,
            AutomaticCheckpointOutcome::Published { .. }
        ));
        let version_count: i64 = store
            .with_connection(|connection| {
                connection.query_row(
                    "SELECT COUNT(*) FROM history_versions WHERE document_id='doc'",
                    [],
                    |row| row.get(0),
                )
            })
            .unwrap_or_else(|error| panic!("count versions: {error}"));
        assert_eq!(version_count, 2);
        drop(store);
        fs::remove_dir_all(root).unwrap_or_else(|error| panic!("remove fixture: {error}"));
    }
}
