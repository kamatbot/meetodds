//! Local summary work yields to recording. This registry owns no credentials or meeting content.
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

static LOCAL: Lazy<Mutex<HashMap<String, CancellationToken>>> = Lazy::new(|| Mutex::new(HashMap::new()));
pub struct LocalSummaryLease { id: String }
pub fn register(id: &str, token: CancellationToken) -> Result<LocalSummaryLease, String> {
    let mut jobs = LOCAL.lock().map_err(|_| "Local inference state is unavailable".to_string())?;
    if jobs.contains_key(id) { return Err("A local summary is already running for this meeting".to_string()); }
    jobs.insert(id.to_string(), token);
    Ok(LocalSummaryLease { id: id.to_string() })
}
/// Called under the recorder's engine lifecycle lock before opening capture streams.
pub fn cancel_for_capture() -> usize {
    let tokens = LOCAL.lock().map(|jobs| jobs.values().cloned().collect::<Vec<_>>()).unwrap_or_default();
    for token in &tokens { token.cancel(); }
    tokens.len()
}
impl Drop for LocalSummaryLease {
    fn drop(&mut self) { if let Ok(mut jobs) = LOCAL.lock() { jobs.remove(&self.id); } }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_cancels_registered_local_work_without_erasing_ownership() {
        let id = format!("priority-test-{}", std::process::id());
        let token = CancellationToken::new();
        let lease = register(&id, token.clone()).unwrap();
        assert!(cancel_for_capture() >= 1); assert!(token.is_cancelled());
        assert!(register(&id, CancellationToken::new()).is_err());
        drop(lease);
        assert!(register(&id, CancellationToken::new()).is_ok());
    }
}
