use chrono::Utc;
use once_cell::sync::Lazy;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

const CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";
const CODEX_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_DEVICE_USER_CODE_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const CODEX_DEVICE_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
const CODEX_DEVICE_VERIFY_URL: &str = "https://auth.openai.com/codex/device";
const CODEX_REDIRECT_URI: &str = "https://auth.openai.com/deviceauth/callback";
const AUTH_FILE_NAME: &str = "openai-codex-auth.json";
const REFRESH_SKEW_SECONDS: i64 = 120;


static AUTH_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CodexAuthState {
    access_token: String,
    refresh_token: String,
    #[serde(default)]
    expires_at: Option<i64>,
    #[serde(default)]
    account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    user_code: String,
    device_auth_id: String,
    #[serde(default)]
    interval: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct DevicePollResponse {
    authorization_code: String,
    code_verifier: String,
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    refresh_token: String,
    #[serde(default)]
    expires_in: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDeviceAuthStart {
    pub user_code: String,
    pub device_auth_id: String,
    pub verification_url: String,
    pub interval_seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDeviceAuthPoll {
    pub status: String,
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuthStatus {
    pub logged_in: bool,
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodexModel {
    pub id: String,
}

fn auth_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Unable to resolve MeetOdds app data directory: {e}"))?;
    Ok(dir.join(AUTH_FILE_NAME))
}

fn read_auth(path: &Path) -> Result<Option<CodexAuthState>, String> {
    if !path.exists() {
        return Ok(None);
    }
    if std::fs::symlink_metadata(path).map_err(|_| "Credential metadata unavailable".to_string())?.file_type().is_symlink() {
        return Err("Refusing a symbolic-link credential file".to_string());
    }
    let bytes =
        std::fs::read(path).map_err(|e| format!("Unable to read OpenAI Codex credentials: {e}"))?;
    let auth = serde_json::from_slice::<CodexAuthState>(&bytes)
        .map_err(|e| format!("OpenAI Codex credential file is invalid: {e}"))?;
    if auth.access_token.trim().is_empty() || auth.refresh_token.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(auth))
}

fn write_auth(path: &Path, auth: &CodexAuthState) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or_else(|| "Credential directory is unavailable".to_string())?;
    std::fs::create_dir_all(parent).map_err(|_| "Credential directory could not be created".to_string())?;
    // NamedTempFile is private from creation on Unix; never write a public file then chmod it.
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| "Credential file could not be created".to_string())?;
    serde_json::to_writer(file.as_file_mut(), auth).map_err(|_| "Credentials could not be serialized".to_string())?;
    file.flush().and_then(|_| file.as_file().sync_all()).map_err(|_| "Credentials could not be flushed".to_string())?;
    file.persist(path).map_err(|_| "Credentials could not be committed".to_string())?;
    #[cfg(unix)]
    std::fs::File::open(parent).and_then(|directory| directory.sync_all()).map_err(|_| "Credential directory could not be flushed".to_string())?;
    Ok(())
}

fn remove_auth(path: &Path) -> Result<(), String> {
    if path.exists() {
        std::fs::remove_file(path)
            .map_err(|e| format!("Unable to remove OpenAI Codex credentials: {e}"))?;
    }
    Ok(())
}

fn interval_seconds(value: Option<&Value>) -> u64 {
    let parsed = match value {
        Some(Value::Number(number)) => number.as_u64(),
        Some(Value::String(text)) => text.parse::<u64>().ok(),
        _ => None,
    };
    parsed.unwrap_or(5).max(3)
}

fn base64url_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut accumulator: u32 = 0;
    let mut bits: u8 = 0;

    for byte in input.bytes() {
        if byte == b'=' {
            break;
        }
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return Err("Invalid base64url character in JWT".to_string()),
        } as u32;

        accumulator = (accumulator << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((accumulator >> bits) & 0xff) as u8);
        }
    }

    Ok(out)
}

fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let decoded = base64url_decode(payload).ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn account_id_from_token(token: &str) -> Option<String> {
    let claims = jwt_claims(token)?;
    claims
        .get("https://api.openai.com/auth")?
        .get("chatgpt_account_id")?
        .as_str()
        .map(str::to_string)
}

