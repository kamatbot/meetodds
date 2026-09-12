//! Situation content and deterministic progression. No model calls.
use super::{Level, OpenerUse, SessionState, SpanishProfile};

#[derive(Debug, Clone, Copy)]
pub struct Beat {
    pub goal: &'static str,
    pub opener: &'static str,
    pub options: &'static str,
    pub max_turns: usize,
}
#[derive(Debug)]
pub struct Scene {
    pub id: &'static str,
    pub tutor_role: &'static str,
    pub learner_role: &'static str,
    pub goal: &'static str,
    pub beats: [Beat; 4],
    pub target_structures: [[&'static str; 2]; 3],
    pub filler: &'static str,
}
impl Scene {
    pub fn beat(&self, index: usize) -> &Beat {
        &self.beats[index.min(self.beats.len() - 1)]
    }
    pub fn targets(&self, level: Level) -> &[&'static str; 2] {
        &self.target_structures[level.dial() as usize]
    }
}
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
pub fn scene(id: &str) -> Option<&'static Scene> {
    SCENES.iter().find(|s| s.id == id)
}
pub const CLOSING: &str =
    "¡Muy bien, terminamos! ¿Quieres practicar otra vez o hablar de otro tema?";
pub const TALK_FALLBACK: &str = "¿Qué te gusta hacer en tu tiempo libre?";
pub fn fallback(s: &SessionState) -> &'static str {
    if s.scene_done {
        CLOSING
    } else {
        scene(&s.scene_id)
            .map(|c| c.beat(s.beat).opener)
            .unwrap_or(TALK_FALLBACK)
    }
}
pub fn scaffold(s: &SessionState) -> &'static str {
    scene(&s.scene_id)
        .map(|c| {
            let b = c.beat(s.beat);
            if b.options.is_empty() {
                b.opener
            } else {
                b.options
            }
        })
        .unwrap_or("¿Quieres hablar de comida o de juegos?")
}
pub fn advance(s: &mut SessionState, reported_met: bool) {
    if s.scene_done || s.scene_id == "just_talk" {
        return;
    }
    let Some(scene) = scene(&s.scene_id) else {
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
pub fn dial_instruction(dial: u8) -> &'static str {
    match dial {
        0 => "Present tense; short, one-clause questions.",
        1 => "Simple sentences; familiar vocabulary; one follow-up.",
        2 => "Natural sentences; invite reasons and past experiences.",
        _ => "Natural idioms and nuanced follow-up questions.",
    }
}

#[derive(Debug)]
pub struct Topic {
    pub id: &'static str,
    pub openers: [[&'static str; 3]; 3],
}
pub static TOPICS: [Topic; 6] = [
    Topic {
        id: "family",
        openers: [
            [
                "¿Qué te gusta hacer con tu familia?",
                "¿Con quién hablas más en casa?",
                "¿Qué hacéis juntos los fines de semana?",
            ],
            [
                "¿Qué hiciste con tu familia el fin de semana pasado?",
                "¿Qué tradición familiar te gusta más?",
                "¿Cómo ha cambiado tu familia con el tiempo?",
            ],
            [
                "¿Qué costumbre familiar te gustaría conservar siempre?",
                "¿Cómo resolverías una diferencia de opinión en casa?",
                "¿Qué has aprendido de alguien de tu familia?",
            ],
        ],
    },
    Topic {
        id: "school",
        openers: [
            [
                "¿Qué asignatura te gusta más?",
                "¿Qué haces durante el recreo?",
                "¿Cómo es tu clase?",
            ],
            [
                "¿Qué aprendiste esta semana?",
                "¿Qué cambiarías de tu horario?",
                "¿Cómo te preparas para un proyecto?",
            ],
            [
                "¿Qué hace que una clase sea interesante?",
                "¿Cómo diseñarías tu escuela ideal?",
                "¿Es más importante memorizar o comprender?",
            ],
        ],
    },
    Topic {
        id: "sports",
        openers: [
            [
                "¿Qué deporte te gusta?",
                "¿Prefieres jugar o ver partidos?",
                "¿Dónde haces ejercicio?",
            ],
            [
                "¿Cuándo empezaste a practicar ese deporte?",
                "¿Cómo fue el último partido que viste?",
                "¿Qué deporte te gustaría probar?",
            ],
            [
                "¿Qué valoras más en un equipo?",
                "¿Qué cambiarías de las reglas de tu deporte favorito?",
                "¿Cómo influye el deporte en tu vida?",
            ],
        ],
    },
    Topic {
        id: "food",
        openers: [
            [
                "¿Cuál es tu comida favorita?",
                "¿Qué desayunas normalmente?",
                "¿Prefieres dulce o salado?",
            ],
            [
                "¿Qué cocinaste o comiste ayer?",
                "¿Qué plato te gustaría aprender a preparar?",
                "¿Qué comida probaste por primera vez recientemente?",
            ],
            [
                "¿Qué plato representa mejor un lugar que conoces?",
                "¿Cómo han cambiado tus gustos con los años?",
                "¿Qué hace que una comida sea memorable?",
            ],
        ],
    },
    Topic {
        id: "travel",
        openers: [
            [
                "¿Adónde quieres viajar?",
                "¿Prefieres la playa o la montaña?",
                "¿Qué llevas en tu mochila?",
            ],
            [
                "¿Cómo fueron tus últimas vacaciones?",
                "¿Qué lugar te sorprendió más?",
                "¿Cómo prepararías un viaje corto?",
            ],
            [
                "¿Qué aprendiste viajando que no esperabas?",
                "¿Cómo elegirías entre comodidad y aventura?",
                "¿Qué hace que te sientas en casa en otro lugar?",
            ],
        ],
    },
    Topic {
        id: "games",
        openers: [
            [
                "¿Cuál es tu juego favorito?",
                "¿Con quién te gusta jugar?",
                "¿Prefieres juegos de mesa o videojuegos?",
            ],
            [
                "¿Cómo aprendiste a jugar a tu juego favorito?",
                "¿Qué pasó en tu última partida?",
                "¿Qué juego recomendarías a un amigo?",
            ],
            [
                "¿Qué hace que un juego siga siendo interesante?",
                "¿Cómo diseñarías un juego cooperativo?",
                "¿Qué cambiarías de tu juego favorito y por qué?",
            ],
        ],
    },
];
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
    let mut candidates = vec![];
    for topic in &TOPICS {
        for (i, text) in topic.openers[p.level.dial() as usize].iter().enumerate() {
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
    // 18 candidates per level > five prior sessions, so this is always populated.
    let (_, id, text) = candidates.remove(0);
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
    use super::*;
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
        advance(&mut s, true);
        assert_eq!(s.beat, 1);
        for _ in 0..3 {
            advance(&mut s, false);
        }
        assert_eq!(s.beat, 2);
    }
    #[test]
    fn last_beat_closes_without_overflow() {
        let mut s = SessionState::new("s", "ordering_food", Level::Beginner);
        s.beat = 3;
        advance(&mut s, true);
        assert!(s.scene_done);
        assert_eq!(s.beat, 3);
        advance(&mut s, true);
        assert_eq!(fallback(&s), CLOSING);
    }
    #[test]
    fn talk_does_not_end() {
        let mut s = SessionState::new("s", "just_talk", Level::Beginner);
        for _ in 0..100 {
            advance(&mut s, true);
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
}
