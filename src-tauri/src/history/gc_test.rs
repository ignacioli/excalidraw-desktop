use super::*;
use std::{
    collections::BTreeSet,
    panic,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Barrier,
    },
    time::{Duration, SystemTime},
};

fn scene(seed: u8) -> ObjectKey {
    ObjectKey::scene(format!("{seed:02x}{:0>62}", "")).expect("valid scene hash")
}

fn asset(seed: u8) -> ObjectKey {
    ObjectKey::asset(format!("{seed:02x}{:0>62}", "")).expect("valid asset hash")
}

fn references(scene: ObjectKey, assets: impl IntoIterator<Item = ObjectKey>) -> ObjectReferences {
    ObjectReferences::from_objects(std::iter::once(scene).chain(assets))
}

#[test]
fn live_set_unifies_committed_operation_and_hydration_references() {
    let gate = ReachabilityGate::new();
    let committed_scene = scene(1);
    let committed_asset = asset(2);
    let operation_scene = scene(3);
    let operation_asset = asset(4);
    let hydration_scene = scene(5);
    let hydration_asset = asset(6);

    gate.set_committed_version(
        "version-1",
        references(committed_scene.clone(), [committed_asset.clone()]),
    )
    .expect("set committed version");
    let operation_pin = gate
        .acquire_operation_pin(
            "operation-1",
            references(operation_scene.clone(), [operation_asset.clone()]),
        )
        .expect("acquire operation pin");
    let hydration_pin = gate
        .acquire_hydration_pin(references(
            hydration_scene.clone(),
            [hydration_asset.clone()],
        ))
        .expect("acquire hydration pin");

    let live = gate.live_objects().expect("read live set");
    let expected = BTreeSet::from([
        committed_scene,
        committed_asset,
        operation_scene,
        operation_asset,
        hydration_scene,
        hydration_asset,
    ]);
    assert_eq!(live.iter().cloned().collect::<BTreeSet<_>>(), expected);

    hydration_pin.release().expect("release hydration pin");
    operation_pin.release().expect("release operation pin");
}

#[test]
fn hydration_pin_releases_after_success_and_error() {
    let gate = ReachabilityGate::new();
    let first = scene(10);
    let second = scene(11);

    let result: Result<usize, GcError> =
        gate.with_hydration_pin(references(first.clone(), []), |_pin| Ok(7));
    assert_eq!(result.expect("successful hydration"), 7);
    assert!(!gate.live_objects().expect("live set").contains(&first));

    let error: Result<(), GcError> = gate
        .with_hydration_pin(references(second.clone(), []), |_pin| {
            Err(GcError::PinNotActive("fixture failure".to_owned()))
        });
    assert!(error.is_err());
    assert!(!gate.live_objects().expect("live set").contains(&second));
}

#[test]
fn hydration_pin_drop_releases_on_panic_path() {
    let gate = ReachabilityGate::new();
    let object = scene(12);
    let result = panic::catch_unwind({
        let gate = gate.clone();
        let object = object.clone();
        move || {
            let _pin = gate
                .acquire_hydration_pin(references(object, []))
                .expect("acquire hydration pin");
            panic!("simulate response failure");
        }
    });
    assert!(result.is_err());
    assert!(!gate.live_objects().expect("live set").contains(&object));
}

#[test]
fn gc_retains_target_objects_during_status_hydration() {
    let gate = ReachabilityGate::new();
    let target = scene(13);
    let hydration_pin = gate
        .acquire_hydration_pin(references(target.clone(), []))
        .expect("acquire status hydration pin");
    let rendezvous = Arc::new(Barrier::new(2));
    let entered = Arc::new(AtomicBool::new(false));
    let worker_gate = gate.clone();
    let worker_rendezvous = rendezvous.clone();
    let worker_entered = entered.clone();
    let worker_target = target.clone();
    let worker = std::thread::spawn(move || {
        worker_rendezvous.wait();
        worker_entered.store(true, Ordering::Release);
        worker_gate
            .collect(
                [GcCandidate::registered(
                    worker_target,
                    SystemTime::UNIX_EPOCH,
                )],
                SystemTime::UNIX_EPOCH + Duration::from_secs(3600),
                Duration::from_secs(1),
                |_| Ok::<(), ()>(()),
            )
            .expect("collect during hydration response")
    });
    rendezvous.wait();
    while !entered.load(Ordering::Acquire) {
        std::thread::yield_now();
    }
    let report = worker.join().expect("join GC worker");
    assert!(report.retained.contains(&target));
    hydration_pin
        .release()
        .expect("release status hydration pin");
    let report = gate
        .collect(
            [GcCandidate::registered(
                target.clone(),
                SystemTime::UNIX_EPOCH,
            )],
            SystemTime::UNIX_EPOCH + Duration::from_secs(3600),
            Duration::from_secs(1),
            |_| Ok::<(), ()>(()),
        )
        .expect("collect after hydration response");
    assert!(report.deleted.contains(&target));
}

