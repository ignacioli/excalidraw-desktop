use excalidraw_desktop_lib::{
    commands::dto::{HistorySetMarkedRequest, HistorySetMarkedResponse},
    commands::error::{ErrorCode, IpcError},
    history::types::{
        validate_cursor, validate_hash, validate_identifier, validate_page_limit,
        validate_scene_json, HistoryChangeKind, HistoryChangedEvent, HistoryCurrentFileSaveOutcome,
        HistoryDocumentLocator, HistoryIssueEvent, HistoryIssueSource, HistoryOperationKind,
        HistoryOperationState, HistoryProtectedAction, HistoryReplaceResponse,
        HistoryReplaceTarget, HistoryVersionAvailability, HistoryVersionItem, HistoryVersionSource,
        HISTORY_MAX_CURSOR_LENGTH, HISTORY_MAX_IDENTIFIER_LENGTH, HISTORY_MAX_PAGE_LIMIT,
        HISTORY_MAX_PATH_LENGTH,
    },
};
use serde_json::{json, Value};

fn serialized<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value)
        .unwrap_or_else(|error| panic!("serialize history contract: {error}"))
}

#[test]
fn selected_mark_contract_is_camel_case_and_validated() {
    let request = HistorySetMarkedRequest {
        document: HistoryDocumentLocator::Handle {
            document_id: "document-1".to_owned(),
        },
        request_id: "request-1".to_owned(),
        version_id: "version-1".to_owned(),
        marked: true,
    };
    assert!(request.validate().is_ok());
    assert_eq!(
        serialized(request.clone()),
        json!({
            "document": {"kind": "handle", "documentId": "document-1"},
            "requestId": "request-1",
            "versionId": "version-1",
            "marked": true
        })
    );
    assert_eq!(
        serialized(HistorySetMarkedResponse {
            version_id: "version-1".to_owned(),
            marked: false,
            retained: false,
        }),
        json!({
            "versionId": "version-1", "marked": false, "retained": false
        })
    );
    assert!(HistorySetMarkedRequest {
        request_id: String::new(),
        ..request
    }
    .validate()
    .is_err());
}

#[test]
fn reserved_history_inputs_reject_boundary_and_control_values() {
    assert!(HistoryDocumentLocator::Path {
        path: "/workspace/drawing.excalidraw".to_owned(),
    }
    .validate()
    .is_ok());
    assert!(HistoryDocumentLocator::Handle {
        document_id: "document-1".to_owned(),
    }
    .validate()
    .is_ok());

    assert!(HistoryDocumentLocator::Path {
        path: String::new(),
    }
    .validate()
    .is_err());
    assert!(HistoryDocumentLocator::Path {
        path: "bad\0path".to_owned(),
    }
    .validate()
    .is_err());
    assert!(HistoryDocumentLocator::Path {
        path: "p".repeat(HISTORY_MAX_PATH_LENGTH + 1),
    }
    .validate()
    .is_err());

    assert!(validate_identifier("request-1", "requestId").is_ok());
    assert!(validate_identifier(&"i".repeat(HISTORY_MAX_IDENTIFIER_LENGTH), "requestId").is_ok());
    assert!(
        validate_identifier(&"i".repeat(HISTORY_MAX_IDENTIFIER_LENGTH + 1), "requestId").is_err()
    );
    assert!(validate_cursor(&"c".repeat(HISTORY_MAX_CURSOR_LENGTH)).is_ok());
    assert!(validate_cursor(&"c".repeat(HISTORY_MAX_CURSOR_LENGTH + 1)).is_err());
    assert!(validate_cursor("cursor\0value").is_err());

    assert!(validate_hash(&"0".repeat(64), "contentHash").is_ok());
    assert!(validate_hash(&"A".repeat(64), "contentHash").is_err());
    assert!(validate_hash(&"0".repeat(63), "contentHash").is_err());
    assert!(validate_hash(&format!("{}g", "0".repeat(63)), "contentHash").is_err());

    assert!(validate_scene_json("{}").is_ok());
    assert!(validate_scene_json("").is_err());
    assert!(validate_page_limit(None).is_ok());
    assert!(validate_page_limit(Some(1)).is_ok());
    assert!(validate_page_limit(Some(HISTORY_MAX_PAGE_LIMIT)).is_ok());
    assert!(validate_page_limit(Some(0)).is_err());
    assert!(validate_page_limit(Some(HISTORY_MAX_PAGE_LIMIT + 1)).is_err());
}

