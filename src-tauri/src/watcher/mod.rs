//! Filesystem watcher domain.
//!
//! Watches every mounted workspace root with `notify`, coalesces raw events
//! into a 200ms debounce window, verifies real changes with an
//! mtime/size/content-hash triplet, suppresses the app's own write echoes,
//! and forwards `file-changed` / `conflict-detected` events to the frontend
//! (plan data flow 2, FR-018/019/020, R7).

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, UNIX_EPOCH},
};

use notify::{EventKind, RecursiveMode, Watcher as _};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::{
    commands::{
        documents::ConflictRegistry,
        dto::{ConflictDetectedEvent, FileChangeKind, FileChangedEvent},
        error::AppError,
    },
    database::repository::{
        DraftRepository, FileIndexRepository, SqliteRepository, WorkspaceRecord,
        WorkspaceRepository,
    },
};

pub const DEBOUNCE_WINDOW_MS: u64 = 200;

/// The verification triplet used to distinguish a real external change from
/// the app's own atomic write echo (plan data flow 2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileTriplet {
    pub mtime: i64,
    pub size: i64,
    pub hash: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RawChangeKind {
    Created,
    Modified,
    Removed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PendingChange {
    kind: RawChangeKind,
    last_seen: Instant,
}

/// Coalesces raw notify events per path inside a fixed debounce window.
#[derive(Debug)]
pub(crate) struct DebounceEngine {
    window: Duration,
    pending: HashMap<PathBuf, PendingChange>,
}

impl DebounceEngine {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            pending: HashMap::new(),
        }
    }

    pub fn record(&mut self, path: PathBuf, kind: RawChangeKind, now: Instant) {
        let merged = self
            .pending
            .get(&path)
            .map(|pending| merge_kinds(pending.kind, kind))
            .unwrap_or(kind);
        self.pending.insert(
            path,
            PendingChange {
                kind: merged,
                last_seen: now,
            },
        );
    }

    /// Returns the per-path events whose last update is at least the debounce
    /// window old, and removes them from the pending buffer.
    pub fn drain_ready(&mut self, now: Instant) -> Vec<(PathBuf, RawChangeKind)> {
        let mut ready = Vec::new();
        self.pending.retain(|path, change| {
            if now.duration_since(change.last_seen) >= self.window {
                ready.push((path.clone(), change.kind));
                false
            } else {
                true
            }
        });
        ready
    }

    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }
}

