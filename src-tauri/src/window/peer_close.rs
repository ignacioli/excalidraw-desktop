//! "Close it and open here": a window asks the window whose Workspace lies
//! inside the folder it wants to close, then opens the folder once that
//! window is gone. Each request waits here until the target window is
//! destroyed or reports that its close failed.

use std::sync::{Mutex, MutexGuard};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerCloseRequest {
    pub request_id: String,
    /// The window that opens the folder.
    pub initiator: String,
    /// The window asked to close.
    pub target: String,
    pub root_path: String,
}

#[derive(Default)]
pub struct PeerCloseRequests {
    pending: Mutex<Vec<PeerCloseRequest>>,
}

impl PeerCloseRequests {
    fn lock(&self) -> MutexGuard<'_, Vec<PeerCloseRequest>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn begin(&self, request: PeerCloseRequest) {
        self.lock().push(request);
    }

    /// The requests answered by `target` being destroyed.
    pub fn take_for_target(&self, target: &str) -> Vec<PeerCloseRequest> {
        let mut pending = self.lock();
        let (taken, kept) = pending
            .drain(..)
            .partition(|request| request.target == target);
        *pending = kept;
        taken
    }

    /// The request `target` failed to close for. Another window cannot
    /// answer a request it was not asked.
    pub fn take(&self, request_id: &str, target: &str) -> Option<PeerCloseRequest> {
        let mut pending = self.lock();
        let index = pending
            .iter()
            .position(|request| request.request_id == request_id && request.target == target)?;
        Some(pending.remove(index))
    }

    /// Forget requests from a window that is gone.
    pub fn drop_initiator(&self, initiator: &str) {
        self.lock().retain(|request| request.initiator != initiator);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str, initiator: &str, target: &str) -> PeerCloseRequest {
        PeerCloseRequest {
            request_id: id.to_owned(),
            initiator: initiator.to_owned(),
            target: target.to_owned(),
            root_path: "/d".to_owned(),
        }
    }

    #[test]
    fn a_destroyed_target_answers_only_its_own_requests() {
        let requests = PeerCloseRequests::default();
        requests.begin(request("r1", "window-1", "window-2"));
        requests.begin(request("r2", "window-3", "window-4"));

        assert_eq!(
            requests.take_for_target("window-2"),
            vec![request("r1", "window-1", "window-2")]
        );
        assert!(requests.take_for_target("window-2").is_empty());
        assert_eq!(
            requests.take_for_target("window-4"),
            vec![request("r2", "window-3", "window-4")]
        );
    }

    #[test]
    fn only_the_asked_window_reports_a_failed_close() {
        let requests = PeerCloseRequests::default();
        requests.begin(request("r1", "window-1", "window-2"));

        assert_eq!(requests.take("r1", "window-3"), None);
        assert_eq!(
            requests.take("r1", "window-2"),
            Some(request("r1", "window-1", "window-2"))
        );
        assert_eq!(requests.take("r1", "window-2"), None);
        assert!(requests.take_for_target("window-2").is_empty());
    }

    #[test]
    fn requests_from_a_destroyed_initiator_are_forgotten() {
        let requests = PeerCloseRequests::default();
        requests.begin(request("r1", "window-1", "window-2"));
        requests.drop_initiator("window-1");

        assert!(requests.take_for_target("window-2").is_empty());
    }
}
