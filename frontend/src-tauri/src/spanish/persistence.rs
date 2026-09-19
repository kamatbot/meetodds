//! Additive JSON persistence for the companion profile/session implementation.
//! Do not rename its tables or convert its existing arrays into new envelopes.
use super::{SessionState, SpanishProfile};
use serde_json::{json, Value};

const STATE_FIELD: &str = "spanishTutorState";
const MAX_BLOB: usize = 4 * 1024 * 1024;
#[derive(Debug)]
pub struct PersistenceUpdate {
    pub turns_json: String,
    pub feedback_json: String,
    pub practicing_json: String,
}
fn array(raw: &str) -> Result<Vec<Value>, String> {
    if raw.len() > MAX_BLOB {
        return Err("Practice history exceeds the supported size.".into());
    }
    match serde_json::from_str(raw).map_err(|_| "Practice history is not valid JSON.")? {
        Value::Array(items) if items.iter().all(Value::is_object) => Ok(items),
        _ => Err("Expected the existing practice-history object array.".into()),
    }
}
fn card_key(card: &Value) -> Option<(u64, &str, &str)> {
    Some((
        card.get("turnIndex")?.as_u64()?,
        card.get("category")?.as_str()?,
        card.get("kind")?.as_str()?,
    ))
}
/// The command has already recorded the audible turn using its original turn
/// shape. Attach metadata to that last object; never insert a fake transcript
/// turn just to hold state. Commit all three returned strings in ONE transaction.
pub fn prepare_update(
    turns_json: &str,
    feedback_json: &str,
    state: &SessionState,
    profile: &SpanishProfile,
) -> Result<PersistenceUpdate, String> {
    let mut turns = array(turns_json)?;
    let mut feedback = array(feedback_json)?;
    if turns.is_empty() {
        return Err("Record the tutor turn before attaching engine state.".into());
    }
    // Only the latest object carries the snapshot. Unknown existing UI fields
    // and the full original conversation remain intact.
    for turn in &mut turns {
        turn.as_object_mut().unwrap().remove(STATE_FIELD);
    }
    turns
        .last_mut()
        .unwrap()
        .as_object_mut()
        .unwrap()
        .insert(STATE_FIELD.into(), json!({"version":1,"state":state}));
    for finding in &state.feedback {
        let value = serde_json::to_value(finding).map_err(|_| "Cannot encode tutor feedback.")?;
        if let Some(existing) = feedback
            .iter_mut()
            .find(|item| card_key(item).is_some() && card_key(item) == card_key(&value))
        {
            existing
                .as_object_mut()
                .unwrap()
                .extend(value.as_object().unwrap().clone());
        } else {
            feedback.push(value);
        }
    }
    let turns_json = serde_json::to_string(&turns).map_err(|_| "Cannot encode practice turns.")?;
    let feedback_json =
        serde_json::to_string(&feedback).map_err(|_| "Cannot encode practice recap.")?;
    let practicing_json = serde_json::to_string(&profile.practicing)
        .map_err(|_| "Cannot encode practicing phrases.")?;
    if turns_json.len() > MAX_BLOB || feedback_json.len() > MAX_BLOB {
        return Err("Practice history exceeds the supported size.".into());
    }
    Ok(PersistenceUpdate {
        turns_json,
        feedback_json,
        practicing_json,
    })
}
pub fn restore(turns_json: &str, fallback: SessionState) -> Result<SessionState, String> {
    let turns = array(turns_json)?;
    let saved = turns.iter().rev().find_map(|turn| turn.get(STATE_FIELD));
    let Some(saved) = saved else {
        return Ok(fallback);
    };
    if saved.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("This practice history needs a newer tutor engine.".into());
    }
    let state: SessionState =
        serde_json::from_value(saved.get("state").cloned().ok_or("Missing tutor state.")?)
            .map_err(|_| "Cannot restore tutor state.")?;
    if state.session_id != fallback.session_id || state.scene_id != fallback.scene_id {
        return Err("Tutor state does not belong to this practice session.".into());
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::super::{Category, Feedback, FeedbackKind, Level, Severity};
    use super::*;
    fn feedback() -> Feedback {
        Feedback {
            kind: FeedbackKind::Correction,
            you_said: "un casa".into(),
            try_this: "una casa".into(),
            why: "The article needs to match the noun.".into(),
            category: Category::Article,
            severity: Severity::Core,
            shown: true,
            turn_index: 1,
            count: 1,
        }
    }
    #[test]
    fn additive_roundtrip_preserves_unknown_fields_and_old_cards() {
        let mut state = SessionState::new("s", "ordering_food", Level::Beginner);
        state.beat = 2;
        state.feedback.push(feedback());
        let update = prepare_update(
            r#"[{"role":"tutor","text":"¿Qué quieres?","timestamp":12,"custom":"keep"}]"#,
            r#"[{"legacy":"keep"}]"#,
            &state,
            &SpanishProfile::default(),
        )
        .unwrap();
        let turns: Value = serde_json::from_str(&update.turns_json).unwrap();
        assert_eq!(turns[0]["custom"], "keep");
        let cards: Value = serde_json::from_str(&update.feedback_json).unwrap();
        assert_eq!(cards.as_array().unwrap().len(), 2);
        assert_eq!(cards[0]["legacy"], "keep");
        let restored = restore(
            &update.turns_json,
            SessionState::new("s", "ordering_food", Level::Beginner),
        )
        .unwrap();
        assert_eq!(restored.beat, 2);
        assert_eq!(restored.feedback.len(), 1);
        let again = prepare_update(
            &update.turns_json,
            &update.feedback_json,
            &state,
            &SpanishProfile::default(),
        )
        .unwrap();
        let cards: Value = serde_json::from_str(&again.feedback_json).unwrap();
        assert_eq!(cards.as_array().unwrap().len(), 2);
    }
    #[test]
    fn legacy_session_loads_without_rewriting() {
        let state = restore(
            r#"[{"text":"hola"}]"#,
            SessionState::new("s", "just_talk", Level::Intermediate),
        )
        .unwrap();
        assert_eq!(state.dial, 1);
    }
    #[test]
    fn missing_turn_is_not_fabricated() {
        assert!(prepare_update(
            "[]",
            "[]",
            &SessionState::default(),
            &SpanishProfile::default()
        )
        .is_err());
    }
    #[test]
    fn corrupted_or_cross_session_state_is_rejected() {
        let update = prepare_update(
            r#"[{"text":"hola"}]"#,
            "[]",
            &SessionState::new("one", "just_talk", Level::Beginner),
            &SpanishProfile::default(),
        )
        .unwrap();
        assert!(restore(
            &update.turns_json,
            SessionState::new("two", "just_talk", Level::Beginner)
        )
        .is_err());
        assert!(restore("broken", SessionState::default()).is_err());
    }
}
