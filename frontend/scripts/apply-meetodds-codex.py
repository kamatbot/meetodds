from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old in text:
        p.write_text(text.replace(old, new, 1))
        return
    if new in text:
        return
    raise SystemExit(f"Missing anchor in {path}: {old[:160]!r}")


# Codex module: let summary generation resolve the MeetOdds-owned auth file
# from the same app-data directory already passed to other local providers.
p = Path("frontend/src-tauri/src/openai_codex.rs")
text = p.read_text()
marker = """async fn request_models(
    client: &Client,
    auth: &CodexAuthState,
) -> Result<reqwest::Response, String> {"""
helpers = """async fn load_valid_auth_from_dir(
    app_data_dir: &Path,
    client: &Client,
) -> Result<CodexAuthState, String> {
    let _guard = AUTH_LOCK.lock().await;
    let path = app_data_dir.join(AUTH_FILE_NAME);
    let auth = read_auth(&path)?.ok_or_else(|| {
        "OpenAI Codex is not connected. Sign in with your ChatGPT subscription in MeetOdds settings."
            .to_string()
    })?;
    if token_needs_refresh(&auth) {
        refresh_auth_with_client(client, &path, &auth).await
    } else {
        Ok(auth)
    }
}

async fn force_refresh_from_dir(
    app_data_dir: &Path,
    client: &Client,
) -> Result<CodexAuthState, String> {
    let _guard = AUTH_LOCK.lock().await;
    let path = app_data_dir.join(AUTH_FILE_NAME);
    let auth = read_auth(&path)?.ok_or_else(|| {
        "OpenAI Codex is not connected. Sign in again in MeetOdds settings.".to_string()
    })?;
    refresh_auth_with_client(client, &path, &auth).await
}

"""
if "async fn load_valid_auth_from_dir(" not in text:
    if marker not in text:
        raise SystemExit("Codex model-request anchor changed after main sync")
    text = text.replace(marker, helpers + marker, 1)

text = text.replace(
    "pub async fn generate_codex_summary<R: Runtime>(\n    client: &Client,\n    app: &AppHandle<R>,",
    "pub async fn generate_codex_summary(\n    client: &Client,\n    app_data_dir: &Path,",
    1,
)
start = text.index("pub async fn generate_codex_summary(")
head, tail = text[:start], text[start:]
tail = tail.replace(
    "load_valid_auth(app, client).await?",
    "load_valid_auth_from_dir(app_data_dir, client).await?",
    1,
)
tail = tail.replace(
    "force_refresh(app, client).await?",
    "force_refresh_from_dir(app_data_dir, client).await?",
    1,
)
text = head + tail
text = text.replace(
    """    let trimmed = body.trim();
    if trimmed.len() <= 600 {
        return trimmed.to_string();
    }
    format!("{}…", &trimmed[..600])""",
    """    let trimmed = body.trim();
    if trimmed.chars().count() <= 600 {
        return trimmed.to_string();
    }
    format!("{}…", trimmed.chars().take(600).collect::<String>())""",
    1,
)
text = text.replace(
    """    apply_codex_headers(client.post(url), auth, true)
        .json(&body)""",
    """    apply_codex_headers(client.post(url), auth, true)
        .timeout(Duration::from_secs(300))
        .json(&body)""",
    1,
)
p.write_text(text)

