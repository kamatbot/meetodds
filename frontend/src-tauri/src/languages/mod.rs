//! Target-language content ported from the Mural iOS app's `Core/Languages`.
//!
//! Data only: no model calls, no Tauri, no storage. IDs are stable storage keys
//! and must not be renamed once a profile has been written with them.
//!
//! Fidelity note: every string here is a verbatim port of the Swift source at
//! Chuloo/mural `apps/ios/Core/Languages/*.swift` and `Core/Themes.swift`.
//! Teaching guidance is pedagogical content reviewed on the Mural side; edit it
//! there and re-port rather than paraphrasing it here.

// Gated exactly as `spanish::commands` is: the standalone lib target used by
// tools/languages-tests defines no such feature, so it needs no Tauri dependency.
#[cfg(feature = "tauri-commands")]
pub mod commands;

pub mod grammar;
pub mod prompts;
pub mod text_policy;
pub mod scenes;
pub mod talk;

use serde::Serialize;

/// A conversation situation. `color_index` and `symbol` are presentation hints
/// carried over from Mural (SF Symbol names); the web UI maps them to its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTheme {
    pub id: &'static str,
    pub title: &'static str,
    pub subtitle: &'static str,
    pub symbol: &'static str,
    pub category: &'static str,
    pub situation: &'static str,
    pub color_index: u8,
}

const fn theme(
    id: &'static str,
    title: &'static str,
    subtitle: &'static str,
    symbol: &'static str,
    category: &'static str,
    situation: &'static str,
    color_index: u8,
) -> ConversationTheme {
    ConversationTheme { id, title, subtitle, symbol, category, situation, color_index }
}

/// The 24 situations offered in every language, before per-language overrides.
pub static SHARED_THEMES: [ConversationTheme; 24] = [
    theme("coffee", "A coffee?", "Something warm, please", "cup.and.saucer", "Everyday", "You work in a cosy café. Help the learner order, then chat naturally.", 0),
    theme("weekend", "The weekend", "Tell me about yours", "sun.horizon", "Connection", "Ask about the learner’s weekend. Practise past events and follow their interests.", 1),
    theme("walk", "A little walk", "Out into the fresh air", "tree", "Local life", "Take an imagined forest walk together. Talk about nature, weather and daily life.", 2),
    theme("dinner", "Dinner plans", "Let’s make something", "fork.knife", "Everyday", "Plan dinner together. Ask about ingredients, preferences and the steps of cooking.", 3),
    theme("introductions", "Nice to meet you", "Start somewhere small", "hand.wave", "Connection", "Meet the learner for the first time. Learn their interests through natural introductions.", 0),
    theme("groceries", "At the market", "Find the good tomatoes", "basket", "Everyday", "Help the learner shop at a local food market. Practise quantities and questions.", 2),
    theme("travel", "Next stop", "A ticket to somewhere", "tram", "Everyday", "Plan a train trip. Discuss routes and tickets without inventing real current schedules.", 1),
    theme("home", "A place of your own", "Make yourself at home", "house", "Everyday", "Discuss a home, rooms, moving and what makes a place comfortable.", 3),
    theme("friends", "New friends", "An invitation, maybe", "person.2", "Connection", "You are a friendly new acquaintance. Arrange something to do together.", 0),
    theme("work", "Monday morning", "Around the office", "briefcase", "Everyday", "Chat as colleagues. Discuss work, meetings and a small problem to solve.", 1),
    theme("weather", "Rain again?", "Whatever the weather", "cloud.rain", "Local life", "Talk about weather, clothing and outdoor plans. Do not claim today’s forecast without sources.", 1),
    theme("cabin", "A weekend away", "A quieter kind of day", "mountain.2", "Local life", "Plan a weekend away: travel, food, walks and relaxing together.", 2),
    theme("music", "On repeat", "What are you listening to?", "music.note", "Interests", "Ask about music the learner enjoys. Explore feelings, favourites and concerts.", 0),
    theme("film", "One more episode", "Something worth watching", "film", "Interests", "Discuss films and series. Ask for opinions and avoid unwanted spoilers.", 1),
    theme("books", "Between the pages", "A story that stayed", "book", "Interests", "Chat about books, characters, stories and why they matter to the learner.", 3),
    theme("design", "Good things", "Made with a little care", "pencil.and.outline", "Interests", "Explore design, architecture and objects the learner loves. Ask for concrete opinions.", 0),
    theme("technology", "What comes next", "Ideas, tools and tomorrow", "sparkles", "Interests", "Discuss technology and how it changes daily life. Delegate claims needing current facts.", 1),
    theme("travelstories", "Somewhere else", "A place you remember", "globe.europe.africa", "Interests", "Exchange travel stories and dream destinations. Invite descriptions and comparisons.", 2),
    theme("restaurant", "A table for two", "Stay for dessert", "wineglass", "Everyday", "Role-play a restaurant meal. Practise requests, preferences and polite problem-solving.", 0),
    theme("neighbours", "Next door", "A familiar face", "building.2", "Connection", "Chat as neighbours. Discuss the neighbourhood and small requests for help.", 3),
    theme("traditions", "Everyday customs", "Small customs, big stories", "flag", "Local life", "Explore everyday customs with nuance. Avoid treating a whole culture as alike.", 2),
    theme("opinions", "What do you think?", "Room for another view", "quote.bubble", "Connection", "Choose an everyday dilemma. Invite reasons and gently explore another perspective.", 1),
    theme("future", "A year from now", "Plans worth talking about", "paperplane", "Connection", "Talk about hopes and future plans. Explore possibilities and practical next steps.", 3),
    theme("today", "The world today", "Something to talk about", "newspaper", "Interests", "Ask what current topic interests the learner, then delegate a source-backed lookup before discussing facts.", 0),
];