#[test]
fn reserved_history_wire_shapes_match_camel_case_typescript_contract() {
    assert_eq!(
        serialized(HistoryDocumentLocator::Path {
            path: "/workspace/drawing.excalidraw".to_owned(),
        }),
        json!({"kind": "path", "path": "/workspace/drawing.excalidraw"}),
    );
    assert_eq!(
        serialized(HistoryDocumentLocator::Handle {
            document_id: "document-1".to_owned(),
        }),
        json!({"kind": "handle", "documentId": "document-1"}),
    );

    let unavailable = IpcError {
        code: ErrorCode::HistoryResourceMissing,
        message: "A history resource is missing or corrupted.".to_owned(),
        retriable: false,
        context: None,
    };
    assert_eq!(
        serialized(HistoryVersionItem {
            version_id: "version-1".to_owned(),
            source: HistoryVersionSource::Protected,
            marked: true,
            protected_action: Some(HistoryProtectedAction::Restore),
            recorded_at: 123,
            sequence: 7,
            content_hash: "0".repeat(64),
            availability: HistoryVersionAvailability::Unavailable { error: unavailable },
        }),
        json!({
            "versionId": "version-1",
            "source": "protected",
            "marked": true,
            "protectedAction": "restore",
            "recordedAt": 123,
            "sequence": 7,
            "contentHash": "0000000000000000000000000000000000000000000000000000000000000000",
            "availability": {
                "status": "unavailable",
                "error": {
                    "code": "HISTORY_RESOURCE_MISSING",
                    "message": "A history resource is missing or corrupted.",
                    "retriable": false,
                },
            },
        }),
    );
    assert_eq!(
        serialized(HistoryVersionAvailability::Available),
        json!({"status": "available"}),
    );

    assert_eq!(
        serialized(HistoryChangedEvent {
            document_id: "document-1".to_owned(),
            request_id: None,
            list_revision: 12,
            change: HistoryChangeKind::Invalidated,
        }),
        json!({
            "documentId": "document-1",
            "listRevision": 12,
            "change": "invalidated",
        }),
    );
    assert_eq!(
        serialized(HistoryIssueEvent {
            document_id: "document-1".to_owned(),
            operation: Some(HistoryOperationKind::Replace),
            source: HistoryIssueSource::Reconciliation,
            error: IpcError {
                code: ErrorCode::HistoryOperationPending,
                message: "History operation is pending reconciliation.".to_owned(),
                retriable: true,
                context: None,
            },
            current_file_save_outcome: Some(HistoryCurrentFileSaveOutcome::Pending),
        }),
        json!({
            "documentId": "document-1",
            "operation": "replace",
            "source": "reconciliation",
            "error": {
                "code": "HISTORY_OPERATION_PENDING",
                "message": "History operation is pending reconciliation.",
                "retriable": true,
            },
            "currentFileSaveOutcome": "pending",
        }),
    );

    assert_eq!(
        serialized(HistoryReplaceTarget::Restore {
            version_id: "version-1".to_owned(),
        }),
        json!({"kind": "restore", "versionId": "version-1"}),
    );
    assert_eq!(
        serialized(HistoryReplaceTarget::Import {
            candidate_scene_json: "{}".to_owned(),
        }),
        json!({"kind": "import", "candidateSceneJson": "{}"}),
    );
    assert_eq!(
        serialized(HistoryReplaceTarget::Clear),
        json!({"kind": "clear"}),
    );
    assert_eq!(
        serialized(HistoryReplaceResponse::Completed {
            request_id: "request-1".to_owned(),
            replacement_committed: true,
            protection_version_id: "protection-1".to_owned(),
            adopted_scene: json!({"elements": []}),
            new_base_hash: "1".repeat(64),
            new_session_generation: 9,
        }),
        json!({
            "status": "completed",
            "requestId": "request-1",
            "replacementCommitted": true,
            "protectionVersionId": "protection-1",
            "adoptedScene": {"elements": []},
            "newBaseHash": "1111111111111111111111111111111111111111111111111111111111111111",
            "newSessionGeneration": 9,
        }),
    );
    assert_eq!(
        serialized(HistoryReplaceResponse::PendingReconciliation {
            request_id: "request-1".to_owned(),
            replacement_committed: None,
            operation_state: HistoryOperationState::PendingReconciliation,
        }),
        json!({
            "status": "pendingReconciliation",
            "requestId": "request-1",
            "replacementCommitted": null,
            "operationState": "pendingReconciliation",
        }),
    );
}
