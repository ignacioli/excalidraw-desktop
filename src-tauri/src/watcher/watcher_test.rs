use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

use super::{
    consume_matching_echo, read_triplet, DebounceEngine, EntryOperation, FileTriplet,
    KnownFileTable, RawChangeKind, WatcherEchoKind,
};

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

fn workspace_record() -> crate::database::repository::WorkspaceRecord {
    crate::database::repository::WorkspaceRecord {
        id: "ws".to_owned(),
        name: "Workspace".to_owned(),
        root_path: "/workspace".to_owned(),
        created_at: 1,
    }
}

fn rename_operation() -> super::EntryOperation {
    super::EntryOperation {
        workspace_id: "ws".to_owned(),
        expected: HashSet::from([
            ("folder".to_owned(), WatcherEchoKind::Removed),
            (
                "folder/child.excalidraw".to_owned(),
                WatcherEchoKind::Removed,
            ),
            ("renamed".to_owned(), WatcherEchoKind::Created),
            (
                "renamed/child.excalidraw".to_owned(),
                WatcherEchoKind::Created,
            ),
        ]),
        recorded_at: Instant::now(),
    }
}

fn operations_with(operation: EntryOperation) -> HashMap<String, EntryOperation> {
    HashMap::from([("op".to_owned(), operation)])
}

#[test]
fn directory_rename_operation_covers_descendant_remove_and_create() {
    let workspace = workspace_record();
    let mut operations = operations_with(rename_operation());
    assert!(consume_matching_echo(
        &mut operations,
        &workspace,
        "folder/child.excalidraw",
        &super::ResolvedChangeKind::Removed,
    ));
    assert!(consume_matching_echo(
        &mut operations,
        &workspace,
        "renamed/child.excalidraw",
        &super::ResolvedChangeKind::Created,
    ));
    let mut renamed = operations_with(rename_operation());
    assert!(consume_matching_echo(
        &mut renamed,
        &workspace,
        "folder/child.excalidraw",
        &super::ResolvedChangeKind::Renamed {
            new_path: PathBuf::from("/workspace/renamed/child.excalidraw"),
        },
    ));
    assert!(!consume_matching_echo(
        &mut operations,
        &workspace,
        "other.excalidraw",
        &super::ResolvedChangeKind::Removed,
    ));
    assert!(!consume_matching_echo(
        &mut operations,
        &workspace,
        "renamed/brand-new.excalidraw",
        &super::ResolvedChangeKind::Created,
    ));
}

#[test]
fn delete_echo_does_not_suppress_a_later_create_on_the_same_path() {
    let workspace = workspace_record();
    let mut operations = operations_with(EntryOperation {
        workspace_id: "ws".to_owned(),
        expected: HashSet::from([("drawing.excalidraw".to_owned(), WatcherEchoKind::Removed)]),
        recorded_at: Instant::now(),
    });
    assert!(consume_matching_echo(
        &mut operations,
        &workspace,
        "drawing.excalidraw",
        &super::ResolvedChangeKind::Removed,
    ));
    assert!(operations.is_empty());
    assert!(!consume_matching_echo(
        &mut operations,
        &workspace,
        "drawing.excalidraw",
        &super::ResolvedChangeKind::Created,
    ));
}

#[test]
fn consumed_create_echo_does_not_suppress_a_second_create() {
    let workspace = workspace_record();
    let mut operations = operations_with(EntryOperation {
        workspace_id: "ws".to_owned(),
        expected: HashSet::from([("target.excalidraw".to_owned(), WatcherEchoKind::Created)]),
        recorded_at: Instant::now(),
    });
    assert!(consume_matching_echo(
        &mut operations,
        &workspace,
        "target.excalidraw",
        &super::ResolvedChangeKind::Created,
    ));
    assert!(!consume_matching_echo(
        &mut operations,
        &workspace,
        "target.excalidraw",
        &super::ResolvedChangeKind::Created,
    ));
}

#[test]
fn suppressed_rename_echo_updates_the_known_table() {
    let directory =
        std::env::temp_dir().join(format!("excalidraw-watcher-echo-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&directory).unwrap();
    let old_path = directory.join("old.excalidraw");
    let new_path = directory.join("new.excalidraw");
    fs::write(&old_path, br#"{"type":"excalidraw"}"#).unwrap();
    fs::rename(&old_path, &new_path).unwrap();

    let mut table = KnownFileTable::default();
    table.note(
        &old_path,
        FileTriplet {
            mtime: 1,
            size: 1,
            hash: "stale".to_owned(),
        },
    );
    super::apply_echo_to_known(
        &mut table,
        &old_path,
        &super::ResolvedChangeKind::Renamed {
            new_path: new_path.clone(),
        },
    );
    assert!(table.changed(
        &old_path,
        &FileTriplet {
            mtime: 1,
            size: 1,
            hash: "stale".to_owned(),
        },
    ));
    let current = super::read_triplet(&new_path).unwrap();
    assert!(!table.changed(&new_path, &current));

    fs::remove_dir_all(directory).unwrap();
}
