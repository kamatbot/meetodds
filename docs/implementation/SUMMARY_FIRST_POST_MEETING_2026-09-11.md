# Summary-first post-meeting experience

Base: `main` at `0efc76484d9ae12a42034f6391931d3f454f7a63`.
Branch: `feat/summary-first-post-meeting`.

## User flow

1. Finish and save a meeting using the existing recording/persistence path.
2. The Summary tab presents **Generate AI summary & actions** as the main action, above any outcome content. Model, template and output language remain available.
3. First-time users can choose automatic generation after future meetings. The input review records the exact provider/model/destination and whether meeting notes may be included. Automatic generation is off by default; selecting next-time automation does not launch the current meeting unexpectedly.
4. One reviewed AI job generates the summary, decisions, outcome, questions and self-contained action sentences. It uses the chosen local, connected-ChatGPT or other existing provider. There is no second action-generation model request.
5. After a successful saved result, its action/outcome projection is loaded. The UI shows a concise outcome, actionable next steps, decisions, optional open questions, and a full editable/exportable AI summary in an expandable section.
6. A failed/cancelled generation creates no new actions. A failed regeneration retains the prior saved outcome. Empty action lists are valid.

## Actions now come from AI output only

The previous native `refresh_meeting_intelligence` appended `parse_transcript_candidates` to summary-derived items. Opening an outcome, Actions inbox or preparation view could therefore create sentence fragments without any AI summary. The new projection accepts only a nonempty **completed** saved summary. Transcripts are read only to attach related source moments; they do not create or replace task text.

The existing public command/response shapes are retained. Native outcome parsing and local recall are separated into `summary_outcome_parser.rs` and `meeting_memory.rs` included in `meeting_intelligence.rs`. The output contract uses machine markers for translated headings and explicit optional owner/due/commitment metadata; legacy English headings, stored Markdown, legacy section blocks and BlockNote summaries are also supported. Unknown owners/dates stay unknown. Source matches are navigation aids, not proof of agreement. AI suggestions still require review.

Projection is transactional and keyed by the saved result hash in `meeting_outcome_state`. Identical reads do not rebuild IDs. Valid zero-action summaries are recorded as projected. Confirmed edits, completed actions and dismissed items survive regeneration; only unreviewed open suggestions are replaced. Exact prior stable keys protect reviewed/rejected items. Semantic deduplication of differently worded tasks is not guaranteed.

## Upgrade behavior

New migration: `frontend/src-tauri/migrations/20260911020000_summary_first_outcomes.sql`.

It archives old unconfirmed/open actions, unconfirmed/nondismissed facts and their evidence into `meeting_legacy_action_candidates`, `meeting_legacy_fact_candidates` and `meeting_legacy_candidate_evidence`, then removes those suggestions from active tables. Reviewed, done and dismissed work is preserved. Source meetings, transcript text, notes, summary results and audio paths are not modified. The archive is a local rollback/audit aid, not an additional user-visible inbox. Existing SQLx migration loading applies this migration; no old migration was edited.

Before native acceptance, test the migration on a backup/copy of the user's database, not the only copy. Old completed summaries are projected on read; a preexisting summary lacking recognizable outcome/action sections may need explicit regeneration. Missing action sections are not replaced with guessed tasks.

## Automatic processing and lifecycle

- Existing `isAutoSummary` setting is respected, with the new scoped approval `meetodds.autoSummaryApproval.v1` and first-choice marker `meetodds.autoSummaryChoice.v1`.
- Automatic runs may include meeting/linked notes only under the remembered selection. Separate personal observation notes are never automatically included.
- Provider, model or destination changes require review. Disabling automation or revoking included-note consent during preparation stops automatic dispatch.
- `meetodds.autoSummaryAttempt.v1:<meetingId>` prevents automatic retries/reloads from submitting repeatedly. Manual retry remains available. An existing failed/cancelled/completed job is never automatically rerun.
- Generation checks the actual persisted provider configuration and native summary status rather than temporary frontend defaults. Existing running jobs resume polling instead of being resubmitted. The existing native summary lease remains the final duplicate-job guard.
- All persisted transcript pages must be available; open notes are flushed before the snapshot. A failed notes read is not treated as empty notes.
- Reviewing/copying/exporting the prior AI document and editing linked notes remain available. Unsaved action edits block regeneration and outcome reload until saved or cancelled.
- No recording, live translation/caption, recognition-engine or audio-persistence implementation files were changed. Native recording/save/reopen regression verification is still required.

## Validation actually executed

In the editing container, Node 22.16.0 with installed TypeScript:

```sh
cd frontend
node --test tests/lib/post-meeting-flow.test.cjs tests/lib/summary-generation-flow.test.cjs
python3 tests/sql/summary-first-migration.test.py
```

**25 JavaScript tests passed:** 12 flow/consent tests and 13 actual-generation-hook tests with deterministic React-hook and native-IPC doubles. Coverage includes one AI request, no early action projection, completed/failed/empty results, duplicate clicks, existing jobs, complete transcript requirements, notes-read failure, local recording contention, automatic note inclusion/exclusion, provider changes and last-moment consent revocation. These tests execute the source hook and helpers but are not React DOM or live-provider tests.

**4 SQLite migration tests passed:** archival including evidence; preservation of reviewed/done/rejected work; unchanged source records; rollback after an injected cleanup failure. The tests use the actual new migration against a minimal compatible schema and do not substitute for SQLx migration testing on the full application database.

**13 Rust tests added, not executed:** native completion gating, idempotence, zero-action outputs, regeneration preservation, projection rollback, multilingual markers, output formats and local recall. No Rust toolchain or full project dependencies were available. Full frontend typechecking/lint, Next/Tauri builds, native execution, visual browser testing and actual local/ChatGPT generations have **not** been performed. This branch is implementation-ready for those acceptance checks, not a validated release.

## Codex local acceptance checklist (no CI/deployment in this change)

1. Use the repository's pinned Node/dependencies. Run the two JS test files, Python SQL tests, changed-file lint and project typechecking. Run native compile checks and `api::meeting_intelligence::tests` with the documented compile-only configuration; never package using placeholder/empty sidecars.
2. On a backed-up database, apply migrations and confirm the archive contains old unreviewed fragments while reviewed/done/dismissed work remains. Open Actions before any new summary and verify no transcript fragments are created.
3. Record -> stop -> save -> reopen -> Generate AI summary & actions. Check both a downloaded local model and the connected ChatGPT option. Generate is visible immediately; outcome appears only after completion. Actual model adherence to markers/metadata needs live testing.
4. Check automatic generation at the first meeting, approve the target/notes selection once, finish a second meeting and verify one job without another review. Turn it off, change target/model, revoke consent while preparation is pending, reload a running job, and cancel/retry. No duplicate or unauthorized request may occur.
5. Test no-action meetings, names/dates unknown, translated summaries, long transcripts, failed provider requests, and failed regeneration. Confirm/edit/done/dismiss a task, regenerate and verify those states survive.
6. Confirm unsaved action edits block regeneration. Verify notes, source navigation, title editing, transcript/audio playback, copy, exports, local recall and preparation remain functional. Check 1100x700 and smaller supported window layouts and keyboard navigation.

All commits use `[skip ci]`. No CI, deployment, releases or package changes were run as part of this work.
