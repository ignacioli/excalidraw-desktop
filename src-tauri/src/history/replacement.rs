//! The single protected replacement pipeline.
//!
//! This module is deliberately a coordination boundary, not a Tauri command.
//! A future `history_replace` handler supplies an authorized backend adapter;
//! the adapter owns document locks, complete scene/asset capture, and the
//! existing draft/index stores.  The pipeline owns ordering and makes it
//! impossible for a caller to perform the destructive rename before the
//! protection and operation intent are durable.

use std::{
    fs,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};
use thiserror::Error;

use super::{
    identity::FileSystemIdentity, operation::OperationObjectPin, types::HistoryProtectedAction,
};
use crate::documents::atomic_write::{
    atomic_write_with_pre_rename_validator, GuardedAtomicWriteError,
};

#[cfg(feature = "e2e-harness")]
fn history_fault(stage: crate::e2e_harness::HistoryFaultStage) -> Result<(), String> {
    crate::e2e_harness::history_fault_barrier_from_environment(stage)
}

/// The observable transaction phase.  `IntentCommitted` is the last phase in
/// which failure can safely claim that the old file remains untouched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplacementPhase {
    Preparing,
    Protected,
    IntentCommitted,
    TargetObserved,
    TargetPublished,
    MetadataCommitted,
    Completed,
    Reconcile,
    Conflict,
    Aborted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtectedReplacementRequest {
    pub request_id: String,
    pub document_id: String,
    pub session_generation: u64,
    pub revision: u64,
    pub target_path: PathBuf,
    pub expected_base_hash: String,
    pub expected_identity: FileSystemIdentity,
    pub action: HistoryProtectedAction,
}

