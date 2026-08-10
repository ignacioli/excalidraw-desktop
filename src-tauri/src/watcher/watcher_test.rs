use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

use super::{read_triplet, DebounceEngine, FileTriplet, KnownFileTable, RawChangeKind};

fn instant_after(start: Instant, millis: u64) -> Instant {
    start + Duration::from_millis(millis)
}

#[test]
fn debounce_merges_bursts_within_the_200ms_window() {
    let window = Duration::from_millis(200);
    let mut engine = DebounceEngine::new(window);
    let start = Instant::now();
    let path = PathBuf::from("/workspace/drawing.excalidraw");

    engine.record(path.clone(), RawChangeKind::Modified, start);
    engine.record(
        path.clone(),
        RawChangeKind::Modified,
        instant_after(start, 100),
    );

    // 150ms after the first event the window has not elapsed yet.
    assert!(engine.drain_ready(instant_after(start, 150)).is_empty());
    assert_eq!(engine.pending_count(), 1);
    // A single merged event surfaces once the whole burst is older than 200ms.
    let ready = engine.drain_ready(instant_after(start, 350));
    assert_eq!(ready.len(), 1);
    assert_eq!(ready[0], (path, RawChangeKind::Modified));
    assert!(engine.drain_ready(instant_after(start, 400)).is_empty());
    assert_eq!(engine.pending_count(), 0);
}

#[test]
fn debounce_keeps_the_latest_kind_per_path() {
    let mut engine = DebounceEngine::new(Duration::from_millis(200));
    let start = Instant::now();
    let path = PathBuf::from("/workspace/drawing.excalidraw");

    engine.record(path.clone(), RawChangeKind::Modified, start);
    engine.record(
        path.clone(),
        RawChangeKind::Removed,
        instant_after(start, 50),
    );

    let ready = engine.drain_ready(instant_after(start, 300));
    assert_eq!(ready, vec![(path, RawChangeKind::Removed)]);
}

#[test]
fn self_write_echo_is_suppressed_by_an_identical_triplet() {
    let directory =
        std::env::temp_dir().join(format!("excalidraw-watcher-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("drawing.excalidraw");
    fs::write(&path, br#"{"type":"excalidraw"}"#).unwrap();

    let triplet = read_triplet(&path).unwrap();
    let mut table = KnownFileTable::default();
    assert!(table.changed(&path, &triplet));
    table.note(&path, triplet.clone());
    // The app's own write is echoed back by notify with the same triplet.
    assert!(!table.changed(&path, &triplet));

    // An external edit changes the content hash and must not be suppressed.
    fs::write(&path, br#"{"type":"excalidraw","version":2}"#).unwrap();
    let external = read_triplet(&path).unwrap();
    assert!(table.changed(&path, &external));
    table.note(&path, external.clone());
    assert!(!table.changed(&path, &external));

    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn hash_unknown_seed_compares_mtime_and_size_only() {
    let mut table = KnownFileTable::default();
    let path = PathBuf::from("/workspace/seed.excalidraw");
    table.note(
        &path,
        FileTriplet {
            mtime: 1_700_000_000,
            size: 42,
            hash: String::new(),
        },
    );

    // Same mtime/size from an un-hashed index row is not a real change.
    assert!(!table.changed(
        &path,
        &FileTriplet {
            mtime: 1_700_000_000,
            size: 42,
            hash: "different-content-hash".to_owned(),
        },
    ));
    // A different mtime or size is a real change.
    assert!(table.changed(
        &path,
        &FileTriplet {
            mtime: 1_700_000_100,
            size: 42,
            hash: "different-content-hash".to_owned(),
        },
    ));
}

#[test]
fn removed_path_leaves_the_known_table() {
    let mut table = KnownFileTable::default();
    let path = PathBuf::from("/workspace/gone.excalidraw");
    table.note(
        &path,
        FileTriplet {
            mtime: 1,
            size: 2,
            hash: "abc".to_owned(),
        },
    );
    table.remove(&path);
    assert!(table.changed(
        &path,
        &FileTriplet {
            mtime: 1,
            size: 2,
            hash: "abc".to_owned(),
        },
    ));
}
