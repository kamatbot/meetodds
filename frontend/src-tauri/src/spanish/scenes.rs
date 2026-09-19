//! Situation content and deterministic progression. No model calls.
//!
//! Spanish keeps its hand-written [`SCENES`] here; every other language's
//! scenes come from `crate::languages::scenes`, and the free-talk lines
//! (closing, fallbacks, pacing instructions, topic openers) for all languages
//! including Spanish come from `crate::languages::talk`. Lookups take the
//! profile's language id; an unknown id resolves to Spanish.
use super::{resolve_language_id, OpenerUse, SessionState, SpanishProfile};
use crate::languages::talk::{self, TalkContent};

/// The one `Scene`/`Beat` shape shared by every language, so `scene()` can
/// serve the Spanish set and the registry sets through a single type.
pub use crate::languages::scenes::{Beat, Scene};

macro_rules! beat {
    ($goal:literal,$opener:literal,$options:literal) => {
        Beat {
            goal: $goal,
            opener: $opener,
            options: $options,
            max_turns: 3,
        }
    };
}
pub static SCENES: [Scene; 8] = [
    Scene {
        id: "ordering_food",
        tutor_role: "waiter",
        learner_role: "customer",
        goal: "order food and a drink, then ask for the bill",
        filler: "Mmm, a ver…",
        beats: [
            beat!(
                "greet and choose a drink",
                "¡Hola! ¿Qué quieres tomar?",
                "¿Agua o zumo?"
            ),
            beat!(
                "order food; offer a dish",
                "Tenemos pizza y tacos. ¿Qué te apetece comer?",
                "¿Pizza o tacos?"
            ),
            beat!(
                "ask how the food tastes",
                "¿Qué te parece la comida?",
                "¿Te gusta mucho o un poco?"
            ),
            beat!(
                "ask for the bill and finish",
                "¿Quieres algo más o te traigo la cuenta?",
                "¿Algo más o la cuenta?"
            ),
        ],
        target_structures: [
            ["quiero + noun", "¿tiene…?"],
            ["me gustaría", "¿me trae…?"],
            ["conditional politeness", "complaining politely"],
        ],
    },
    Scene {
        id: "meeting_someone",
        tutor_role: "new acquaintance",
        learner_role: "new acquaintance",
        goal: "introduce yourself and find a shared interest",
        filler: "Un momento…",
        beats: [
            beat!(
                "exchange names",
                "¡Hola! ¿Cómo te llamas?",
                "¿Te llamas Ana o tienes otro nombre?"
            ),
            beat!(
                "say where you live",
                "¿Dónde vives?",
                "¿En una ciudad o en un pueblo?"
            ),
            beat!(
                "find a shared interest",
                "¿Qué te gusta hacer en tu tiempo libre?",
                "¿Deporte o música?"
            ),
            beat!(
                "suggest another conversation",
                "¡Me ha gustado conocerte! ¿Hablamos otro día?",
                "¿Mañana o el fin de semana?"
            ),
        ],
        target_structures: [
            ["me llamo", "me gusta"],
            ["suelo + infinitive", "llevo viviendo"],
            ["shared interests", "polite invitations"],
        ],
    },
    Scene {
        id: "school_day",
        tutor_role: "classmate",
        learner_role: "student",
        goal: "talk about subjects, a class project and after-school activities",
        filler: "Mmm, a ver…",
        beats: [
            beat!(
                "name a favorite subject",
                "¿Cuál es tu asignatura favorita?",
                "¿Matemáticas o arte?"
            ),
            beat!(
                "describe a class",
                "¿Qué haces en esa clase?",
                "¿Lees o haces proyectos?"
            ),
            beat!(
                "describe a project or activity",
                "¿Qué proyecto quieres hacer?",
                "¿Un dibujo o una maqueta?"
            ),
            beat!(
                "arrange an after-school activity",
                "¿Qué quieres hacer después de clase?",
                "¿Jugar o descansar?"
            ),
        ],
        target_structures: [
            ["me gusta", "tengo clase"],
            ["hoy hemos", "ayer aprendí"],
            ["explain an opinion", "compare learning experiences"],
        ],
    },
    Scene {
        id: "weekend_plans",
        tutor_role: "friend",
        learner_role: "friend",
        goal: "agree an activity, place and time",
        filler: "Déjame pensar…",
        beats: [
            beat!(
                "choose an activity",
                "¿Qué quieres hacer este fin de semana?",
                "¿Ir al parque o ver una película?"
            ),
            beat!(
                "choose a place",
                "¿Dónde te gustaría quedar?",
                "¿En el parque o en casa?"
            ),
            beat!(
                "agree a time",
                "¿A qué hora te viene bien?",
                "¿Por la mañana o por la tarde?"
            ),
            beat!(
                "confirm the plan",
                "¡Ya tenemos un plan! ¿Qué llevamos?",
                "¿Comida o una pelota?"
            ),
        ],
        target_structures: [
            ["quiero ir", "a las + time"],
            ["voy a", "podemos quedar"],
            ["negotiate alternatives", "hypothetical plans"],
        ],
    },
    Scene {
        id: "shopping",
        tutor_role: "shop assistant",
        learner_role: "customer",
        goal: "choose an item, compare options and buy it",
        filler: "Mmm, a ver…",
        beats: [
            beat!(
                "identify an item",
                "¡Hola! ¿Qué estás buscando?",
                "¿Una camiseta o unos zapatos?"
            ),
            beat!(
                "choose size and color",
                "¿Qué color prefieres?",
                "¿Azul o rojo?"
            ),
            beat!(
                "compare an alternative",
                "Tengo otra opción. ¿Quieres verla?",
                "¿Esta o la otra?"
            ),
            beat!(
                "ask price and decide",
                "¿Te llevas este o prefieres seguir mirando?",
                "¿Lo compras o sigues mirando?"
            ),
        ],
        target_structures: [
            ["quiero este", "¿cuánto cuesta?"],
            ["más grande que", "estoy buscando"],
            ["compare value", "negotiate politely"],
        ],
    },
    Scene {
        id: "asking_directions",
        tutor_role: "helpful pedestrian",
        learner_role: "visitor",
        goal: "find a destination and check the route",
        filler: "Un momento…",
        beats: [
            beat!(
                "ask for a destination",
                "¡Hola! ¿Adónde quieres ir?",
                "¿Al parque o a la estación?"
            ),
            beat!(
                "establish a landmark",
                "¿Ves el edificio de enfrente?",
                "¿El edificio blanco o el azul?"
            ),
            beat!(
                "explain and confirm a route",
                "Sigue recto y gira a la derecha. ¿Qué haces primero?",
                "¿Sigues recto o giras?"
            ),
            beat!(
                "check understanding and finish",
                "¿Sabes cómo llegar o lo repetimos?",
                "¿Seguimos o lo repetimos?"
            ),
        ],
        target_structures: [
            ["¿dónde está?", "a la derecha"],
            ["tengo que girar", "¿cuánto se tarda?"],
            ["clarify ambiguous directions", "compare routes"],
        ],
    },
    Scene {
        id: "hotel_checkin",
        tutor_role: "hotel receptionist",
        learner_role: "guest",
        goal: "check in, ask about facilities and agree checkout",
        filler: "Déjame ver…",
        beats: [
            beat!(
                "greet and confirm reservation",
                "¡Bienvenido! ¿Tienes una reserva?",
                "¿Con reserva o sin reserva?"
            ),
            beat!(
                "choose a room",
                "¿Qué tipo de habitación necesitas?",
                "¿Una habitación pequeña o grande?"
            ),
            beat!(
                "ask about facilities",
                "¿Qué quieres saber del hotel?",
                "¿El desayuno o la piscina?"
            ),
            beat!(
                "agree checkout and finish",
                "¿A qué hora quieres salir mañana?",
                "¿Temprano o después de desayunar?"
            ),
        ],
        target_structures: [
            ["tengo una reserva", "¿hay…?"],
            ["quisiera saber", "¿se puede…?"],
            ["request an accommodation", "resolve a reservation problem"],
        ],
    },
    Scene {
        id: "planning_party",
        tutor_role: "friend helping organize",
        learner_role: "party organizer",
        goal: "plan guests, food, activities and timing",
        filler: "Mmm, a ver…",
        beats: [
            beat!(
                "decide who is invited",
                "¿A quién quieres invitar a la fiesta?",
                "¿A la familia o a tus amigos?"
            ),
            beat!("choose food", "¿Qué vamos a comer?", "¿Pizza o bocadillos?"),
            beat!(
                "choose an activity",
                "¿Qué hacemos durante la fiesta?",
                "¿Música o juegos?"
            ),
            beat!(
                "confirm when and finish",
                "¡Todo está preparado! ¿A qué hora empieza?",
                "¿A las cuatro o a las cinco?"
            ),
        ],
        target_structures: [
            ["quiero invitar", "vamos a comer"],
            ["me gustaría organizar", "podríamos organizar"],
            ["coordinate preferences", "negotiate constraints"],
        ],
    },
];
/// The scene set for a language: Spanish is hand-written here, the rest come
/// from the registry. A registered language without scenes (none today) and
/// an unknown id both fall back to Spanish rather than to nothing.
pub fn scenes_for(lang: &str) -> &'static [Scene; 8] {
    let lang = resolve_language_id(lang);
    if lang == super::LEGACY_LANGUAGE_ID {
        &SCENES
    } else {
        crate::languages::scenes::scenes_for(lang).unwrap_or(&SCENES)
    }
}
pub fn scene(lang: &str, id: &str) -> Option<&'static Scene> {
    scenes_for(lang).iter().find(|s| s.id == id)
}
/// Free-talk content for a language. Every registered language has an entry;
/// Spanish is the fallback for an unknown id, matching `resolve_language_id`.
pub fn talk_for(lang: &str) -> &'static TalkContent {
    talk::talk_for(resolve_language_id(lang)).unwrap_or(&talk::SPANISH_TALK)
}
/// Said once a scene is finished.
pub fn closing(lang: &str) -> &'static str {
    talk_for(lang).closing
}
/// Opens free talk when no scene is driving the conversation.
pub fn talk_fallback(lang: &str) -> &'static str {
    talk_for(lang).talk_fallback
}
pub fn fallback(lang: &str, s: &SessionState) -> &'static str {
    if s.scene_done {
        closing(lang)
    } else {
        scene(lang, &s.scene_id)
            .map(|c| c.beat(s.beat).opener)
            .unwrap_or(talk_fallback(lang))
    }
}
pub fn scaffold(lang: &str, s: &SessionState) -> &'static str {
    scene(lang, &s.scene_id)
        .map(|c| {
            let b = c.beat(s.beat);
            if b.options.is_empty() {
                b.opener
            } else {
                b.options
            }
        })
        .unwrap_or(talk_for(lang).scaffold_fallback)
}
/// Thinking noise spoken while a slow reply is generated: the scene's own
/// line, or for free talk the language's first scene's line.
pub fn filler(lang: &str, s: &SessionState) -> &'static str {
    scene(lang, &s.scene_id)
        .map(|x| x.filler)
        .unwrap_or(scenes_for(lang)[0].filler)
}
pub fn advance(lang: &str, s: &mut SessionState, reported_met: bool) {
    if s.scene_done || s.scene_id == "just_talk" {
        return;
    }
    let Some(scene) = scene(lang, &s.scene_id) else {
        return;
    };
    s.beat_turns = s.beat_turns.saturating_add(1);
    if reported_met || s.beat_turns >= scene.beat(s.beat).max_turns {
        s.beat_turns = 0;
        if s.beat + 1 >= scene.beats.len() {
            s.scene_done = true;
        } else {
            s.beat += 1;
        }
    }
}
/// Model-facing pacing instruction for a dial position, in this language's
/// reviewed wording. Clamps rather than panicking on a stored dial.
pub fn dial_instruction(lang: &str, dial: u8) -> &'static str {
    talk_for(lang).dial_instruction(dial)
}