/// A target language's content and teaching policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageModule {
    pub id: &'static str,
    pub name: &'static str,
    pub native_name: &'static str,
    pub variety: &'static str,
    pub locale: &'static str,
    pub greeting: &'static str,
    pub greeting_word: &'static str,
    /// How the model should sound. Drives the spoken-reply prompt.
    pub speech_guidance: &'static str,
    /// How the model should spell and punctuate. Drives written output.
    pub writing_guidance: &'static str,
    /// Dictionary form rules. Drives vocabulary capture, not correction.
    pub lemma_guidance: &'static str,
    /// Six ascending focus bands. See [`LanguageModule::focus_for_dial`] for how
    /// these map onto MeetOdds' three-level dial.
    pub teaching_focus: [&'static str; 6],
    pub topic_placeholder: &'static str,
    /// Said in-language when a requested lookup could not be verified.
    pub lookup_unavailable_reply: &'static str,
    /// Replaces the shared theme sharing its `id`.
    pub theme_overrides: &'static [ConversationTheme],
}

impl LanguageModule {
    /// Shared themes with this language's overrides substituted in place.
    /// Order follows [`SHARED_THEMES`]; overrides never add or reorder entries.
    pub fn themes(&self) -> Vec<ConversationTheme> {
        SHARED_THEMES
            .iter()
            .map(|shared| {
                self.theme_overrides
                    .iter()
                    .find(|o| o.id == shared.id)
                    .copied()
                    .unwrap_or(*shared)
            })
            .collect()
    }

    /// Mural exposes six focus bands; the MeetOdds tutor carries a three-step
    /// dial (0 beginner, 1 intermediate, 2 advanced). Each dial position takes
    /// the two adjacent bands so no guidance is dropped: 0 -> [0,1],
    /// 1 -> [2,3], 2 -> [4,5]. Out-of-range dials clamp to advanced.
    pub fn focus_for_dial(&self, dial: u8) -> [&'static str; 2] {
        let base = (dial.min(2) as usize) * 2;
        [self.teaching_focus[base], self.teaching_focus[base + 1]]
    }

    pub fn default_title(&self) -> String {
        format!("A little {}", self.name)
    }
    pub fn talk_title(&self) -> String {
        format!("A little everyday {}", self.name)
    }
    pub fn settings_title(&self) -> String {
        format!("{} · {}", self.name, self.variety)
    }
}

/// Language id used when a profile has none stored.
pub const DEFAULT_LANGUAGE_ID: &str = "nb";

/// Registry order is the order Mural offers the languages in. Hindi was
/// added on the MeetOdds side and is appended so no stored index shifts.
pub static LANGUAGES: [LanguageModule; 9] = [
    NORWEGIAN, SPANISH, ENGLISH, FRENCH, GERMAN, ITALIAN, PORTUGUESE, MANDARIN, HINDI,
];

/// Looks up a module by its stable id. Unknown ids return `None` rather than
/// silently falling back, so callers decide whether a stored id is recoverable.
pub fn module(id: &str) -> Option<&'static LanguageModule> {
    LANGUAGES.iter().find(|m| m.id == id)
}

/// The module for `id`, or the default language when `id` is unknown or empty.
pub fn module_or_default(id: &str) -> &'static LanguageModule {
    module(id).unwrap_or_else(|| module(DEFAULT_LANGUAGE_ID).expect("default language present"))
}

/// Languages the learner can read meanings/subtitles in.
pub static MEANING_LANGUAGES: [&str; 11] = [
    "English", "French", "German", "Spanish", "Norwegian", "Portuguese", "Italian",
    "Chinese (Simplified)", "Polish", "Arabic", "Ukrainian",
];

/// Greeting shown in the learner's chosen meaning language. Unknown names fall
/// back to English, matching Mural.
pub fn meaning_greeting(language: &str) -> &'static str {
    match language {
        "English" => "Hi!",
        "French" => "Salut !",
        "German" => "Hallo!",
        "Spanish" => "¡Hola!",
        "Norwegian" => "Hei!",
        "Portuguese" => "Olá!",
        "Italian" => "Ciao!",
        "Chinese (Simplified)" | "Chinese" => "你好！",
        "Polish" => "Cześć!",
        "Arabic" => "مرحبًا!",
        "Ukrainian" => "Привіт!",
        _ => "Hi!",
    }
}

// ---------------------------------------------------------------------------
// Language modules. Verbatim ports; see the fidelity note at the top of file.
// ---------------------------------------------------------------------------

pub static NORWEGIAN: LanguageModule = LanguageModule {
    id: "nb", name: "Norwegian", native_name: "Norsk", variety: "Bokmål", locale: "nb-NO",
    greeting: "Hei!", greeting_word: "hei",
    speech_guidance: "Use natural Eastern Norwegian pronunciation. Accept other Norwegian dialects without treating dialect differences as errors.",
    writing_guidance: "Use Norwegian Bokmål spelling and wording.",
    lemma_guidance: "Give nouns with their singular grammatical article and verbs in the infinitive, for example en tur and å gå. Accept valid gender variants.",
    teaching_focus: [
        "Greetings, introductions and short everyday chunks.",
        "Simple questions, noun gender and present-tense everyday exchanges.",
        "Connected stories, past tense, word order and familiar situations.",
        "Reasons and opinions, subordinate clauses and natural connectors.",
        "Nuanced discussion, idiomatic phrasing and register.",
        "Flexible advanced conversation with precise, natural Norwegian.",
    ],
    topic_placeholder: "Design, space, life in Norway…",
    lookup_unavailable_reply: "Jeg klarte ikke å sjekke det akkurat nå. Vi kan snakke om temaet generelt, hvis du vil.",
    theme_overrides: &[
        theme("groceries", "At the market", "Find the good tomatoes", "basket", "Everyday", "Help the learner shop at a Norwegian food market. Practise quantities and questions.", 2),
        theme("travel", "Next stop", "A ticket to somewhere", "tram", "Everyday", "Plan a train trip in Norway. Discuss routes and tickets without inventing current schedules.", 1),
        theme("weather", "Rain again?", "A very Norwegian chat", "cloud.rain", "Local life", "Talk about weather, clothing and outdoor plans in Norway. Verify current forecasts before claiming them.", 1),
        theme("cabin", "Cabin weekend", "A quieter kind of day", "mountain.2", "Local life", "Plan a hytte weekend: travel, food, walks and relaxing together.", 2),
        theme("traditions", "Life in Norway", "Small customs, big stories", "flag", "Local life", "Explore Norwegian everyday customs with nuance. Avoid treating all Norwegians as alike.", 2),
    ],
};

