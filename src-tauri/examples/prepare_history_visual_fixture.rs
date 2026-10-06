//! Prepare synthetic History data without starting Tauri or touching a user profile.

use std::{
    env, fs, io,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use excalidraw_desktop_lib::{
    commands::{
        documents::DocumentService,
        dto::{HistoryListRequest, HistoryPreviewRequest, PathRequest, WorkspaceAddRequest},
        error::ErrorCode,
        workspace::WorkspaceService,
    },
    database::repository::SqliteRepository,
    history::{
        query::HistoryQueryService,
        repository::{HistoryRepository, PublishSceneRequest},
        store::HistoryStore,
        types::{HistoryDocumentLocator, HistoryVersionAvailability, HistoryVersionSource},
        validation::HISTORY_OBJECT_SCHEMA_VERSION,
    },
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const VERSION_COUNT: usize = 50;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os();
    let _program = args.next();
    let first = args.next().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "usage: prepare_history_visual_fixture <new-absolute-temp-root> | refresh-pending <existing-root>",
        )
    })?;
    if first == "refresh-pending" {
        let requested_root = args
            .next()
            .ok_or_else(|| io::Error::other("existing root is required"))?;
        if args.next().is_some() {
            return Err(io::Error::other("unexpected extra argument").into());
        }
        println!(
            "{}",
            serde_json::to_string_pretty(&refresh_pending(Path::new(&requested_root))?)?
        );
        return Ok(());
    }
    let requested_root = first;
    if args.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected exactly one root argument",
        )
        .into());
    }
    let root = validate_new_root(Path::new(&requested_root))?;
    fs::create_dir(&root)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let manifest = runtime.block_on(prepare(&root))?;
    fs::write(
        root.join("fixture-manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&manifest)?);
    Ok(())
}

fn validate_existing_fixture_path(root: &Path, target: &Path) -> io::Result<()> {
    if !target.starts_with(root)
        || target == root
        || target
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "fixture path escapes its root",
        ));
    }
    let mut checked = root.to_path_buf();
    for part in target
        .strip_prefix(root)
        .map_err(io::Error::other)?
        .components()
    {
        checked.push(part);
        if fs::symlink_metadata(&checked)?.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "fixture path contains a symbolic link",
            ));
        }
    }
    Ok(())
}

fn refresh_pending(requested: &Path) -> Result<Value, Box<dyn std::error::Error>> {
    // Reuse the new-root validator's parent/temp checks without deleting or
    // replacing the existing root. Existing roots must be canonical directories.
    if validate_new_root(requested)
        .err()
        .is_none_or(|error| error.kind() != io::ErrorKind::AlreadyExists)
        || fs::symlink_metadata(requested)?.file_type().is_symlink()
        || requested.canonicalize()? != requested
        || !requested.is_dir()
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refresh requires a canonical existing synthetic temporary root",
        )
        .into());
    }
    let manifest_path = requested.join("fixture-manifest.json");
    validate_existing_fixture_path(requested, &manifest_path)?;
    let manifest: Value = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    let app_data = requested.join("home/Library/Application Support/excalidraw-desktop");
    let current_file = requested.join("workspace/History pending issue.excalidraw");
    let field_matches = |key: &str, expected: &Path| manifest[key].as_str() == expected.to_str();
    if !field_matches("root", requested)
        || !field_matches("profileHome", &requested.join("home"))
        || !field_matches("appDataDirectory", &app_data)
        || !field_matches("workspace", &requested.join("workspace"))
        || manifest["nativeVerified"] != false
        || manifest["documents"]["pendingIssue"]["currentFile"].as_str() != current_file.to_str()
    {
        return Err(io::Error::other("manifest is not the declared synthetic fixture").into());
    }
    // Validate the complete History tree before opening the store: it can
    // access WAL/object files as well as the declared main SQLite path.
    validate_existing_fixture_path(requested, &app_data)?;
    validate_existing_fixture_path(requested, &current_file)?;
    validate_no_symlinks(&app_data)?;
    let scene: Value = serde_json::from_slice(&fs::read(&current_file)?)?;
    if scene["type"] != "excalidraw" {
        return Err(io::Error::other("pending drawing is invalid").into());
    }
    let history_database = PathBuf::from(
        manifest["historyDatabase"]
            .as_str()
            .ok_or_else(|| io::Error::other("history database is missing"))?,
    );
    validate_existing_fixture_path(requested, &history_database)?;
    let store = HistoryStore::open(&app_data)?;
    if store.database_path() != history_database {
        return Err(io::Error::other("history database path mismatch").into());
    }
    let identity = store
        .load_active_document_identity(&current_file.display().to_string())?
        .ok_or_else(|| io::Error::other("pending drawing has no active History identity"))?;
    if manifest["documents"]["pendingIssue"]["documentId"].as_str()
        != Some(identity.document_id.as_str())
    {
        return Err(
            io::Error::other("pending drawing identity differs from fixture manifest").into(),
        );
    }
    let recorded_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
    store.record_maintenance_issue(
        &identity.document_id,
        "fixture_pending",
        "fixture_preparation",
        recorded_at,
    )?;
    Ok(
        json!({"root": requested, "documentId": identity.document_id, "currentFile": current_file,
        "backendSeeded": true, "nativeVerified": false,
        "nextStep": "Reopen Version History, then run native-macos-validation readiness. A later Save can clear this synthetic pending issue."}),
    )
}

