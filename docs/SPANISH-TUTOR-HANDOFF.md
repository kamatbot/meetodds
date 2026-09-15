# Spanish tutoring engine — implementation handoff

## Status and source boundary

Implemented on `feat/spanish-tutoring-engine` in **kamatbot/notes**, from main at `fc6056feda2a283e3569c2452af907e74ddec216`, following the supplied **Spanish Practice: Core Tutoring Logic — Implementation Brief**.

At implementation time, neither `notes` nor `meetodds` exposed the brief's `feat/spanish-practice` branch, and `notes` had no `spanish.rs`, Spanish commands, profile tables, or practice UI on main. The connector returned `No commit found for the ref feat/spanish-practice`. Therefore this branch supplies the implemented engine, native adapter, migration, additive interface types, and tests; it does **not** invent replacement UI command payloads or recreate the separately-owned audio/profile/session foundation.

This is **not yet a user-accessible Spanish screen** on main. The companion branch must map its real existing command DTOs to the engine and attach its persistence transaction. The engine method retains the name `spanish_tutor_turn`; no existing commands were renamed. Once the companion branch is available, keep its command shell in `spanish/mod.rs` or a submodule, remove its old conflicting `spanish.rs`, and call this core rather than retaining the single `{reply, feedback}` model request.

## Implemented surface

| Path | Responsibility |
| --- | --- |
| `frontend/src-tauri/src/spanish/mod.rs` | Serializable profile, turn, state and feedback types; core exports |
| `spanish/tutor.rs` | Intent routing, reply/judge orchestration, prompt budgets, deadlines, event delivery, model-independent async tests |
| `spanish/policy.rs` | Finding validation, correction/praise pacing, level rules, practice memory, complexity and recap |
| `spanish/text.rs` | Speech-text heuristics, normalization, reasoning stripping, bounded word LCS and retry outcomes |
| `spanish/scenes.rs` | Eight four-beat situations and six topic banks, each with three openers per level |
| `spanish/persistence.rs` | Additive state serialization into existing turn/feedback object arrays |
| `spanish/provider.rs` | Real MeetOdds inference and window-event adapters; exported as `crate::spanish_provider` |
| `spanish/migrations/001_practicing.sql` | The single requested profile column |
| `frontend/src/types/spanishTutor.ts` | Optional frontend extensions, event types and stale-event/rate helpers |
| `tools/spanish-core-tests` | Independent Rust workspace; no Tauri, microphone, GPU or downloaded model required |

The only changes to existing runtime files are module declarations in `lib.rs` and a backwards-compatible sampling entry point in `summary/summary_engine/client.rs`. Meeting prompts, global sampling defaults, capture, recording recovery, native voices, iOS code, and UI pages are unchanged.

## Native integration sequence

1. Keep the companion command's existing name and argument shape. Map its `open | reply | help | stuck` mode and learner text into `TutorRequest`. Generate a native request ID and time; do not use a client's clock as authoritative mastery history.
2. Resolve the authorized selected learner and session on the native side. Do not let arbitrary webview-supplied JSON become authoritative profile/mastery state. Create a session with `SessionState::new(session_id, scene_id, profile.level)`; use `persistence::restore` on its existing turns JSON. Reject a cross-session state blob.
3. Construct `spanish_provider::MeetOddsModel` using existing native provider settings and the native credential store. The configuration is intentionally neither serializable nor debug-printable. External text processing requires explicit consent for this practice profile. There is no automatic local-to-cloud fallback.
4. Retain a `TutorEngine` instance and a cancellation token per active session. Its in-process lease prevents simultaneous turns on that engine/session. The host must cancel and settle the old request before starting a replacement, and use a generation/revision check before committing. A lease does not replace transaction/revision ownership.
5. Attach a `WindowSink` to the originating practice window. Subscribe to `spanish-tutor-reply` **before** invoking the command. Filter events by current `sessionId` and `requestId` after interruptions/navigation. Do not use an application-wide unfiltered listener.
6. Call `engine.spanish_tutor_turn(request, &mut profile, &mut state, sink, token).await`. The engine emits speech events while the command is still awaiting the judge. Its return is `{feedback, beat, sceneDone}`, with no duplicate reply text to speak.
7. The host records audible tutor turns using its original turn shape, then calls `persistence::prepare_update`. Atomically save the returned `turns_json`, `feedback_json`, and `practicing_json` to the existing session/profile rows. Do not save only the visible feedback card: recap-only findings must survive too. The helper preserves old fields and does not create new tables.
8. An ignored noise/meta request must not be appended as a learner turn. Track audible events separately from successful analytic completion: if an interruption occurs after speech was delivered, the host retains the actual audible transcript, but must not attach a cancelled judge's feedback or overwrite a newer turn's state. The core keeps its turn mutation atomic; integration must reconcile the audible event journal when a turn is cancelled after delivery.

