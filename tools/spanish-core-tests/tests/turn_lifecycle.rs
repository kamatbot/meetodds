//! Cancellation and failure tests use synthetic speech text, never a model.
use spanish_core::tutor::{CallKind, Diagnostic, EventSink, Model, ModelFuture, Prompt, TutorEngine, TutorError, TutorReplyEvent, TutorRequest};
use spanish_core::{Level, SessionState, SpanishProfile};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

struct Fake { reply_delay: Duration, judge_delay: Duration, parallel: bool }
impl Model for Fake {
    fn parallel_requests(&self) -> bool { self.parallel }
    fn generate<'a>(&'a self, prompt: Prompt, cancellation: CancellationToken) -> ModelFuture<'a> {
        Box::pin(async move {
            tokio::select! { biased;
                _ = cancellation.cancelled() => Err("cancelled".into()),
                _ = tokio::time::sleep(if prompt.kind == CallKind::Reply { self.reply_delay } else { self.judge_delay }) => {
                    Ok(if prompt.kind == CallKind::Reply { "¿Con quién fuiste?".into() } else { r#"{"hasError":false,"notable":false}"#.into() })
                }
            }
        })
    }
}
#[derive(Default)]
struct Sink { events: Mutex<Vec<TutorReplyEvent>>, reasons: Mutex<Vec<&'static str>> }
impl EventSink for Sink {
    fn reply(&self, event: TutorReplyEvent) -> Result<(), String> { self.events.lock().unwrap().push(event); Ok(()) }
    fn diagnostic(&self, diagnostic: Diagnostic) { assert!(diagnostic.raw.is_none()); self.reasons.lock().unwrap().push(diagnostic.reason); }
}
fn request() -> TutorRequest { TutorRequest { text: "Ayer fui al parque".into(), request_id: "current".into(), ..Default::default() } }
fn state() -> SessionState { SessionState::new("session", "ordering_food", Level::Intermediate) }

#[tokio::test(start_paused = true)]
async fn cancel_during_reply_prevents_events_and_commit() {
    let engine = TutorEngine::new(Arc::new(Fake { reply_delay: Duration::from_secs(3), judge_delay: Duration::from_secs(1), parallel: false }));
    let cancel = CancellationToken::new(); let task_cancel = cancel.clone();
    let sink = Arc::new(Sink::default()); let task_sink = sink.clone();
    let task = tokio::spawn(async move {
        let mut s = state(); let mut p = SpanishProfile { level: Level::Intermediate, ..Default::default() };
        let result = engine.spanish_tutor_turn(request(), &mut p, &mut s, task_sink.as_ref(), &task_cancel).await;
        (result, s, p)
    });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(200)).await;
    cancel.cancel();
    let (result, s, p) = task.await.unwrap();
    assert_eq!(result.unwrap_err(), TutorError::Cancelled);
    assert!(sink.events.lock().unwrap().is_empty());
    assert_eq!(s.turn_index, 0); assert!(s.feedback.is_empty()); assert!(p.practicing.is_empty());
}

#[tokio::test(start_paused = true)]
async fn cancel_during_judge_does_not_attach_late_feedback() {
    let engine = TutorEngine::new(Arc::new(Fake { reply_delay: Duration::from_millis(100), judge_delay: Duration::from_secs(5), parallel: false }));
    let cancel = CancellationToken::new(); let task_cancel = cancel.clone();
    let sink = Arc::new(Sink::default()); let task_sink = sink.clone();
    let task = tokio::spawn(async move {
        let mut s = state(); let mut p = SpanishProfile { level: Level::Intermediate, ..Default::default() };
        let result = engine.spanish_tutor_turn(request(), &mut p, &mut s, task_sink.as_ref(), &task_cancel).await;
        (result, s)
    });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_millis(200)).await; tokio::task::yield_now().await;
    assert_eq!(sink.events.lock().unwrap().len(), 1);
    cancel.cancel();
    let (result, s) = task.await.unwrap();
    assert_eq!(result.unwrap_err(), TutorError::Cancelled);
    // Already-audible speech remains in the host event journal; a cancelled
    // analytic turn must not replace its newer authoritative session snapshot.
    assert_eq!(sink.events.lock().unwrap().len(), 1); assert!(s.feedback.is_empty());
}

#[tokio::test(start_paused = true)]
async fn judge_deadline_keeps_reply_and_marks_assessment_unknown() {
    let engine = TutorEngine::new(Arc::new(Fake { reply_delay: Duration::from_millis(100), judge_delay: Duration::from_secs(60), parallel: false }));
    let sink = Sink::default(); let mut s = state(); let mut p = SpanishProfile { level: Level::Intermediate, ..Default::default() };
    let response = engine.spanish_tutor_turn(request(), &mut p, &mut s, &sink, &CancellationToken::new()).await.unwrap();
    assert!(response.feedback.is_none()); assert_eq!(s.turn_index, 1); assert_eq!(s.window[0].error, None);
    assert_eq!(sink.events.lock().unwrap().len(), 1); assert!(sink.reasons.lock().unwrap().contains(&"judge_timeout"));
}

#[tokio::test(start_paused = true)]
async fn reply_deadline_uses_script_and_only_one_filler() {
    let engine = TutorEngine::new(Arc::new(Fake { reply_delay: Duration::from_secs(60), judge_delay: Duration::from_millis(100), parallel: false }));
    let sink = Sink::default(); let mut s = state(); let mut p = SpanishProfile { level: Level::Intermediate, ..Default::default() };
    engine.spanish_tutor_turn(request(), &mut p, &mut s, &sink, &CancellationToken::new()).await.unwrap();
    let events = sink.events.lock().unwrap();
    assert_eq!(events.iter().filter(|e| e.filler).count(), 1);
    assert_eq!(events.iter().filter(|e| !e.filler).count(), 1);
    assert!(events.last().unwrap().text.ends_with('?'));
    assert!(sink.reasons.lock().unwrap().contains(&"reply_timeout"));
}

#[tokio::test(start_paused = true)]
async fn deterministic_controls_work_when_model_is_slow() {
    let engine = TutorEngine::new(Arc::new(Fake { reply_delay: Duration::from_secs(60), judge_delay: Duration::from_secs(60), parallel: true }));
    let sink = Sink::default(); let mut s = state(); s.last_reply = "¿Qué quieres tomar?".into();
    let mut p = SpanishProfile::default();
    let before = tokio::time::Instant::now();
    engine.spanish_tutor_turn(TutorRequest { text: "otra vez".into(), ..Default::default() }, &mut p, &mut s, &sink, &CancellationToken::new()).await.unwrap();
    assert_eq!(tokio::time::Instant::now(), before);
    assert_eq!(sink.events.lock().unwrap()[0].rate, Some(115));
}
