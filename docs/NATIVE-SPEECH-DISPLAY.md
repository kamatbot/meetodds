# Native pronunciation with readable script

Hindi has two text channels: Roman Hindi for reading/history/feedback and
Devanagari for the Hindi voice. New model replies produce both in one JSON
response. If sentence limiting or a scene transition changes the displayed
phrase, the old voice variant is discarded rather than speaking different words.

Mandarin remains Chinese characters in the tutor, scorer and voice command.
The UI renders pinyin (including tone marks) using local Core Foundation
transliteration. English translation remains a separate action. Hindi transcripts
that arrive in Devanagari also get a Latin-script display without changing the
underlying transcript. Latin-script target languages are not rewritten.

All audio routes, including repeat, slower, hints, saved phrases and corrections,
pass through `spanish_speak`. A valid native voice variant or cached native text
is used directly. Legacy Roman Hindi and pinyin-only phrases are converted to
native script by the existing LOCAL model, validated, and cached in memory.
This repair can add latency on the first playback of a legacy/authored phrase.
There is no cloud fallback and no fallback to reading Roman letters or using an
English voice. Ambiguous legacy romanization still depends on the local model;
new paired replies avoid reverse-transliteration ambiguity.

Stopping playback cancels pending native preparation and invalidates its
playback generation. The final generation check and process spawn share a lock.
The native phrase goes to `say` via stdin, not command-line arguments.

Current non-Latin target languages are Hindi and Mandarin. Adding another target
requires an explicit native-script validator, conversion policy and native voice;
a display transliteration alone is not sufficient.

## Verification

- `cargo test --manifest-path tools/tutoring-core-tests/Cargo.toml --locked`
- `NODE_PATH=frontend/node_modules node --test frontend/tests/lib/practice-script.test.cjs`
- On macOS the core tests exercise Core Foundation pinyin and Hindi conversion.
- These tests validate text routing, not pronunciation quality from a live voice.

Manual Mac acceptance: use Hindi and Mandarin profiles, hear the opening line,
reply, replay an older bubble, choose Slower, Help me answer, Hear the phrase and
Practice it, then replay from recap. Hindi must display Roman letters and speak
natural Hindi; Mandarin must display pinyin and speak Mandarin. Cancel while a
legacy phrase is preparing: no delayed audio may begin. Remove the target voice:
show an actionable error without English speech. Verify Spanish is unchanged.
