use std::{
    ffi::OsString,
    fmt,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[cfg(any(test, feature = "e2e-harness"))]
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc, Barrier, Mutex, OnceLock,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AtomicWriteFaultPoint {
    TempCreated,
    MidWrite,
    TempSynced,
    JsonValidated,
    BeforeRename,
    AfterRename,
    BeforeParentSync,
    ParentSynced,
}

impl fmt::Display for AtomicWriteFaultPoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::TempCreated => "temp_created",
            Self::MidWrite => "mid_write",
            Self::TempSynced => "temp_synced",
            Self::JsonValidated => "json_validated",
            Self::BeforeRename => "before_rename",
            Self::AfterRename => "after_rename",
            Self::BeforeParentSync => "before_parent_sync",
            Self::ParentSynced => "parent_synced",
        };
        formatter.write_str(name)
    }
}

#[derive(Debug, Error)]
pub enum AtomicWriteError {
    #[error("atomic write {operation} failed for {path}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("temporary document is not valid JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[allow(dead_code, reason = "constructed only by test and e2e fault injectors")]
    #[error("atomic write interrupted at {0}")]
    FaultInjected(AtomicWriteFaultPoint),
    #[error("target path has no file name: {0}")]
    InvalidTarget(PathBuf),
}

pub trait AtomicWriteFaultInjector: Send + Sync {
    fn interrupt(&self, point: AtomicWriteFaultPoint) -> Result<(), AtomicWriteError>;
}

#[cfg(not(any(test, feature = "e2e-harness")))]
struct NoFault;

#[cfg(not(any(test, feature = "e2e-harness")))]
impl AtomicWriteFaultInjector for NoFault {
    fn interrupt(&self, _point: AtomicWriteFaultPoint) -> Result<(), AtomicWriteError> {
        Ok(())
    }
}

#[cfg(any(test, feature = "e2e-harness"))]
static CONFIGURED_FAULT_POINT: AtomicU8 = AtomicU8::new(0);

#[cfg(any(test, feature = "e2e-harness"))]
static INJECT_DISK_FULL: AtomicBool = AtomicBool::new(false);

#[cfg(any(test, feature = "e2e-harness"))]
static BEFORE_RENAME_BARRIER: OnceLock<Mutex<Option<Arc<Barrier>>>> = OnceLock::new();

#[cfg(feature = "e2e-harness")]
pub fn set_fault_point(point: Option<AtomicWriteFaultPoint>) {
    CONFIGURED_FAULT_POINT.store(point.map_or(0, fault_point_number), Ordering::SeqCst);
}

#[cfg(feature = "e2e-harness")]
pub fn clear_fault_point() {
    set_fault_point(None);
    INJECT_DISK_FULL.store(false, Ordering::SeqCst);
    set_before_rename_barrier(None);
}

#[cfg(feature = "e2e-harness")]
pub fn set_disk_full_fault(enabled: bool) {
    INJECT_DISK_FULL.store(enabled, Ordering::SeqCst);
}

#[cfg(feature = "e2e-harness")]
pub fn set_before_rename_barrier(participants: Option<usize>) {
    let barrier = participants.map(|count| Arc::new(Barrier::new(count)));
    *before_rename_barrier()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = barrier;
}

#[cfg(any(test, feature = "e2e-harness"))]
fn fault_point_number(point: AtomicWriteFaultPoint) -> u8 {
    match point {
        AtomicWriteFaultPoint::TempCreated => 1,
        AtomicWriteFaultPoint::MidWrite => 2,
        AtomicWriteFaultPoint::TempSynced => 3,
        AtomicWriteFaultPoint::JsonValidated => 4,
        AtomicWriteFaultPoint::BeforeRename => 5,
        AtomicWriteFaultPoint::AfterRename => 6,
        AtomicWriteFaultPoint::BeforeParentSync => 7,
        AtomicWriteFaultPoint::ParentSynced => 8,
    }
}

#[cfg(any(test, feature = "e2e-harness"))]
struct ConfiguredFault;

#[cfg(any(test, feature = "e2e-harness"))]
impl AtomicWriteFaultInjector for ConfiguredFault {
    fn interrupt(&self, point: AtomicWriteFaultPoint) -> Result<(), AtomicWriteError> {
        if point == AtomicWriteFaultPoint::MidWrite && INJECT_DISK_FULL.load(Ordering::SeqCst) {
            return Err(AtomicWriteError::Io {
                operation: "write remaining temporary segment",
                path: PathBuf::from("<e2e-injected-temporary-file>"),
                source: std::io::Error::from_raw_os_error(28),
            });
        }
        if point == AtomicWriteFaultPoint::BeforeRename {
            let barrier = before_rename_barrier()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            if let Some(barrier) = barrier {
                barrier.wait();
            }
        }
        if CONFIGURED_FAULT_POINT.load(Ordering::SeqCst) == fault_point_number(point) {
            return Err(AtomicWriteError::FaultInjected(point));
        }
        Ok(())
    }
}