pub static SPANISH: LanguageModule = LanguageModule {
    id: "es", name: "Spanish", native_name: "Español", variety: "Spain", locale: "es-ES",
    greeting: "¡Hola!", greeting_word: "hola",
    speech_guidance: "Use clear Spanish from Spain, with a natural distinction between s and z/soft c, tú for friendly singular address and vosotros for informal plural address. Accept seseo, ustedes, voseo and other valid regional forms without marking them wrong. Do not imitate a regional caricature.",
    writing_guidance: "Use standard Spanish spelling, accents and opening question and exclamation marks.",
    lemma_guidance: "Give nouns with their singular grammatical article and verbs in the infinitive, for example la casa and hablar. Keep reflexive verbs such as llamarse distinct. Preserve accents and ñ.",
    teaching_focus: [
        "Greetings, introductions and short useful chunks such as me llamo and quiero.",
        "Everyday questions, gender and number agreement, present tense and useful ser/estar contrasts.",
        "Connected stories, past events, object pronouns and familiar situations.",
        "Reasons and opinions, contrasts between past tenses and common subjunctive contexts.",
        "Nuance, hypothetical situations, register and regional variation.",
        "Flexible advanced discussion with precise, idiomatic Spanish.",
    ],
    topic_placeholder: "Food, travel, music, life in Spain…",
    lookup_unavailable_reply: "No he podido comprobarlo ahora mismo. Si quieres, podemos hablar del tema en general.",
    theme_overrides: &[
        theme("coffee", "Un café", "Something warm, please", "cup.and.saucer", "Everyday", "Meet in a neighbourhood café in Spain. Order a drink and chat. Ask about the learner's interests.", 0),
        theme("groceries", "En el mercado", "A little of everything", "basket", "Everyday", "Visit a local market in a Spanish-speaking community. Practise quantities, prices and polite questions. Respect regional food vocabulary.", 2),
        theme("travel", "Next stop", "A ticket to somewhere", "tram", "Everyday", "Plan a trip in Spain. Discuss transport and tickets without inventing current schedules.", 1),
        theme("cabin", "A weekend away", "Somewhere in the sunshine", "mountain.2", "Local life", "Plan an imagined weekend in a Spanish-speaking place. Choose a city, coast or countryside together and discuss practical plans.", 2),
        theme("traditions", "La sobremesa", "Let the conversation linger", "fork.knife", "Local life", "Talk after a shared meal about daily routines, family and local customs. Compare experiences without treating Spanish-speaking cultures as uniform.", 2),
    ],
};

pub static ENGLISH: LanguageModule = LanguageModule {
    id: "en", name: "English", native_name: "English", variety: "International", locale: "en",
    greeting: "Hi!", greeting_word: "hi",
    speech_guidance: "Use clear, broadly intelligible English with a consistent, natural pronunciation. Accept valid regional accents, vocabulary and grammar, including British and American forms. Do not treat an accent difference as an error or require imitation of a native accent. Correct pronunciation only when meaning is unclear and the audio supports the correction.",
    writing_guidance: "Use standard English spelling and punctuation. Keep one spelling convention within your own reply, but accept valid regional spelling and usage from the learner.",
    lemma_guidance: "Give countable nouns in the singular and verbs in the base form, for example a journey and go. Keep meaningful phrasal verbs such as look after together. Use a short, plain English definition as the stable sense rather than repeating the word itself.",
    teaching_focus: [
        "Greetings, introductions and useful everyday chunks such as I'd like and my name is.",
        "Everyday questions, present forms, articles and common countable and uncountable nouns.",
        "Connected stories, past events, future plans and familiar situations.",
        "Reasons and opinions, present perfect in context, conditionals and natural linking phrases.",
        "Nuance, idiomatic expressions, reported speech and appropriate register.",
        "Flexible advanced discussion with precise language, implication and tact.",
    ],
    topic_placeholder: "Travel, films, work, everyday life…",
    lookup_unavailable_reply: "I couldn't check that just now. We can talk about the topic more generally, if you like.",
    theme_overrides: &[
        theme("coffee", "A coffee?", "Something warm, please", "cup.and.saucer", "Everyday", "Meet in a neighbourhood café. Order a drink and chat in English. Follow the learner's interests and accept regional vocabulary.", 0),
        theme("travel", "Next stop", "A ticket to somewhere", "tram", "Everyday", "Plan a trip using English. Let the learner choose the destination. Discuss transport and tickets without inventing current schedules.", 1),
        theme("traditions", "Everyday customs", "Small customs, big stories", "flag", "Local life", "Compare everyday customs from places the learner knows. English is used across many cultures; avoid presenting one country's habits as universal.", 2),
    ],
};