fn jwt_expiry(token: &str) -> Option<i64> {
    jwt_claims(token)?.get("exp")?.as_i64()
}

fn token_needs_refresh(auth: &CodexAuthState) -> bool {
    let expires_at = auth.expires_at.or_else(|| jwt_expiry(&auth.access_token));
    match expires_at {
        Some(expiry) => expiry <= Utc::now().timestamp() + REFRESH_SKEW_SECONDS,
        None => false,
    }
}

fn codex_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Unable to initialize OpenAI Codex client: {e}"))
}

async fn refresh_auth_with_client(
    client: &Client,
    path: &Path,
    current: &CodexAuthState,
) -> Result<CodexAuthState, String> {
    let response = client
        .post(CODEX_OAUTH_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", current.refresh_token.as_str()),
            ("client_id", CODEX_OAUTH_CLIENT_ID),
        ])
        .send()
        .await
        .map_err(|e| format!("Unable to refresh ChatGPT/Codex session: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(
                "ChatGPT/Codex session expired or was revoked. Sign in again in MeetOdds."
                    .to_string(),
            );
        }
        return Err(format!(
            "Unable to refresh ChatGPT/Codex session (HTTP {status}): {}",
            compact_error(&body)
        ));
    }

    let token = response
        .json::<OAuthTokenResponse>()
        .await
        .map_err(|e| format!("OpenAI returned an invalid refresh response: {e}"))?;
    let account_id =
        account_id_from_token(&token.access_token).or_else(|| current.account_id.clone());
    let refreshed = CodexAuthState {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: token
            .expires_in
            .map(|seconds| Utc::now().timestamp().saturating_add(seconds)),
        account_id,
    };
    write_auth(path, &refreshed)?;
    Ok(refreshed)
}

async fn load_valid_auth<R: Runtime>(
    app: &AppHandle<R>,
    client: &Client,
) -> Result<CodexAuthState, String> {
    let _guard = AUTH_LOCK.lock().await;
    let path = auth_path(app)?;
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

async fn force_refresh<R: Runtime>(
    app: &AppHandle<R>,
    client: &Client,
) -> Result<CodexAuthState, String> {
    let _guard = AUTH_LOCK.lock().await;
    let path = auth_path(app)?;
    let auth = read_auth(&path)?.ok_or_else(|| {
        "OpenAI Codex is not connected. Sign in again in MeetOdds settings.".to_string()
    })?;
    refresh_auth_with_client(client, &path, &auth).await
}

fn compact_error(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.chars().count() <= 600 {
        return trimmed.to_string();
    }
    format!("{}…", trimmed.chars().take(600).collect::<String>())
}

fn apply_codex_headers(
    request: reqwest::RequestBuilder,
    auth: &CodexAuthState,
    accept_sse: bool,
) -> reqwest::RequestBuilder {
    let mut request = request
        .bearer_auth(&auth.access_token)
        .header("Content-Type", "application/json")
        .header("User-Agent", "codex_cli_rs/0.0.0 (MeetOdds)")
        .header("originator", "codex_cli_rs");
    if accept_sse {
        request = request
            .header("Accept", "text/event-stream")
            .header("OpenAI-Beta", "responses=experimental");
    }
    if let Some(account_id) = auth.account_id.as_deref() {
        request = request.header("ChatGPT-Account-ID", account_id);
    }
    request
}

#[tauri::command]
pub async fn openai_codex_start_device_auth() -> Result<CodexDeviceAuthStart, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Unable to initialize OpenAI login client: {e}"))?;
    let response = client
        .post(CODEX_DEVICE_USER_CODE_URL)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "client_id": CODEX_OAUTH_CLIENT_ID }))
        .send()
        .await
        .map_err(|e| format!("Unable to start ChatGPT/Codex sign-in: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "OpenAI could not start device sign-in (HTTP {status}): {}",
            compact_error(&body)
        ));
    }

    let data = response
        .json::<DeviceCodeResponse>()
        .await
        .map_err(|e| format!("OpenAI returned an invalid device sign-in response: {e}"))?;
    if data.user_code.trim().is_empty() || data.device_auth_id.trim().is_empty() {
        return Err("OpenAI device sign-in response was missing the required code.".to_string());
    }

    Ok(CodexDeviceAuthStart {
        user_code: data.user_code,
        device_auth_id: data.device_auth_id,
        verification_url: CODEX_DEVICE_VERIFY_URL.to_string(),
        interval_seconds: interval_seconds(data.interval.as_ref()),
    })
}

