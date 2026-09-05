# P0 capture and summaries: implementation checkpoints

Date: 2026-09-05
Branch: `feat/p0-capture-summaries`
Status: **Draft implementation; not release-ready and not the entire P0 backlog.**

## Base and parallel work

Started from `main` at `cf862c63df6d843577003e14736225282fcd7e6c`. Integrated the six subsequent main commits through `07c7ccdc98305299d8569047d5aefebe1142267d` with a two-parent merge commit. The latest-only `watch` preview receiver and main's preview/canonical inference synchronization are preserved. Main's other transcription, Cargo and benchmark changes are included without replacement.

The independent `feat/ux-polish` branch contains autosave, shell save status and export refinements. The branches edit different paths. Its new save-status listener consumes the additive `recording-save-failed` event from this branch; either branch can still be reviewed separately.

## Pushed implementation milestones

| Commit | Change |
| --- | --- |
| `0c4441a` | Single-flight recording start across entry points; remove the unrelated hard-coded Parakeet readiness gate; reconcile native capture state; isolate notification failure. |
| `58d5c05` | Review summary inputs and destination; explicitly select personal notes; preserve transcript, template and language behavior; cancellation and prior-summary handling. |
| `57d16b8` | Close/drain recording writer instead of a timed save guess; atomic flushed transcript/metadata checkpoints; explicit persistence failures; transcript-only completion. |
| `e4002a7` | Native RAII summary-job lease prevents duplicate jobs across view remounts before the process record is reset. |

## Implemented behavior

Recording starts use the configured native transcription model rather than requiring Parakeet when Whisper is selected. A shared frontend gate prevents simultaneous starts; native state is checked after a lost start response. A failed system notification does not report a successfully started recording as failed.

The recording manager checks that recovery storage initialized before starting capture. Save-worker shutdown closes its queue and drains accepted messages. Blocking checkpoint work is separated from the asynchronous audio executor. Transcript upsert, snapshot and persistence are serialized; JSON checkpoints are flushed and atomically replaced. Save failures are latched, propagated and emitted separately from capture-stop events. Transcript-only recordings complete metadata without pretending audio was retained. Capture duration is snapshotted before final transcription drain and state cleanup.

The summary flow fetches the complete saved transcript and presents the provider, endpoint, model, template, transcript preview and an editable personal-note excerpt. Personal notes are excluded by default. Cloud transmission needs explicit approval each time. Local loopback endpoints have a forwarding caveat; the code does not equate loopback with guaranteed zero cloud processing. API and ChatGPT-account modes remain distinct. Unknown providers and insecure remote endpoints fail closed in this UI path.

Selected notes are labeled personal observations in a processing snapshot; they do not overwrite canonical transcript rows or the original note. The prompt distinguishes proposals, commitments, unknown owners/dates and private interpretations. Generate and regenerate both pass through review. A setting change during review invalidates approval. Copy for ChatGPT is an explicit alternative with a clipboard disclosure. Native job ownership survives view navigation and prevents a second job from resetting the current process.

## Validation actually performed

A partial local source checkout was used, not a full native app environment. Node 22 focused checks passed:

```sh
cd frontend
node --test \
  tests/lib/capture-start.test.cjs \
  tests/lib/summary-input.test.cjs \
  tests/lib/capture-persistence-contract.test.cjs \
  tests/lib/summary-native-contract.test.cjs
```

Result: **35 passing checks: 19 behavioral JavaScript tests and 16 source-contract checks.** Source-contract checks inspect implementation structure; they do not execute Rust or prove runtime durability. TypeScript syntax transpilation passed for the modified TypeScript/TSX files. The pure capture-start and summary-input helpers also passed an isolated strict TypeScript check.

Nine Rust unit tests were added (three queue-drain tests, two checkpoint/session tests, four native job-lease tests). **They were not run.** No Rust compiler, Tauri runtime, installed complete frontend dependency graph, or Mac audio hardware was available here. No full build was run, no full-project typecheck is claimed, and no UI screenshot or real recording performance result is claimed.

## Remaining P0 work and release blockers

- Complete audio preflight: independent microphone/system audio test, permission-versus-silence diagnosis, available disk space and configured recording-directory handling. The existing default-directory behavior is preserved, not repaired here.
- Complete crash durability: the existing incremental audio saver still buffers compressed checkpoints. This is not a per-chunk raw audio journal and does not establish the proposed <=2-second crash-loss bound. Verify checkpoint retention through finalization, fsync behavior and recovery across process termination/disk-full failures. Do not advertise zero lost audio.
- Complete capture scheduling: the writer channel remains unbounded; the local-summary launch guard is not a full cross-engine resource scheduler. Device-switch/sleep gap accounting, bounded queues, thermal pressure and a two-hour concurrent-call test remain.
- Native egress enforcement: this iteration reviews and rechecks the destination in the UI. The summary service still loads provider configuration internally. Add an immutable native approved-input/destination contract, including endpoint changes during dispatch and provider forwarding behavior. This is not a complete private-mode network firewall.
- Preserve existing Codex transport until a tested migration: documented app-server integration, OS credential store, quota/account card and fallback-model catalog cleanup are not implemented here. Existing direct OAuth/backend handling remains in place. No authentication or token refresh was tested against an account.
- Summary lifecycle: exercise early cancellation, navigation/remount, an existing running job, account limits, provider failures, malformed output, long transcripts and prior-summary restoration through the real native service. Full reattachment after app restart is not implemented.
- Validate old recordings, import/re-transcription, audio-disabled mode, custom language settings, legacy summary formats and failure recovery. The native shutdown command still has a separate capture-stopped lifecycle, so consumers must not use it as a persistence receipt.

## Required native review

Run the Rust tests and formatter/type checks in the existing Mac build workflow, then exercise real mic + system capture, Bluetooth disconnect/reconnect, force quit, disk exhaustion and a long meeting. Confirm no preview text enters canonical transcript exports/summaries. Test both this branch independently and integrated with the UX branch before promotion from draft. Keep main unchanged until those gates are satisfied.