fn validate_no_symlinks(directory: &Path) -> io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "fixture History tree contains a symbolic link",
            ));
        }
        if kind.is_dir() {
            validate_no_symlinks(&entry.path())?;
        }
    }
    Ok(())
}

fn validate_new_root(requested: &Path) -> io::Result<PathBuf> {
    if !requested.is_absolute()
        || requested
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "root must be an absolute path without . or ..",
        ));
    }
    let parent = requested.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "root must have a parent directory",
        )
    })?;
    let canonical_parent = parent.canonicalize()?;
    let canonical_temp = env::temp_dir().canonicalize()?;
    #[cfg(target_os = "macos")]
    if !canonical_temp.starts_with("/private/var/folders")
        && !canonical_temp.starts_with("/private/tmp")
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "TMPDIR must resolve inside a macOS system temporary directory",
        ));
    }
    if !canonical_parent.starts_with(&canonical_temp) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "root must be beneath the system temporary directory",
        ));
    }
    // A caller-provided symlink (including an empty symlinked directory) must
    // never redirect fixture writes into another profile.
    let mut checked = canonical_temp.clone();
    for component in canonical_parent
        .strip_prefix(&canonical_temp)
        .map_err(io::Error::other)?
        .components()
    {
        checked.push(component);
        if fs::symlink_metadata(&checked)?.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "root parent contains a symbolic link",
            ));
        }
    }
    match fs::symlink_metadata(requested) {
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "root already exists; choose a new path",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let name = requested.file_name().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "root must have a name")
            })?;
            Ok(canonical_parent.join(name))
        }
        Err(error) => Err(error),
    }
}

