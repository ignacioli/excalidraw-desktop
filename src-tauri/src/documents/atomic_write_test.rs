use std::{
    fs,
    sync::{Arc, Barrier},
    thread,
};

use super::atomic_write::{
    atomic_write_with_injector, AtomicWriteError, AtomicWriteFaultInjector, AtomicWriteFaultPoint,
};

const FAULT_POINTS: [AtomicWriteFaultPoint; 8] = [
    AtomicWriteFaultPoint::TempCreated,
    AtomicWriteFaultPoint::MidWrite,
    AtomicWriteFaultPoint::TempSynced,
    AtomicWriteFaultPoint::JsonValidated,
    AtomicWriteFaultPoint::BeforeRename,
    AtomicWriteFaultPoint::AfterRename,
    AtomicWriteFaultPoint::BeforeParentSync,
    AtomicWriteFaultPoint::ParentSynced,
];

struct InterruptAt(AtomicWriteFaultPoint);

impl AtomicWriteFaultInjector for InterruptAt {
    fn interrupt(&self, point: AtomicWriteFaultPoint) -> Result<(), AtomicWriteError> {
        if point == self.0 {
            return Err(AtomicWriteError::FaultInjected(point));
        }
        Ok(())
    }
}

#[test]
fn every_fault_point_preserves_a_complete_old_or_new_document() {
    for point in FAULT_POINTS {
        let directory = test_directory(&format!("fault-{point}"));
        let target = directory.join("drawing.excalidraw");
        let old = br#"{"type":"excalidraw","version":2,"elements":[]}"#;
        let new = br#"{"type":"excalidraw","version":2,"elements":[{"id":"new"}]}"#;
        fs::write(&target, old).unwrap_or_else(|error| panic!("write fixture: {error}"));

        let result = atomic_write_with_injector(&target, new, &InterruptAt(point));
        assert!(matches!(result, Err(AtomicWriteError::FaultInjected(actual)) if actual == point));

        let persisted =
            fs::read(&target).unwrap_or_else(|error| panic!("read target after {point}: {error}"));
        assert!(
            persisted == old || persisted == new,
            "unexpected bytes after {point}"
        );
        serde_json::from_slice::<serde_json::Value>(&persisted)
            .unwrap_or_else(|error| panic!("invalid JSON after {point}: {error}"));

        let leftovers = tmp_files(&directory);
        assert!(
            leftovers.is_empty(),
            "temporary files remain after {point}: {leftovers:?}"
        );
        fs::remove_dir_all(directory)
            .unwrap_or_else(|error| panic!("remove test directory: {error}"));
    }
}

#[test]
fn invalid_json_leaves_the_previous_document_and_no_temporary_file() {
    let directory = test_directory("invalid-json");
    let target = directory.join("drawing.excalidraw");
    let old = br#"{"type":"excalidraw","version":2,"elements":[]}"#;
    fs::write(&target, old).unwrap_or_else(|error| panic!("write fixture: {error}"));

    let result = super::atomic_write::atomic_write(&target, br#"{"incomplete":"#);
    assert!(matches!(result, Err(AtomicWriteError::InvalidJson(_))));
    assert_eq!(
        fs::read(&target).unwrap_or_else(|error| panic!("read target: {error}")),
        old
    );
    assert!(tmp_files(&directory).is_empty());
    fs::remove_dir_all(directory).unwrap_or_else(|error| panic!("remove test directory: {error}"));
}

#[test]
fn concurrent_writers_only_publish_a_complete_document() {
    const WRITERS: usize = 12;
    let directory = test_directory("concurrent");
    let target = directory.join("drawing.excalidraw");
    let barrier = Arc::new(Barrier::new(WRITERS));
    let payloads: Vec<Vec<u8>> = (0..WRITERS)
        .map(|index| {
            format!(r#"{{"type":"excalidraw","version":2,"elements":[{{"id":"writer-{index}"}}]}}"#)
                .into_bytes()
        })
        .collect();

    let handles: Vec<_> = payloads
        .iter()
        .cloned()
        .map(|payload| {
            let barrier = Arc::clone(&barrier);
            let target = target.clone();
            thread::spawn(move || {
                barrier.wait();
                super::atomic_write::atomic_write(&target, &payload)
            })
        })
        .collect();

    for handle in handles {
        handle
            .join()
            .unwrap_or_else(|_| panic!("writer thread panicked"))
            .unwrap_or_else(|error| panic!("atomic write failed: {error}"));
    }

    let persisted = fs::read(&target).unwrap_or_else(|error| panic!("read target: {error}"));
    assert!(payloads.contains(&persisted));
    serde_json::from_slice::<serde_json::Value>(&persisted)
        .unwrap_or_else(|error| panic!("invalid persisted JSON: {error}"));
    assert!(tmp_files(&directory).is_empty());
    fs::remove_dir_all(directory).unwrap_or_else(|error| panic!("remove test directory: {error}"));
}

fn test_directory(label: &str) -> std::path::PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "excalidraw-desktop-{label}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&directory).unwrap_or_else(|error| panic!("create test directory: {error}"));
    directory
}

fn tmp_files(directory: &std::path::Path) -> Vec<std::path::PathBuf> {
    fs::read_dir(directory)
        .unwrap_or_else(|error| panic!("read test directory: {error}"))
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "tmp"))
        .collect()
}