# Native LLM provider dispatch.
llm = "frontend/src-tauri/src/summary/llm_client.rs"
replace_once(llm, "    OpenAI,\n    Claude,", "    OpenAI,\n    OpenAICodex,\n    Claude,")
replace_once(
    llm,
    '            "openai" => Ok(Self::OpenAI),\n            "claude" => Ok(Self::Claude),',
    '            "openai" => Ok(Self::OpenAI),\n            "openai-codex" | "codex" | "chatgpt" => Ok(Self::OpenAICodex),\n            "claude" => Ok(Self::Claude),',
)
replace_once(
    llm,
    """    // Handle BuiltInAI provider separately (uses local sidecar, no HTTP API)
    if provider == &LLMProvider::BuiltInAI {""",
    """    if provider == &LLMProvider::OpenAICodex {
        let app_data_dir = app_data_dir
            .ok_or_else(|| "app_data_dir is required for OpenAI Codex provider".to_string())?;
        return crate::openai_codex::generate_codex_summary(
            client,
            app_data_dir,
            model_name,
            system_prompt,
            user_prompt,
            cancellation_token,
        )
        .await;
    }

    // Handle BuiltInAI provider separately (uses local sidecar, no HTTP API)
    if provider == &LLMProvider::BuiltInAI {""",
)
replace_once(
    llm,
    """        LLMProvider::BuiltInAI => {
            // This case is handled earlier with early returns
            unreachable!("BuiltInAI is handled before this match statement")
        }""",
    """        LLMProvider::BuiltInAI => {
            unreachable!("BuiltInAI is handled before this match statement")
        }
        LLMProvider::OpenAICodex => {
            unreachable!("OpenAICodex is handled before this match statement")
        }""",
)
replace_once(
    llm,
    '        LLMProvider::OpenAI => "OpenAI",\n        LLMProvider::Claude => "Claude",',
    '        LLMProvider::OpenAI => "OpenAI",\n        LLMProvider::OpenAICodex => "OpenAI Codex (ChatGPT subscription)",\n        LLMProvider::Claude => "Claude",',
)

replace_once(
    "frontend/src-tauri/src/summary/service.rs",
    "        let api_key = if provider == LLMProvider::Ollama || provider == LLMProvider::BuiltInAI || provider == LLMProvider::CustomOpenAI {",
    """        let api_key = if provider == LLMProvider::Ollama
            || provider == LLMProvider::BuiltInAI
            || provider == LLMProvider::CustomOpenAI
            || provider == LLMProvider::OpenAICodex
        {""",
)

# Database settings: Codex OAuth uses no API-key column.
settings = Path("frontend/src-tauri/src/database/repositories/setting.rs")
text = settings.read_text()
text = text.replace(
    '            "builtin-ai" => return Ok(()), // No API key needed\n            _ => {',
    '            "builtin-ai" => return Ok(()), // No API key needed\n            "openai-codex" => return Ok(()), // MeetOdds-owned OAuth\n            _ => {',
    1,
)
text = text.replace(
    '            "builtin-ai" => return Ok(None), // No API key needed\n            _ => {',
    '            "builtin-ai" => return Ok(None), // No API key needed\n            "openai-codex" => return Ok(None), // OAuth lives outside SQLite\n            _ => {',
    1,
)
text = text.replace(
    '            "builtin-ai" => return Ok(()), // No API key needed\n            _ => {',
    '            "builtin-ai" => return Ok(()), // No API key needed\n            "openai-codex" => return Ok(()), // OAuth lives outside SQLite\n            _ => {',
    1,
)
settings.write_text(text)

replace_once(
    "frontend/src-tauri/src/lib.rs",
    "pub mod openai;\npub mod anthropic;",
    "pub mod openai;\npub mod openai_codex;\npub mod anthropic;",
)
replace_once(
    "frontend/src-tauri/src/lib.rs",
    "            openai::openai::get_openai_models,\n            anthropic::anthropic::get_anthropic_models,",
    """            openai::openai::get_openai_models,
            openai_codex::openai_codex_start_device_auth,
            openai_codex::openai_codex_poll_device_auth,
            openai_codex::openai_codex_get_auth_status,
            openai_codex::openai_codex_logout,
            openai_codex::openai_codex_get_models,
            anthropic::anthropic::get_anthropic_models,""",
)

# Frontend provider types.
p = Path("frontend/src/services/configService.ts")
text = p.read_text()
old_variants = [
    "provider: 'ollama' | 'groq' | 'claude' | 'openrouter' | 'openai' | 'builtin-ai' | 'custom-openai';",
    "provider: 'ollama' | 'groq' | 'claude' | 'openai' | 'openrouter' | 'builtin-ai' | 'custom-openai';",
]
new = "provider: 'ollama' | 'groq' | 'claude' | 'openai' | 'openai-codex' | 'openrouter' | 'builtin-ai' | 'custom-openai';"
if new not in text:
    for old in old_variants:
        if old in text:
            text = text.replace(old, new, 1)
            break
    else:
        raise SystemExit("configService provider union changed after main sync")