async fn prepare(root: &Path) -> Result<Value, Box<dyn std::error::Error>> {
    let home = root.join("home");
    let app_data = home.join("Library/Application Support/excalidraw-desktop");
    let workspace = root.join("workspace");
    fs::create_dir_all(&app_data)?;
    fs::create_dir(&workspace)?;
    let database = app_data.join("excalidraw-desktop.sqlite3");
    let repository = Arc::new(SqliteRepository::open(&database).await?);
    let store = Arc::new(HistoryStore::open(&app_data)?);
    let workspace_record = WorkspaceService::new(Arc::clone(&repository))
        .add(WorkspaceAddRequest {
            root_path: workspace.display().to_string(),
            name: Some("Synthetic History Fixture".to_owned()),
        })
        .await
        .map_err(ipc_error)?;

    let current_file = workspace.join("History long list.excalidraw");
    let current_bytes = scene_bytes(VERSION_COUNT)?;
    fs::write(&current_file, &current_bytes)?;
    let mut documents = DocumentService::new(Arc::clone(&repository));
    documents.attach_history_store(Arc::clone(&store));
    documents
        .doc_open(PathRequest {
            path: current_file.display().to_string(),
        })
        .await
        .map_err(ipc_error)?;
    let current_path = current_file.canonicalize()?.display().to_string();
    let identity = store
        .load_active_document_identity(&current_path)?
        .ok_or_else(|| io::Error::other("document open did not establish History identity"))?;
    let recorded_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
    let history = HistoryRepository::new(&store);
    for number in 1..=VERSION_COUNT {
        let scene_bytes = scene_bytes(number)?;
        let (published, reused) = history.mark_current_scene_with_assets(
            PublishSceneRequest {
                version_id: Uuid::new_v4().to_string(),
                document_id: identity.document_id.clone(),
                scene_bytes,
                schema_version: i64::from(HISTORY_OBJECT_SCHEMA_VERSION),
                source: HistoryVersionSource::Manual,
                protected_action: None,
                recorded_at: recorded_at - (VERSION_COUNT - number) as i64,
                sequence: number as u64,
            },
            Vec::new(),
        )?;
        if reused || !published.evicted_version_ids.is_empty() {
            return Err(
                io::Error::other("manual marked History version was reused or evicted").into(),
            );
        }
    }

    let query = HistoryQueryService::new(Arc::clone(&repository), Some(Arc::clone(&store)));
    let locator = HistoryDocumentLocator::Path {
        path: current_path.clone(),
    };
    let first = query
        .list(HistoryListRequest {
            document: locator.clone(),
            cursor: None,
            limit: Some(25),
        })
        .await
        .map_err(ipc_error)?;
    let second = query
        .list(HistoryListRequest {
            document: locator.clone(),
            cursor: first.next_cursor.clone(),
            limit: Some(25),
        })
        .await
        .map_err(ipc_error)?;
    if first.document_id != identity.document_id
        || first.items.len() != 25
        || second.items.len() != 25
        || first.next_cursor.is_none()
        || second.next_cursor.is_some()
        || first.pending_issue.is_some()
        || second.pending_issue.is_some()
    {
        return Err(io::Error::other(
            "History pagination did not return exactly 50 healthy versions",
        )
        .into());
    }
    let items = first.items.iter().chain(&second.items).collect::<Vec<_>>();
    let mut hashes = std::collections::HashSet::new();
    for item in &items {
        if item.source != HistoryVersionSource::Manual
            || !item.marked
            || !matches!(item.availability, HistoryVersionAvailability::Available)
            || !hashes.insert(item.content_hash.clone())
        {
            return Err(io::Error::other(
                "History list contains an unavailable, unmarked, or duplicate version",
            )
            .into());
        }
    }
    for index in [0, VERSION_COUNT / 2, VERSION_COUNT - 1] {
        let preview = query
            .preview(HistoryPreviewRequest {
                document: locator.clone(),
                version_id: items[index].version_id.clone(),
            })
            .await
            .map_err(ipc_error)?;
        if preview
            .scene
            .get("elements")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
        {
            return Err(
                io::Error::other("History preview did not hydrate a readable scene").into(),
            );
        }
    }

    let pending_file = workspace.join("History pending issue.excalidraw");
    fs::write(&pending_file, scene_bytes(VERSION_COUNT + 1)?)?;
    documents
        .doc_open(PathRequest {
            path: pending_file.display().to_string(),
        })
        .await
        .map_err(ipc_error)?;
    let pending_path = pending_file.canonicalize()?.display().to_string();
    let pending_identity = store
        .load_active_document_identity(&pending_path)?
        .ok_or_else(|| io::Error::other("pending document has no History identity"))?;
    store.record_maintenance_issue(
        &pending_identity.document_id,
        "fixture_pending",
        "fixture_preparation",
        recorded_at,
    )?;
    let pending_list = query
        .list(HistoryListRequest {
            document: HistoryDocumentLocator::Path {
                path: pending_path.clone(),
            },
            cursor: None,
            limit: Some(25),
        })
        .await
        .map_err(ipc_error)?;
    let pending_issue = pending_list
        .pending_issue
        .ok_or_else(|| io::Error::other("maintenance issue is absent from History list"))?;
    if pending_list.document_id != pending_identity.document_id
        || !pending_list.items.is_empty()
        || pending_issue.code != ErrorCode::HistoryOperationPending
    {
        return Err(io::Error::other("pending issue document did not query as expected").into());
    }

    let unavailable_file = workspace.join("History unavailable version.excalidraw");
    let unavailable_bytes = scene_bytes(VERSION_COUNT + 2)?;
    fs::write(&unavailable_file, &unavailable_bytes)?;
    documents
        .doc_open(PathRequest {
            path: unavailable_file.display().to_string(),
        })
        .await
        .map_err(ipc_error)?;
    let unavailable_path = unavailable_file.canonicalize()?.display().to_string();
    let unavailable_identity = store
        .load_active_document_identity(&unavailable_path)?
        .ok_or_else(|| io::Error::other("unavailable document has no History identity"))?;
    let unavailable_version = history.publish_scene(PublishSceneRequest {
        version_id: Uuid::new_v4().to_string(),
        document_id: unavailable_identity.document_id.clone(),
        scene_bytes: unavailable_bytes,
        schema_version: i64::from(HISTORY_OBJECT_SCHEMA_VERSION),
        source: HistoryVersionSource::Manual,
        protected_action: None,
        recorded_at,
        sequence: 1,
    })?;
    if hashes.contains(&unavailable_version.scene_hash) {
        return Err(
            io::Error::other("unavailable scene shares an object with the healthy list").into(),
        );
    }
    let scene_object = store
        .objects()
        .scene_path(&unavailable_version.scene_hash)?;
    let quarantine = root.join("quarantine");
    fs::create_dir(&quarantine)?;
    let quarantined_scene = quarantine.join(format!("{}.scene", unavailable_version.scene_hash));
    fs::rename(&scene_object, &quarantined_scene)?;
    let unavailable_locator = HistoryDocumentLocator::Path {
        path: unavailable_path.clone(),
    };
    let unavailable_list = query
        .list(HistoryListRequest {
            document: unavailable_locator.clone(),
            cursor: None,
            limit: Some(25),
        })
        .await
        .map_err(ipc_error)?;
    if unavailable_list.document_id != unavailable_identity.document_id
        || unavailable_list.items.len() != 1
        || unavailable_list.items[0].version_id != unavailable_version.version_id
        || !matches!(
            &unavailable_list.items[0].availability,
            HistoryVersionAvailability::Unavailable { .. }
        )
        || unavailable_list.pending_issue.is_some()
    {
        return Err(io::Error::other("quarantined version did not query as unavailable").into());
    }
    let preview_error = match query
        .preview(HistoryPreviewRequest {
            document: unavailable_locator,
            version_id: unavailable_version.version_id.clone(),
        })
        .await
    {
        Ok(_) => return Err(io::Error::other("quarantined scene unexpectedly hydrated").into()),
        Err(error) => error,
    };
    if preview_error.code != ErrorCode::HistoryResourceMissing {
        return Err(io::Error::other("quarantined preview returned the wrong error").into());
    }
    let healthy_after_quarantine = query
        .list(HistoryListRequest {
            document: locator,
            cursor: None,
            limit: Some(VERSION_COUNT as u16),
        })
        .await
        .map_err(ipc_error)?;
    if healthy_after_quarantine.items.len() != VERSION_COUNT
        || healthy_after_quarantine
            .items
            .iter()
            .any(|item| !matches!(item.availability, HistoryVersionAvailability::Available))
    {
        return Err(io::Error::other("quarantine affected the healthy History list").into());
    }

    Ok(json!({
        "scenarios": ["history-long-list-and-preview", "history-pending-issue", "history-unavailable-version"],
        "root": root,
        "profileHome": home,
        "appDataDirectory": app_data,
        "database": database,
        "historyDatabase": store.database_path(),
        "workspaceId": workspace_record.id,
        "workspace": workspace,
        "currentFile": current_path,
        "currentFileSha256": format!("{:x}", Sha256::digest(&current_bytes)),
        "documentId": identity.document_id,
        "versionCount": items.len(),
        "markedVersionCount": items.len(),
        "previewReadbackCount": 3,
        "documents": {
            "longList": {"documentId": identity.document_id, "currentFile": current_path, "versionCount": items.len(), "markedVersionCount": items.len()},
            "pendingIssue": {"documentId": pending_identity.document_id, "currentFile": pending_path, "versionCount": 0, "pendingIssueCode": pending_issue.code},
            "unavailable": {"documentId": unavailable_identity.document_id, "currentFile": unavailable_path, "versionCount": 1, "versionId": unavailable_version.version_id, "sceneHash": unavailable_version.scene_hash, "availability": "unavailable", "previewErrorCode": preview_error.code, "quarantinedScene": quarantined_scene}
        },
        "nativeVerified": false
    }))
}

