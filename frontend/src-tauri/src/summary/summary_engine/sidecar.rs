// Sidecar process lifecycle management for llama-helper
// Handles spawning, health checking, keep-alive, and graceful shutdown

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use super::models;

// ============================================================================
// Sidecar State Management
// ============================================================================

/// Sidecar process manager with keep-alive and health monitoring
pub struct SidecarManager {
    /// Child process handle
    child_process: Arc<Mutex<Option<Child>>>,

    /// Stdin writer for sending requests
    stdin_writer: Arc<Mutex<Option<ChildStdin>>>,

    /// Stdout reader for receiving responses
    stdout_reader: Arc<Mutex<Option<BufReader<ChildStdout>>>>,

    /// Held across a request's write + read so exchanges never interleave
    exchange: Arc<Mutex<()>>,

    /// Source of request ids; the helper echoes the id in its reply
    next_request_id: Arc<AtomicU64>,

    /// Last activity timestamp
    last_activity: Arc<RwLock<Instant>>,

    /// Health status
    is_healthy: Arc<AtomicBool>,

    /// Shutdown flag
    should_shutdown: Arc<AtomicBool>,

    /// Active request count (for graceful shutdown)
    active_request_count: Arc<AtomicUsize>,

    /// Path to llama-helper binary
    helper_binary_path: PathBuf,

    /// Current model path (if loaded)
    current_model_path: Arc<RwLock<Option<PathBuf>>>,

    /// Idle timeout in seconds (configurable via env var)
    idle_timeout_secs: u64,
}

/// RAII guard for tracking active requests
/// Decrements the active request count when dropped
struct RequestGuard {
    counter: Arc<AtomicUsize>,
}

impl RequestGuard {
    fn new(counter: Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self { counter }
    }
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        self.counter.fetch_sub(1, Ordering::SeqCst);
    }
}

impl SidecarManager {
    /// Create a new sidecar manager
    pub fn new(_app_data_dir: PathBuf) -> Result<Self> {
        let helper_binary_path = Self::resolve_helper_binary()?;

        // Get idle timeout from env var or use default
        let idle_timeout_secs = std::env::var("LLAMA_IDLE_TIMEOUT")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(models::DEFAULT_IDLE_TIMEOUT_SECS);

        log::info!(
            "SidecarManager initialized with idle timeout: {}s",
            idle_timeout_secs
        );
        log::info!("Helper binary path: {}", helper_binary_path.display());

        Ok(Self {
            child_process: Arc::new(Mutex::new(None)),
            stdin_writer: Arc::new(Mutex::new(None)),
            stdout_reader: Arc::new(Mutex::new(None)),
            exchange: Arc::new(Mutex::new(())),
            next_request_id: Arc::new(AtomicU64::new(1)),
            last_activity: Arc::new(RwLock::new(Instant::now())),
            is_healthy: Arc::new(AtomicBool::new(false)),
            should_shutdown: Arc::new(AtomicBool::new(false)),
            active_request_count: Arc::new(AtomicUsize::new(0)),
            helper_binary_path,
            current_model_path: Arc::new(RwLock::new(None)),
            idle_timeout_secs,
        })
    }