p.write_text(text)

p = Path("frontend/src/components/ModelSettingsModal.tsx")
text = p.read_text()
old = "provider: 'ollama' | 'groq' | 'claude' | 'openai' | 'openrouter' | 'builtin-ai' | 'custom-openai';"
new = "provider: 'ollama' | 'groq' | 'claude' | 'openai' | 'openai-codex' | 'openrouter' | 'builtin-ai' | 'custom-openai';"
if old in text:
    text = text.replace(old, new, 1)
elif new not in text:
    raise SystemExit("ModelSettings provider union changed after main sync")

if "OpenAICodexSettings" not in text:
    text = text.replace(
        "import { toast } from 'sonner';",
        "import { toast } from 'sonner';\nimport { OpenAICodexSettings } from '@/components/OpenAICodexSettings';",
        1,
    )

if "const CODEX_FALLBACK_MODELS" not in text:
    text = text.replace(
        "const CLAUDE_FALLBACK_MODELS = [",
        """const CODEX_FALLBACK_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4-mini',
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
];

const CLAUDE_FALLBACK_MODELS = [""",
        1,
    )

if "const [codexModels" not in text:
    text = text.replace(
        "  const [openaiModels, setOpenaiModels] = useState<string[]>([]);\n  const [claudeModels, setClaudeModels] = useState<string[]>([]);",
        "  const [openaiModels, setOpenaiModels] = useState<string[]>([]);\n  const [codexModels, setCodexModels] = useState<string[]>([]);\n  const [codexConnected, setCodexConnected] = useState<boolean>(false);\n  const [claudeModels, setClaudeModels] = useState<string[]>([]);",
        1,
    )

if "'openai-codex': codexModels" not in text:
    text = text.replace(
        "    openai: openaiModels.length > 0 ? openaiModels : OPENAI_FALLBACK_MODELS,\n    openrouter:",
        "    openai: openaiModels.length > 0 ? openaiModels : OPENAI_FALLBACK_MODELS,\n    'openai-codex': codexModels.length > 0 ? codexModels : CODEX_FALLBACK_MODELS,\n    openrouter:",
        1,
    )

if "modelConfig.provider === 'openai-codex' && !codexConnected" not in text:
    text = text.replace(
        "    (requiresApiKey && (!apiKey || (typeof apiKey === 'string' && !apiKey.trim()))) ||\n    (modelConfig.provider === 'ollama' && ollamaEndpointChanged) ||",
        "    (requiresApiKey && (!apiKey || (typeof apiKey === 'string' && !apiKey.trim()))) ||\n    (modelConfig.provider === 'openai-codex' && !codexConnected) ||\n    (modelConfig.provider === 'ollama' && ollamaEndpointChanged) ||",
        1,
    )

text = text.replace(
    "          if (data.provider !== 'ollama' && !data.apiKey) {",
    "          if (data.provider !== 'ollama' && data.provider !== 'openai-codex' && !data.apiKey) {",
    1,
)
text = text.replace(
    "  }, [models, openRouterModels, builtinAiModels, openaiModels, claudeModels, groqModels, modelConfig.provider]);",
    "  }, [models, openRouterModels, builtinAiModels, openaiModels, codexModels, claudeModels, groqModels, modelConfig.provider]);",
    1,
)
text = text.replace(
    "      apiKey: typeof apiKey === 'string' ? apiKey.trim() || null : null,",
    "      apiKey: modelConfig.provider === 'openai-codex' ? null : (typeof apiKey === 'string' ? apiKey.trim() || null : null),",
    1,
)

if '<SelectItem value="openai-codex">' not in text:
    text = text.replace(
        '                <SelectItem value="openai">OpenAI Cloud API</SelectItem>',
        '                <SelectItem value="openai-codex">OpenAI Codex (ChatGPT subscription)</SelectItem>\n                <SelectItem value="openai">OpenAI Cloud API</SelectItem>',
        1,
    )

start = text.find("        {modelConfig.provider === 'openai' && (")
end_anchor = "        {/* Custom OpenAI Configuration Section */}"
end = text.find(end_anchor, start)
if start == -1 or end == -1:
    raise SystemExit("OpenAI settings block moved after main sync")