fn merge_kinds(previous: RawChangeKind, incoming: RawChangeKind) -> RawChangeKind {
    match (previous, incoming) {
        (_, RawChangeKind::Removed) => RawChangeKind::Removed,
        (RawChangeKind::Removed, RawChangeKind::Created) => RawChangeKind::Modified,
        (RawChangeKind::Created, RawChangeKind::Modified) => RawChangeKind::Created,
        (_, kind) => kind,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ResolvedChangeKind {
    Created,
    Modified,
    Removed,
    Renamed { new_path: PathBuf },
}

/// Pairs a Remove and a Create in the same batch as a rename when they are the
/// only two events; anything else passes through unchanged.
pub(crate) fn resolve_batch(
    events: Vec<(PathBuf, RawChangeKind)>,
) -> Vec<(PathBuf, ResolvedChangeKind)> {
    if events.len() == 2 {
        let removed = events
            .iter()
            .find(|(_, kind)| *kind == RawChangeKind::Removed)
            .map(|(path, _)| path.clone());
        let created = events
            .iter()
            .find(|(_, kind)| *kind == RawChangeKind::Created)
            .map(|(path, _)| path.clone());
        if let (Some(old_path), Some(new_path)) = (removed, created) {
            if old_path != new_path {
                return vec![(old_path, ResolvedChangeKind::Renamed { new_path })];
            }
        }
    }
    events
        .into_iter()
        .map(|(path, kind)| {
            let resolved = match kind {
                RawChangeKind::Created => ResolvedChangeKind::Created,
                RawChangeKind::Modified => ResolvedChangeKind::Modified,
                RawChangeKind::Removed => ResolvedChangeKind::Removed,
            };
            (path, resolved)
        })
        .collect()
}

/// Tracks the last verified triplet per path so the app's own writes are not
/// reported as external changes.
#[derive(Debug, Default)]
pub(crate) struct KnownFileTable {
    entries: HashMap<PathBuf, FileTriplet>,
}

impl KnownFileTable {
    pub fn note(&mut self, path: &Path, triplet: FileTriplet) {
        self.entries.insert(path.to_path_buf(), triplet);
    }

    pub fn remove(&mut self, path: &Path) {
        self.entries.remove(path);
    }

    /// An unknown path is always a real change. An empty hash (an un-hashed
    /// index seed) falls back to the mtime/size pair.
    pub fn changed(&self, path: &Path, current: &FileTriplet) -> bool {
        match self.entries.get(path) {
            None => true,
            Some(known) if known.hash.is_empty() => {
                known.mtime != current.mtime || known.size != current.size
            }
            Some(known) => known != current,
        }
    }
}

#[derive(Clone)]
pub struct WatcherService {
    repository: Arc<SqliteRepository>,
    conflicts: ConflictRegistry,
    known: Arc<Mutex<KnownFileTable>>,
    tasks: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
}

#[derive(Clone)]
pub struct WatcherState {
    pub service: WatcherService,
}

impl WatcherState {
    pub fn new(service: WatcherService) -> Self {
        Self { service }
    }
}

impl WatcherService {
    pub fn new(repository: Arc<SqliteRepository>, conflicts: ConflictRegistry) -> Self {
        Self {
            repository,
            conflicts,
            known: Arc::new(Mutex::new(KnownFileTable::default())),
            tasks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Registers a recursive watcher for one workspace root and owns the
    /// notify handle inside a background task.
    pub async fn spawn_for_workspace(
        &self,
        workspace: WorkspaceRecord,
        app: AppHandle,
    ) -> Result<(), AppError> {
        let root = PathBuf::from(&workspace.root_path);
        let service = self.clone();
        let workspace_id = workspace.id.clone();
        let task = tokio::spawn(async move {
            if let Err(error) = service.run_workspace_watch(workspace, root, app).await {
                eprintln!("workspace watcher stopped: {error}");
            }
        });
        self.tasks.lock().await.insert(workspace_id, task);
        Ok(())
    }

    pub async fn start_existing(&self, app: AppHandle) -> Result<(), AppError> {
        let workspaces = self.repository.workspace_list().await?;
        for workspace in workspaces {
            self.spawn_for_workspace(workspace, app.clone()).await?;
        }
        Ok(())
    }

    pub async fn stop_for_workspace(&self, workspace_id: &str) {
        if let Some(task) = self.tasks.lock().await.remove(workspace_id) {
            task.abort();
        }
    }

    /// Called by the document commands after a successful atomic write so the
    /// watcher recognizes the resulting notify event as its own echo.
    pub async fn note_own_write(&self, path: PathBuf, mtime: i64, size: i64, hash: String) {
        self.known
            .lock()
            .await
            .note(&path, FileTriplet { mtime, size, hash });
    }

    async fn run_workspace_watch(
        &self,
        workspace: WorkspaceRecord,
        root: PathBuf,
        app: AppHandle,
    ) -> Result<(), AppError> {
        let (sender, mut receiver) =
            tokio::sync::mpsc::unbounded_channel::<(PathBuf, RawChangeKind)>();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                let Ok(event) = result else {
                    return;
                };
                if let Some(kind) = classify_event_kind(&event.kind) {
                    for path in event.paths {
                        let _ = sender.send((path, kind));
                    }
                }
            })
            .map_err(watcher_error)?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(watcher_error)?;

        self.seed_known(&workspace).await;
        let mut engine = DebounceEngine::new(Duration::from_millis(DEBOUNCE_WINDOW_MS));
        let mut tick = tokio::time::interval(Duration::from_millis(DEBOUNCE_WINDOW_MS));
        loop {
            tokio::select! {
                _ = tick.tick() => {
                    let ready = engine.drain_ready(Instant::now());
                    if !ready.is_empty() {
                        self.process_batch(&app, ready).await;
                    }
                }
                event = receiver.recv() => {
                    let Some((path, kind)) = event else { break };
                    engine.record(path, kind, Instant::now());
                }
            }
        }
        Ok(())
    }

    async fn seed_known(&self, workspace: &WorkspaceRecord) {
        let Ok(indexed) = self.repository.file_index_list(workspace.id.clone()).await else {
            return;
        };
        let mut known = self.known.lock().await;
        for record in indexed {
            known.note(
                Path::new(&record.canonical_path),
                FileTriplet {
                    mtime: record.mtime,
                    size: record.file_size,
                    hash: record.content_hash.unwrap_or_default(),
                },
            );
        }
    }

    async fn process_batch(&self, app: &AppHandle, events: Vec<(PathBuf, RawChangeKind)>) {
        for (path, kind) in resolve_batch(events) {
            self.process_change(app, &path, kind).await;
        }
    }

    async fn process_change(&self, app: &AppHandle, path: &Path, kind: ResolvedChangeKind) {
        match kind {
            ResolvedChangeKind::Renamed { new_path } => {
                let (mtime, content_hash) = match read_triplet(&new_path) {
                    Ok(triplet) => {
                        self.known.lock().await.remove(path);
                        self.known.lock().await.note(&new_path, triplet.clone());
                        (Some(triplet.mtime), Some(triplet.hash))
                    }
                    _ => (None, None),
                };
                let _ = app.emit(
                    "file-changed",
                    FileChangedEvent {
                        path: path.display().to_string(),
                        change: FileChangeKind::Renamed,
                        new_path: Some(new_path.display().to_string()),
                        mtime,
                        content_hash,
                    },
                );
            }
            ResolvedChangeKind::Removed => {
                let removed = match self.current_triplet(path) {
                    Ok(_) => !path.exists(),
                    Err(_) => true,
                };
                if !removed {
                    self.process_modified(app, path, RawChangeKind::Modified, false)
                        .await;
                    return;
                }
                self.known.lock().await.remove(path);
                self.conflicts.clear_conflicted(path).await;
                let _ = app.emit(
                    "file-changed",
                    FileChangedEvent {
                        path: path.display().to_string(),
                        change: FileChangeKind::Removed,
                        new_path: None,
                        mtime: None,
                        content_hash: None,
                    },
                );
            }
            ResolvedChangeKind::Created | ResolvedChangeKind::Modified => {
                let raw = match kind {
                    ResolvedChangeKind::Created => RawChangeKind::Created,
                    _ => RawChangeKind::Modified,
                };
                self.process_modified(app, path, raw, true).await;
            }
        }
    }

    async fn process_modified(
        &self,
        app: &AppHandle,
        path: &Path,
        raw_kind: RawChangeKind,
        emit_removed_when_missing: bool,
    ) {
        let triplet = match self.current_triplet(path) {
            Ok(triplet) => triplet,
            Err(_) => {
                if emit_removed_when_missing {
                    self.known.lock().await.remove(path);
                    self.conflicts.clear_conflicted(path).await;
                    let _ = app.emit(
                        "file-changed",
                        FileChangedEvent {
                            path: path.display().to_string(),
                            change: FileChangeKind::Removed,
                            new_path: None,
                            mtime: None,
                            content_hash: None,
                        },
                    );
                }
                return;
            }
        };

        {
            let mut known = self.known.lock().await;
            if !known.changed(path, &triplet) {
                return;
            }
            known.note(path, triplet.clone());
        }

        let change = match raw_kind {
            RawChangeKind::Created => FileChangeKind::Created,
            _ => FileChangeKind::Modified,
        };
        let path_string = path.display().to_string();
        let _ = app.emit(
            "file-changed",
            FileChangedEvent {
                path: path_string.clone(),
                change,
                new_path: None,
                mtime: Some(triplet.mtime),
                content_hash: Some(triplet.hash.clone()),
            },
        );

        // A modified file with a dirty draft is a pending conflict: block
        // automatic persistence until the user decides (data-model invariant 2).
        if change == FileChangeKind::Modified {
            if let Ok(Some(draft)) = self.repository.draft_get(path_string.clone()).await {
                if draft.is_dirty {
                    self.conflicts.mark_conflicted(path.to_path_buf()).await;
                    let _ = app.emit(
                        "conflict-detected",
                        ConflictDetectedEvent {
                            path: path_string,
                            external_mtime: triplet.mtime,
                            local_draft_updated_at: draft.updated_at,
                        },
                    );
                }
            }
        }
    }

    fn current_triplet(&self, path: &Path) -> Result<FileTriplet, AppError> {
        read_triplet(path)
    }
}

fn classify_event_kind(kind: &EventKind) -> Option<RawChangeKind> {
    match kind {
        EventKind::Create(_) => Some(RawChangeKind::Created),
        EventKind::Remove(_) => Some(RawChangeKind::Removed),
        EventKind::Modify(_) => Some(RawChangeKind::Modified),
        EventKind::Any | EventKind::Other | EventKind::Access(_) => None,
    }
}

fn watcher_error(error: notify::Error) -> AppError {
    AppError::Internal(format!("file watcher failed: {error}"))
}

pub(crate) fn read_triplet(path: &Path) -> Result<FileTriplet, AppError> {
    let metadata = fs::metadata(path).map_err(|source| AppError::Io {
        path: Some(path.to_path_buf()),
        source,
    })?;
    let mtime = metadata
        .modified()
        .map_err(|source| AppError::Io {
            path: Some(path.to_path_buf()),
            source,
        })?
        .duration_since(UNIX_EPOCH)
        .map_err(|error| AppError::Internal(format!("file mtime predates Unix epoch: {error}")))?
        .as_secs() as i64;
    let size = metadata.len() as i64;
    let bytes = fs::read(path).map_err(|source| AppError::Io {
        path: Some(path.to_path_buf()),
        source,
    })?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    Ok(FileTriplet { mtime, size, hash })
}

#[cfg(test)]
mod watcher_test;
