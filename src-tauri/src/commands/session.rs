#![allow(
    dead_code,
    reason = "explicit session release is a lifecycle hook consumed by a later shutdown task"
)]

use std::{path::Path, sync::Mutex};

use tauri::State;

use crate::documents::session_lock::{SessionLock, SessionLockError};

use super::{
    dto::{AppHandshakeResponse, IPC_CONTRACT_VERSION},
    error::{AppError, IpcError},
};

pub struct SessionState {
    abnormal_exit: bool,
    pending_open_paths: Vec<String>,
    lock: Mutex<Option<SessionLock>>,
}

impl SessionState {
    pub fn initialize(
        app_data_directory: &Path,
        pending_open_paths: Vec<String>,
    ) -> Result<Self, AppError> {
        let lock = SessionLock::acquire(app_data_directory).map_err(session_lock_error)?;
        Ok(Self {
            abnormal_exit: lock.abnormal_exit(),
            pending_open_paths,
            lock: Mutex::new(Some(lock)),
        })
    }

    pub fn handshake(&self) -> AppHandshakeResponse {
        AppHandshakeResponse {
            contract_version: IPC_CONTRACT_VERSION,
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            abnormal_exit: self.abnormal_exit,
            pending_open_paths: self.pending_open_paths.clone(),
        }
    }

    pub fn release(&self) -> Result<(), AppError> {
        let lock = self
            .lock
            .lock()
            .map_err(|_| AppError::Internal("session lock mutex is poisoned".to_owned()))?
            .take();
        if let Some(lock) = lock {
            lock.release().map_err(session_lock_error)?;
        }
        Ok(())
    }
}

#[tauri::command]
pub fn app_handshake(state: State<'_, SessionState>) -> Result<AppHandshakeResponse, IpcError> {
    Ok(state.handshake())
}

fn session_lock_error(error: SessionLockError) -> AppError {
    match error {
        SessionLockError::CreateDirectory { path, source }
        | SessionLockError::Remove { path, source }
        | SessionLockError::SyncDirectory { path, source } => AppError::Io {
            path: Some(path),
            source,
        },
        SessionLockError::AtomicWrite(source) => source.into(),
        SessionLockError::InvalidSystemTime => {
            AppError::Internal("system clock is before Unix epoch".to_owned())
        }
        SessionLockError::Serialize(source) => AppError::Internal(source.to_string()),
    }
}