#[tauri::command]
pub async fn openai_codex_poll_device_auth<R: Runtime>(
    app: AppHandle<R>,
    device_auth_id: String,
    user_code: String,
) -> Result<CodexDeviceAuthPoll, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Unable to initialize OpenAI login client: {e}"))?;
    let response = client
        .post(CODEX_DEVICE_TOKEN_URL)
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({
            "device_auth_id": device_auth_id,
            "user_code": user_code,
        }))
        .send()
        .await
        .map_err(|e| format!("Unable to check ChatGPT/Codex sign-in: {e}"))?;

    if response.status() == StatusCode::FORBIDDEN || response.status() == StatusCode::NOT_FOUND {
        return Ok(CodexDeviceAuthPoll {
            status: "pending".to_string(),
            account_id: None,
        });
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "OpenAI device sign-in polling failed (HTTP {status}): {}",
            compact_error(&body)
        ));
    }

    let code = response
        .json::<DevicePollResponse>()
        .await
        .map_err(|e| format!("OpenAI returned an invalid device authorization response: {e}"))?;
    if code.authorization_code.trim().is_empty() || code.code_verifier.trim().is_empty() {
        return Err("OpenAI device authorization response was incomplete.".to_string());
    }

    let token_response = client
        .post(CODEX_OAUTH_TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.authorization_code.as_str()),
            ("redirect_uri", CODEX_REDIRECT_URI),
            ("client_id", CODEX_OAUTH_CLIENT_ID),
            ("code_verifier", code.code_verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("Unable to finish ChatGPT/Codex sign-in: {e}"))?;

    if !token_response.status().is_success() {
        let status = token_response.status();
        let body = token_response.text().await.unwrap_or_default();
        return Err(format!(
            "OpenAI token exchange failed (HTTP {status}): {}",
            compact_error(&body)
        ));
    }

    let token = token_response
        .json::<OAuthTokenResponse>()
        .await
        .map_err(|e| format!("OpenAI returned an invalid token response: {e}"))?;
    let account_id = account_id_from_token(&token.access_token);
    let auth = CodexAuthState {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: token
            .expires_in
            .map(|seconds| Utc::now().timestamp().saturating_add(seconds)),
        account_id: account_id.clone(),
    };

    let _guard = AUTH_LOCK.lock().await;
    let path = auth_path(&app)?;
    write_auth(&path, &auth)?;

    Ok(CodexDeviceAuthPoll {
        status: "connected".to_string(),
        account_id,
    })
}

#[tauri::command]
pub async fn openai_codex_get_auth_status<R: Runtime>(
    app: AppHandle<R>,
) -> Result<CodexAuthStatus, String> {
    let client = codex_client()?;
    match load_valid_auth(&app, &client).await {
        Ok(auth) => Ok(CodexAuthStatus {
            logged_in: true,
            account_id: auth.account_id,
        }),
        Err(error) if error.contains("not connected") => Ok(CodexAuthStatus {
            logged_in: false,
            account_id: None,
        }),
        Err(error) if error.contains("Sign in again") || error.contains("expired") => {
            Ok(CodexAuthStatus {
                logged_in: false,
                account_id: None,
            })
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn openai_codex_logout<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let _guard = AUTH_LOCK.lock().await;
    let path = auth_path(&app)?;
    remove_auth(&path)
}

async fn load_valid_auth_from_dir(
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

async fn request_models(
    client: &Client,
    auth: &CodexAuthState,
) -> Result<reqwest::Response, String> {
    let url = format!("{CODEX_BASE_URL}/models?client_version=1.0.0");
    apply_codex_headers(client.get(url), auth, false)
        .send()
        .await
        .map_err(|e| format!("Unable to load ChatGPT/Codex models: {e}"))
}

#[tauri::command]
pub async fn openai_codex_get_models<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<CodexModel>, String> {
    let client = codex_client()?;
    let mut auth = load_valid_auth(&app, &client).await?;
    let mut response = request_models(&client, &auth).await?;
    if response.status() == StatusCode::UNAUTHORIZED {
        auth = force_refresh(&app, &client).await?;
        response = request_models(&client, &auth).await?;
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "ChatGPT/Codex model discovery failed (HTTP {status}): {}",
            compact_error(&body)
        ));
    }

    let value = response
        .json::<Value>()
        .await
        .map_err(|e| format!("ChatGPT/Codex model response was invalid: {e}"))?;
    let mut models: Vec<String> = value
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| model.get("slug").and_then(Value::as_str))
        .filter(|slug| !slug.ends_with("-pro"))
        .map(str::to_string)
        .collect();

    models.sort();
    models.dedup();
    if models.is_empty() {
        return Err("No summary-capable models were returned for this ChatGPT account. Reconnect or refresh the model list; no fallback model was selected.".to_string());
    }

    Ok(models.into_iter().map(|id| CodexModel { id }).collect())
}

