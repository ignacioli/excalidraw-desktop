//! Shared reachability gate for history object cleanup.
//!
//! Object publication, version retention, preview hydration and protected
//! replacement do not share a SQLite transaction with the immutable object
//! files.  This gate is the in-process serialization boundary between those
//! operations and physical object deletion.  Callers must persist an
//! operation intent before acquiring an operation pin and must keep that pin
//! until the operation is completed or reconciled.
//!
//! The gate intentionally does not start a task or a timer.  Collection is an
//! explicit maintenance action, normally run after a successful retention or
//! deletion transaction.  The caller supplies the object candidates because
//! the current T008 object store has no directory enumeration primitive.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, SystemTime},
};

use thiserror::Error;

/// A bounded grace period for objects written before their metadata
/// transaction becomes visible.  It is deliberately finite and is not an
/// idle cleanup timer.
pub const DEFAULT_ORPHAN_GRACE: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ObjectKind {
    Scene,
    Asset,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ObjectKey {
    pub kind: ObjectKind,
    pub hash: String,
}

impl ObjectKey {
    pub fn new(kind: ObjectKind, hash: impl Into<String>) -> Result<Self, GcError> {
        let hash = hash.into();
        if hash.is_empty()
            || hash.len() != 64
            || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            || hash.bytes().any(|byte| byte.is_ascii_uppercase())
        {
            return Err(GcError::InvalidHash);
        }
        Ok(Self { kind, hash })
    }

    pub fn scene(hash: impl Into<String>) -> Result<Self, GcError> {
        Self::new(ObjectKind::Scene, hash)
    }

    pub fn asset(hash: impl Into<String>) -> Result<Self, GcError> {
        Self::new(ObjectKind::Asset, hash)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ObjectReferences {
    objects: BTreeSet<ObjectKey>,
}

impl ObjectReferences {
    pub fn new(
        scene_hash: impl Into<String>,
        asset_hashes: impl IntoIterator<Item = String>,
    ) -> Result<Self, GcError> {
        let mut objects = BTreeSet::new();
        objects.insert(ObjectKey::scene(scene_hash)?);
        for hash in asset_hashes {
            objects.insert(ObjectKey::asset(hash)?);
        }
        Ok(Self { objects })
    }

    pub fn from_objects(objects: impl IntoIterator<Item = ObjectKey>) -> Self {
        Self {
            objects: objects.into_iter().collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.objects.is_empty()
    }

    pub fn contains(&self, object: &ObjectKey) -> bool {
        self.objects.contains(object)
    }

    pub fn iter(&self) -> impl Iterator<Item = &ObjectKey> {
        self.objects.iter()
    }
}

impl FromIterator<ObjectKey> for ObjectReferences {
    fn from_iter<T: IntoIterator<Item = ObjectKey>>(iter: T) -> Self {
        Self::from_objects(iter)
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum GcError {
    #[error("history GC hash must be a lowercase SHA-256 digest")]
    InvalidHash,
    #[error("history GC lock is poisoned")]
    LockPoisoned,
    #[error("history GC pin {0} is not active")]
    PinNotActive(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GcCandidate {
    pub object: ObjectKey,
    pub created_at: SystemTime,
    /// Whether the metadata row is already committed.  Unregistered objects
    /// are retained for the bounded grace period even if they are currently
    /// unreachable.
    pub registered: bool,
}

impl GcCandidate {
    pub fn registered(object: ObjectKey, created_at: SystemTime) -> Self {
        Self {
            object,
            created_at,
            registered: true,
        }
    }

    pub fn unregistered(object: ObjectKey, created_at: SystemTime) -> Self {
        Self {
            object,
            created_at,
            registered: false,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct GcReport<E> {
    pub deleted: Vec<ObjectKey>,
    pub retained: Vec<ObjectKey>,
    pub failures: Vec<(ObjectKey, E)>,
}

#[derive(Debug, Default)]
struct GateState {
    committed_versions: BTreeMap<String, ObjectReferences>,
    operation_pins: BTreeMap<String, ObjectReferences>,
    hydration_pins: BTreeMap<u64, ObjectReferences>,
    unregistered: BTreeMap<ObjectKey, SystemTime>,
    next_pin_id: u64,
}

#[derive(Debug, Clone, Default)]
pub struct ReachabilityGate {
    state: Arc<Mutex<GateState>>,
}

impl ReachabilityGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Serialize an object metadata mutation with collection.  The callback
    /// receives a mutation view so callers can update committed references
    /// before the gate is released.  This is the production seam that keeps
    /// object verification, metadata publication and reachability updates in
    /// one critical section.
    pub fn with_mutation<T, E, F>(&self, operation: F) -> Result<T, E>
    where
        E: From<GcError>,
        F: FnOnce(&mut ReachabilityMutation<'_>) -> Result<T, E>,
    {
        let state = self.lock().map_err(E::from)?;
        let mut mutation = ReachabilityMutation { state };
        operation(&mut mutation)
    }

    /// Record the object references of a committed semantic version.
    /// Replacing an existing version is idempotent and remains under the same
    /// lock used by collection.
    pub fn set_committed_version(
        &self,
        version_id: impl Into<String>,
        references: ObjectReferences,
    ) -> Result<(), GcError> {
        self.with_mutation(|mutation| {
            mutation.set_committed_version(version_id.into(), references);
            Ok(())
        })
    }

    pub fn remove_committed_version(&self, version_id: &str) -> Result<(), GcError> {
        self.with_mutation(|mutation| {
            mutation.remove_committed_version(version_id);
            Ok(())
        })
    }

    /// Acquire a durable operation pin.  The operation ID is the persisted
    /// idempotency ID, not a transient request token.  The caller must first
    /// commit the operation intent and must release this pin only after
    /// completion or reconciliation has been persisted.
    pub fn acquire_operation_pin(
        &self,
        operation_id: impl Into<String>,
        references: ObjectReferences,
    ) -> Result<OperationPin, GcError> {
        let operation_id = operation_id.into();
        self.restore_operation_pin(operation_id.clone(), references)?;
        Ok(OperationPin {
            gate: self.clone(),
            operation_id,
            released: false,
        })
    }

    /// Rebuild a durable operation pin from persisted operation metadata.
    /// Unlike [`Self::acquire_operation_pin`], this does not return a scoped
    /// handle whose destructor could release the pin; the durable row owns the
    /// pin until a terminal operation transition explicitly releases it.
    pub fn restore_operation_pin(
        &self,
        operation_id: impl Into<String>,
        references: ObjectReferences,
    ) -> Result<(), GcError> {
        let operation_id = operation_id.into();
        let mut state = self.lock()?;
        state.operation_pins.insert(operation_id, references);
        Ok(())
    }

    pub fn release_operation_pin(&self, operation_id: &str) -> Result<(), GcError> {
        let mut state = self.lock()?;
        if state.operation_pins.remove(operation_id).is_none() {
            return Err(GcError::PinNotActive(operation_id.to_owned()));
        }
        Ok(())
    }

    /// Mark an object as written but not yet visible in metadata.  The
    /// timestamp is kept under the gate so collection cannot observe the
    /// candidate between publication steps.
    pub fn track_unregistered(
        &self,
        object: ObjectKey,
        created_at: SystemTime,
    ) -> Result<(), GcError> {
        let mut state = self.lock()?;
        state.unregistered.entry(object).or_insert(created_at);
        Ok(())
    }

    pub fn mark_registered(&self, object: &ObjectKey) -> Result<(), GcError> {
        let mut state = self.lock()?;
        state.unregistered.remove(object);
        Ok(())
    }

    /// Acquire a request-scoped hydration pin.  The returned guard must stay
    /// alive until all scene and asset bytes have been read and the response
    /// has been assembled.  `Drop` also releases it, covering error and panic
    /// paths.
    pub fn acquire_hydration_pin(
        &self,
        references: ObjectReferences,
    ) -> Result<HydrationPin, GcError> {
        let mut state = self.lock()?;
        state.next_pin_id = state.next_pin_id.wrapping_add(1);
        if state.next_pin_id == 0 {
            state.next_pin_id = 1;
        }
        let pin_id = state.next_pin_id;
        state.hydration_pins.insert(pin_id, references);
        Ok(HydrationPin {
            gate: self.clone(),
            pin_id,
            released: false,
        })
    }

    /// Execute a complete hydration response while holding a request pin.
    /// The callback must buffer the complete response before returning.  A
    /// callback error never prevents pin release.
    pub fn with_hydration_pin<T, E, F>(
        &self,
        references: ObjectReferences,
        callback: F,
    ) -> Result<T, E>
    where
        E: From<GcError>,
        F: FnOnce(&HydrationPin) -> Result<T, E>,
    {
        let pin = self.acquire_hydration_pin(references).map_err(E::from)?;
        let result = callback(&pin);
        let released = pin.release();
        match (result, released) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(E::from(error)),
        }
    }

    /// Compute and delete unreachable object candidates under the same lock as
    /// pin acquisition/release.  The final reachability check happens
    /// immediately before each delete while the lock is still held.
    /// `delete` must only delete the supplied immutable object and must not
    /// call back into this gate.
    pub fn collect<E, F>(
        &self,
        candidates: impl IntoIterator<Item = GcCandidate>,
        now: SystemTime,
        grace: Duration,
        mut delete: F,
    ) -> Result<GcReport<E>, GcError>
    where
        F: FnMut(&ObjectKey) -> Result<(), E>,
    {
        let mut state = self.lock()?;
        let live = state.live_objects();
        let mut seen = BTreeSet::new();
        let mut report = GcReport {
            deleted: Vec::new(),
            retained: Vec::new(),
            failures: Vec::new(),
        };

        for candidate in candidates {
            if !seen.insert(candidate.object.clone()) {
                continue;
            }
            let age_is_within_grace = candidate
                .created_at
                .checked_add(grace)
                .is_some_and(|deadline| now < deadline);
            let tracked_grace = state
                .unregistered
                .get(&candidate.object)
                .and_then(|created| created.checked_add(grace))
                .is_some_and(|deadline| now < deadline);

            if live.contains(&candidate.object)
                || (!candidate.registered && age_is_within_grace)
                || tracked_grace
            {
                report.retained.push(candidate.object);
                continue;
            }

            // Recheck while holding the gate immediately before deletion.
            // This is intentionally explicit even though `live` was computed
            // under the same lock: it documents and protects this critical
            // ordering if the live-set construction changes later.
            if state.live_objects().contains(&candidate.object) {
                report.retained.push(candidate.object);
                continue;
            }

            match delete(&candidate.object) {
                Ok(()) => {
                    state.unregistered.remove(&candidate.object);
                    report.deleted.push(candidate.object);
                }
                Err(error) => report.failures.push((candidate.object, error)),
            }
        }
        Ok(report)
    }

    pub fn live_objects(&self) -> Result<ObjectReferences, GcError> {
        let state = self.lock()?;
        Ok(ObjectReferences::from_objects(state.live_objects()))
    }

    fn lock(&self) -> Result<MutexGuard<'_, GateState>, GcError> {
        self.state.lock().map_err(|_| GcError::LockPoisoned)
    }

    fn release_hydration(&self, pin_id: u64) -> Result<(), GcError> {
        let mut state = self.lock()?;
        if state.hydration_pins.remove(&pin_id).is_none() {
            return Err(GcError::PinNotActive(format!("hydration:{pin_id}")));
        }
        Ok(())
    }
}

/// Mutation view held for the lifetime of a `ReachabilityGate` critical
/// section.  It is intentionally small: callers cannot directly manipulate
/// transient hydration pins or bypass the lock during collection.
pub struct ReachabilityMutation<'a> {
    state: MutexGuard<'a, GateState>,
}

impl ReachabilityMutation<'_> {
    pub fn set_committed_version(
        &mut self,
        version_id: impl Into<String>,
        references: ObjectReferences,
    ) {
        self.state
            .committed_versions
            .insert(version_id.into(), references);
    }

    pub fn remove_committed_version(&mut self, version_id: &str) {
        self.state.committed_versions.remove(version_id);
    }

    pub fn mark_registered(&mut self, object: &ObjectKey) {
        self.state.unregistered.remove(object);
    }
}

impl GateState {
    fn live_objects(&self) -> BTreeSet<ObjectKey> {
        self.committed_versions
            .values()
            .chain(self.operation_pins.values())
            .chain(self.hydration_pins.values())
            .flat_map(ObjectReferences::iter)
            .cloned()
            .collect()
    }
}

#[derive(Debug)]
pub struct HydrationPin {
    gate: ReachabilityGate,
    pin_id: u64,
    released: bool,
}

impl HydrationPin {
    pub fn release(mut self) -> Result<(), GcError> {
        if self.released {
            return Ok(());
        }
        let result = self.gate.release_hydration(self.pin_id);
        if result.is_ok() {
            self.released = true;
        }
        result
    }
}

impl Drop for HydrationPin {
    fn drop(&mut self) {
        if !self.released {
            // A poisoned gate fails closed: leaving the pin in the state can
            // only retain bytes, while deleting them would risk data loss.
            let _ = self.gate.release_hydration(self.pin_id);
        }
    }
}

#[derive(Debug)]
pub struct OperationPin {
    gate: ReachabilityGate,
    operation_id: String,
    released: bool,
}

impl OperationPin {
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }

    /// Release only after the durable operation has reached Completed,
    /// Aborted, or a reconciled terminal state.
    pub fn release(mut self) -> Result<(), GcError> {
        if self.released {
            return Ok(());
        }
        let result = self.gate.release_operation_pin(&self.operation_id);
        if result.is_ok() {
            self.released = true;
        }
        result
    }
}

#[cfg(test)]
#[path = "gc_test.rs"]
mod tests;