#[cfg(any(test, feature = "e2e-harness"))]
fn before_rename_barrier() -> &'static Mutex<Option<Arc<Barrier>>> {
    BEFORE_RENAME_BARRIER.get_or_init(|| Mutex::new(None))
}

pub fn atomic_write(target: &Path, contents: &[u8]) -> Result<(), AtomicWriteError> {
    #[cfg(any(test, feature = "e2e-harness"))]
    {
        atomic_write_with_injector(target, contents, &ConfiguredFault)
    }

    #[cfg(not(any(test, feature = "e2e-harness")))]
    {
        atomic_write_with_injector(target, contents, &NoFault)
    }
}

pub fn atomic_write_with_injector(
    target: &Path,
    contents: &[u8],
    injector: &dyn AtomicWriteFaultInjector,
) -> Result<(), AtomicWriteError> {
    let parent = normalized_parent(target);
    let temp_path = unique_temp_path(target)?;
    let result = write_and_publish(target, &temp_path, parent, contents, injector);

    if result.is_err() {
        match fs::remove_file(&temp_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                // Preserve the causative write error. Startup cleanup can remove a file that
                // the operating system temporarily kept busy.
            }
        }
    }
    result
}

pub fn cleanup_atomic_write_temps(target: &Path) -> Result<usize, AtomicWriteError> {
    let parent = normalized_parent(target);
    let file_name = target
        .file_name()
        .ok_or_else(|| AtomicWriteError::InvalidTarget(target.to_path_buf()))?;
    let prefix = format!("{}.", file_name.to_string_lossy());
    let mut removed = 0;

    let entries =
        fs::read_dir(parent).map_err(|source| io_error("read parent directory", parent, source))?;
    for entry in entries {
        let entry = entry.map_err(|source| io_error("read parent entry", parent, source))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&prefix) && name.ends_with(".tmp") {
            fs::remove_file(entry.path())
                .map_err(|source| io_error("remove stale temporary file", &entry.path(), source))?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn write_and_publish(
    target: &Path,
    temp_path: &Path,
    parent: &Path,
    contents: &[u8],
    injector: &dyn AtomicWriteFaultInjector,
) -> Result<(), AtomicWriteError> {
    let mut temp = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp_path)
        .map_err(|source| io_error("create temporary file", temp_path, source))?;
    injector.interrupt(AtomicWriteFaultPoint::TempCreated)?;

    let split = contents.len().div_ceil(2);
    temp.write_all(&contents[..split])
        .map_err(|source| io_error("write first temporary segment", temp_path, source))?;
    injector.interrupt(AtomicWriteFaultPoint::MidWrite)?;
    temp.write_all(&contents[split..])
        .map_err(|source| io_error("write remaining temporary segment", temp_path, source))?;
    temp.flush()
        .map_err(|source| io_error("flush temporary file", temp_path, source))?;
    temp.sync_all()
        .map_err(|source| io_error("sync temporary file", temp_path, source))?;
    injector.interrupt(AtomicWriteFaultPoint::TempSynced)?;
    drop(temp);

    let mut persisted = Vec::with_capacity(contents.len());
    File::open(temp_path)
        .and_then(|mut file| file.read_to_end(&mut persisted))
        .map_err(|source| io_error("read temporary file", temp_path, source))?;
    serde_json::from_slice::<serde_json::Value>(&persisted)?;
    injector.interrupt(AtomicWriteFaultPoint::JsonValidated)?;
    injector.interrupt(AtomicWriteFaultPoint::BeforeRename)?;

    fs::rename(temp_path, target)
        .map_err(|source| io_error("rename temporary file", target, source))?;
    injector.interrupt(AtomicWriteFaultPoint::AfterRename)?;
    injector.interrupt(AtomicWriteFaultPoint::BeforeParentSync)?;

    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| io_error("sync parent directory", parent, source))?;
    injector.interrupt(AtomicWriteFaultPoint::ParentSynced)?;
    Ok(())
}

fn unique_temp_path(target: &Path) -> Result<PathBuf, AtomicWriteError> {
    let file_name = target
        .file_name()
        .ok_or_else(|| AtomicWriteError::InvalidTarget(target.to_path_buf()))?;
    let mut temp_name = OsString::from(file_name);
    temp_name.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    Ok(normalized_parent(target).join(temp_name))
}

fn normalized_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn io_error(operation: &'static str, path: &Path, source: std::io::Error) -> AtomicWriteError {
    AtomicWriteError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    }
}