The engine's eight-turn `state.turns` buffer is prompt context, **not** a replacement for the companion's complete session history. Load opener history from the learner's previous sessions before `open`. At session end, persist the final dial and assessment counters inside existing session JSON and pass the latest three completed `SessionResult`s to `policy::recap` for the level suggestion. Do not change the saved level until the learner accepts that suggestion.

## Migration and compatibility

Call `spanish_provider::migrate_practicing(&mut transaction)` after the companion's `spanish_profiles` table exists. It checks `PRAGMA table_info`, executes `ALTER TABLE ... ADD COLUMN practicing TEXT NOT NULL DEFAULT '[]'` only when needed, and returns a clear error when the foundation table is absent. Do not call it unconditionally at startup on this branch's main-based schema.

`prepare_update` expects the existing `turns` and `feedback` blobs to be arrays of objects. It places a versioned `spanishTutorState` field on the last actual tutor-turn object; this is an additive field, not an invented transcript turn or a new JSON envelope. If the companion chose a different representation, adapt the persistence boundary explicitly rather than silently coercing it. Legacy arrays without engine state still load. Feedback extensions deserialize with defaults.

`practicing[].useSessionIds` is additional internal evidence beyond the brief's display fields. Crediting one use per distinct session prevents two immediate retries from being presented as cross-session mastery. A phrase becomes mastered at two credited sessions; mastered phrases no longer enter prompts. The list remains capped at eight, normalized-deduplicated and FIFO by `addedAt`.

## Speech event contract

```ts
// New event; required brief fields preserved, correlation/speech hints additive.
{
  text: string,
  repeat: boolean,
  rate?: number,
  filler?: boolean,
  sessionId: string,
  requestId: string
}
// Command result:
{ feedback: Feedback | null, beat: number, sceneDone: boolean }
```

Speak from events only. `repeat` uses rate 115; stuck scaffolding uses 130. A filler event is transient, not a new teaching/learner turn or a new eight-second silence deadline. Replace/stop queued filler audio when the actual reply arrives; never queue it behind the full response. Do not double-speak when the command resolves.

Start the eight-second stuck timer **after tutor playback finishes**, cancel it on user speech/stop/navigation, and call the existing command with `mode: stuck`. Auto-scaffolds and repeats do not call a model. `help` is the explicit model-generated sample-answer path.

Only `response.feedback` may enter the live card surface. The recap uses the complete state buffer, including `shown: false` findings. Practice-it should use `text::practice_attempt`, display its `missedWordIndices`, and end after success or the third attempt; no failure state. Repeating a target is not credited as a new cross-session conversational use.

## Provider scheduling and sampling

The engine supports concurrent reply and judge futures when a provider explicitly advertises independent capacity. The **built-in single-slot llama-helper uses reply-first scheduling**: finish/emit the short reply, then run the judge under speech playback. Starting two local futures without additional model capacity would only allow the judge to block the reply.

The existing `generate_with_builtin(...)` signature remains unchanged and retains model defaults. New `generate_with_builtin_with_sampling(..., Some(BuiltinSamplingOverride))` applies only per-request temperature/top-p/top-k, leaving stop sequences and other model parameters unchanged. Judge defaults are temperature 0.05, top-p 1, top-k 1; conversation uses 0.65/0.9/40.

The actual repository's shared HTTP builder drops temperature outside CustomOpenAI. The tutoring adapter therefore applies sampling to its own Ollama/CustomOpenAI request body, and to a cloud request only when the host explicitly marks that selected model as supporting it. Meeting calls are not changed. Codex delegates to the existing account provider; no new subscription entitlement or sampling behavior is assumed.