pub static FRENCH: LanguageModule = LanguageModule {
    id: "fr", name: "French", native_name: "Français", variety: "France", locale: "fr-FR",
    greeting: "Salut !", greeting_word: "salut",
    speech_guidance: "Use clear, natural metropolitan French pronunciation. Use tu in a friendly conversation and vous when the situation calls for formality or plural address. Accept valid regional accents, vocabulary and grammar from across the French-speaking world. Do not treat regional variation, informal omission of ne or a non-native accent alone as an error. Do not imitate a regional caricature.",
    writing_guidance: "Use standard French spelling, accents, apostrophes and punctuation. Preserve accents on capital letters. Match the register to the situation and accept valid regional usage from the learner.",
    lemma_guidance: "Give nouns with a singular article that makes gender clear where possible and verbs in the infinitive, for example une maison, un ami and parler. Keep pronominal verbs such as se souvenir distinct. Preserve accents and meaningful elisions.",
    teaching_focus: [
        "Greetings, introductions and useful everyday chunks such as je m'appelle and je voudrais.",
        "Everyday questions, grammatical gender, present tense and common negation in conversation.",
        "Connected stories, passé composé and imparfait in context, future plans and familiar situations.",
        "Reasons and opinions, object pronouns, conditional requests and common subjunctive contexts.",
        "Nuance, hypothetical situations, register, idiomatic phrasing and regional variation.",
        "Flexible advanced discussion with precise, natural French and appropriate tone.",
    ],
    topic_placeholder: "Food, cinema, travel, life in France…",
    lookup_unavailable_reply: "Je n'ai pas pu vérifier ça pour le moment. On peut parler du sujet en général, si tu veux.",
    theme_overrides: &[
        theme("coffee", "Un café ?", "Something warm, please", "cup.and.saucer", "Everyday", "Meet in a neighbourhood café in France. Order a drink and chat. Use polite greetings with staff and a friendly register with the learner.", 0),
        theme("groceries", "Au marché", "A little of everything", "basket", "Everyday", "Visit a local market in France. Practise quantities, prices and polite requests, then ask what the learner likes to cook.", 2),
        theme("travel", "En route", "A ticket to somewhere", "tram", "Everyday", "Plan a trip in France. Discuss transport, directions and tickets without inventing current schedules.", 1),
        theme("cabin", "A weekend away", "A change of scene", "mountain.2", "Local life", "Plan an imagined weekend in a French-speaking place. Choose a city, coast or countryside together and discuss practical plans.", 2),
        theme("traditions", "À table", "Stay a little longer", "fork.knife", "Local life", "Talk over an imagined meal about daily routines and local customs. Compare the learner's experiences with life in France without treating French-speaking cultures as uniform.", 2),
    ],
};

pub static GERMAN: LanguageModule = LanguageModule {
    id: "de", name: "German", native_name: "Deutsch", variety: "Germany", locale: "de-DE",
    greeting: "Hallo!", greeting_word: "hallo",
    speech_guidance: "Use clear, natural Standard German as spoken in Germany. Use du for friendly conversation and Sie when the situation calls for formality. Accept valid Austrian, Swiss and other regional pronunciation, vocabulary and grammar. Do not treat a regional difference or a non-native accent alone as an error. Correct pronunciation only when supported by the audio, not a transcript alone.",
    writing_guidance: "Use standard German spelling, noun capitalization, umlauts and ß. Accept Swiss ss spellings and valid regional wording. Match the register to the situation.",
    lemma_guidance: "Give nouns with their singular article and verbs in the infinitive, for example das Haus, die Straße and sprechen. Preserve umlauts and ß. Keep separable verbs such as aufstehen and reflexive verbs such as sich erinnern together as dictionary entries, while quoting the learner's actual word order exactly.",
    teaching_focus: [
        "Greetings, introductions and useful everyday chunks such as ich heiße and ich möchte.",
        "Everyday questions, grammatical gender, present tense, verb-second word order and common accusative objects.",
        "Connected stories, conversational past tenses, dative uses, separable verbs and familiar situations.",
        "Reasons and opinions, subordinate-clause word order, relative clauses and polite Konjunktiv II requests.",
        "Nuance, hypothetical situations, passive voice, idiomatic phrasing and regional register.",
        "Flexible advanced discussion with precise, natural German and appropriate tone.",
    ],
    topic_placeholder: "Food, travel, music, life in Germany…",
    lookup_unavailable_reply: "Das konnte ich gerade nicht überprüfen. Wenn du möchtest, können wir allgemein über das Thema sprechen.",
    theme_overrides: &[
        theme("coffee", "Ein Kaffee?", "Something warm, please", "cup.and.saucer", "Everyday", "Meet in a neighbourhood café in Germany. Order a drink and chat. Use polite greetings with staff and follow the learner's interests.", 0),
        theme("groceries", "Auf dem Markt", "A little of everything", "basket", "Everyday", "Shop at a weekly market in Germany. Practise quantities, prices and polite requests, accepting regional names for foods.", 2),
        theme("travel", "Unterwegs", "A ticket to somewhere", "tram", "Everyday", "Plan a trip in Germany. Discuss transport, directions and tickets without inventing current schedules.", 1),
        theme("cabin", "A weekend away", "A change of scene", "mountain.2", "Local life", "Plan an imagined weekend in a German-speaking place. Choose a city, coast or countryside together and discuss practical plans.", 2),
        theme("traditions", "Feierabend", "After the working day", "flag", "Local life", "Talk about routines after work and local customs in Germany. Compare the learner's experiences without treating German-speaking cultures as uniform.", 2),
    ],
};

