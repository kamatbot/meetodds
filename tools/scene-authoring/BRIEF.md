# MeetOdds scene authoring brief

You are authoring conversation-practice scene content for ONE target language,
to sit alongside the existing Spanish content in the MeetOdds language tutor.

## What a scene is

8 role-play situations. Each has 4 "beats" (stages). In each beat the tutor
speaks an `opener` in the target language; if the learner stalls, the tutor
offers `options` — a very short either/or prompt in the target language that
makes replying easy for a beginner.

## What you must NOT change

These fields are shared English metadata, identical across all languages.
Copy them exactly as given. Do not translate or reword them:
`id`, `tutor_role`, `learner_role`, `goal`, and each beat's `goal`.

## What you author (all in the TARGET LANGUAGE unless stated)

- `filler` — a short natural "thinking aloud" noise the tutor says while the
  model is still producing a reply. Spanish uses "Mmm, a ver…", "Un momento…",
  "Déjame pensar…", "Déjame ver…". Must sound like a real speaker hesitating,
  NOT a translation of the English word "filler". Reuse 2-4 such fillers across
  the 8 scenes, as Spanish does.
- `opener` — one natural spoken line, usually a question, that opens the beat.
  Keep it short and speakable. This is SPOKEN dialogue, not written prose.
- `options` — a very short either/or fallback, e.g. "¿Agua o zumo?". Typically
  2-6 words. It must offer two concrete choices the learner can just pick.
- `target_structures` — 3 levels, 2 entries each:
  - beginner and intermediate: CONCRETE forms in the target language that the
    beat naturally elicits, e.g. Spanish "quiero + noun", "¿cuánto cuesta?",
    "me gustaría". Use the real grammar of your language, not a gloss of the
    Spanish. Include the language's own article/particle/case conventions.
  - advanced: use the ENGLISH descriptive labels given in the skeleton verbatim
    (e.g. "conditional politeness"). These are shared across languages.

## Register and quality bar

- Address the learner the way this language addresses a friendly stranger in
  that situation. Follow the language policy block given in your task.
- Natural, contemporary, everyday speech from the stated variety. No textbook
  stiffness, no regional caricature.
- Correct orthography: accents, umlauts, ß, ã/õ/ç, ¿¡, simplified characters,
  etc. Mandarin: no pinyin anywhere in the content; simplified characters only;
  no spaces between Chinese words.
- Openers must fit the beat goal AND be answerable by a beginner.
- Do not invent real schedules, prices, or current facts.

## The 8 scenes (skeleton — English fields are fixed)

1. ordering_food | tutor=waiter | learner=customer
   goal: order food and a drink, then ask for the bill
   beats: greet and choose a drink / order food; offer a dish /
          ask how the food tastes / ask for the bill and finish
   advanced targets: ["conditional politeness", "complaining politely"]

2. meeting_someone | tutor=new acquaintance | learner=new acquaintance
   goal: introduce yourself and find a shared interest
   beats: exchange names / say where you live / find a shared interest /
          suggest another conversation
   advanced targets: ["shared interests", "polite invitations"]

3. school_day | tutor=classmate | learner=student
   goal: talk about subjects, a class project and after-school activities
   beats: name a favorite subject / describe a class /
          describe a project or activity / arrange an after-school activity
   advanced targets: ["explain an opinion", "compare learning experiences"]

4. weekend_plans | tutor=friend | learner=friend
   goal: agree an activity, place and time
   beats: choose an activity / choose a place / agree a time / confirm the plan
   advanced targets: ["negotiate alternatives", "hypothetical plans"]

5. shopping | tutor=shop assistant | learner=customer
   goal: choose an item, compare options and buy it
   beats: identify an item / choose size and color / compare an alternative /
          ask price and decide
   advanced targets: ["compare value", "negotiate politely"]

6. asking_directions | tutor=helpful pedestrian | learner=visitor
   goal: find a destination and check the route
   beats: ask for a destination / establish a landmark /
          explain and confirm a route / check understanding and finish
   advanced targets: ["clarify ambiguous directions", "compare routes"]

7. hotel_checkin | tutor=hotel receptionist | learner=guest
   goal: check in, ask about facilities and agree checkout
   beats: greet and confirm reservation / choose a room /
          ask about facilities / agree checkout and finish
   advanced targets: ["request an accommodation", "resolve a reservation problem"]

8. planning_party | tutor=friend helping organize | learner=party organizer
   goal: plan guests, food, activities and timing
   beats: decide who is invited / choose food / choose an activity /
          confirm when and finish
   advanced targets: ["coordinate preferences", "negotiate constraints"]

## Worked example (Spanish — the quality bar to match, DO NOT COPY into output)

ordering_food, filler "Mmm, a ver…"
  beat1 goal "greet and choose a drink"
        opener "¡Hola! ¿Qué quieres tomar?"   options "¿Agua o zumo?"
  beat2 goal "order food; offer a dish"
        opener "Tenemos pizza y tacos. ¿Qué te apetece comer?"
        options "¿Pizza o tacos?"
  beat3 goal "ask how the food tastes"
        opener "¿Qué te parece la comida?"    options "¿Te gusta mucho o un poco?"
  beat4 goal "ask for the bill and finish"
        opener "¿Quieres algo más o te traigo la cuenta?"
        options "¿Algo más o la cuenta?"
  target_structures: beginner ["quiero + noun","¿tiene…?"]
                     intermediate ["me gustaría","¿me trae…?"]
                     advanced ["conditional politeness","complaining politely"]

meeting_someone, filler "Un momento…"
  beat1 opener "¡Hola! ¿Cómo te llamas?"  options "¿Te llamas Ana o tienes otro nombre?"
  target_structures: beginner ["me llamo","me gusta"]
                     intermediate ["suelo + infinitive","llevo viviendo"]

## Output format

Write ONE JSON file to the exact path given in your task. No prose, no
markdown fence, just valid UTF-8 JSON:

{
  "language_id": "de",
  "scenes": [
    {
      "id": "ordering_food",
      "tutor_role": "waiter",
      "learner_role": "customer",
      "goal": "order food and a drink, then ask for the bill",
      "filler": "...",
      "beats": [
        {"goal": "greet and choose a drink", "opener": "...", "options": "..."},
        {"goal": "order food; offer a dish", "opener": "...", "options": "..."},
        {"goal": "ask how the food tastes", "opener": "...", "options": "..."},
        {"goal": "ask for the bill and finish", "opener": "...", "options": "..."}
      ],
      "target_structures": [["...","..."],["...","..."],["conditional politeness","complaining politely"]]
    }
    // ... all 8 scenes, in the order listed above
  ]
}

Requirements: exactly 8 scenes in the given order; exactly 4 beats each;
target_structures exactly 3 rows of exactly 2 strings; no empty strings;
no trailing commas; no comments in the actual output.