/// Complete current-document input captured after the prior write queue has
/// drained.  Assets are copied into history by the backend adapter before it
/// reports `ProtectionReceipt`; a borrowed workspace asset is never enough.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedDocument {
    pub scene_json: Vec<u8>,
    pub assets: Vec<CapturedAsset>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedAsset {
    pub file_id: String,
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtectionReceipt {
    pub version_id: String,
    pub scene_hash: String,
    pub object_pins: Vec<OperationObjectPin>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedTarget {
    /// Backend-resolved target bytes. Restore loads this by version ID; clear
    /// and import are validated before this pipeline receives the bytes.
    pub scene_json: Vec<u8>,
    pub target_scene_hash: String,
    pub object_pins: Vec<OperationObjectPin>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalizedReplacement {
    pub adopted_scene: Vec<u8>,
    pub new_base_hash: String,
    pub new_session_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplacementFailure {
    pub phase: ReplacementPhase,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplacementOutcome {
    /// The file rename, directory sync, draft/index update, identity update,
    /// and generation advance all completed.
    Completed(FinalizedReplacement),
    /// No target rename has been performed. The old file is still authoritative
    /// (subject to the caller's external filesystem authority).
    PreCommitFailure(ReplacementFailure),
    /// The target rename may have happened. The caller must reconcile by
    /// request ID and must not write stale frontend state.
    PublishedButDurabilityUnknown(ReplacementFailure),
    /// The last pre-rename identity/base-hash check rejected the operation.
    Conflict(ReplacementFailure),
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ReplacementError {
    #[error("replacement backend failed during {phase:?}: {message}")]
    Backend {
        phase: ReplacementPhase,
        message: String,
    },
    #[error("replacement input is invalid: {0}")]
    InvalidInput(String),
}

/// Backend-owned seams for one protected replacement.  A production adapter
/// should map `begin_operation`, `transition_*`, and `mark_reconcile` to the
/// public `OperationStore` methods.  The pipeline does not reach into SQLite,
/// the hot draft repository, or Tauri state itself.
pub trait ProtectedReplacementBackend {
    type Error: ToString;

    /// Stop/coalesce every earlier draft/checkpoint write for this document.
    fn drain_prior_writes(
        &mut self,
        request: &ProtectedReplacementRequest,
    ) -> Result<(), Self::Error>;

    /// Capture the complete current scene and required image bytes after the
    /// drain. This is the only source for the protected version.
    fn capture_current(
        &mut self,
        request: &ProtectedReplacementRequest,
    ) -> Result<CapturedDocument, Self::Error>;

    /// Validate the selected target and all resources it references before
    /// publishing the protected snapshot. This boundary must not create a
    /// durable history record or operation intent.
    fn validate_target(
        &mut self,
        _request: &ProtectedReplacementRequest,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    /// Publish immutable scene/assets and their protected history metadata.
    /// This must return only after the protection record is durable.
    fn publish_protection(
        &mut self,
        request: &ProtectedReplacementRequest,
        captured: &CapturedDocument,
    ) -> Result<ProtectionReceipt, Self::Error>;

    /// Persist the operation record in `IntentCommitted` before target rename.
    fn begin_operation(
        &mut self,
        request: &ProtectedReplacementRequest,
        protection: &ProtectionReceipt,
    ) -> Result<(), Self::Error>;

    /// Resolve and validate the selected target. It must be complete and
    /// history-owned before destructive file work begins.
    fn resolve_target(
        &mut self,
        request: &ProtectedReplacementRequest,
        protection: &ProtectionReceipt,
    ) -> Result<PreparedTarget, Self::Error>;

    /// Record that the operation has observed a target and is about to call
    /// the guarded atomic writer.
    fn mark_target_observed(
        &mut self,
        request: &ProtectedReplacementRequest,
        target: &PreparedTarget,
    ) -> Result<(), Self::Error>;

    /// Record the target-published state immediately after the rename and
    /// parent sync have returned successfully.
    fn mark_target_published(
        &mut self,
        request: &ProtectedReplacementRequest,
        target: &PreparedTarget,
    ) -> Result<(), Self::Error>;

    /// Atomically update hot draft, workspace index, persistent identity and
    /// the next session generation. It must not report success until all are
    /// durable or its implementation has recorded reconciliation work.
    fn finalize_published_target(
        &mut self,
        request: &ProtectedReplacementRequest,
        protection: &ProtectionReceipt,
        target: &PreparedTarget,
    ) -> Result<FinalizedReplacement, Self::Error>;

    /// Preserve the operation and pins for restart reconciliation. This is
    /// best-effort after a post-rename error; the original uncertainty remains
    /// visible even if recording reconciliation itself fails.
    fn mark_reconcile(
        &mut self,
        request: &ProtectedReplacementRequest,
        phase: ReplacementPhase,
        reason: &str,
    ) -> Result<(), Self::Error>;

    /// Record a pre-rename conflict. This must not alter the target file.
    fn mark_conflict(
        &mut self,
        request: &ProtectedReplacementRequest,
        reason: &str,
    ) -> Result<(), Self::Error>;

    /// Abort an intent that is known not to have crossed the filesystem
    /// rename boundary. Implementations must release durable operation pins.
    fn abort_operation(
        &mut self,
        _request: &ProtectedReplacementRequest,
        _phase: ReplacementPhase,
        _reason: &str,
    ) -> Result<(), Self::Error> {
        Ok(())
    }
}

pub struct ProtectedReplacementEngine<B> {
    backend: B,
}

impl<B> ProtectedReplacementEngine<B>
where
    B: ProtectedReplacementBackend,
{
    pub fn new(backend: B) -> Self {
        Self { backend }
    }

    pub fn backend(&self) -> &B {
        &self.backend
    }

    pub fn backend_mut(&mut self) -> &mut B {
        &mut self.backend
    }

    pub fn execute(&mut self, request: ProtectedReplacementRequest) -> ReplacementOutcome {
        if let Err(error) = validate_request(&request) {
            return ReplacementOutcome::PreCommitFailure(ReplacementFailure {
                phase: ReplacementPhase::Preparing,
                message: error.to_string(),
            });
        }

        if let Err(error) = self.backend.drain_prior_writes(&request) {
            return precommit(ReplacementPhase::Preparing, error);
        }
        let captured = match self.backend.capture_current(&request) {
            Ok(captured) => captured,
            Err(error) => return precommit(ReplacementPhase::Preparing, error),
        };
        if let Err(error) = validate_capture(&captured) {
            return ReplacementOutcome::PreCommitFailure(ReplacementFailure {
                phase: ReplacementPhase::Preparing,
                message: error.to_string(),
            });
        }

        if let Err(error) = self.backend.validate_target(&request) {
            return precommit(ReplacementPhase::Preparing, error);
        }

        let protection = match self.backend.publish_protection(&request, &captured) {
            Ok(protection) => protection,
            Err(error) => return precommit(ReplacementPhase::Protected, error),
        };
        #[cfg(feature = "e2e-harness")]
        if let Err(error) = history_fault(crate::e2e_harness::HistoryFaultStage::ProtectionCommit) {
            return precommit(ReplacementPhase::Protected, error);
        }
        if let Err(error) = self.backend.begin_operation(&request, &protection) {
            let reason = error.to_string();
            // The operation record may have been created before a later
            // metadata/pin step failed. Give the backend one uniform abort
            // boundary for every failure before target publication; the
            // adapter releases any durable operation pins it owns.
            let _ = self
                .backend
                .abort_operation(&request, ReplacementPhase::Protected, &reason);
            return precommit(ReplacementPhase::Protected, reason);
        }
        #[cfg(feature = "e2e-harness")]
        if let Err(error) = history_fault(crate::e2e_harness::HistoryFaultStage::IntentCommit) {
            let _ =
                self.backend
                    .abort_operation(&request, ReplacementPhase::IntentCommitted, &error);
            return precommit(ReplacementPhase::IntentCommitted, error);
        }
        let target = match self.backend.resolve_target(&request, &protection) {
            Ok(target) => target,
            Err(error) => {
                let reason = error.to_string();
                let _ = self.backend.abort_operation(
                    &request,
                    ReplacementPhase::IntentCommitted,
                    &reason,
                );
                return precommit(ReplacementPhase::IntentCommitted, error);
            }
        };
        if let Err(error) = self.backend.mark_target_observed(&request, &target) {
            let reason = error.to_string();
            let _ =
                self.backend
                    .abort_operation(&request, ReplacementPhase::TargetObserved, &reason);
            return precommit(ReplacementPhase::TargetObserved, error);
        }

        let validator = |path: &Path| validate_expected_target(path, &request);
        match atomic_write_with_pre_rename_validator(
            &request.target_path,
            &target.scene_json,
            &validator,
        ) {
            Ok(()) => {}
            Err(GuardedAtomicWriteError::Conflict { path }) => {
                let reason = format!("target changed before rename: {}", path.display());
                let _ = self.backend.mark_conflict(&request, &reason);
                return ReplacementOutcome::Conflict(ReplacementFailure {
                    phase: ReplacementPhase::Conflict,
                    message: reason,
                });
            }
            Err(GuardedAtomicWriteError::PublishedButDurabilityUnknown {
                phase, detail, ..
            }) => {
                let reason = format!("{detail} (phase {phase})");
                let _ = self
                    .backend
                    .mark_reconcile(&request, ReplacementPhase::Reconcile, &reason);
                return ReplacementOutcome::PublishedButDurabilityUnknown(ReplacementFailure {
                    phase: ReplacementPhase::Reconcile,
                    message: reason,
                });
            }
            Err(GuardedAtomicWriteError::Atomic(error)) => {
                let reason = error.to_string();
                let _ = self.backend.abort_operation(
                    &request,
                    ReplacementPhase::IntentCommitted,
                    &reason,
                );
                return precommit(ReplacementPhase::IntentCommitted, error);
            }
        }

        if let Err(error) = self.backend.mark_target_published(&request, &target) {
            let reason = error.to_string();
            let _ = self
                .backend
                .mark_reconcile(&request, ReplacementPhase::Reconcile, &reason);
            return ReplacementOutcome::PublishedButDurabilityUnknown(ReplacementFailure {
                phase: ReplacementPhase::Reconcile,
                message: reason,
            });
        }
        match self
            .backend
            .finalize_published_target(&request, &protection, &target)
        {
            Ok(finalized) => {
                #[cfg(feature = "e2e-harness")]
                if let Err(error) = history_fault(
                    crate::e2e_harness::HistoryFaultStage::MetadataCompleteBeforeFrontendAck,
                ) {
                    return ReplacementOutcome::PublishedButDurabilityUnknown(ReplacementFailure {
                        phase: ReplacementPhase::Reconcile,
                        message: error,
                    });
                }
                ReplacementOutcome::Completed(finalized)
            }
            Err(error) => {
                let reason = error.to_string();
                let _ = self
                    .backend
                    .mark_reconcile(&request, ReplacementPhase::Reconcile, &reason);
                ReplacementOutcome::PublishedButDurabilityUnknown(ReplacementFailure {
                    phase: ReplacementPhase::Reconcile,
                    message: reason,
                })
            }
        }
    }
}

fn precommit<E: ToString>(phase: ReplacementPhase, error: E) -> ReplacementOutcome {
    ReplacementOutcome::PreCommitFailure(ReplacementFailure {
        phase,
        message: error.to_string(),
    })
}

fn validate_request(request: &ProtectedReplacementRequest) -> Result<(), ReplacementError> {
    if request.request_id.is_empty() || request.document_id.is_empty() {
        return Err(ReplacementError::InvalidInput(
            "request and document identifiers must be non-empty".to_owned(),
        ));
    }
    if request.expected_base_hash.len() != 64
        || !request
            .expected_base_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || request
            .expected_base_hash
            .bytes()
            .any(|byte| byte.is_ascii_uppercase())
    {
        return Err(ReplacementError::InvalidInput(
            "expected base hash must be a lowercase SHA-256 digest".to_owned(),
        ));
    }
    if request.target_path.file_name().is_none() {
        return Err(ReplacementError::InvalidInput(
            "replacement target must have a file name".to_owned(),
        ));
    }
    Ok(())
}

fn validate_capture(captured: &CapturedDocument) -> Result<(), ReplacementError> {
    if captured.scene_json.is_empty() {
        return Err(ReplacementError::InvalidInput(
            "protected snapshot cannot have an empty scene".to_owned(),
        ));
    }
    for asset in &captured.assets {
        if asset.file_id.is_empty() || asset.mime_type.is_empty() || asset.bytes.is_empty() {
            return Err(ReplacementError::InvalidInput(
                "protected snapshot assets require id, MIME type, and bytes".to_owned(),
            ));
        }
    }
    Ok(())
}

/// This check is intentionally performed by the atomic writer immediately
/// before rename. A check in the service before temp-file construction would
/// leave an independent check-to-rename race.
pub fn validate_expected_target(
    target: &Path,
    request: &ProtectedReplacementRequest,
) -> Result<(), GuardedAtomicWriteError> {
    let identity =
        FileSystemIdentity::from_path(target).map_err(|_| GuardedAtomicWriteError::Conflict {
            path: target.to_path_buf(),
        })?;
    if !request.expected_identity.refers_to_same_file(&identity) {
        return Err(GuardedAtomicWriteError::Conflict {
            path: target.to_path_buf(),
        });
    }
    let bytes = fs::read(target).map_err(|_| GuardedAtomicWriteError::Conflict {
        path: target.to_path_buf(),
    })?;
    if sha256_hex(&bytes) != request.expected_base_hash {
        return Err(GuardedAtomicWriteError::Conflict {
            path: target.to_path_buf(),
        });
    }
    Ok(())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::*;
    use crate::documents::atomic_write::{
        atomic_write_with_pre_rename_validator_and_injector, AtomicWriteError,
        AtomicWriteFaultInjector, AtomicWriteFaultPoint,
    };

    #[derive(Default)]
    struct FakeBackend {
        phases: Vec<&'static str>,
        fail_finalize: bool,
        mutate_before_write: bool,
        fail_target_validation: bool,
        path: PathBuf,
        old_bytes: Vec<u8>,
    }

    impl ProtectedReplacementBackend for FakeBackend {
        type Error = String;

        fn drain_prior_writes(
            &mut self,
            _: &ProtectedReplacementRequest,
        ) -> Result<(), Self::Error> {
            self.phases.push("drain");
            Ok(())
        }

        fn capture_current(
            &mut self,
            _: &ProtectedReplacementRequest,
        ) -> Result<CapturedDocument, Self::Error> {
            self.phases.push("capture");
            Ok(CapturedDocument {
                scene_json: self.old_bytes.clone(),
                assets: vec![CapturedAsset {
                    file_id: "image-1".to_owned(),
                    bytes: b"png".to_vec(),
                    mime_type: "image/png".to_owned(),
                }],
            })
        }

        fn validate_target(&mut self, _: &ProtectedReplacementRequest) -> Result<(), Self::Error> {
            self.phases.push("validate");
            if self.fail_target_validation {
                return Err("target resource is unavailable".to_owned());
            }
            Ok(())
        }

        fn publish_protection(
            &mut self,
            _: &ProtectedReplacementRequest,
            _: &CapturedDocument,
        ) -> Result<ProtectionReceipt, Self::Error> {
            self.phases.push("protect");
            Ok(ProtectionReceipt {
                version_id: "version-1".to_owned(),
                scene_hash: sha256_hex(&self.old_bytes),
                object_pins: vec![OperationObjectPin::scene(sha256_hex(&self.old_bytes))],
            })
        }

        fn begin_operation(
            &mut self,
            _: &ProtectedReplacementRequest,
            _: &ProtectionReceipt,
        ) -> Result<(), Self::Error> {
            self.phases.push("intent");
            Ok(())
        }

        fn resolve_target(
            &mut self,
            _: &ProtectedReplacementRequest,
            _: &ProtectionReceipt,
        ) -> Result<PreparedTarget, Self::Error> {
            self.phases.push("resolve");
            let scene_json =
                br#"{"type":"excalidraw","version":2,"elements":[{"id":"new"}]}"#.to_vec();
            Ok(PreparedTarget {
                target_scene_hash: sha256_hex(&scene_json),
                scene_json,
                object_pins: Vec::new(),
            })
        }

        fn mark_target_observed(
            &mut self,
            _: &ProtectedReplacementRequest,
            _: &PreparedTarget,
        ) -> Result<(), Self::Error> {
            self.phases.push("observed");
            if self.mutate_before_write {
                fs::write(&self.path, b"external").map_err(|error| error.to_string())?;
            }
            Ok(())
        }

        fn mark_target_published(
            &mut self,
            _: &ProtectedReplacementRequest,
            _: &PreparedTarget,
        ) -> Result<(), Self::Error> {
            self.phases.push("published");
            Ok(())
        }

        fn finalize_published_target(
            &mut self,
            _: &ProtectedReplacementRequest,
            _: &ProtectionReceipt,
            target: &PreparedTarget,
        ) -> Result<FinalizedReplacement, Self::Error> {
            self.phases.push("finalize");
            if self.fail_finalize {
                return Err("metadata commit unavailable".to_owned());
            }
            Ok(FinalizedReplacement {
                adopted_scene: target.scene_json.clone(),
                new_base_hash: target.target_scene_hash.clone(),
                new_session_generation: 2,
            })
        }

        fn mark_reconcile(
            &mut self,
            _: &ProtectedReplacementRequest,
            _: ReplacementPhase,
            _: &str,
        ) -> Result<(), Self::Error> {
            self.phases.push("reconcile");
            Ok(())
        }

        fn mark_conflict(
            &mut self,
            _: &ProtectedReplacementRequest,
            _: &str,
        ) -> Result<(), Self::Error> {
            self.phases.push("conflict");
            Ok(())
        }
    }

    fn fixture() -> (PathBuf, ProtectedReplacementRequest) {
        let root = std::env::temp_dir().join(format!(
            "excalidraw-protected-replace-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create fixture");
        let path = root.join("drawing.excalidraw");
        let old = br#"{"type":"excalidraw","version":2,"elements":[]}"#;
        fs::write(&path, old).expect("write old document");
        let request = ProtectedReplacementRequest {
            request_id: "request-1".to_owned(),
            document_id: "document-1".to_owned(),
            session_generation: 1,
            revision: 3,
            target_path: path.clone(),
            expected_base_hash: sha256_hex(old),
            expected_identity: FileSystemIdentity::from_path(&path).expect("identity"),
            action: HistoryProtectedAction::Restore,
        };
        (root, request)
    }

    #[test]
    fn pipeline_orders_drain_capture_protection_intent_and_finalize() {
        let (root, request) = fixture();
        let old = fs::read(&request.target_path).expect("old");
        let backend = FakeBackend {
            path: request.target_path.clone(),
            old_bytes: old,
            ..Default::default()
        };
        let mut engine = ProtectedReplacementEngine::new(backend);
        let outcome = engine.execute(request.clone());
        assert!(matches!(outcome, ReplacementOutcome::Completed(_)));
        assert_eq!(
            engine.backend().phases,
            [
                "drain",
                "capture",
                "validate",
                "protect",
                "intent",
                "resolve",
                "observed",
                "published",
                "finalize"
            ]
        );
        assert_ne!(
            fs::read(request.target_path).expect("new"),
            br#"{"type":"excalidraw","version":2,"elements":[]}"#
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn target_validation_failure_happens_before_protection() {
        let (root, request) = fixture();
        let old = fs::read(&request.target_path).expect("old");
        let backend = FakeBackend {
            path: request.target_path.clone(),
            old_bytes: old.clone(),
            fail_target_validation: true,
            ..Default::default()
        };
        let mut engine = ProtectedReplacementEngine::new(backend);

        let outcome = engine.execute(request.clone());

        assert!(matches!(
            outcome,
            ReplacementOutcome::PreCommitFailure(ReplacementFailure {
                phase: ReplacementPhase::Preparing,
                ..
            })
        ));
        assert_eq!(fs::read(&request.target_path).expect("old file"), old);
        assert_eq!(engine.backend().phases, ["drain", "capture", "validate"]);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn external_change_is_a_conflict_and_never_replaced() {
        let (root, request) = fixture();
        let old = fs::read(&request.target_path).expect("old");
        let backend = FakeBackend {
            path: request.target_path.clone(),
            old_bytes: old,
            mutate_before_write: true,
            ..Default::default()
        };
        let mut engine = ProtectedReplacementEngine::new(backend);
        assert!(matches!(
            engine.execute(request.clone()),
            ReplacementOutcome::Conflict(_)
        ));
        assert_eq!(
            fs::read(&request.target_path).expect("external"),
            b"external"
        );
        assert_eq!(engine.backend().phases.last(), Some(&"conflict"));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn finalize_failure_is_not_reported_as_precommit_failure() {
        let (root, request) = fixture();
        let old = fs::read(&request.target_path).expect("old");
        let backend = FakeBackend {
            path: request.target_path.clone(),
            old_bytes: old,
            fail_finalize: true,
            ..Default::default()
        };
        let mut engine = ProtectedReplacementEngine::new(backend);
        assert!(matches!(
            engine.execute(request),
            ReplacementOutcome::PublishedButDurabilityUnknown(_)
        ));
        assert_eq!(engine.backend().phases.last(), Some(&"reconcile"));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn guarded_writer_reports_after_rename_as_durability_unknown() {
        let (root, request) = fixture();
        struct AfterRename;
        impl AtomicWriteFaultInjector for AfterRename {
            fn interrupt(&self, point: AtomicWriteFaultPoint) -> Result<(), AtomicWriteError> {
                if point == AtomicWriteFaultPoint::AfterRename {
                    Err(AtomicWriteError::FaultInjected(point))
                } else {
                    Ok(())
                }
            }
        }
        let result = atomic_write_with_pre_rename_validator_and_injector(
            &request.target_path,
            br#"{"type":"excalidraw","version":2,"elements":[{"id":"new"}]}"#,
            &|path| validate_expected_target(path, &request),
            &AfterRename,
        );
        assert!(matches!(
            result,
            Err(GuardedAtomicWriteError::PublishedButDurabilityUnknown {
                phase: AtomicWriteFaultPoint::AfterRename,
                ..
            })
        ));
        assert_ne!(
            fs::read(&request.target_path).expect("published bytes"),
            br#"{"type":"excalidraw","version":2,"elements":[]}"#
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[cfg(feature = "e2e-harness")]
    #[test]
    fn e2e_history_replacement_hooks_are_reached_at_real_boundaries() {
        use crate::e2e_harness::{
            history_fault_test_hits, history_fault_test_scope, HistoryFaultStage,
        };

        for stage in [
            HistoryFaultStage::ProtectionCommit,
            HistoryFaultStage::IntentCommit,
            HistoryFaultStage::AfterRenameBeforeParentSync,
            HistoryFaultStage::MetadataCompleteBeforeFrontendAck,
        ] {
            let scope = history_fault_test_scope(stage);
            let (root, request) = fixture();
            let old = fs::read(&request.target_path).expect("old");
            let backend = FakeBackend {
                path: request.target_path.clone(),
                old_bytes: old,
                ..Default::default()
            };
            let mut engine = ProtectedReplacementEngine::new(backend);
            let _ = engine.execute(request);
            assert_eq!(history_fault_test_hits(), vec![stage]);
            drop(scope);
            fs::remove_dir_all(root).expect("cleanup");
        }
    }
}
