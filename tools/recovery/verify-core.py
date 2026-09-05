"""Execute production core algorithms without the desktop/audio device shell.
Tauri command wrappers are excluded; SQLite, journal, codec and queue algorithms remain real.
This is not a full Tauri build or a hardware capture test.
"""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path.cwd()
crate = Path(tempfile.mkdtemp(prefix='meetodds-core-'))
(crate/'src'/'audio').mkdir(parents=True)
(crate/'Cargo.toml').write_text('''[package]
name = "meetodds-core-verification"
version = "0.1.0"
edition = "2021"
[workspace]
[dependencies]
anyhow = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tempfile = "3"
tokio = { version = "1", features = ["full"] }
once_cell = "1"
tokio-util = "0.7"
uuid = { version = "1", features = ["v4"] }
url = "2"
sqlx = { version = "0.8", default-features = false, features = ["runtime-tokio", "sqlite"] }
''')
modules = []
audio = root/'frontend/src-tauri/src/audio'
if (audio/'pcm_journal.rs').exists():
    for name in ['pcm_journal.rs', 'incremental_saver.rs', 'save_worker.rs']:
        source = (audio/name).read_text().replace('#[tauri::command]\n', '')
        (crate/'src/audio'/name).write_text(source)
    modules.append('''pub mod audio {
    pub mod recording_state {
        #[derive(Debug, Clone, PartialEq)] pub enum DeviceType { Microphone, System }
        #[derive(Debug, Clone)] pub struct AudioChunk {
            pub data: Vec<f32>, pub sample_rate: u32, pub timestamp: f64,
            pub chunk_id: u64, pub device_type: DeviceType,
        }
    }
    pub mod ffmpeg { pub fn find_ffmpeg_path() -> Option<std::path::PathBuf> { Some("/usr/bin/ffmpeg".into()) } }
    pub mod incremental_saver;
    pub mod save_worker;
}''')
summary = root/'frontend/src-tauri/src/summary'
if (summary/'execution_config.rs').exists():
    (crate/'src/execution_config.rs').write_text((summary/'execution_config.rs').read_text())
    (crate/'src/execution_gate.rs').write_text((summary/'execution_gate.rs').read_text())
    (crate/'src/inference_priority.rs').write_text((summary/'inference_priority.rs').read_text())
    modules.append('mod inference_priority;')
    llm = (summary/'llm_client.rs').read_text()
    provider = llm[llm.index('#[derive(Debug, Clone, PartialEq)]\npub enum LLMProvider'):llm.index('/// Build the HTTP request')]
    modules.append('pub mod summary { pub mod llm_client {\n'+provider+'\n} }')
    modules.append('''pub mod database { pub mod repositories { pub mod setting {
        pub struct SettingsRepository;
        pub struct ModelConfig { pub ollama_endpoint: Option<String> }
        pub struct CustomConfig { pub endpoint: String, pub model: String, pub api_key: Option<String>, pub max_tokens: Option<i32>, pub temperature: Option<f32>, pub top_p: Option<f32> }
        impl SettingsRepository {
            pub async fn get_model_config(_: &sqlx::SqlitePool) -> Result<Option<ModelConfig>, String> { Ok(None) }
            pub async fn get_custom_openai_config(_: &sqlx::SqlitePool) -> Result<Option<CustomConfig>, String> { Ok(None) }
            pub async fn get_api_key(_: &sqlx::SqlitePool, _: &str) -> Result<Option<String>, String> { Ok(None) }
        }
    } } }
    mod execution_config;
    mod execution_gate;
    ''')
api = root/'frontend/src-tauri/src/api'
for name in ['meeting_notes', 'meeting_export']:
    source = (api/(name+'.rs')).read_text()
    # Retain exact tested data/serialization/SQLite helpers and their production tests.
    body = source[:source.index('#[tauri::command]')]
    tests = source[source.index('#[cfg(test)]'):]
    body = body.replace('use tauri::State;\n', '').replace('use tauri::{AppHandle, Runtime, State};\n', '')
    body = body.replace('use tauri_plugin_dialog::DialogExt;\n', '').replace('use crate::state::AppState;\n', '')
    if 'fn save_dialog_path<' in body:
        start = body.index('fn save_dialog_path<'); end = body.index('fn paths_refer_to_same_file',start)
        body = body[:start]+body[end:]
    (crate/'src'/(name+'.rs')).write_text(body+tests)
    modules.append('mod '+name+';')
(crate/'src/lib.rs').write_text('\n'.join(modules))
env = dict(os.environ)
env['CARGO_TARGET_DIR'] = str(root/'.core-test-target')
print('Executing production core tests; desktop command wrappers and hardware capture excluded.', flush=True)
subprocess.run(['cargo','test','--manifest-path',str(crate/'Cargo.toml'),'--','--nocapture'], env=env, check=True)
