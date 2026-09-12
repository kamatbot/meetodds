"""One-shot, branch-scoped integration edits. Removed after the checkpoint lands.
Never changes main, audio capture, UI pages, model files, or credentials.
"""
import os
from pathlib import Path

assert os.environ.get('GITHUB_REF') == 'refs/heads/feat/spanish-tutoring-engine'
assert os.environ.get('GITHUB_REPOSITORY') == 'kamatbot/notes'
ROOT = Path('frontend/src-tauri/src')

def edit(path, old, new):
    path = Path(path)
    data = path.read_text()
    if new in data:
        return
    assert data.count(old) == 1, f'Unexpected source boundary: {path}'
    path.write_text(data.replace(old, new, 1))

edit(ROOT/'spanish/tutor.rs',
     'let mut deliver=|text:&str,repeat:bool,rate:Option<u16>,filler:bool|',
     'let event_session_id = s.session_id.clone();\n        let deliver=|text:&str,repeat:bool,rate:Option<u16>,filler:bool|')
edit(ROOT/'spanish/tutor.rs',
     'repeat,rate,filler,request_id:request.request_id.clone(),session_id:s.session_id.clone()',
     'repeat,rate,filler,request_id:request.request_id.clone(),session_id:event_session_id.clone()')
edit(ROOT/'spanish/mod.rs', 'pub mod tutor;', 'pub mod tutor;\npub mod persistence;')
edit(ROOT/'spanish/mod.rs',
     'pub enum Category { VerbTense, VerbConjugation, SerEstar, GenderAgreement, NumberAgreement, Article, Preposition, WordChoice, WordOrder, MissingWord, EnglishMixed, Other }',
     'pub enum Category { VerbTense, VerbConjugation, SerEstar, GenderAgreement, NumberAgreement, Article, Preposition, WordChoice, WordOrder, MissingWord, EnglishMixed, Other }\nimpl Default for Category { fn default() -> Self { Self::Other } }')
edit(ROOT/'spanish/mod.rs',
     '    pub category: Category,\n    pub severity: Severity,',
     '    #[serde(default)] pub category: Category,\n    #[serde(default)] pub severity: Severity,')
edit(ROOT/'spanish/persistence.rs',
     'use crate::{Category, Feedback, FeedbackKind, Level, Severity};',
     'use super::super::{Category, Feedback, FeedbackKind, Level, Severity};')
edit(ROOT/'spanish/policy.rs',
     'if !practiced && at_level(category, f.structure, p.level) { return Decision::Discard; }',
     'if !practiced && !demonstrably_above_level(category, f.structure, p.level) { return Decision::Discard; }')
edit(ROOT/'spanish/policy.rs',
     '#[derive(Debug, Clone)]\npub enum Decision',
     '''fn demonstrably_above_level(c: Category, s: Structure, level: Level) -> bool {
    if level == Level::Advanced || c == Category::Other { return false; }
    match level {
        Level::Beginner => matches!(s, Structure::Past | Structure::Future | Structure::Subjunctive | Structure::Conditional | Structure::Register)
            || matches!(c, Category::Preposition | Category::WordChoice),
        Level::Intermediate => matches!(s, Structure::Subjunctive | Structure::Conditional | Structure::Register),
        Level::Advanced => false,
    }
}
#[derive(Debug, Clone)]
pub enum Decision''')
edit(ROOT/'spanish/scenes.rs', '"¿Qué proyecto te gustaría hacer?"', '"¿Qué proyecto quieres hacer?"')
edit(ROOT/'spanish/scenes.rs', '"necesito que"', '"¿se puede…?"')
edit(ROOT/'spanish/scenes.rs', '"me gustaría que"', '"me gustaría organizar"')
edit(ROOT/'lib.rs', 'pub mod summary;',
     'pub mod summary;\npub mod spanish;\n#[path = "spanish/provider.rs"]\npub mod spanish_provider;')

signature = '''pub async fn generate_with_builtin(
    app_data_dir: &PathBuf,
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: Option<u32>,
    cancellation_token: Option<&CancellationToken>,
) -> Result<String> {'''
replacement = '''/// Per-request overrides; model defaults and stop tokens remain unchanged.
#[derive(Debug, Clone, Copy)]
pub struct BuiltinSamplingOverride {
    pub temperature: f32,
    pub top_p: f32,
    pub top_k: i32,
}
impl BuiltinSamplingOverride {
    pub fn validated(self) -> Result<Self> {
        if !self.temperature.is_finite() || !(0.0..=2.0).contains(&self.temperature)
            || !self.top_p.is_finite() || self.top_p <= 0.0 || self.top_p > 1.0
            || !(1..=256).contains(&self.top_k) {
            return Err(anyhow!("Invalid per-request sampling override"));
        }
        Ok(self)
    }
}

/// Backwards-compatible entry point: existing summaries keep model defaults.
pub async fn generate_with_builtin(
    app_data_dir: &PathBuf,
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: Option<u32>,
    cancellation_token: Option<&CancellationToken>,
) -> Result<String> {
    generate_with_builtin_with_sampling(app_data_dir, model_name, system_prompt,
        user_prompt, max_tokens, cancellation_token, None).await
}

/// The tutor judge uses near-greedy sampling without changing global settings.
pub async fn generate_with_builtin_with_sampling(
    app_data_dir: &PathBuf,
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: Option<u32>,
    cancellation_token: Option<&CancellationToken>,
    sampling_override: Option<BuiltinSamplingOverride>,
) -> Result<String> {
    let sampling_override = sampling_override.map(BuiltinSamplingOverride::validated).transpose()?;'''
edit(ROOT/'summary/summary_engine/client.rs', signature, replacement)
edit(ROOT/'summary/summary_engine/client.rs',
     'let sampling = model_def.sampling.sanitize_for_llama_helper();',
     '''let mut sampling = model_def.sampling.sanitize_for_llama_helper();
    if let Some(overrides) = sampling_override {
        sampling.temperature = overrides.temperature;
        sampling.top_p = overrides.top_p;
        sampling.top_k = overrides.top_k;
    }''')
print('Applied guarded engine/native edits; no recording or meeting workflow changed.')