pub static ITALIAN: LanguageModule = LanguageModule {
    id: "it", name: "Italian", native_name: "Italiano", variety: "Italy", locale: "it-IT",
    greeting: "Ciao!", greeting_word: "ciao",
    speech_guidance: "Use clear, natural Standard Italian pronunciation. Use tu for friendly conversation and Lei when the situation calls for formality. Model vowel sounds, word stress and consonant length naturally. Accept valid regional accents and vocabulary without treating regional variation or a non-native accent alone as an error. Do not infer a pronunciation error from spelling alone.",
    writing_guidance: "Use standard Italian spelling, accents, apostrophes and punctuation. Preserve meaningful contrasts such as e and è. Match the register to the situation and accept valid regional usage.",
    lemma_guidance: "Give nouns with their singular article and verbs in the infinitive, for example la casa, lo studente and parlare. Preserve elisions and accents. Keep reflexive verbs such as chiamarsi and pronominal verbs such as farcela distinct.",
    teaching_focus: [
        "Greetings, introductions and useful everyday chunks such as mi chiamo and vorrei.",
        "Everyday questions, gender and number agreement, present tense and common prepositions.",
        "Connected stories, passato prossimo and imperfetto in context, future plans and familiar situations.",
        "Reasons and opinions, object pronouns, conditional requests and common congiuntivo contexts.",
        "Nuance, hypothetical situations, pronoun combinations, idiomatic phrasing and regional register.",
        "Flexible advanced discussion with precise, natural Italian and appropriate tone.",
    ],
    topic_placeholder: "Food, cinema, travel, life in Italy…",
    lookup_unavailable_reply: "Non sono riuscito a verificarlo adesso. Se vuoi, possiamo parlare dell'argomento in generale.",
    theme_overrides: &[
        theme("coffee", "Un caffè?", "Something warm, please", "cup.and.saucer", "Everyday", "Meet at a neighbourhood bar in Italy for a coffee. Order a drink, greet the staff politely and chat about the learner's day.", 0),
        theme("groceries", "Al mercato", "A little of everything", "basket", "Everyday", "Visit a local market in Italy. Practise quantities, prices and polite requests, then ask what the learner likes to cook.", 2),
        theme("travel", "In viaggio", "A ticket to somewhere", "tram", "Everyday", "Plan a trip in Italy. Discuss transport, directions and tickets without inventing current schedules.", 1),
        theme("cabin", "A weekend away", "A change of scene", "mountain.2", "Local life", "Plan an imagined weekend in Italy. Choose a city, coast or countryside together and discuss practical plans.", 2),
        theme("traditions", "La passeggiata", "An evening walk", "figure.walk", "Local life", "Take an imagined evening walk and discuss daily routines and local customs. Compare experiences without treating Italian communities as uniform.", 2),
    ],
};

pub static PORTUGUESE: LanguageModule = LanguageModule {
    id: "pt", name: "Portuguese", native_name: "Português", variety: "Brazil", locale: "pt-BR",
    greeting: "Olá!", greeting_word: "olá",
    speech_guidance: "Use clear, natural Brazilian Portuguese with broadly intelligible pronunciation and consistent Brazilian vocabulary. Use você in friendly conversation and formal address when appropriate. Accept valid uses of tu, regional Brazilian accents and grammar, and European, African and other Portuguese varieties without marking them wrong. Do not imitate a regional caricature or infer pronunciation errors from a transcript alone.",
    writing_guidance: "Use standard contemporary Brazilian Portuguese spelling, accents, ã, õ and ç. Prefer everyday Brazilian wording, including a gente and conversational pronoun placement when natural. Accept valid regional and European Portuguese usage from the learner.",
    lemma_guidance: "Give nouns with their singular article and verbs in the infinitive, for example a casa, o pão and falar. Preserve accents, nasal vowels and ç. Keep reflexive and pronominal verbs such as se lembrar distinct. Use a consistent Brazilian dictionary form without treating regional alternatives as errors.",
    teaching_focus: [
        "Greetings, introductions and useful everyday chunks such as meu nome é and eu gostaria de.",
        "Everyday questions, gender and number agreement, present tense, ser and estar, and você and a gente.",
        "Connected stories, pretérito perfeito and imperfeito in context, future plans and familiar situations.",
        "Reasons and opinions, object pronouns, polite requests and common subjunctive contexts.",
        "Nuance, future subjunctive, personal infinitive, hypothetical situations, idiomatic phrasing and regional register.",
        "Flexible advanced discussion with precise, natural Brazilian Portuguese and appropriate tone.",
    ],
    topic_placeholder: "Food, music, travel, life in Brazil…",
    lookup_unavailable_reply: "Não consegui verificar isso agora. Se quiser, podemos conversar sobre o assunto de forma geral.",
    theme_overrides: &[
        theme("coffee", "Um cafezinho?", "Something warm, please", "cup.and.saucer", "Everyday", "Meet at a neighbourhood café or padaria in Brazil. Order a drink and chat about the learner's day, using natural Brazilian vocabulary.", 0),
        theme("groceries", "Na feira", "A little of everything", "basket", "Everyday", "Shop at a street market in Brazil. Practise quantities, prices and polite requests, respecting regional food names.", 2),
        theme("travel", "Pé na estrada", "A ticket to somewhere", "tram", "Everyday", "Plan a trip in Brazil. Discuss transport, directions and tickets without inventing current schedules.", 1),
        theme("cabin", "A weekend away", "A change of scene", "mountain.2", "Local life", "Plan an imagined weekend in Brazil. Choose a city, coast or countryside together and discuss practical plans.", 2),
        theme("traditions", "Uma conversa à mesa", "Stay a little longer", "fork.knife", "Local life", "Talk over an imagined meal about routines and local customs in Brazil. Compare the learner's experiences without treating Brazilian or Portuguese-speaking cultures as uniform.", 2),
    ],
};

