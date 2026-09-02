# Speaker detection

Notes attaches a speaker label to each live transcript turn without uploading or retaining biometric voiceprints.

## Reliable channel attribution

When both microphone and system audio are active, the transcription pipeline keeps the streams separate:

- microphone turns are labelled **Me**;
- system-audio turns are labelled **Speaker 1**, **Speaker 2**, and so on;
- only the saved audio recording is mixed.

The previous pipeline mixed both streams before VAD and then labelled every generated chunk as microphone audio. Source separation now happens before VAD, so the minimum `Me` versus remote distinction is based on the capture channel rather than a voice guess.

## Multiple speakers

Remote or room turns are clustered locally using a compact acoustic signature built from MFCC-like spectral features, pitch, spectral shape, and zero-crossing behavior. Clusters are scoped to one recording and capped at six speakers. Labels are intentionally generic because this is diarization, not identity recognition.

Acoustic labels carry a confidence score and low-confidence labels appear as **best estimate**. New clusters require a sufficiently long and strongly dissimilar turn, which favors avoiding false speaker proliferation over detecting every very short interruption.

## Important boundaries

- With system audio enabled, **Me** is deterministic from the microphone channel. Headphones reduce duplicate remote speech leaking into the microphone.
- In a microphone-only room recording, the app cannot know which voice belongs to the device owner. It uses `Speaker 1`, `Speaker 2`, and so on instead of falsely labelling every person as **Me**.
- Imported or retranscribed mixed recordings do not contain the original channel identity, so existing turns remain unlabelled unless a later model-backed offline diarization pass is run.
- Simultaneous speakers on different capture channels can produce overlapping timestamped turns. Separating overlapping people within one mono channel requires a dedicated segmentation and speaker-embedding model.

## Data model

Each transcript may contain:

- `speaker`: stable session-local id such as `me` or `remote-2`;
- `speaker_label`: display label;
- `speaker_source`: `microphone-channel`, `system-acoustic`, or `microphone-acoustic`;
- `speaker_confidence`: value from 0 to 1.

Speaker labels flow through live rendering, crash recovery, SQLite persistence, transcript copy, pagination, and summary generation. This lets meeting templates attribute decisions, commitments, and dissent to the correct turn.