fn scene_bytes(number: usize) -> Result<Vec<u8>, serde_json::Error> {
    let label = format!("历史版本 {number:02}");
    serde_json::to_vec(&json!({
        "type": "excalidraw",
        "version": 2,
        "elements": [{
            "id": format!("history-text-{number:02}"),
            "type": "text",
            "x": 80,
            "y": 100,
            "width": 260,
            "height": 36,
            "angle": 0,
            "strokeColor": "#1e1e1e",
            "backgroundColor": "transparent",
            "fillStyle": "solid",
            "strokeWidth": 1,
            "strokeStyle": "solid",
            "roughness": 0,
            "opacity": 100,
            "groupIds": [],
            "frameId": null,
            "roundness": null,
            "seed": number,
            "version": 1,
            "versionNonce": number,
            "isDeleted": false,
            "boundElements": null,
            "updated": 1,
            "link": null,
            "locked": false,
            "text": label,
            "originalText": label,
            "fontSize": 24,
            "fontFamily": 1,
            "textAlign": "left",
            "verticalAlign": "top",
            "containerId": null,
            "autoResize": false,
            "lineHeight": 1.25
        }],
        "appState": { "viewBackgroundColor": "#ffffff" },
        "files": {}
    }))
}

fn ipc_error(error: excalidraw_desktop_lib::commands::error::IpcError) -> io::Error {
    io::Error::other(format!("History API rejected synthetic fixture: {error:?}"))
}

