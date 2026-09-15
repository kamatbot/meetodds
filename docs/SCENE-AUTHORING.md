# Scene authoring

Conversation scenes for the practice tutor. Each target language has 8 role-play
situations; each situation has 4 beats (stages) the tutor moves through
deterministically.

## Where content lives

| | |
|---|---|
| Spanish | `frontend/src-tauri/src/spanish/scenes.rs` — hand-written, **do not regenerate** |
| Everything else | `frontend/src-tauri/src/languages/scenes.rs` — **generated**, do not hand-edit |
| Source of truth for the generated set | `tools/scene-authoring/content/<lang>.json` |

Spanish is deliberately excluded from the generated module. It predates this
pipeline and the Spanish engine still owns its own scene progression; unifying
the two is a follow-up, not a prerequisite.

## The shared skeleton

Every language shares the same 8 scene ids, roles, goals and beat goals. These
fields are **English metadata, byte-identical across all languages**, because
they key the engine's deterministic progression — a translated `goal` would
silently desynchronise that language. A test enforces this.

Per-language content is only: `filler`, each beat's `opener` and `options`, and
the beginner/intermediate rows of `target_structures`. The advanced row is a
shared English label set.

## Regenerating

```sh
python3 tools/scene-authoring/validate.py tools/scene-authoring/content/*.json
python3 tools/scene-authoring/codegen.py tools/scene-authoring/content \
  frontend/src-tauri/src/languages/scenes.rs
cargo test --manifest-path tools/languages-tests/Cargo.toml
```

Edit the JSON, never the `.rs`. The generator emits the test module too, so
tests survive regeneration.

## Invariants the gate enforces

- 8 scenes in the fixed order; 4 beats each; `target_structures` 3 rows × 2
- English metadata byte-identical to the skeleton
- **Every `opener` and `options` ends with `?`** (or full-width `？`). The
  Spanish engine asserts this; the multilingual set holds the same contract.
- `options` is a short either/or a beginner can simply pick from
- No empty strings; fillers reused across scenes rather than unique per scene
- Mandarin: simplified characters only, no pinyin or Latin letters, full-width
  punctuation, no spaces between Chinese characters
- Register consistency: no mixing du/Sie, tu/vous, tu/Lei within one scene
- Brazilian Portuguese: no European Portuguese forms
- No duplicate openers within or across languages

## Hindi is taught in Roman script, by design

Hindi (`hi`) is the one language whose learner-facing content is deliberately
**not** in its native script. The product decision: learners **speak** Hindi and
build a spoken vocabulary; they are explicitly not learning to read or write
Devanagari. So Devanagari must not appear anywhere a learner can see it, and a
learner who cannot read it should not meet it even in the language picker
(`native_name` is "Hindi", not the Devanagari spelling).

What that means for content:

- Everything is written in **everyday Roman Hindi** — the register of texting,
  Bollywood subtitles and Hinglish: "Aap kya peena chahenge?", never
  Devanagari.
- **No IAST diacritics** (no ā ī ū ṭ ṃ). A learner cannot type or skim them;
  plain ASCII letters only.
- Roman Hindi has no fixed spelling, so the content fixes **one spelling per
  word** and uses it everywhere. The decided forms (hai/hain, nahi, kya,
  chahiye, mein = in, main = I, toh, yeh/woh, achha, theek, bahut, ...) are
  listed in the `HINDI_TEXT` comment in
  `frontend/src-tauri/src/languages/text_policy.rs`; `validate.py` and
  `validate_talk.py` reject the common alternatives.
- Register: **aap** in the four service scenes (ordering_food, shopping,
  hotel_checkin, asking_directions), **tum** in the four peer scenes and in free
  talk, never mixed within a scene, and **tu** is never modelled.
- Everyday English loanwords (bus, time, phone, class, weekend) are ordinary
  Hindi. They are neither errors nor evidence that the learner has fallen back
  to English.
- Questions end with the ASCII `?` (the danda ends statements, and the content
  is not in Devanagari anyway).

The invariant is pinned: tests in `languages/{mod,text_policy,grammar,prompts,
scenes,talk}.rs` assert that no Devanagari codepoint (U+0900–U+097F) and no
non-ASCII letter appears in any Hindi learner-facing string, module field,
grammar wording or prompt. The text policy forgives romanisation variants
(hai/hain/he, nahi/nahin, kya/kyaa, w/v, z/j, ...) as speech-recognition noise
and subtracts the Roman-Hindi words that collide with English function words
(`the`, `is`, `do`, `to`, `so`, `or`) from the English-mixing evidence, so
"main to bas yahi keh raha tha" is read as Hindi, not as giving up.

## Content status — read before making teaching claims

The non-Spanish content is **machine-authored**. It has been checked for
structure, register consistency and orthography, and reviewed for plausibility,
but it has **not been reviewed by a fluent speaker of each language**.

Mural's own README makes the same caveat about its language modules: voice
accent and teaching guidance are model instructions, and fluent-speaker review
is still required before making pronunciation or learning-effectiveness claims.
That applies here with more force, because this is dialogue a learner will copy.

Before shipping any language to users, get a fluent speaker to review that
language's JSON file. Record who reviewed what in `verification/`.