pub static MANDARIN: LanguageModule = LanguageModule {
    id: "zh", name: "Mandarin Chinese", native_name: "普通话", variety: "Mainland China", locale: "zh-CN",
    greeting: "你好！", greeting_word: "你好",
    speech_guidance: "Use clear, natural Standard Mandarin pronunciation. Treat tones, tone changes, retroflex and non-retroflex sounds, and distinctions between initials and finals as meaningful when they affect understanding. Accept valid regional accents and vocabulary without treating a regional difference or a non-native accent alone as an error. Do not imitate a regional caricature.",
    writing_guidance: "Use natural Simplified Chinese and standard modern punctuation. Prefer everyday Mainland usage while accepting valid regional wording and Traditional Chinese input. Keep Chinese text free of unnecessary spaces. The app displays pinyin separately; do not append pinyin or translations to ordinary spoken replies. Explain characters and tones briefly in Mandarin when asked.",
    lemma_guidance: "Give vocabulary lemmas in simplified characters only, with no pinyin or English in the lemma; the app supplies pronunciation help separately. Keep the exact observed form and quote, including Traditional Chinese or learner-written pinyin. Use dictionary forms and preserve meaningful chunks such as 洗澡 and 见面. Do not infer tone accuracy, pronunciation or spoken recall from typed pinyin or a transcript alone.",
    teaching_focus: [
        "Greetings, introductions and useful everyday chunks such as 我叫 and 我想要.",
        "Everyday questions, word order, measure words, numbers and common present-time exchanges.",
        "Connected stories, completed actions with 了, experiences with 过, and familiar situations.",
        "Reasons and opinions, comparisons, 把 and 被 constructions, and natural linking phrases.",
        "Nuance, aspect, conditionals, idiomatic phrasing, register and regional variation.",
        "Flexible advanced discussion with precise, natural Mandarin and appropriate tone.",
    ],
    topic_placeholder: "Food, travel, films, everyday life…",
    lookup_unavailable_reply: "我现在没法查证这件事。如果你愿意，我们可以先聊聊这个话题的一般情况。",
    theme_overrides: &[
        theme("coffee", "喝杯咖啡？", "Something warm, please", "cup.and.saucer", "Everyday", "在一家社区咖啡馆见面。用普通话点饮料并聊天，跟着学习者的兴趣展开对话。", 0),
        theme("groceries", "去买菜", "Find something good", "basket", "Everyday", "在菜市场或超市买日常食材。练习数量、价格和礼貌的提问，尊重不同地区的食物词汇。", 2),
        theme("travel", "下一站", "A ticket to somewhere", "tram", "Everyday", "用普通话计划一次旅行。讨论交通、方向和买票，不要编造当前的时刻表。", 1),
        theme("cabin", "周末出游", "A change of scene", "mountain.2", "Local life", "一起设想一个周末旅行，选择城市、海边或乡村，讨论实际安排和喜欢做的事情。", 2),
        theme("traditions", "日常习俗", "Small customs, big stories", "flag", "Local life", "用普通话聊日常习俗和节日。比较学习者熟悉的地方，避免把任何一种习惯说成所有人的共同体验。", 2),
    ],
};

/// Hindi, taught in ROMAN SCRIPT by design. Learners speak Hindi and build a
/// spoken vocabulary; they are explicitly not learning to read or write
/// Devanagari, so no learner-facing string here (or in the Hindi scenes, free
/// talk, grammar wording or prompts) may contain a Devanagari codepoint
/// (U+0900..=U+097F) or an IAST diacritic. `native_name` is "Hindi" in Latin
/// letters for the same reason: a learner who cannot read Devanagari should not
/// meet it in the language picker. See docs/SCENE-AUTHORING.md.
///
/// Not a Mural port: authored for MeetOdds against the same policy shape, with
/// the same fluent-speaker-review caveat as the generated scene content.
pub static HINDI: LanguageModule = LanguageModule {
    id: "hi", name: "Hindi", native_name: "Hindi", variety: "India", locale: "hi-IN",
    greeting: "Namaste!", greeting_word: "namaste",
    speech_guidance: "Use clear, natural everyday Hindi as spoken in India, not formal or Sanskritised. Use aap with strangers and in service situations and tum between friends; never model tu. Roman spelling gives few cues, so model dental versus retroflex t and d, aspiration, vowel length and nasal vowels clearly. Match verb and adjective gender to the learner once known. Never mark a learner wrong for how a word was romanised or infer a pronunciation error from a transcript alone.",
    writing_guidance: "Write Hindi in the Roman alphabet only, in the everyday spelling of texting and Hinglish, for example Aap kya peena chahenge? Never write Devanagari and never use IAST or any diacritics: plain ASCII letters only. Keep one romanisation within your reply (hai/hain, nahi, kya, chahiye, mein for in, main for I) and accept any reasonable learner spelling. Everyday English loanwords such as bus, time and phone are normal Hindi, not errors. End questions with ?.",
    lemma_guidance: "Give lemmas in Roman script only, never Devanagari, as the spoken word a learner would say and could look up: nouns in the singular with gender noted, for example kitaab (f) and ghar (m), and verbs in the -na infinitive, for example jaana and khaana. Keep compound verbs such as le jaana and pasand karna together. A romanisation variant is the same word, not a new lemma.",
    teaching_focus: [
        "Greetings, introductions and short everyday chunks such as mera naam and mujhe chahiye.",
        "Simple questions with kya and question words, hai/hain, aap and tum, postpositions such as mein, pe and ko, and noun gender.",
        "Connected stories, the past with tha/thi/the and ne, gender and number agreement on verbs and adjectives, and familiar situations.",
        "Reasons and opinions, ki and kyunki clauses, compound verbs, the subjunctive with agar, and polite requests.",
        "Nuance, register and honorifics, particles such as toh, hi and bhi, the presumptive and counterfactual, and idiomatic phrasing.",
        "Flexible advanced conversation with precise, natural Hindi and appropriate tone.",
    ],
    topic_placeholder: "Food, films, cricket, life in India…",
    lookup_unavailable_reply: "Abhi yeh check nahi ho paaya. Chaho toh hum is baare mein aam taur pe baat kar sakte hain.",
    theme_overrides: &[
        theme("coffee", "Ek chai?", "Something warm, please", "cup.and.saucer", "Everyday", "Meet at a neighbourhood chai stall or café in India. Order a drink and chat. Use aap with the staff and follow the learner's interests.", 0),
        theme("groceries", "Sabzi mandi", "A little of everything", "basket", "Everyday", "Shop at a local vegetable market in India. Practise quantities, prices and polite requests, accepting regional names for foods.", 2),
        theme("travel", "Agla station", "A ticket to somewhere", "tram", "Everyday", "Plan a train trip in India. Discuss routes and tickets without inventing current schedules.", 1),
        theme("cabin", "A weekend away", "A change of scene", "mountain.2", "Local life", "Plan an imagined weekend away in India. Choose hills, coast or a city together and discuss practical plans.", 2),
        theme("traditions", "Chai pe baatein", "Small customs, big stories", "flag", "Local life", "Talk over chai about daily routines, festivals and local customs in India. Compare the learner's experiences without treating Hindi-speaking communities as uniform.", 2),
    ],
};