replacement = """        {modelConfig.provider === 'openai' && (
          <Alert className="border-blue-200 bg-blue-50">
            <AlertDescription className="space-y-2 text-sm text-blue-950">
              <p>
                <strong>OpenAI Cloud API</strong> uses an OpenAI API key and separate API billing.
                To use your ChatGPT Plus/Pro Codex allowance, choose
                <strong> OpenAI Codex (ChatGPT subscription)</strong>.
              </p>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-blue-700"
                onClick={() => invoke('open_external_url', { url: 'https://platform.openai.com/api-keys' })}
              >
                Create or manage an OpenAI API key
                <ExternalLink className="ml-1 h-3.5 w-3.5" />
              </Button>
            </AlertDescription>
          </Alert>
        )}

        {modelConfig.provider === 'openai-codex' && (
          <OpenAICodexSettings
            onConnectionChange={setCodexConnected}
            onModelsChange={(nextModels) => {
              setCodexModels(nextModels);
              if (nextModels.length > 0 && !nextModels.includes(modelConfig.model)) {
                setModelConfig((prev: ModelConfig) => ({ ...prev, model: nextModels[0] }));
              }
            }}
          />
        )}

"""
text = text[:start] + replacement + text[end:]
p.write_text(text)

# ConfigContext requires one model list for every provider in the union.
p = Path("frontend/src/contexts/ConfigContext.tsx")
text = p.read_text()
if "'openai-codex':" not in text:
    if "    openai: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo']," in text:
        text = text.replace(
            "    openai: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo'],",
            "    openai: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'],\n    'openai-codex': ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4'],",
            1,
        )
    elif "    openai: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna']," in text:
        text = text.replace(
            "    openai: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'],",
            "    openai: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'],\n    'openai-codex': ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4'],",
            1,
        )
    else:
        raise SystemExit("ConfigContext OpenAI model anchor moved after main sync")
p.write_text(text)

p = Path("frontend/src/hooks/meeting-details/useModelConfiguration.ts")
text = p.read_text()
text = text.replace(
    "          if (data.provider !== 'ollama' && data.provider !== 'custom-openai' && !data.apiKey) {",
    "          if (data.provider !== 'ollama' && data.provider !== 'custom-openai' && data.provider !== 'openai-codex' && !data.apiKey) {",
    1,
)
p.write_text(text)

Path("docs/OPENAI_CLOUD.md").write_text(
    """# OpenAI in MeetOdds

MeetOdds supports two separate OpenAI summary providers. Recording and transcription stay local unless you explicitly choose a cloud summary provider.

## OpenAI Codex — ChatGPT subscription

Choose **OpenAI Codex (ChatGPT subscription)** to use the Codex allowance available to your ChatGPT Plus/Pro account. MeetOdds follows the same pattern used by Hermes Agent: OpenAI's Codex device-code OAuth flow and the ChatGPT Codex Responses backend. No OpenAI API key is required.

MeetOdds opens OpenAI's device-login page, stores its own rotating access/refresh token pair in the app-data directory, refreshes it when needed, discovers models from the signed-in Codex account, and sends summary requests to `https://chatgpt.com/backend-api/codex/responses`.

MeetOdds deliberately does **not** import or overwrite `~/.codex/auth.json`; refresh tokens rotate, so MeetOdds owns only the OAuth session it created. On Unix, the credential file is owner-readable only. A subscription usage-limit response is surfaced as a Codex allowance condition instead of an API-key error.

## OpenAI Cloud API — API billing

Choose **OpenAI Cloud API** for the normal OpenAI Platform API-key path. This calls `api.openai.com` and uses API billing separately from ChatGPT subscriptions.

## Privacy

Local Built-in AI and Ollama remain available for fully local summaries. When either OpenAI provider is selected, transcript text needed for summary generation or translation is sent to that OpenAI service.

## Upgrade compatibility

The visible app name is **MeetOdds**, while the existing `com.meetily.ai` bundle identifier and internal Rust package name remain unchanged so existing settings, recordings, model files, and database data survive the rename.
"""
)
