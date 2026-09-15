
#[cfg(test)]
mod tests {
    use super::*;

    fn all() -> Vec<&'static TalkContent> {
        TALK_LANGUAGES
            .iter()
            .map(|id| talk_for(id).expect("registered language has talk content"))
            .collect()
    }

    #[test]
    fn every_language_is_complete() {
        assert_eq!(TALK_LANGUAGES.len(), 8);
        for t in all() {
            assert!(!t.closing.trim().is_empty(), "{}", t.language_id);
            assert!(!t.talk_fallback.trim().is_empty(), "{}", t.language_id);
            assert!(!t.scaffold_fallback.trim().is_empty(), "{}", t.language_id);
            for d in t.dial_instructions.iter() {
                assert!(!d.trim().is_empty(), "{}", t.language_id);
            }
            assert_eq!(t.topics.len(), 6, "{}", t.language_id);
        }
    }

    #[test]
    fn topics_share_ids_and_order_across_languages() {
        for t in all() {
            for (topic, want) in t.topics.iter().zip(TOPIC_IDS.iter()) {
                assert_eq!(&topic.id, want, "{} topic order", t.language_id);
            }
        }
    }

    #[test]
    fn every_opener_is_a_question() {
        for t in all() {
            for text in [t.closing, t.talk_fallback, t.scaffold_fallback] {
                assert!(
                    text.ends_with('?') || text.ends_with('\u{ff1f}'),
                    "{}: {text}", t.language_id
                );
            }
            for topic in t.topics.iter() {
                for row in topic.openers.iter() {
                    for o in row.iter() {
                        assert!(
                            o.ends_with('?') || o.ends_with('\u{ff1f}'),
                            "{}/{}: {o}", t.language_id, topic.id
                        );
                    }
                }
            }
        }
    }

    /// Moving Spanish onto this registry must be invisible to the learner:
    /// these are the exact strings the Spanish engine used before.
    #[test]
    fn spanish_parity() {
        let es = talk_for("es").expect("spanish present");
        assert_eq!(
            es.closing,
            "¡Muy bien, terminamos! ¿Quieres practicar otra vez o hablar de otro tema?"
        );
        assert_eq!(es.talk_fallback, "¿Qué te gusta hacer en tu tiempo libre?");
        assert_eq!(es.scaffold_fallback, "¿Quieres hablar de comida o de juegos?");
        assert_eq!(
            es.dial_instruction(0),
            "UNA sola pregunta corta (máximo 10 palabras), en presente, una cláusula. Nada antes de la pregunta."
        );
        assert_eq!(
            es.dial_instruction(2),
            "Natural sentences; invite reasons and past experiences."
        );
        let family = es.topic("family").expect("family topic");
        assert_eq!(family.openers[0][0], "¿Qué te gusta hacer con tu familia?");
        assert_eq!(
            family.openers[2][2],
            "¿Qué has aprendido de alguien de tu familia?"
        );
    }

    #[test]
    fn dial_and_opener_lookups_clamp() {
        let t = talk_for("de").expect("german present");
        assert_eq!(t.dial_instruction(9), t.dial_instruction(3));
        let topic = t.topic("food").expect("food topic");
        assert_eq!(topic.openers_for(9), topic.openers_for(2));
        assert!(t.topic("nonexistent").is_none());
    }

    #[test]
    fn unknown_language_is_not_served() {
        assert!(talk_for("xx").is_none());
        assert!(talk_for("").is_none());
    }

    #[test]
    fn languages_do_not_share_openers() {
        let sets = all();
        for (i, a) in sets.iter().enumerate() {
            for b in sets.iter().skip(i + 1) {
                assert_ne!(
                    a.talk_fallback, b.talk_fallback,
                    "{} and {} share a fallback", a.language_id, b.language_id
                );
            }
        }
    }

    #[test]
    fn mandarin_carries_no_pinyin_in_learner_text() {
        let zh = talk_for("zh").expect("mandarin present");
        let mut texts = vec![zh.closing, zh.talk_fallback, zh.scaffold_fallback];
        for topic in zh.topics.iter() {
            for row in topic.openers.iter() {
                texts.extend(row.iter().copied());
            }
        }
        for text in texts {
            assert!(
                !text.chars().any(|c| c.is_ascii_alphabetic()),
                "Mandarin learner text has Latin letters: {text}"
            );
        }
    }

    /// Pacing instructions are model-facing and written in English, even for
    /// Mandarin, where they may still cite structures in characters.
    #[test]
    fn dial_instructions_are_english_prose() {
        for t in all() {
            for d in t.dial_instructions.iter() {
                let latin = d.chars().filter(|c| c.is_ascii_alphabetic()).count();
                assert!(latin >= 20, "{} dial instruction not English: {d}", t.language_id);
            }
        }
    }
}