// ---------------------------------------------------------------------------
// Tutor integration
// ---------------------------------------------------------------------------

/// Per-language guidance block for the tutoring prompts.
///
/// The Spanish engine (`crate::spanish`) currently hard-codes its Spanish
/// system prompts. This renders the equivalent block from any language module so
/// the prompt builders can be parameterised by language rather than rewritten
/// per language. `dial` is the tutor's 0..=2 level dial.
pub fn tutor_guidance(module: &LanguageModule, dial: u8) -> String {
    let focus = module.focus_for_dial(dial);
    format!(
        "Target language: {name} ({native}, {variety}).\n\
         Speech: {speech}\n\
         Writing: {writing}\n\
         Vocabulary lemmas: {lemma}\n\
         Focus at this level: {focus_a} {focus_b}",
        name = module.name,
        native = module.native_name,
        variety = module.variety,
        speech = module.speech_guidance,
        writing = module.writing_guidance,
        lemma = module.lemma_guidance,
        focus_a = focus[0],
        focus_b = focus[1],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_carries_every_mural_language() {
        let ids: Vec<_> = LANGUAGES.iter().map(|m| m.id).collect();
        assert_eq!(ids, ["nb", "es", "en", "fr", "de", "it", "pt", "zh", "hi"]);
    }

    #[test]
    fn hindi_is_registered_and_complete() {
        let hi = module("hi").expect("Hindi registered");
        assert_eq!((hi.name, hi.native_name, hi.variety, hi.locale), ("Hindi", "Hindi", "India", "hi-IN"));
        assert_eq!((hi.greeting, hi.greeting_word), ("Namaste!", "namaste"));
        assert!(hi.teaching_focus.iter().all(|f| !f.is_empty()));
        assert!(!hi.lookup_unavailable_reply.is_empty());
        assert_eq!(hi.settings_title(), "Hindi · India");
        // Existing entries keep their positions: Hindi is appended, not inserted.
        assert_eq!(LANGUAGES[8].id, "hi");
        assert_eq!(LANGUAGES[7].id, "zh");
        assert_eq!(module_or_default("hi").id, "hi");
    }

    /// The defining Hindi requirement: learners speak Hindi and never read
    /// Devanagari, so no module field may carry a Devanagari codepoint
    /// (U+0900..=U+097F), and learner-facing text uses plain ASCII letters
    /// (no IAST diacritics such as ā, ṭ or ṃ).
    #[test]
    fn hindi_module_carries_no_devanagari_anywhere() {
        let hi = module("hi").unwrap();
        let is_deva = |c: char| ('\u{0900}'..='\u{097F}').contains(&c);
        let mut fields: Vec<(&str, &str)> = vec![
            ("name", hi.name),
            ("native_name", hi.native_name),
            ("variety", hi.variety),
            ("locale", hi.locale),
            ("greeting", hi.greeting),
            ("greeting_word", hi.greeting_word),
            ("speech_guidance", hi.speech_guidance),
            ("writing_guidance", hi.writing_guidance),
            ("lemma_guidance", hi.lemma_guidance),
            ("topic_placeholder", hi.topic_placeholder),
            ("lookup_unavailable_reply", hi.lookup_unavailable_reply),
        ];
        fields.extend(hi.teaching_focus.iter().map(|f| ("teaching_focus", *f)));
        for t in hi.themes() {
            fields.extend([("theme.title", t.title), ("theme.subtitle", t.subtitle), ("theme.situation", t.situation)]);
        }
        for (name, text) in &fields {
            assert!(!text.chars().any(is_deva), "{name} contains Devanagari: {text}");
        }
        // Learner-facing strings are plain ASCII letters; ellipsis and · are punctuation, not letters.
        for text in [hi.native_name, hi.greeting, hi.greeting_word, hi.lookup_unavailable_reply] {
            assert!(text.chars().filter(|c| c.is_alphabetic()).all(|c| c.is_ascii()), "{text}");
        }
        for t in hi.theme_overrides {
            assert!(t.title.chars().filter(|c| c.is_alphabetic()).all(|c| c.is_ascii()), "{}", t.title);
        }
        // The guidance says the load-bearing things out loud.
        assert!(hi.writing_guidance.contains("Roman alphabet only"));
        assert!(hi.writing_guidance.contains("Never write Devanagari"));
        assert!(hi.writing_guidance.contains("loanwords") && hi.writing_guidance.contains("not errors"));
        assert!(hi.lemma_guidance.contains("Roman script only"));
        assert!(hi.speech_guidance.contains("never model tu"));
        assert!(hi.speech_guidance.contains("romanised"));
        assert!(tutor_guidance(hi, 0).contains("Hindi (Hindi, India)"));
    }

    #[test]
    fn the_four_new_languages_are_present_and_complete() {
        for id in ["de", "it", "pt", "zh"] {
            let m = module(id).expect("new language registered");
            assert!(!m.greeting.is_empty(), "{id} greeting");
            assert!(!m.speech_guidance.is_empty(), "{id} speech guidance");
            assert!(!m.writing_guidance.is_empty(), "{id} writing guidance");
            assert!(!m.lemma_guidance.is_empty(), "{id} lemma guidance");
            assert!(!m.lookup_unavailable_reply.is_empty(), "{id} lookup reply");
            assert!(m.teaching_focus.iter().all(|f| !f.is_empty()), "{id} focus");
        }
    }

    #[test]
    fn ids_are_unique_and_stable_storage_keys() {
        let mut seen = std::collections::HashSet::new();
        for m in LANGUAGES.iter() {
            assert!(seen.insert(m.id), "duplicate language id {}", m.id);
        }
    }

    #[test]
    fn unknown_ids_do_not_silently_resolve() {
        assert!(module("xx").is_none());
        assert!(module("").is_none());
        assert_eq!(module_or_default("xx").id, DEFAULT_LANGUAGE_ID);
        assert_eq!(module_or_default("es").id, "es");
    }

    #[test]
    fn default_language_exists() {
        assert!(module(DEFAULT_LANGUAGE_ID).is_some());
    }

    #[test]
    fn themes_keep_shared_order_and_count() {
        for m in LANGUAGES.iter() {
            let themes = m.themes();
            assert_eq!(themes.len(), SHARED_THEMES.len(), "{} theme count", m.id);
            for (resolved, shared) in themes.iter().zip(SHARED_THEMES.iter()) {
                assert_eq!(resolved.id, shared.id, "{} theme order", m.id);
            }
        }
    }

    #[test]
    fn overrides_replace_the_shared_theme_they_name() {
        let es = module("es").unwrap();
        let coffee = es.themes().into_iter().find(|t| t.id == "coffee").unwrap();
        assert_eq!(coffee.title, "Un café");
        // Norwegian has no coffee override, so it keeps the shared one.
        let nb = module("nb").unwrap();
        let shared_coffee = nb.themes().into_iter().find(|t| t.id == "coffee").unwrap();
        assert_eq!(shared_coffee.title, "A coffee?");
    }

    #[test]
    fn every_override_names_an_existing_shared_theme() {
        for m in LANGUAGES.iter() {
            for o in m.theme_overrides.iter() {
                assert!(
                    SHARED_THEMES.iter().any(|s| s.id == o.id),
                    "{} overrides unknown theme {}",
                    m.id,
                    o.id
                );
            }
        }
    }

    #[test]
    fn focus_bands_cover_all_six_across_the_dial() {
        let m = module("de").unwrap();
        assert_eq!(m.focus_for_dial(0), [m.teaching_focus[0], m.teaching_focus[1]]);
        assert_eq!(m.focus_for_dial(1), [m.teaching_focus[2], m.teaching_focus[3]]);
        assert_eq!(m.focus_for_dial(2), [m.teaching_focus[4], m.teaching_focus[5]]);
        // Out-of-range clamps rather than panicking on a bad stored dial.
        assert_eq!(m.focus_for_dial(9), m.focus_for_dial(2));
    }

    #[test]
    fn titles_match_mural_formatting() {
        let m = module("pt").unwrap();
        assert_eq!(m.default_title(), "A little Portuguese");
        assert_eq!(m.talk_title(), "A little everyday Portuguese");
        assert_eq!(m.settings_title(), "Portuguese · Brazil");
    }

    #[test]
    fn meaning_greetings_cover_the_offered_list_and_fall_back() {
        // English's own greeting is "Hi!", which is also the fallback, so
        // coverage is checked per language rather than against the fallback.
        assert_eq!(meaning_greeting("English"), "Hi!");
        for name in MEANING_LANGUAGES.iter().filter(|n| **n != "English") {
            assert_ne!(
                meaning_greeting(name),
                "Hi!",
                "{name} should have its own greeting, not the fallback"
            );
        }
        assert_eq!(meaning_greeting("Klingon"), "Hi!");
        // Mural accepts both spellings for Chinese.
        assert_eq!(meaning_greeting("Chinese"), meaning_greeting("Chinese (Simplified)"));
    }

    #[test]
    fn tutor_guidance_carries_the_language_policy_into_the_prompt() {
        let zh = module("zh").unwrap();
        let g = tutor_guidance(zh, 0);
        assert!(g.contains("Mandarin Chinese"));
        assert!(g.contains(zh.speech_guidance));
        assert!(g.contains(zh.lemma_guidance));
        assert!(g.contains(zh.teaching_focus[0]));
        // Level 0 must not leak advanced guidance into a beginner prompt.
        assert!(!g.contains(zh.teaching_focus[5]));
    }

    #[test]
    fn mandarin_lemma_policy_survives_the_port() {
        // Mandarin is the one language whose lemma rules the UI depends on
        // (pinyin is rendered separately, never appended to replies).
        let zh = module("zh").unwrap();
        assert!(zh.lemma_guidance.contains("simplified characters only"));
        assert!(zh.writing_guidance.contains("pinyin separately"));
    }
}
