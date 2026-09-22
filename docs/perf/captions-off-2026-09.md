# Captions-off performance correction

Scope: the Apple Speech option plus an evidence-led pass through capture, VAD,
Whisper/Parakeet inference, preview translation, transcript rendering, and packaging.
The app's speech thresholds, selected engine/model, audio retention, and finalized
transcript/translation behavior are not changed for performance.

## Corrections

- Captions visibility now synchronizes with a persisted native preference before
  capture starts. Both normal and selected-device start paths wait for it. Tray
  starts read the native preference. Failed synchronization has an explicit retry.
- Captions off disables rolling snapshots **before** their PCM copy, avoids loading
  the preview engine, and admits no new preview inference. An already-running native
  decode may finish; its generation is rejected so it cannot reappear after off/on.
- Pause/stop also invalidates preview generations. Canonical finalization is not
  gated, including the last buffered sentence and saved-audio tail.
- Paused capture returns before mono conversion, resampling, filtering and level
  normalization, instead of doing that work and discarding its result afterward.
- Removed an unconsumed diagnostic history: per-chunk amplitude scans, metric
  queueing and a growing results vector served no pipeline consumer.
- The pipeline now waits on its input channel directly. Its previous 50ms timeout
  only continued the loop: 20 idle wakeups/second become zero timeout wakeups.
- Removed redundant PCM clones before ring-buffer insertion, saved-audio delivery,
  and preview decoding without changing the samples.
- The floating caption bridge no longer sends a two-second heartbeat: 30 periodic
  IPC frames/minute become zero. The explicit ready handshake remains, and a hidden
  overlay receives only its disabling transition rather than ongoing caption data.
- Disabling captions cancels speculative preview translation; finalized transcript
  translation is preserved. Existing bounded queues, local-inference permit, decoder
  state reuse, virtualized transcript view, and non-spinning ONNX pools remain.
- Distributed builds no longer force host-specific CPU instructions. Node 24 is
  checked by the packer; the real sidecar is selected from the active Cargo target.

## Evidence and limits

Focused native tests exercise the actual pipeline's captions-off snapshot rejection,
canonical output preservation, stale-epoch rejection, and channel-close audio flush.
The 640ms audio fixture retains all 30,720 samples, including the final 40ms tail.
Fourteen relevant native tests passed on the Apple M4/macOS 27 development host.
Frontend tests exercise ordered preference writes, legacy migration, reloads,
off/on toggles, failed-write/read recovery, and recording-start barriers.

The counts above are directly removed operations, **not measured whole-app CPU
percentages**. Historical Parakeet-only benchmarks in this folder are not evidence
for this release. A large Whisper model still uses CPU/GPU for finalized sentences.
Apple Speech still recognizes continuously to produce finals when captions are off;
it does not have a separate speculative re-decode pass.

Release acceptance must record the exact merged `main` SHA, full validation gate,
app version/hash/signature and observed launch/start/captions toggle/pause/stop/save/
reopen behavior. Use public synthetic speech for a matched captions-on/off CPU test;
do not log or transmit private meeting content. Older supported macOS launch and
another physical Mac remain distinct coverage, not implied by this machine's tests.