The host must coordinate the shared local model with meeting/summary work and the companion's audio session. Do not start practice inference during a conflicting active recording/summary. Existing helper cancellation may shut down its shared process; this branch does not redesign that global lifecycle.

## Conservative interpretation of ambiguous brief details

- Explicit short meta/minimal phrases (`repeat`, `sí`, `no sé`, `¿qué?`) take precedence over the generic less-than-two-alphabetic-token noise filter. The English word list is a deliberately small heuristic, not a validated language detector.
- Long/non-English explanations use the category's English rule template, following the explicit card-content and test sections rather than discarding an otherwise valid finding.
- A correction whose only change is capitalization, punctuation, accents or the specified STT spelling confusions is rejected. A correct notable phrase is allowed to have identical `youSaid`/`tryThis`.
- `structure` is optional judge metadata needed to distinguish present conjugation from subjunctive/conditional/register. Missing/unknown structural evidence is handled conservatively. Unknown category is rejected; unknown model output never counts as an error-free learner turn.
- Praise requires affirmative above-level evidence or an unmastered practicing phrase; a generic `other` category is not evidence of advanced language.
- One preferred topic has only three openers; after those are exhausted, selection broadens to another topic to enforce a five-session no-repeat window.
- Raw rejected model output is **off by default** to preserve the repository's privacy boundary. An explicit, bounded sensitive-diagnostics callback is available for local prompt tuning; never enable it silently or send it to ordinary analytics.

## Prompt and latency limits

Reply system/user limits are checked at 250/500 tokens through the `Model::token_count` abstraction. Without an exact selected-model tokenizer, the adapter uses a conservative UTF-8 byte upper bound rather than a misleading word-count estimate. `with_token_counter` accepts the real tokenizer. Optional history/context is removed before exceeding the budget; the current learner utterance is never silently truncated. An over-budget utterance returns a recoverable error and should invite a shorter answer.

The reply has a four-second one-time filler threshold (never two consecutive learner turns), a twelve-second recovery deadline, and the judge a six-second deadline. These are **configured guards, not measured model performance**. The brief's 2.5-second first-spoken-word goal also includes voice startup, which is owned by the companion branch.

## Validation

The integrated model-free core passed **50 tests** at checkpoint `ff785eb825e922384df2ff9c0c1b2f8eb5b106ea` in GitHub Actions, including policy, intent, validation, mastery, scene advancement, history compatibility, reply-before-judge ordering, controls and filler cadence. The permanent workflow also compiles/tests the manual runner and checks the migration on a disposable SQLite database. See the latest workflow run for subsequent test counts.

```sh
cargo test --manifest-path tools/spanish-core-tests/Cargo.toml --locked --all-targets
```

The macOS native workflow checks the real Tauri module/adapter with the repository's compile-only `TAURI_CONFIG`. This is not a signed application, packaged sidecar, device recording, or iOS runtime test. Do not infer a shipping feature from a compile check.

### Manual Qwen 3.5 4B tuning loop

`spanish/golden.jsonl` contains 44 synthetic utterances with expected intent/category/severity, including correct sentences, regional variants, STT artifacts and controls. Explicit acceptable alternatives are recorded only where category boundaries overlap; a wrong severity is still a mismatch. Treat this as a reviewable development corpus, not a validated language-learning benchmark.

Start an existing local llama-server with the exact reference GGUF and an alias such as `qwen3.5-4b`, then run:

```sh
cargo run --manifest-path tools/spanish-core-tests/Cargo.toml --locked \
  --example judge_golden -- http://127.0.0.1:8080 qwen3.5-4b
```

The runner calls the production judge prompt/validator, refuses non-loopback endpoints, never downloads a model, and never falls back to cloud. It reports category/severity mismatches, false corrections, invalid JSON/findings and judge latency. Record model hash, quantization, prompt template/thinking configuration, hardware, warm/cold status, and measured results alongside any prompt adjustment. Also run a native end-to-end playback test: an HTTP judge-only result does not validate llama-helper scheduling or spoken latency.

**Not performed in this implementation environment:** reference-model inference/quality tuning, Apple Silicon first-spoken-word benchmarking, the full companion UI/audio integration, or iOS device validation. These remain explicit integration/release gates; no pronunciation scoring, placement tests or other languages were added.
