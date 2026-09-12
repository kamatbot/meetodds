# Spanish Practice: Core Tutoring Logic — Implementation Brief

Audience: the engineer implementing the tutoring engine (Astra). Scope: everything between "the learner's words arrived as text" and "the tutor speaks and a card may appear". The plumbing around it (mic → VAD → STT, `say` voice, profiles, sessions, the full-screen UI) is being built separately on branch `feat/spanish-practice` and is not in scope here except where interfaces change.

## 1. What "useful" means (design contract)

The current skeleton is one LLM call that returns `{reply, feedback}`. That is a tech demo: it produces a reply, and on a 4B local model it either corrects everything or nothing. The engine below is what turns it into a tutor. Non-negotiables, taken from the product spec:

1. The conversation never stops for a correction. The tutor's voice stays in Spanish, keeps the thread, and ends with a question.
2. One card at a time. Everything else is saved for the recap.
3. No manufactured corrections. Silence is a valid outcome. Praise only when a phrase is genuinely notable.
4. Corrections must be *right* and *at the learner's level*. A wrong correction is worse than none; a subjunctive correction for a beginner is noise.
5. Improvement must be visible across sessions: the tutor remembers what the learner is practicing and creates chances to use it.

## 2. Architecture

Location: Rust, `frontend/src-tauri/src/spanish/` (split the current single `spanish.rs` into a module directory). Rust owns the logic because it owns the LLM access (`summary::llm_client::generate_summary`) and because the rules must be unit-testable without a model.

```
spanish/
  mod.rs        commands (already exist; keep names and payload shapes)
  tutor.rs      orchestration of one turn: intent → reply call ∥ judge call → policy → response
  policy.rs     pure rules: what to show, when, and what to suppress
  scenes.rs     situation scripts and the "just talk" topic bank (data)
  text.rs       normalization, English detection, similarity, word diff (pure)
```

Frontend impact is limited to new optional fields on `Feedback` and one new event (`spanish-tutor-reply`, see §9). Do not change existing command names.

## 3. The turn pipeline

Entry point stays `spanish_tutor_turn(request) -> TutorResponse`. Internally:

```
learner text
  → 3.1 normalize + classify intent
  → 3.2 reply call (fast, creative)          → emit reply immediately (spoken while judge runs)
  → 3.3 judge call (slow, analytic, JSON)    → 3.4 policy → card or nothing
  → 3.5 update session state (beat, complexity window, practicing list)
```

### 3.1 Intent classification (rules, no LLM)

STT output from a learner is messy. Before anything else, classify:

| Intent | Detection | Handling |
|---|---|---|
| `spanish_attempt` | default | full pipeline |
| `english_mixed` | ≥ 40% of tokens in a small English stopword/function list, or an English question pattern ("how do you say", "what does … mean") | reply stays in Spanish; judge produces a `translation` card ("In Spanish you could say: …"), never a `correction` |
| `meta_request` | "repeat", "slower", "otra vez", "más despacio", "no entiendo", "¿qué?" | do not call the LLM; return the previous reply with `repeat: true` (the frontend re-speaks it at rate 115) |
| `minimal` | ≤ 2 tokens ("sí", "no sé", "ok") twice in a row | trigger the stuck scaffold (§5.3) |
| `empty_or_noise` | < 2 alphabetic tokens, bracketed STT artifacts | ignore; no turn recorded |

Keep the English list to ~120 words; this is a heuristic and should be marked as such.

### 3.2 Reply call

Separate from the judge on purpose. Small models degrade sharply when asked to converse and analyze in one JSON. Prompt budget: system ≤ 250 tokens, user ≤ 500 tokens (last 8 turns).

Inputs: profile (name, level, variety), scene + current beat (§5.1), complexity dial 0–3 (§5.2), up to 3 practicing phrases (§6), and the judge's *previous-turn* correction if any (for recasting).

Rules in the prompt:

- Spanish only, 1–2 sentences, end with a question. Never comment on errors.
- **Recast**: if the learner's last sentence had an error, weave the correct form naturally into the reply ("¡Ah, fuiste al parque! ¿Con quién fuiste?"). This is implicit correction; it is the single biggest "feels like a real tutor" lever and costs nothing.
- Prefer questions that invite one of the practicing phrases.
- Follow the current beat's goal; when the beat's goal is met, move to the next one.

Output: plain text, not JSON. Strip `<think>` blocks and quotes. Fallback if empty: a beat-specific canned line from `scenes.rs`.

Emit the reply the moment this call returns (§9). Do not wait for the judge.

### 3.3 Judge call

Analytic, temperature as low as the provider allows, JSON only. One or two few-shot examples in the prompt. The prompt must state that the text came from speech recognition: **ignore accents, punctuation, capitalization, ¿¡, and b/v, ll/y, s/z confusions**. Most "corrections" a naive judge produces on STT text are transcription artifacts.