#[test]
fn hydration_read_pin_keeps_scene_and_asset_alive_during_gc() {
    let gate = ReachabilityGate::new();
    let target_scene = scene(14);
    let target_asset = asset(15);
    let hydration_pin = gate
        .acquire_hydration_pin(references(target_scene.clone(), [target_asset.clone()]))
        .expect("acquire read hydration pin");
    let report = gate
        .collect(
            [
                GcCandidate::registered(target_scene.clone(), SystemTime::UNIX_EPOCH),
                GcCandidate::registered(target_asset.clone(), SystemTime::UNIX_EPOCH),
            ],
            SystemTime::UNIX_EPOCH + Duration::from_secs(3600),
            Duration::ZERO,
            |_| Ok::<(), ()>(()),
        )
        .expect("collect while read response is buffered");
    assert!(report.deleted.is_empty());
    assert_eq!(report.retained.len(), 2);

    hydration_pin.release().expect("release read hydration pin");
    let report = gate
        .collect(
            [
                GcCandidate::registered(target_scene, SystemTime::UNIX_EPOCH),
                GcCandidate::registered(target_asset, SystemTime::UNIX_EPOCH),
            ],
            SystemTime::UNIX_EPOCH + Duration::from_secs(3600),
            Duration::ZERO,
            |_| Ok::<(), ()>(()),
        )
        .expect("collect after read response");
    assert_eq!(report.deleted.len(), 2);
}

#[test]
fn operation_pin_keeps_evicted_target_and_assets_alive() {
    let gate = ReachabilityGate::new();
    let target_scene = scene(20);
    let target_asset = asset(21);
    gate.set_committed_version(
        "oldest",
        references(target_scene.clone(), [target_asset.clone()]),
    )
    .expect("set target version");
    let pin = gate
        .acquire_operation_pin(
            "restore-operation",
            references(target_scene.clone(), [target_asset.clone()]),
        )
        .expect("pin restore target");
    gate.remove_committed_version("oldest")
        .expect("evict visible target");

    let mut deleted = Vec::new();
    let report = gate
        .collect(
            [
                GcCandidate::registered(target_scene.clone(), SystemTime::UNIX_EPOCH),
                GcCandidate::registered(target_asset.clone(), SystemTime::UNIX_EPOCH),
            ],
            SystemTime::UNIX_EPOCH + Duration::from_secs(3600),
            Duration::from_secs(1),
            |object| {
                deleted.push(object.clone());
                Ok::<(), ()>(())
            },
        )
        .expect("collect while operation is active");
    assert!(deleted.is_empty());
    assert_eq!(report.retained.len(), 2);

    pin.release().expect("release restore target");
    let report = gate
        .collect(
            [
                GcCandidate::registered(target_scene, SystemTime::UNIX_EPOCH),
                GcCandidate::registered(target_asset, SystemTime::UNIX_EPOCH),
            ],
            SystemTime::UNIX_EPOCH + Duration::from_secs(3600),
            Duration::from_secs(1),
            |object| {
                deleted.push(object.clone());
                Ok::<(), ()>(())
            },
        )
        .expect("collect after operation is terminal");
    assert_eq!(report.deleted.len(), 2);
    assert_eq!(deleted.len(), 2);
}

#[test]
fn unregistered_objects_are_retained_only_within_bounded_grace() {
    let gate = ReachabilityGate::new();
    let object = asset(30);
    let created = SystemTime::UNIX_EPOCH + Duration::from_secs(100);
    gate.track_unregistered(object.clone(), created)
        .expect("track unregistered object");

    let mut deleted = Vec::new();
    let retained = gate
        .collect(
            [GcCandidate::unregistered(object.clone(), created)],
            created + Duration::from_secs(59),
            Duration::from_secs(60),
            |candidate| {
                deleted.push(candidate.clone());
                Ok::<(), ()>(())
            },
        )
        .expect("collect within grace");
    assert!(retained.deleted.is_empty());
    assert_eq!(retained.retained, vec![object.clone()]);
    assert!(deleted.is_empty());

    let expired = gate
        .collect(
            [GcCandidate::unregistered(object.clone(), created)],
            created + Duration::from_secs(60),
            Duration::from_secs(60),
            |candidate| {
                deleted.push(candidate.clone());
                Ok::<(), ()>(())
            },
        )
        .expect("collect after grace");
    assert_eq!(expired.deleted, vec![object]);
    assert_eq!(deleted.len(), 1);
}

#[test]
fn collection_reports_delete_failures_without_removing_other_candidates() {
    let gate = ReachabilityGate::new();
    let failed = asset(40);
    let deleted = asset(41);
    let mut attempted = Vec::new();
    let report = gate
        .collect(
            [
                GcCandidate::registered(failed.clone(), SystemTime::UNIX_EPOCH),
                GcCandidate::registered(deleted.clone(), SystemTime::UNIX_EPOCH),
            ],
            SystemTime::UNIX_EPOCH + Duration::from_secs(2),
            Duration::from_secs(1),
            |candidate| {
                attempted.push(candidate.clone());
                if candidate == &failed {
                    Err("permission denied")
                } else {
                    Ok(())
                }
            },
        )
        .expect("collect candidates");
    assert_eq!(report.deleted, vec![deleted]);
    assert_eq!(report.failures, vec![(failed, "permission denied")]);
    assert_eq!(attempted.len(), 2);
}