    /// Resolve the path to llama-helper binary
    fn resolve_helper_binary() -> Result<PathBuf> {
        // 1. Check environment variable (dev mode or manual override)
        if let Ok(env_path) = std::env::var("MEETODDS_LLAMA_HELPER") {
            if !env_path.is_empty() {
                let path = PathBuf::from(env_path);
                if path.exists() {
                    log::info!("Using llama-helper from MEETODDS_LLAMA_HELPER: {}", path.display());
                    return Ok(path);
                }
            }
        }

        // In production, Tauri bundles the binary with target triple suffix
        // 2. Check relative to current executable (most reliable for AppImage/bundled apps)
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                log::info!("Searching for llama-helper relative to executable: {}", exe_dir.display());
                
                // Get the target triple (same logic as before)
                let target_triple = std::env::var("TARGET")
                    .unwrap_or_else(|_| {
                        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
                        { "x86_64-unknown-linux-gnu".to_string() }
                        #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
                        { "aarch64-unknown-linux-gnu".to_string() }
                        #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
                        { "x86_64-apple-darwin".to_string() }
                        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
                        { "aarch64-apple-darwin".to_string() }
                        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
                        { "x86_64-pc-windows-msvc".to_string() }
                        #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
                        { "aarch64-pc-windows-msvc".to_string() }
                        #[cfg(not(any(
                            all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")),
                            all(target_os = "macos", any(target_arch = "x86_64", target_arch = "aarch64")),
                            all(target_os = "windows", any(target_arch = "x86_64", target_arch = "aarch64"))
                        )))]
                        { "unknown".to_string() }
                    });

                let binary_name = if cfg!(windows) {
                    format!("llama-helper-{}.exe", target_triple)
                } else {
                    format!("llama-helper-{}", target_triple)
                };

                // Try exact match in exe dir
                let bundled = exe_dir.join(&binary_name);
                if bundled.exists() {
                    log::info!("Found exact match next to executable: {}", bundled.display());
                    return Ok(bundled);
                }

                // Fuzzy match in exe dir
                log::info!("Attempting fuzzy match in exe dir: {}", exe_dir.display());
                if let Ok(entries) = std::fs::read_dir(exe_dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                            if name.starts_with("llama-helper") && !name.ends_with(".d") {
                                log::info!("Found fuzzy match next to executable: {}", path.display());
                                return Ok(path);
                            }
                        }
                    }
                }
            }
        }

        // 3. Check bundled resources (RESOURCE_DIR) - Fallback
        if let Ok(resource_dir) = std::env::var("RESOURCE_DIR") {
            log::info!("Searching for llama-helper in RESOURCE_DIR: {}", resource_dir);
            let resource_path = PathBuf::from(&resource_dir);
             // Get the target triple again (or we could have shared it, but code duplication is safer for this tool usage)
            let target_triple = std::env::var("TARGET")
                .unwrap_or_else(|_| {
                     #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
                    { "x86_64-unknown-linux-gnu".to_string() }
                    // ... (abbreviated for brevity in thought, but must be full in tool)
                     #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
                    { "aarch64-unknown-linux-gnu".to_string() }
                    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
                    { "x86_64-apple-darwin".to_string() }
                    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
                    { "aarch64-apple-darwin".to_string() }
                    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
                    { "x86_64-pc-windows-msvc".to_string() }
                    #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
                    { "aarch64-pc-windows-msvc".to_string() }
                    #[cfg(not(any(
                        all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")),
                        all(target_os = "macos", any(target_arch = "x86_64", target_arch = "aarch64")),
                        all(target_os = "windows", any(target_arch = "x86_64", target_arch = "aarch64"))
                    )))]
                    { "unknown".to_string() }
                });

            let binary_name = if cfg!(windows) {
                format!("llama-helper-{}.exe", target_triple)
            } else {
                format!("llama-helper-{}", target_triple)
            };

            let bundled = resource_path.join(&binary_name);
            if bundled.exists() {
                log::info!("Found exact match in RESOURCE_DIR: {}", bundled.display());
                return Ok(bundled);
            }

            // Fuzzy match in RESOURCE_DIR
            if let Ok(entries) = std::fs::read_dir(&resource_path) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        if name.starts_with("llama-helper") && !name.ends_with(".d") {
                            log::info!("Found fuzzy match in RESOURCE_DIR: {}", path.display());
                            return Ok(path);
                        }
                    }
                }
            }
        } else {
            log::warn!("RESOURCE_DIR environment variable not set");
        }

        // 3. Fallback for dev: try relative paths from workspace (no target triple in dev builds)
        if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
            let project_root = PathBuf::from(&manifest_dir)
                .parent()
                .and_then(|p| p.parent())
                .ok_or_else(|| anyhow!("Failed to determine project root"))?
                .to_path_buf();

            let candidates = vec![
                project_root.join("target/release/llama-helper"),
                project_root.join("target/debug/llama-helper"),
                project_root.join("target/release/llama-helper.exe"),
                project_root.join("target/debug/llama-helper.exe"),
            ];

            for candidate in candidates {
                if candidate.exists() {
                    log::info!("Using dev llama-helper: {}", candidate.display());
                    return Ok(candidate);
                }
            }
        }

        Err(anyhow!(
            "llama-helper binary not found. Build with 'cd llama-helper && cargo build --release' or set MEETODDS_LLAMA_HELPER env var."
        ))
    }

    /// Ensure sidecar is running, spawn if needed
    pub async fn ensure_running(&self, model_path: PathBuf) -> Result<()> {
        // Check if already running with correct model
        {
            let current_model = self.current_model_path.read().await;
            if current_model.as_ref() == Some(&model_path) && self.is_healthy() {
                log::debug!("Sidecar already running with correct model");
                self.update_activity().await;
                return Ok(());
            }
        }

        // Need to spawn or restart
        self.spawn(model_path).await
    }

    /// Spawn the sidecar process
    async fn spawn(&self, model_path: PathBuf) -> Result<()> {
        // Shutdown existing process if running
        self.shutdown().await?;

        log::info!("Spawning llama-helper sidecar");
        log::info!("Model path: {}", model_path.display());

        #[cfg(unix)]
        let mut command = tokio::process::Command::new("nice");
        
        #[cfg(not(unix))]
        let mut command = tokio::process::Command::new(&self.helper_binary_path);

        #[cfg(unix)]
        command.arg("-n").arg("10").arg(&self.helper_binary_path);

        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit()) // Log stderr to main process
            .env("LLAMA_IDLE_TIMEOUT", self.idle_timeout_secs.to_string());

        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x00004000;

            command.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
        }

        let mut child = command
            .spawn()
            .with_context(|| format!("Failed to spawn llama-helper at {:?}", self.helper_binary_path))?;

        let stdin = child.stdin.take().ok_or_else(|| anyhow!("Failed to get stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("Failed to get stdout"))?;

        // Store handles
        {
            let mut child_lock = self.child_process.lock().await;
            *child_lock = Some(child);
        }

        {
            let mut stdin_lock = self.stdin_writer.lock().await;
            *stdin_lock = Some(stdin);
        }

        {
            let mut stdout_lock = self.stdout_reader.lock().await;
            *stdout_lock = Some(BufReader::new(stdout));
        }

        // Update state
        {
            let mut current_model = self.current_model_path.write().await;
            *current_model = Some(model_path);
        }

        self.is_healthy.store(true, Ordering::SeqCst);
        self.should_shutdown.store(false, Ordering::SeqCst);
        self.update_activity().await;

        log::info!("Sidecar spawned successfully");

        // Start background tasks
        self.start_health_check_loop();
        self.start_idle_check_loop();

        Ok(())
    }

    /// Allocate an id for a request; it must be the request JSON's `id` field.
    pub fn next_request_id(&self) -> u64 {
        self.next_request_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Send a request (whose JSON carries `id`) and wait for the reply with that id
    pub async fn send_request(&self, id: u64, request_json: String, timeout: Duration) -> Result<String> {
        self.send_request_with_deltas(id, request_json, timeout, &mut |_| {}).await
    }

    async fn send_request_with_deltas(
        &self,
        id: u64,
        request_json: String,
        timeout: Duration,
        on_delta: &mut (dyn FnMut(&str) + Send),
    ) -> Result<String> {
        // Track active request
        let _guard = RequestGuard::new(self.active_request_count.clone());
        let _exchange = self.exchange.lock().await;

        write_line(&self.stdin_writer, &request_json).await?;

        // Read response from stdout with timeout
        match tokio::time::timeout(timeout, self.read_response(id, on_delta)).await {
            Ok(Ok(response)) => {
                self.update_activity().await;
                Ok(response)
            }
            Ok(Err(e)) => Err(e),
            Err(_) => {
                // Timeout reached - shutdown sidecar to stop generation
                log::error!("Request timeout after {:?}, shutting down sidecar", timeout);
                if let Err(shutdown_err) = self.shutdown().await {
                    log::error!("Failed to shutdown sidecar after timeout: {}", shutdown_err);
                }
                Err(anyhow!("Request timed out after {:?}", timeout))
            }
        }
    }

    /// `send_request` for a streamed request: each `delta` line's text goes to `on_delta`.
    /// Cancelling `token` stops waiting at once and asks the helper to abort just this
    /// generation; the process and its loaded model are kept.
    pub async fn send_request_cancellable(
        &self,
        id: u64,
        request_json: String,
        timeout: Duration,
        token: &CancellationToken,
        on_delta: &mut (dyn FnMut(&str) + Send),
    ) -> Result<String> {
        tokio::select! {
            result = self.send_request_with_deltas(id, request_json, timeout, on_delta) => result,
            _ = token.cancelled() => {
                // The helper still answers `id` (as cancelled); the next reader discards it.
                let cancel = serde_json::json!({"type": "cancel", "id": id}).to_string();
                if let Err(e) = write_line(&self.stdin_writer, &cancel).await {
                    log::debug!("Failed to send cancel to sidecar: {}", e);
                }
                Err(anyhow!("Generation cancelled"))
            }
        }
    }

    /// Read the reply for request `id` from stdout
    async fn read_response(&self, id: u64, on_delta: &mut (dyn FnMut(&str) + Send)) -> Result<String> {
        let mut stdout_lock = self.stdout_reader.lock().await;
        let reader = stdout_lock
            .as_mut()
            .ok_or_else(|| anyhow!("Sidecar not running"))?;
        read_reply(reader, id, on_delta).await
    }

    /// Send ping to keep sidecar alive
    async fn send_ping(&self) -> Result<()> {
        // A request in flight already proves the sidecar is alive; don't queue behind it.
        let Ok(_exchange) = self.exchange.try_lock() else {
            return Ok(());
        };
        let id = self.next_request_id();
        let request = serde_json::json!({"type": "ping", "id": id}).to_string();
        let timeout = Duration::from_secs(5);

        // Note: We don't use send_request here to avoid incrementing active_request_count
        // for internal health checks, as that would prevent graceful shutdown
        write_line(&self.stdin_writer, &request).await?;

        // Read response
        let response = tokio::time::timeout(timeout, self.read_response(id, &mut |_| {})).await??;

        let resp: serde_json::Value = serde_json::from_str(&response)?;
        if resp.get("type").and_then(|t| t.as_str()) == Some("pong") {
            Ok(())
        } else {
            Err(anyhow!("Unexpected ping response: {}", response))
        }
    }

    /// Gracefully shutdown the sidecar
    /// Waits for active requests to complete before killing the process
    pub async fn shutdown_gracefully(&self) -> Result<()> {
        log::info!("Initiating graceful shutdown of sidecar");
        
        // Set shutdown flag to prevent new internal tasks
        self.should_shutdown.store(true, Ordering::SeqCst);
        
        // Wait for active requests to complete
        // We poll every 500ms
        let start = Instant::now();
        let max_wait = Duration::from_secs(600); // Wait up to 10 minutes for long generations
        
        loop {
            let count = self.active_request_count.load(Ordering::SeqCst);
            if count == 0 {
                log::info!("No active requests, proceeding with shutdown");
                break;
            }
            
            if start.elapsed() > max_wait {
                log::warn!("Timed out waiting for active requests ({} active), forcing shutdown", count);
                break;
            }
            
            log::debug!("Waiting for {} active requests to complete...", count);
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        
        self.shutdown().await
    }

    /// Force shutdown the sidecar
    pub async fn shutdown(&self) -> Result<()> {
        // Set shutdown flag
        self.should_shutdown.store(true, Ordering::SeqCst);

        // Send shutdown command
        if self.is_healthy() {
            let request = serde_json::json!({"type": "shutdown"}).to_string();
            let _timeout = Duration::from_secs(5);

            // Try to send shutdown command, but ignore errors
            // We don't use send_request to avoid incrementing counter
            let _ = async {
                let mut stdin_lock = self.stdin_writer.lock().await;
                if let Some(stdin) = stdin_lock.as_mut() {
                    stdin.write_all(request.as_bytes()).await?;
                    stdin.write_all(b"\n").await?;
                    stdin.flush().await?;
                }
                Ok::<(), anyhow::Error>(())
            }.await;
        }

        // Kill process if still running
        {
            let mut child_lock = self.child_process.lock().await;
            if let Some(mut child) = child_lock.take() {
                match tokio::time::timeout(Duration::from_secs(3), child.wait()).await {
                    Ok(Ok(status)) => {
                        log::info!("Sidecar exited with status: {}", status);
                    }
                    Ok(Err(e)) => {
                        log::error!("Failed to wait for sidecar: {}", e);
                    }
                    Err(_) => {
                        log::warn!("Sidecar didn't exit gracefully, killing");
                        let _ = child.kill().await;
                    }
                }
            }
        }

        // Clear handles
        {
            let mut stdin_lock = self.stdin_writer.lock().await;
            *stdin_lock = None;
        }

        {
            let mut stdout_lock = self.stdout_reader.lock().await;
            *stdout_lock = None;
        }

        {
            let mut current_model = self.current_model_path.write().await;
            *current_model = None;
        }

        self.is_healthy.store(false, Ordering::SeqCst);

        log::info!("Sidecar shutdown complete");
        Ok(())
    }

    /// Check if sidecar is healthy
    pub fn is_healthy(&self) -> bool {
        self.is_healthy.load(Ordering::SeqCst)
    }

    /// Update last activity timestamp
    async fn update_activity(&self) {
        let mut last_activity = self.last_activity.write().await;
        *last_activity = Instant::now();
    }

    /// Get seconds since last activity
    async fn seconds_since_activity(&self) -> u64 {
        let last_activity = self.last_activity.read().await;
        last_activity.elapsed().as_secs()
    }

    /// Start health check loop (runs in background)
    fn start_health_check_loop(&self) {
        let manager = Self {
            child_process: self.child_process.clone(),
            stdin_writer: self.stdin_writer.clone(),
            stdout_reader: self.stdout_reader.clone(),
            exchange: self.exchange.clone(),
            next_request_id: self.next_request_id.clone(),
            last_activity: self.last_activity.clone(),
            is_healthy: self.is_healthy.clone(),
            should_shutdown: self.should_shutdown.clone(),
            active_request_count: self.active_request_count.clone(),
            helper_binary_path: self.helper_binary_path.clone(),
            current_model_path: self.current_model_path.clone(),
            idle_timeout_secs: self.idle_timeout_secs,
        };

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                interval.tick().await;

                if manager.should_shutdown.load(Ordering::SeqCst) {
                    log::debug!("Health check loop: shutdown flag set, exiting");
                    break;
                }

                if !manager.is_healthy() {
                    log::debug!("Health check loop: sidecar unhealthy, skipping ping");
                    continue;
                }

                // Don't ping if we are busy with a request
                if manager.active_request_count.load(Ordering::SeqCst) > 0 {
                    continue;
                }

                log::debug!("Health check: sending ping");
                if let Err(e) = manager.send_ping().await {
                    log::warn!("Health check failed: {}", e);
                    manager.is_healthy.store(false, Ordering::SeqCst);
                }
            }

            log::debug!("Health check loop exited");
        });
    }

    /// Start idle check loop (runs in background)
    fn start_idle_check_loop(&self) {
        let manager = Self {
            child_process: self.child_process.clone(),
            stdin_writer: self.stdin_writer.clone(),
            stdout_reader: self.stdout_reader.clone(),
            exchange: self.exchange.clone(),
            next_request_id: self.next_request_id.clone(),
            last_activity: self.last_activity.clone(),
            is_healthy: self.is_healthy.clone(),
            should_shutdown: self.should_shutdown.clone(),
            active_request_count: self.active_request_count.clone(),
            helper_binary_path: self.helper_binary_path.clone(),
            current_model_path: self.current_model_path.clone(),
            idle_timeout_secs: self.idle_timeout_secs,
        };

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                interval.tick().await;

                if manager.should_shutdown.load(Ordering::SeqCst) {
                    log::debug!("Idle check loop: shutdown flag set, exiting");
                    break;
                }

                // Don't shutdown if we are busy
                if manager.active_request_count.load(Ordering::SeqCst) > 0 {
                    // Update activity to prevent timeout immediately after request finishes
                    manager.update_activity().await;
                    continue;
                }

                let idle_secs = manager.seconds_since_activity().await;
                log::debug!("Idle check: {}s since last activity", idle_secs);

                if idle_secs > manager.idle_timeout_secs {
                    log::info!(
                        "Sidecar idle for {}s (timeout: {}s), shutting down",
                        idle_secs,
                        manager.idle_timeout_secs
                    );

                    if let Err(e) = manager.shutdown().await {
                        log::error!("Failed to shutdown idle sidecar: {}", e);
                    }

                    break;
                }
            }

            log::debug!("Idle check loop exited");
        });
    }
}