Schema:

```json
{
  "hasError": true,
  "category": "verb_tense",
  "severity": "core",
  "youSaid": "Ayer yo voy al parque con mi hermano.",
  "tryThis": "Ayer fui al parque con mi hermano.",
  "why": "You are describing a completed action in the past, so use the preterite.",
  "notable": false,
  "notableWhy": ""
}
```

Category enum (finite; the policy and recap depend on it):

`verb_tense, verb_conjugation, ser_estar, gender_agreement, number_agreement, article, preposition, word_choice, word_order, missing_word, english_mixed, other`

Severity: `blocking` (meaning unclear), `core` (a rule at or below the learner's level), `polish` (above level or stylistic).

Validation in code, not trust: drop the finding if `tryThis` equals `youSaid` after normalization, if `tryThis` contains English, if `why` is > 30 words or not English, or if the category is unknown. A dropped finding is logged with the raw output for later prompt tuning.

### 3.4 Policy (pure code; this is the product)

`policy::decide(finding, session_state, profile) -> Decision` where `Decision` is `Show(Feedback) | SaveForRecap(Feedback) | Discard`.

Rules, in order:

1. `severity == polish` and level is beginner or intermediate → SaveForRecap.
2. Category is above level (table below) → SaveForRecap.
3. Same category shown in the last 3 learner turns → SaveForRecap (increment the repeat count; the recap shows "3×").
4. A card was shown on the previous learner turn and this one is not `blocking` → SaveForRecap. This is the "cooldown": at most one card every two turns.
5. `english_mixed` → Show as kind `translation` (these are not errors, they are help).
6. Otherwise → Show as `correction`.

Praise: `notable == true` → Show as `praise` only if no card was shown this turn, no praise in the last 4 turns, and the phrase is either on the practicing list (kind `practiced`, mark a use) or above the learner's level. Otherwise discard. Praise should be rare enough to mean something.

Level table (what is "at level"):

| Level | Correct these | Save for recap |
|---|---|---|
| beginner | gender/number agreement, article, ser/estar (present), present-tense conjugation, missing_word, word_order, english_mixed | verb_tense (past/future), preposition, subjunctive anything |
| intermediate | everything above + verb_tense (preterite/imperfect), preposition, word_choice | subjunctive, conditional, register |
| advanced | all | none |

### 3.5 State update

Session state carried between turns (persist inside the existing `turns`/`feedback` JSON blobs; add fields, no new tables):

- `beat` index and `beatTurns` (turns spent on this beat)
- rolling window (last 5 learner turns): mean tokens, error rate, English-mix rate → complexity dial (§5.2)
- `lastCardTurn`, `lastPraiseTurn`, `shownCategories` with turn indices
- recap buffer: every finding, shown or not, with `shown: bool` and `count`

## 4. Feedback card content

`Feedback` gains: `category`, `severity`, `shown`, `turnIndex`, `count`. `kind` extends to `correction | praise | practiced | translation`.

`why` must be one English sentence naming the rule, not the fix ("You're describing a completed action in the past" rather than "Use fui"). Keep per-category fallback templates in `policy.rs` for when the model's `why` fails validation; a templated sentence beats no card.

## 5. Conversation management

### 5.1 Scenes (`scenes.rs`)

Each situation is a script, not a one-line label:

```rust
Scene {
  id: "ordering_food",
  tutor_role: "waiter at a casual restaurant",
  learner_role: "customer",
  goal: "order a meal and a drink, then ask for the bill",
  beats: [
    Beat { goal: "greet and ask what they want to drink", opener: "¡Hola! Bienvenido. ¿Qué quieres tomar?", max_turns: 3 },
    Beat { goal: "take the food order, suggest one dish", ... },
    Beat { goal: "ask how the food is", ... },
    Beat { goal: "bring the bill and say goodbye", ... },
  ],
  target_structures: { beginner: ["quiero + noun", "¿tiene…?"], intermediate: ["me gustaría", "¿me trae…?"], advanced: ["conditional politeness", "complaining politely"] },
}
```

Beat advancement is a rule: advance when the reply call reports the goal met (a trailing `[[next]]` token the prompt asks for, stripped before speaking) or when `beatTurns >= max_turns`. When the last beat ends, the tutor closes the scene and the session offers "Practice again" or "Just talk". This is what stops the aimless "¿y qué más?" loop.

"Just talk" uses a topic bank keyed by the profile's topics, with 2–3 opener questions per level per topic, rotating so the same opener is not reused within 5 sessions.

Ship 8 scenes, 4 beats each. Data, not code.

### 5.2 In-session complexity dial

Do not change the stored level mid-session. Instead compute a dial 0–3 from the rolling window and pass it into the reply prompt as concrete instructions ("use only present tense and questions with one clause" … "use natural pace, idioms, follow-up questions"):

- mean learner tokens < 4 or error rate > 0.5 → dial down one
- mean tokens > 10 and error rate < 0.15 for 5 turns → dial up one
- clamp to level ± 1

Recap already offers Too easy / Just right / Too hard; additionally, if 3 consecutive sessions ended at dial = level + 1 with error rate < 0.15, suggest a level bump on the recap screen (one line, one button).

### 5.3 Stuck scaffold

Triggered by `minimal` intent twice, or by the frontend reporting 8 s of silence after a tutor question (new command `spanish_tutor_turn` mode `stuck`). The engine does not call the LLM for this. It re-asks the previous question in a simpler form using a rule: take the last tutor question, and produce a two-option version from the scene beat ("¿Pizza o tacos?") if the beat provides `options`, otherwise the beat's `opener`. Speak it at rate 130. The "Help me answer" button remains the explicit route to a model-generated example sentence.

## 6. Cross-session memory: the practicing list

Profile gains `practicing: [{ phrase, category, uses, mastered, addedAt }]` (new column `practicing TEXT NOT NULL DEFAULT '[]'` on `spanish_profiles`, one migration).

- Every *shown* correction adds its `tryThis` to the list (max 8, FIFO by `addedAt`, no duplicates after normalization).
- The reply prompt receives up to 3 unmastered phrases and is asked to create openings for them.
- The judge prompt receives the same 3 and sets `notable` if the learner produced one correctly; policy shows it as `practiced` and increments `uses`. At `uses >= 2` across ≥ 2 sessions, `mastered = true` and the recap says so. Mastered phrases leave the prompt.

This is the loop that makes session 5 feel different from session 1.

## 7. Practice-it exercise

Keep the repeat-and-retry shape. Replace the plain Levenshtein threshold with:

- normalization: lowercase, strip accents, strip `¿¡` and punctuation, collapse whitespace, digits to words is not needed
- word-level diff (LCS) between target and attempt; score = matched words / target words
- ≥ 0.8 → "¡Muy bien!"; otherwise highlight the missed words on the card and let them try again, max 3 attempts, then exit positively ("Casi. Sigamos.") and keep the phrase on the practicing list. There is no failure state.

## 8. Recap

From the recap buffer: group by category, sort by `count` desc, take the top 2 as "Focus next time" with the category's plain-English name and one example. List every finding (shown or saved) with a speaker button. Show mastered phrases from this session. Then the existing level-feel buttons.

## 9. Interface changes (coordinate with the frontend)

- New event `spanish-tutor-reply` `{ text, repeat: bool }` emitted as soon as the reply call returns; the existing `TutorResponse` return value now carries only `feedback` (or `null`) plus `beat` and `sceneDone`. The frontend speaks on the event and shows the card on the return value, so the card lands while the tutor is still talking.
- `spanish_tutor_turn` modes: `open | reply | help | stuck`.
- `Feedback` new fields per §4; `SpanishProfile.practicing` per §6.

## 10. Provider realities

- `generate_summary` only threads `temperature`/`top_p` for the CustomOpenAI provider; the built-in llama.cpp path uses the per-model `SamplingParams`. Add an optional sampling override to `summary_engine::generate_with_builtin` so the judge can run near-greedy. Ollama and cloud providers accept temperature through the same function today.
- Built-in Qwen 3.5 4B is the reference model. Test prompts against it, not against a cloud model; if it only works on Claude or GPT, it does not work.
- Latency budget on Apple Silicon with the 4B model: reply call ≤ 2.5 s to first spoken word; judge may take up to 6 s because it runs under the voice. If the reply exceeds 4 s, speak a short filler from the scene ("Mmm, a ver…") once, never twice in a row.

## 11. Tests (no model required)

Pure-function tests in `policy.rs`, `text.rs`, `scenes.rs`:

- policy: cooldown, level table, repeat suppression, praise cadence, translation vs correction, blocking overrides cooldown
- intent: english_mixed, meta_request, minimal, noise
- judge validation: tryThis == youSaid dropped, English in tryThis dropped, unknown category dropped, long why replaced by template
- beat advancement: by token and by max_turns
- practicing list: FIFO cap, dedupe, mastery after 2 uses in 2 sessions
- word diff score for practice-it

Plus a golden file `spanish/golden.jsonl` with ~40 learner utterances and the expected category/severity, run manually against the local model with a small `cargo run --example` or a `#[ignore]` test. This is the tuning loop for the judge prompt.

## 12. Out of scope for this brief

Pronunciation scoring (STT cannot see it; do not fake it), placement tests, streaming partial replies, non-Spanish languages, Windows/Linux voices.
