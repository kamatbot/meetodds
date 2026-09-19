//! Tauri command shell for the language registry. Read-only: the registry is
//! static content, so these commands take no state and touch no database.

use super::{
    meaning_greeting, module, ConversationTheme, LanguageModule, LANGUAGES, MEANING_LANGUAGES,
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageSummary {
    pub id: &'static str,
    pub name: &'static str,
    pub native_name: &'static str,
    pub variety: &'static str,
    pub locale: &'static str,
    pub greeting: &'static str,
    pub topic_placeholder: &'static str,
    pub settings_title: String,
    pub talk_title: String,
}

impl From<&'static LanguageModule> for LanguageSummary {
    fn from(m: &'static LanguageModule) -> Self {
        Self {
            id: m.id,
            name: m.name,
            native_name: m.native_name,
            variety: m.variety,
            locale: m.locale,
            greeting: m.greeting,
            topic_placeholder: m.topic_placeholder,
            settings_title: m.settings_title(),
            talk_title: m.talk_title(),
        }
    }
}

/// Every target language the app offers, in registry order.
#[tauri::command]
pub async fn languages_list() -> Result<Vec<LanguageSummary>, String> {
    Ok(LANGUAGES.iter().map(LanguageSummary::from).collect())
}

/// The 24 situations for one language, with that language's overrides applied.
#[tauri::command]
pub async fn languages_themes(language_id: String) -> Result<Vec<ConversationTheme>, String> {
    module(&language_id)
        .map(|m| m.themes())
        .ok_or_else(|| format!("Unknown language id: {language_id}"))
}

/// Subtitle/meaning languages, each with its greeting.
#[tauri::command]
pub async fn languages_meaning_options() -> Result<Vec<(&'static str, &'static str)>, String> {
    Ok(MEANING_LANGUAGES
        .iter()
        .map(|n| (*n, meaning_greeting(n)))
        .collect())
}