#[cfg(test)]
mod tests {
    use super::{prepare, refresh_pending, validate_existing_fixture_path, validate_new_root};
    use std::{fs, io, path::PathBuf};
    use uuid::Uuid;

    fn test_path() -> PathBuf {
        std::env::temp_dir().join(format!("history-fixture-root-test-{}", Uuid::new_v4()))
    }

    #[test]
    fn refuses_existing_nonempty_root() -> io::Result<()> {
        let root = test_path();
        fs::create_dir(&root)?;
        fs::write(root.join("owned-marker"), b"owned")?;
        assert_eq!(
            validate_new_root(&root).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        fs::remove_file(root.join("owned-marker"))?;
        fs::remove_dir(root)
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_root() -> io::Result<()> {
        use std::os::unix::fs::symlink;
        let target = test_path();
        let link = test_path();
        fs::create_dir(&target)?;
        symlink(&target, &link)?;
        assert_eq!(
            validate_new_root(&link).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        fs::remove_file(link)?;
        fs::remove_dir(target)
    }

    #[test]
    fn refuses_path_outside_system_temp() {
        let outside = PathBuf::from("/Users/history-fixture-must-not-write");
        assert_eq!(
            validate_new_root(&outside).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[tokio::test]
    async fn refreshes_only_the_manifest_bound_synthetic_pending_identity(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let root = validate_new_root(&test_path())?;
        fs::create_dir(&root)?;
        let manifest = prepare(&root).await?;
        fs::write(
            root.join("fixture-manifest.json"),
            serde_json::to_vec(&manifest)?,
        )?;
        let result = refresh_pending(&root)?;
        assert_eq!(result["nativeVerified"], false);
        assert_eq!(
            result["documentId"],
            manifest["documents"]["pendingIssue"]["documentId"]
        );
        let mut forged = manifest;
        forged["documents"]["pendingIssue"]["documentId"] = serde_json::json!("wrong-identity");
        fs::write(
            root.join("fixture-manifest.json"),
            serde_json::to_vec(&forged)?,
        )?;
        assert!(refresh_pending(&root)
            .unwrap_err()
            .to_string()
            .contains("identity differs"));
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn rejects_internal_symlink_escape_before_refresh_writes() -> io::Result<()> {
        use std::os::unix::fs::symlink;
        let root = validate_new_root(&test_path())?;
        fs::create_dir(&root)?;
        symlink(std::env::temp_dir(), root.join("home"))?;
        assert_eq!(
            validate_existing_fixture_path(&root, &root.join("home"))
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        fs::remove_file(root.join("home"))?;
        fs::remove_dir(root)
    }
}