/// Write one request line to the helper's stdin
async fn write_line(stdin_writer: &Mutex<Option<ChildStdin>>, line: &str) -> Result<()> {
    let mut stdin_lock = stdin_writer.lock().await;
    let stdin = stdin_lock
        .as_mut()
        .ok_or_else(|| anyhow!("Sidecar not running"))?;

    stdin
        .write_all(line.as_bytes())
        .await
        .context("Failed to write request to stdin")?;
    stdin
        .write_all(b"\n")
        .await
        .context("Failed to write newline")?;
    stdin.flush().await.context("Failed to flush stdin")?;
    Ok(())
}

/// Read lines until the reply for `id`, passing the text of its `delta` lines to
/// `on_delta`. Lines for other ids (e.g. the late reply to a request whose caller gave
/// up) or without one are discarded.
async fn read_reply(
    reader: &mut (impl AsyncBufRead + Unpin),
    id: u64,
    on_delta: &mut (dyn FnMut(&str) + Send),
) -> Result<String> {
    loop {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .context("Failed to read response from stdout")?;

        if line.is_empty() {
            return Err(anyhow!("Sidecar closed stdout (process may have crashed)"));
        }

        let reply = serde_json::from_str::<serde_json::Value>(&line).ok();
        let reply_id = reply.as_ref().and_then(|v| v.get("id")?.as_u64());
        let delta = reply
            .as_ref()
            .filter(|v| v.get("type").and_then(|t| t.as_str()) == Some("delta"))
            .map(|v| v.get("text").and_then(|t| t.as_str()).unwrap_or_default());
        match (reply_id == Some(id), delta) {
            (true, Some(text)) => on_delta(text),
            (true, None) => return Ok(line.trim().to_string()),
            (false, Some(_)) => {}
            (false, None) => {
                log::debug!("Discarding sidecar reply for request {:?} while waiting for {}", reply_id, id)
            }
        }
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        // Set shutdown flag
        self.should_shutdown.store(true, Ordering::SeqCst);

        // Note: Actual cleanup happens in shutdown() method
        // We can't do async work in Drop, so this is best-effort
        log::debug!("SidecarManager dropped");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn read_reply_skips_lines_for_other_ids() {
        let mut stdout: &[u8] = b"{\"type\":\"response\",\"id\":1,\"text\":\"stale\",\"error\":null}\n\
            {\"type\":\"goodbye\"}\n\
            not json\n\
            {\"type\":\"response\",\"id\":2,\"text\":\"mine\",\"error\":null}\n";
        let reply = read_reply(&mut stdout, 2, &mut |_| {}).await.unwrap();
        assert!(reply.contains("\"text\":\"mine\""));
        assert!(read_reply(&mut stdout, 3, &mut |_| {}).await.is_err(), "EOF must be an error");
    }

    #[tokio::test]
    async fn read_reply_forwards_only_its_own_deltas() {
        let mut stdout: &[u8] = "{\"type\":\"delta\",\"id\":1,\"text\":\"stale\"}\n\
            {\"type\":\"delta\",\"id\":2,\"text\":\"नम\"}\n\
            {\"type\":\"delta\",\"id\":1,\"text\":\"stale\"}\n\
            {\"type\":\"delta\",\"id\":2,\"text\":\"स्ते\"}\n\
            {\"type\":\"response\",\"id\":2,\"text\":\"नमस्ते\",\"error\":null}\n"
            .as_bytes();
        let mut deltas = Vec::new();
        let reply = read_reply(&mut stdout, 2, &mut |text| deltas.push(text.to_string()))
            .await
            .unwrap();
        assert_eq!(deltas, ["नम", "स्ते"]);
        assert!(reply.contains("\"type\":\"response\""), "{reply}");
    }

    /// Stand-in for llama-helper: answers requests in order, echoing their id,
    /// taking 0.5 s per generation. Streamed requests first get a delta for another id,
    /// then two of their own. Every line it receives is appended to `<script>.log`.
    #[cfg(unix)]
    const FAKE_HELPER: &str = r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$0.log"
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"type":"ping"'*) echo "{\"type\":\"pong\",\"id\":$id}" ;;
    *'"stream":true'*)
      echo '{"type":"delta","id":999,"text":"other"}'
      for part in re ply; do sleep 0.1; echo "{\"type\":\"delta\",\"id\":$id,\"text\":\"$part\"}"; done
      sleep 0.3; echo "{\"type\":\"response\",\"id\":$id,\"text\":\"reply-$id\",\"error\":null}" ;;
    *'"type":"generate"'*) sleep 0.5; echo "{\"type\":\"response\",\"id\":$id,\"text\":\"reply-$id\",\"error\":null}" ;;
    *'"type":"shutdown"'*) echo '{"type":"goodbye"}'; exit 0 ;;
  esac