fn build_codex_response_body(
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_output_tokens: Option<u32>,
) -> Value {
    let mut body = serde_json::json!({
        "model": model_name,
        "input": [{
            "role": "user",
            "content": user_prompt,
        }],
        "instructions": system_prompt,
        "stream": true,
        "store": false,
    });
    if let Some(limit) = max_output_tokens {
        body["max_output_tokens"] = serde_json::json!(limit);
    }
    body
}

async fn send_codex_response_request(
    client: &Client,
    auth: &CodexAuthState,
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_output_tokens: Option<u32>,
) -> Result<reqwest::Response, String> {
    let url = format!("{CODEX_BASE_URL}/responses");
    let body = build_codex_response_body(model_name, system_prompt, user_prompt, max_output_tokens);
    apply_codex_headers(client.post(url), auth, true)
        .timeout(Duration::from_secs(300))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Unable to send ChatGPT/Codex request: {e}"))
}

fn content_text(value: &Value) -> Option<String> {
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    if let Some(text) = value.get("output_text").and_then(Value::as_str) {
        return Some(text.to_string());
    }
    None
}

fn collect_item_text(item: &Value) -> String {
    let mut out = String::new();
    if let Some(content) = item.get("content").and_then(Value::as_array) {
        for part in content {
            if let Some(text) = content_text(part) {
                out.push_str(&text);
            }
        }
    }
    out
}

fn collect_response_text(response: &Value) -> String {
    if let Some(text) = response.get("output_text").and_then(Value::as_str) {
        return text.to_string();
    }
    let mut out = String::new();
    if let Some(output) = response.get("output").and_then(Value::as_array) {
        for item in output {
            out.push_str(&collect_item_text(item));
        }
    }
    out
}

fn parse_codex_sse(body: &str) -> Result<String, String> {
    let mut deltas = String::new();
    let mut completed_fallback = String::new();
    let mut item_fallback = String::new();

    for line in body.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let event: Value = match serde_json::from_str(data) {
            Ok(event) => event,
            Err(_) => continue,
        };
        match event.get("type").and_then(Value::as_str) {
            Some("response.output_text.delta") => {
                if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                    deltas.push_str(delta);
                }
            }
            Some("response.output_item.done") => {
                if let Some(item) = event.get("item") {
                    let text = collect_item_text(item);
                    if !text.is_empty() {
                        item_fallback.push_str(&text);
                    }
                }
            }
            Some("response.completed") => {
                if let Some(response) = event.get("response") {
                    completed_fallback = collect_response_text(response);
                }
            }
            Some("error") | Some("response.failed") => {
                let message = event
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .or_else(|| event.get("message").and_then(Value::as_str))
                    .unwrap_or("ChatGPT/Codex returned an unknown error");
                return Err(message.to_string());
            }
            _ => {}
        }
    }

    let result = if !deltas.is_empty() {
        deltas
    } else if !item_fallback.is_empty() {
        item_fallback
    } else {
        completed_fallback
    };

    if result.trim().is_empty() {
        Err("ChatGPT/Codex returned no text output.".to_string())
    } else {
        Ok(result)
    }
}

