//! Native ownership of a meeting's summary job survives view navigation/remounts.
use once_cell::sync::Lazy;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

type Jobs = Arc<Mutex<HashSet<String>>>;
static JOBS: Lazy<Jobs> = Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

pub struct SummaryLease { meeting_id: String, jobs: Jobs }
impl SummaryLease {
    pub fn acquire(meeting_id: &str) -> Result<Self, String> { Self::acquire_from(JOBS.clone(), meeting_id) }
    fn acquire_from(jobs: Jobs, meeting_id: &str) -> Result<Self, String> {
        if meeting_id.trim().is_empty() { return Err("A meeting is required for summary generation".to_string()); }
        {
            let mut active = jobs.lock().map_err(|_| "Summary job state is unavailable. Restart MeetOdds before retrying.".to_string())?;
            if !active.insert(meeting_id.to_string()) {
                return Err("A summary is already running for this meeting. Reopen it to check progress or cancel the existing job.".to_string());
            }
        }
        Ok(Self { meeting_id: meeting_id.to_string(), jobs })
    }
}
impl Drop for SummaryLease {
    fn drop(&mut self) {
        if let Ok(mut active) = self.jobs.lock() { active.remove(&self.meeting_id); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn jobs() -> Jobs { Arc::new(Mutex::new(HashSet::new())) }
    #[test]
    fn a_duplicate_cannot_replace_the_active_job() {
        let jobs = jobs(); let _first = SummaryLease::acquire_from(jobs.clone(), "a").unwrap();
        assert!(SummaryLease::acquire_from(jobs.clone(), "a").is_err());
        assert!(SummaryLease::acquire_from(jobs, "b").is_ok());
    }
    #[test]
    fn completion_or_early_error_releases_the_meeting() {
        let jobs = jobs();
        let lease = SummaryLease::acquire_from(jobs.clone(), "a").unwrap(); drop(lease);
        assert!(SummaryLease::acquire_from(jobs, "a").is_ok());
    }
    #[test]
    fn empty_ids_are_rejected_without_leaking_a_lease() {
        let jobs = jobs(); assert!(SummaryLease::acquire_from(jobs.clone(), " ").is_err());
        assert!(jobs.lock().unwrap().is_empty());
    }
    #[test]
    fn only_one_competing_thread_acquires_the_same_meeting() {
        let jobs = jobs();
        let acquired = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..12).map(|_| {
                let jobs = jobs.clone();
                scope.spawn(move || SummaryLease::acquire_from(jobs, "same-meeting").ok())
            }).collect();
            // Keep successful leases alive until all contenders have completed.
            handles.into_iter().filter_map(|handle| handle.join().unwrap()).collect::<Vec<_>>()
        });
        assert_eq!(acquired.len(), 1);
    }
}