done
"#;

    #[cfg(unix)]
    async fn spawn_fake_helper(name: &str) -> SidecarManager {
        use std::os::unix::fs::PermissionsExt;
        let script = std::env::temp_dir().join(format!(
            "fake-llama-helper-{}-{}.sh",
            std::process::id(),
            name
        ));
        std::fs::write(&script, FAKE_HELPER).unwrap();
        let _ = std::fs::remove_file(helper_log(&script));
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let manager = SidecarManager {
            child_process: Arc::new(Mutex::new(None)),
            stdin_writer: Arc::new(Mutex::new(None)),
            stdout_reader: Arc::new(Mutex::new(None)),
            exchange: Arc::new(Mutex::new(())),
            next_request_id: Arc::new(AtomicU64::new(1)),
            last_activity: Arc::new(RwLock::new(Instant::now())),
            is_healthy: Arc::new(AtomicBool::new(false)),
            should_shutdown: Arc::new(AtomicBool::new(false)),
            active_request_count: Arc::new(AtomicUsize::new(0)),
            helper_binary_path: script,
            current_model_path: Arc::new(RwLock::new(None)),
            idle_timeout_secs: 300,
        };
        manager.spawn(PathBuf::from("model.gguf")).await.unwrap();
        // Let the health loop's immediate first ping finish before the test's requests.
        tokio::time::sleep(Duration::from_millis(300)).await;
        manager
    }

    #[cfg(unix)]
    fn generate_json(id: u64) -> String {
        serde_json::json!({"type": "generate", "id": id, "prompt": "p"}).to_string()
    }

    #[cfg(unix)]
    fn stream_json(id: u64) -> String {
        serde_json::json!({"type": "generate", "id": id, "prompt": "p", "stream": true}).to_string()
    }

    #[cfg(unix)]
    fn helper_log(script: &std::path::Path) -> PathBuf {
        PathBuf::from(format!("{}.log", script.display()))
    }

    /// Waits up to 2 s for the fake helper to have received a cancel for `id`.
    #[cfg(unix)]
    async fn helper_got_cancel(manager: &SidecarManager, id: u64) -> bool {
        let cancel = serde_json::json!({"type": "cancel", "id": id});
        for _ in 0..40 {
            let log = std::fs::read_to_string(helper_log(&manager.helper_binary_path)).unwrap_or_default();
            if log.lines().any(|line| serde_json::from_str::<serde_json::Value>(line).ok() == Some(cancel.clone())) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn streamed_request_delivers_its_deltas_before_the_reply() {
        let manager = spawn_fake_helper("stream").await;
        let id = manager.next_request_id();
        let started = Instant::now();
        let mut deltas = Vec::new();
        let reply = manager
            .send_request_cancellable(id, stream_json(id), Duration::from_secs(5), &CancellationToken::new(), &mut |text| {
                deltas.push((text.to_string(), started.elapsed()))
            })
            .await
            .unwrap();
        let done = started.elapsed();
        assert!(reply.contains(&format!("\"text\":\"reply-{id}\"")), "{reply}");
        assert_eq!(deltas.iter().map(|(t, _)| t.as_str()).collect::<Vec<_>>(), ["re", "ply"], "other ids' deltas ignored");
        assert!(deltas[0].1 + Duration::from_millis(250) < done, "first delta {:?} vs reply {:?}", deltas[0].1, done);
        assert!(!helper_got_cancel(&manager, id).await, "an answered request is not cancelled");
        manager.shutdown().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_mid_stream_sends_cancel_and_next_request_is_clean() {
        let manager = Arc::new(spawn_fake_helper("stream-cancel").await);
        let token = CancellationToken::new();
        let id = manager.next_request_id();
        let (first_tx, first_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn({
            let (manager, token) = (manager.clone(), token.clone());
            async move {
                let mut first_tx = Some(first_tx);
                manager
                    .send_request_cancellable(id, stream_json(id), Duration::from_secs(5), &token, &mut |_| {
                        if let Some(tx) = first_tx.take() {
                            let _ = tx.send(());
                        }
                    })
                    .await
            }
        });
        first_rx.await.unwrap();
        token.cancel();
        assert!(task.await.unwrap().is_err());
        assert!(helper_got_cancel(&manager, id).await, "helper was not told to stop {id}");

        let next = manager.next_request_id();
        let mut deltas = Vec::new();
        let reply = manager
            .send_request_cancellable(next, stream_json(next), Duration::from_secs(5), &CancellationToken::new(), &mut |t| {
                deltas.push(t.to_string())
            })
            .await
            .unwrap();
        assert!(reply.contains(&format!("\"text\":\"reply-{next}\"")), "{reply}");
        assert_eq!(deltas, ["re", "ply"], "no leftover deltas from the cancelled request");
        manager.shutdown().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn abandoned_request_reply_does_not_reach_next_caller() {
        let manager = spawn_fake_helper("abandoned").await;

        // Caller gives up (like live translation's outer timeout) after its request was
        // written but before the reply arrived.
        let abandoned = manager.next_request_id();
        let gave_up = tokio::time::timeout(
            Duration::from_millis(100),
            manager.send_request(abandoned, generate_json(abandoned), Duration::from_secs(5)),
        )
        .await;
        assert!(gave_up.is_err());

        let next = manager.next_request_id();
        let reply = manager
            .send_request(next, generate_json(next), Duration::from_secs(5))
            .await
            .unwrap();
        assert!(reply.contains(&format!("\"text\":\"reply-{next}\"")), "{reply}");

        // The health ping also gets its own pong, not a leftover line.
        manager.send_ping().await.unwrap();
        manager.shutdown().await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancel_stops_waiting_and_releases_the_permit() {
        let manager = Arc::new(spawn_fake_helper("cancel").await);
        let pool = Arc::new(tokio::sync::Semaphore::new(1));
        let token = CancellationToken::new();

        // Mirrors live translation: hold the single local permit while waiting.
        let id = manager.next_request_id();
        let task = tokio::spawn({
            let (manager, pool, token) = (manager.clone(), pool.clone(), token.clone());
            async move {
                let _permit = pool.acquire().await.unwrap();
                manager
                    .send_request_cancellable(id, generate_json(id), Duration::from_secs(5), &token, &mut |_| {})
                    .await
            }
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(pool.available_permits(), 0);

        let started = Instant::now();
        token.cancel();
        let result = task.await.unwrap();
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_millis(200), "{:?}", started.elapsed());
        assert_eq!(pool.available_permits(), 1);
        assert!(manager.is_healthy(), "cancel must not kill the sidecar");

        // The cancelled request's late reply does not reach the next caller.
        let next = manager.next_request_id();
        let reply = manager
            .send_request(next, generate_json(next), Duration::from_secs(5))
            .await
            .unwrap();
        assert!(reply.contains(&format!("\"text\":\"reply-{next}\"")), "{reply}");
        manager.shutdown().await.unwrap();
    }
}