/// Preferred topics first; broaden only when all their three openers were used
/// recently. A single topic's three openers cannot by themselves satisfy a
/// five-session nonrepeat window. This fallback makes that rule achievable.
pub fn choose_opener(
    p: &SpanishProfile,
    recent: &[OpenerUse],
    session_id: &str,
) -> (OpenerUse, &'static str) {
    let mut sessions: Vec<&str> = vec![];
    for used in recent.iter().rev() {
        if used.session_id != session_id && !sessions.contains(&used.session_id.as_str()) {
            sessions.push(&used.session_id);
            if sessions.len() == 5 {
                break;
            }
        }
    }
    let recent_ids: Vec<&str> = recent
        .iter()
        .filter(|x| sessions.contains(&x.session_id.as_str()))
        .map(|x| x.opener_id.as_str())
        .collect();
    let talk = talk_for(p.language_id());
    let mut candidates = vec![];
    for topic in &talk.topics {
        for (i, text) in topic.openers_for(p.level.dial()).iter().enumerate() {
            let id = format!("{}:{}:{}", topic.id, p.level.name(), i);
            if !recent_ids.contains(&id.as_str()) {
                candidates.push((
                    !p.topics.iter().any(|x| x.eq_ignore_ascii_case(topic.id)),
                    id,
                    *text,
                ));
            }
        }
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    // 18 candidates per level > the six-entry history window, so this is always
    // populated; the fallback only keeps stored state from ever panicking here.
    let (_, id, text) = if candidates.is_empty() {
        let topic = &talk.topics[0];
        (
            true,
            format!("{}:{}:0", topic.id, p.level.name()),
            topic.openers_for(p.level.dial())[0],
        )
    } else {
        candidates.remove(0)
    };
    (
        OpenerUse {
            session_id: session_id.into(),
            opener_id: id,
        },
        text,
    )
}

#[cfg(test)]
mod tests {
    use super::super::Level;
    use super::*;
    /// Every legacy assertion below is Spanish; the language id is the only
    /// change to these call sites.
    const ES: &str = "es";
    #[test]
    fn eight_complete_scripts() {
        assert_eq!(SCENES.len(), 8);
        let mut ids = std::collections::HashSet::new();
        for scene in &SCENES {
            assert!(ids.insert(scene.id));
            assert_eq!(scene.beats.len(), 4);
            for beat in scene.beats {
                assert!(beat.max_turns > 0);
                assert!(beat.opener.ends_with('?'));
                assert!(beat.options.ends_with('?'));
            }
        }
    }
    #[test]
    fn token_and_timeout_advance() {
        let mut s = SessionState::new("s", "ordering_food", Level::Beginner);
        advance(ES, &mut s, true);
        assert_eq!(s.beat, 1);
        for _ in 0..3 {
            advance(ES, &mut s, false);
        }
        assert_eq!(s.beat, 2);
    }
    #[test]
    fn last_beat_closes_without_overflow() {
        let mut s = SessionState::new("s", "ordering_food", Level::Beginner);
        s.beat = 3;
        advance(ES, &mut s, true);
        assert!(s.scene_done);
        assert_eq!(s.beat, 3);
        advance(ES, &mut s, true);
        assert_eq!(fallback(ES, &s), closing(ES));
    }
    #[test]
    fn talk_does_not_end() {
        let mut s = SessionState::new("s", "just_talk", Level::Beginner);
        for _ in 0..100 {
            advance(ES, &mut s, true);
        }
        assert!(!s.scene_done);
    }
    #[test]
    fn no_opener_repeated_in_five_sessions_even_one_preferred_topic() {
        let p = SpanishProfile {
            topics: vec!["food".into()],
            ..Default::default()
        };
        let mut h: Vec<OpenerUse> = vec![];
        for i in 0..20 {
            let (u, _) = choose_opener(&p, &h, &i.to_string());
            assert!(h.iter().rev().take(5).all(|x| x.opener_id != u.opener_id));
            h.push(u);
        }
    }
    #[test]
    fn first_choice_matches_topic_and_level() {
        let p = SpanishProfile {
            topics: vec!["sports".into()],
            level: Level::Intermediate,
            ..Default::default()
        };
        let (u, _) = choose_opener(&p, &[], "s");
        assert!(u.opener_id.starts_with("sports:intermediate:"));
    }
    #[test]
    fn scenes_and_talk_follow_the_language() {
        let german = crate::languages::scenes::scenes_for("de").unwrap();
        let de = scene("de", "ordering_food").unwrap();
        assert_eq!(de, &german[0]);
        assert_ne!(de.beats[0].opener, scene(ES, "ordering_food").unwrap().beats[0].opener);
        assert_eq!(scene(ES, "ordering_food").unwrap().beats[0].opener, "¡Hola! ¿Qué quieres tomar?");
        // Every registered language serves all eight scene ids.
        for m in crate::languages::LANGUAGES.iter() {
            for id in crate::languages::scenes::SCENE_IDS {
                assert!(scene(m.id, id).is_some(), "{} {id}", m.id);
            }
            assert!(!closing(m.id).is_empty() && !talk_fallback(m.id).is_empty());
        }
        let s = SessionState::new("s", "ordering_food", Level::Beginner);
        assert_eq!(fallback("de", &s), de.beats[0].opener);
        assert_eq!(scaffold("de", &s), de.beats[0].options);
        assert_eq!(filler("de", &s), de.filler);
        assert_eq!(closing("de"), crate::languages::talk::talk_for("de").unwrap().closing);
        assert_eq!(dial_instruction("de", 0), crate::languages::talk::talk_for("de").unwrap().dial_instructions[0]);
        assert_eq!(dial_instruction(ES, 9), dial_instruction(ES, 3));
        // Free talk in German draws German openers for the preferred topic.
        let p = SpanishProfile {
            topics: vec!["food".into()],
            language: "de".into(),
            ..Default::default()
        };
        let (u, text) = choose_opener(&p, &[], "s");
        assert!(u.opener_id.starts_with("food:beginner:"));
        let de_talk = crate::languages::talk::talk_for("de").unwrap();
        assert!(de_talk.topic("food").unwrap().openers_for(0).contains(&text));
        // Unknown or blank ids degrade to Spanish rather than to nothing.
        for lang in ["", "xx"] {
            assert_eq!(scene(lang, "ordering_food").unwrap(), scene(ES, "ordering_food").unwrap());
            assert_eq!(closing(lang), "¡Muy bien, terminamos! ¿Quieres practicar otra vez o hablar de otro tema?");
            assert_eq!(talk_fallback(lang), "¿Qué te gusta hacer en tu tiempo libre?");
            let just_talk = SessionState::new("s", "just_talk", Level::Beginner);
            assert_eq!(scaffold(lang, &just_talk), "¿Quieres hablar de comida o de juegos?");
            assert_eq!(filler(lang, &just_talk), "Mmm, a ver…");
        }
        let (_, text) = choose_opener(&SpanishProfile { language: "xx".into(), ..Default::default() }, &[], "s");
        assert!(text.starts_with('¿'));
    }
}