/// Send a streaming Responses request and return the open SSE response,
/// refreshing the ChatGPT session once on 401.
pub async fn open_codex_stream(
    client: &Client,
    app_data_dir: &Path,
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_output_tokens: Option<u32>,
) -> Result<reqwest::Response, String> {
    let mut auth = load_valid_auth_from_dir(app_data_dir, client).await?;
    let mut response = send_codex_response_request(
        client,
        &auth,
        model_name,
        system_prompt,
        user_prompt,
        max_output_tokens,
    )
    .await?;

    if response.status() == StatusCode::UNAUTHORIZED {
        auth = force_refresh_from_dir(app_data_dir, client).await?;
        response = send_codex_response_request(
            client,
            &auth,
            model_name,
            system_prompt,
            user_prompt,
            max_output_tokens,
        )
        .await?;
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if status == StatusCode::TOO_MANY_REQUESTS {
            return Err(format!(
                "ChatGPT/Codex usage limit reached. Your subscription's Codex allowance may need time to reset: {}",
                compact_error(&body)
            ));
        }
        return Err(format!(
            "ChatGPT/Codex request failed (HTTP {status}): {}",
            compact_error(&body)
        ));
    }

    Ok(response)
}

pub async fn generate_codex_summary(
    client: &Client,
    app_data_dir: &Path,
    model_name: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_output_tokens: Option<u32>,
    cancellation_token: Option<&CancellationToken>,
) -> Result<String, String> {
    if let Some(token) = cancellation_token {
        if token.is_cancelled() {
            return Err("Summary generation was cancelled".to_string());
        }
    }

    let response = open_codex_stream(
        client,
        app_data_dir,
        model_name,
        system_prompt,
        user_prompt,
        max_output_tokens,
    )
    .await?;

    let body_future = response.text();
    let body = if let Some(token) = cancellation_token {
        tokio::select! {
            result = body_future => result.map_err(|e| format!("Unable to read ChatGPT/Codex response: {e}"))?,
            _ = token.cancelled() => return Err("Summary generation was cancelled".to_string()),
        }
    } else {
        body_future
            .await
            .map_err(|e| format!("Unable to read ChatGPT/Codex response: {e}"))?
    };

    parse_codex_sse(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_chatgpt_account_id_from_jwt() {
        let claims = r#"{"exp":4102444800,"https://api.openai.com/auth":{"chatgpt_account_id":"acct_test"}}"#;
        fn encode(data: &[u8]) -> String {
            const TABLE: &[u8; 64] =
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let mut out = String::new();
            let mut acc = 0u32;
            let mut bits = 0u8;
            for byte in data {
                acc = (acc << 8) | *byte as u32;
                bits += 8;
                while bits >= 6 {
                    bits -= 6;
                    out.push(TABLE[((acc >> bits) & 0x3f) as usize] as char);
                }
            }
            if bits > 0 {
                out.push(TABLE[((acc << (6 - bits)) & 0x3f) as usize] as char);
            }
            out
        }
        let token = format!("e30.{}.sig", encode(claims.as_bytes()));
        assert_eq!(account_id_from_token(&token).as_deref(), Some("acct_test"));
    }

    #[test]
    fn parses_streaming_output_text_deltas() {
        let body = concat!(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello \"}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"world\"}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"output\":null}}\n\n",
            "data: [DONE]\n\n"
        );
        assert_eq!(parse_codex_sse(body).unwrap(), "Hello world");
    }

    #[test]
    fn falls_back_to_output_item_text() {
        let body = concat!(
            "data: {\"type\":\"response.output_item.done\",\"item\":{\"content\":[{\"type\":\"output_text\",\"text\":\"Fallback text\"}]}}\n\n",
            "data: [DONE]\n\n"
        );
        assert_eq!(parse_codex_sse(body).unwrap(), "Fallback text");
    }

    #[test]
    fn codex_response_body_only_sets_an_explicit_output_limit() {
        let limited = build_codex_response_body("model", "system", "user", Some(512));
        assert_eq!(limited["max_output_tokens"], 512);

        let unlimited = build_codex_response_body("model", "system", "user", None);
        assert!(unlimited.get("max_output_tokens").is_none());
    }
}
