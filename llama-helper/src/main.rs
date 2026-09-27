use std::collections::VecDeque;
use std::io::{self, BufRead, Write};
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::pin::pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use encoding_rs;
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use serde::{Deserialize, Serialize};

// ============================================================================
// Protocol Messages (JSON over stdin/stdout)
// ============================================================================
// Every reply echoes the request `id` so the app can pair replies with requests.

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Request {
    Generate {
        id: Option<u64>,
        prompt: String,
        max_tokens: Option<i32>,
        context_size: Option<u32>,
        /// Ask for a smaller llama context than `context_size` (which stays the model
        /// load key). Grown to fit prompt + max_tokens; see `request_n_ctx`.
        n_ctx: Option<u32>,
        model_path: Option<String>,
        // Sampling parameters
        temperature: Option<f32>,
        top_k: Option<i32>,
        top_p: Option<f32>,
        presence_penalty: Option<f32>,
        frequency_penalty: Option<f32>,
        repeat_penalty: Option<f32>,
        penalty_last_n: Option<i32>,
        stop_tokens: Option<Vec<String>>,
        /// Emit `delta` lines with the new text while generating (live translation).
        #[serde(default)]
        stream: bool,
    },
    Ping {
        id: Option<u64>,
    },
    Shutdown,
    /// Stop the generation for request `id` early; it still gets a (cancelled) reply.
    Cancel {
        id: u64,
    },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Response {
    Response {
        id: Option<u64>,
        text: String,
        error: Option<String>,
    },
    /// Text generated since the previous delta for request `id`; the final `response`
    /// still carries the whole text.
    Delta {
        id: Option<u64>,
        text: String,
    },
    Pong {
        id: Option<u64>,
    },
    Goodbye,
    Error {
        id: Option<u64>,
        message: String,
    },
}

/// A parsed stdin line, or the parse error with the line's `id` if it had one.
type Incoming = std::result::Result<Request, (Option<u64>, String)>;

#[derive(Debug, Clone, Copy, PartialEq)]
struct SamplingConfig {
    temperature: f32,
    top_k: i32,
    top_p: f32,
    presence_penalty: f32,
    frequency_penalty: f32,
    repeat_penalty: f32,
    penalty_last_n: i32,
}

impl SamplingConfig {
    fn from_request(
        temperature: Option<f32>,
        top_k: Option<i32>,
        top_p: Option<f32>,
        presence_penalty: Option<f32>,
        frequency_penalty: Option<f32>,
        repeat_penalty: Option<f32>,
        penalty_last_n: Option<i32>,
    ) -> Self {
        let temperature = temperature.unwrap_or(1.0);
        let temperature = if temperature.is_finite() {
            temperature.max(0.0)
        } else {
            0.0
        };
        let top_k = top_k.unwrap_or(64).max(1);
        let top_p = top_p.unwrap_or(0.95);
        let top_p = if top_p.is_finite() && top_p > 0.0 && top_p <= 1.0 {
            top_p
        } else {
            1.0
        };
        let presence_penalty = presence_penalty.unwrap_or(0.0);
        let presence_penalty = if presence_penalty.is_finite() {
            presence_penalty.max(0.0)
        } else {
            0.0
        };
        let frequency_penalty = frequency_penalty.unwrap_or(0.0);
        let frequency_penalty = if frequency_penalty.is_finite() {
            frequency_penalty.max(0.0)
        } else {
            0.0
        };
        let repeat_penalty = repeat_penalty.unwrap_or(1.0);
        let repeat_penalty = if repeat_penalty.is_finite() && repeat_penalty > 0.0 {
            repeat_penalty
        } else {
            1.0
        };
        let penalty_last_n = penalty_last_n.unwrap_or(0).max(0);

        Self {
            temperature,
            top_k,
            top_p,
            presence_penalty,
            frequency_penalty,
            repeat_penalty,
            penalty_last_n,
        }
    }

    fn uses_penalties(&self) -> bool {
        self.penalty_last_n > 0
            && (self.presence_penalty > 0.0
                || self.frequency_penalty > 0.0
                || (self.repeat_penalty - 1.0).abs() > f32::EPSILON)
    }
}

// ============================================================================
// VRAM Detection and GPU Layer Calculation
// ============================================================================

/// Detect available VRAM in GB
fn detect_vram_gb() -> f32 {
    #[cfg(feature = "metal")]
    {
        // macOS Metal: Query recommended max working set size
        if let Some(vram) = detect_metal_vram() {
            eprintln!("Metal VRAM detected: {:.2} GB", vram);
            return vram;
        }
    }

    #[cfg(feature = "cuda")]
    {
        // NVIDIA CUDA: Query device memory
        if let Some(vram) = detect_cuda_vram() {
            eprintln!("CUDA VRAM detected: {:.2} GB", vram);
            return vram;
        }
    }

    /// TODO: Vulkan VRAM detection

    eprintln!("VRAM detection not available, using conservative estimate");
    4.0 // Conservative fallback
}

#[cfg(feature = "metal")]
fn detect_metal_vram() -> Option<f32> {
    if let Ok(output) = std::process::Command::new("sysctl")
        .arg("hw.memsize")
        .output()
    {
        if let Ok(stdout) = String::from_utf8(output.stdout) {
            if let Some(bytes_str) = stdout.split(':').nth(1) {
                if let Ok(bytes) = bytes_str.trim().parse::<u64>() {
                    let gb = bytes as f32 / (1024.0 * 1024.0 * 1024.0);
                    // Assume GPU can use ~60% of system memory on Apple Silicon
                    return Some(gb * 0.6);
                }
            }
        }
    }
    None
}

#[cfg(feature = "cuda")]
fn detect_cuda_vram() -> Option<f32> {
    // Use nvidia-smi to query VRAM
    if let Ok(output) = std::process::Command::new("nvidia-smi")
        .args(&["--query-gpu=memory.free", "--format=csv,noheader,nounits"])
        .output()
    {
        if let Ok(stdout) = String::from_utf8(output.stdout) {
            if let Ok(mb) = stdout.trim().parse::<f32>() {
                return Some(mb / 1024.0); // Convert MB to GB
            }
        }
    }
    None
}

/// Calculate safe GPU layer count based on VRAM, model file size, and context size
fn calculate_gpu_layers(
    model_path: &PathBuf,
    model_layers: u32,
    vram_gb: f32,
    context_size: u32,
) -> u32 {
    let file_size_gb = std::fs::metadata(model_path)
        .map(|m| m.len() as f32 / 1024.0 / 1024.0 / 1024.0)
        .unwrap_or(0.0);

    if file_size_gb == 0.0 {
        eprintln!("⚠️ Could not determine model file size, using conservative default");
        return 0;
    }

    // Heuristic: Estimate KV cache size
    // 7B models (approx > 2.5GB) usually have 4096 hidden dim -> ~256MB per 1k context
    // 1B models (approx < 2.5GB) usually have 2048 hidden dim -> ~128MB per 1k context
    let kv_per_1k_gb = if file_size_gb > 2.5 { 0.25 } else { 0.12 };
    let total_kv_gb = (context_size as f32 / 1000.0) * kv_per_1k_gb;

    // Safety buffer (500MB) for OS/Display
    let safe_vram = vram_gb - 0.5;

    // For debugging
    eprintln!("📊 VRAM Analysis:");
    eprintln!("   • Available: {:.2} GB", vram_gb);
    eprintln!("   • Safe Limit: {:.2} GB", safe_vram);
    eprintln!("   • Model Weights: {:.2} GB", file_size_gb);
    eprintln!(
        "   • KV Cache ({} ctx): {:.2} GB",
        context_size, total_kv_gb
    );

    if safe_vram <= 0.0 {
        eprintln!("⚠️ No safe VRAM available, using CPU only");
        return 0;
    }

    // Calculate cost per layer
    let weight_per_layer = file_size_gb / model_layers as f32;
    let kv_per_layer = total_kv_gb / model_layers as f32;
    let total_per_layer = weight_per_layer + kv_per_layer;

    // Calculate how many layers fit
    let safe_layers = (safe_vram / total_per_layer).floor() as u32;
    let layers = safe_layers.min(model_layers);

    eprintln!(
        "   • Cost per layer: {:.2} MB (Weights) + {:.2} MB (KV) = {:.2} MB",
        weight_per_layer * 1024.0,
        kv_per_layer * 1024.0,
        total_per_layer * 1024.0
    );

    if layers < model_layers {
        eprintln!(
            "⚠️ Memory constrained. Offloading {}/{} layers ({:.1}%)",
            layers,
            model_layers,
            (layers as f32 / model_layers as f32) * 100.0
        );
    } else {
        eprintln!("✅ Full offload possible ({} layers)", layers);
    }

    layers
}

/// Get default GPU layer count with smart detection
fn get_default_gpu_layers(model_path: &PathBuf, context_size: u32) -> u32 {
    let vram = detect_vram_gb();
    // TODO: Use actual model metadata instead of heuristics
    // Heuristic: Estimate total layers based on file size
    // 7B models (Q4) are ~4.1GB and have ~32-35 layers
    // 1B models (Q4) are ~1.1GB and have ~20-28 layers
    let file_size_gb = std::fs::metadata(model_path)
        .map(|m| m.len() as f32 / 1024.0 / 1024.0 / 1024.0)
        .unwrap_or(0.0);

    let estimated_layers = if file_size_gb > 2.5 { 33 } else { 28 };

    calculate_gpu_layers(model_path, estimated_layers, vram, context_size)
}

// ============================================================================
// Model State Management
// ============================================================================

struct ModelState {
    backend: LlamaBackend,
    model: Option<LlamaModel>,
    model_path: Option<PathBuf>,
    context_size: u32,
    last_activity: Arc<AtomicU64>,
}

impl ModelState {
    fn new() -> Result<Self> {
        let backend = LlamaBackend::init().context("Failed to init LlamaBackend")?;
        Ok(Self {
            backend,
            model: None,
            model_path: None,
            context_size: 2048,
            last_activity: Arc::new(AtomicU64::new(Self::current_timestamp())),
        })
    }

    fn current_timestamp() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    fn update_activity(&self) {
        self.last_activity
            .store(Self::current_timestamp(), Ordering::SeqCst);
    }

    fn seconds_since_activity(&self) -> u64 {
        Self::current_timestamp() - self.last_activity.load(Ordering::SeqCst)
    }

    fn load_model_if_needed(&mut self, model_path: PathBuf, context_size: u32) -> Result<()> {
        // Check if model is already loaded
        if let Some(ref loaded_path) = self.model_path {
            if loaded_path == &model_path && self.context_size == context_size {
                eprintln!("✓ Model already loaded");
                self.update_activity();
                return Ok(());
            }
        }

        eprintln!("📥 Loading model: {}", model_path.display());

        // Detect GPU layers
        let gpu_layers = get_default_gpu_layers(&model_path, context_size);

        // Configure model parameters with GPU offload
        let model_params = LlamaModelParams::default().with_n_gpu_layers(gpu_layers);
        let model_params = pin!(model_params);

        let model = LlamaModel::load_from_file(&self.backend, model_path.clone(), &model_params)
            .with_context(|| format!("unable to load model at {:?}", model_path))?;

        self.model = Some(model);
        self.model_path = Some(model_path);
        self.context_size = context_size;
        self.update_activity();

        eprintln!("✅ Model loaded successfully");
        Ok(())
    }

    fn generate(
        &mut self,
        prompt: String,
        max_tokens: i32,
        n_ctx: Option<u32>,
        sampling: SamplingConfig,
        stop_tokens: Vec<String>,
        mut cancel_requested: impl FnMut() -> bool,
        mut on_delta: Option<&mut dyn FnMut(&str)>,
    ) -> Result<String> {
        let start_time = Instant::now();
        let model = self.model.as_ref().context("Model not loaded")?;

        // Calculate thread count (conservative default: max(1, (Cores / 2) + 2))
        // This ensures the UI thread is never starved
        let threads: i32 = std::thread::available_parallelism()
            .map(|n| {
                let cores = n.get() as i32;
                ((cores / 2) + 2).max(1)
            })
            .unwrap_or(2);

        let tokens_list = model
            .str_to_token(&prompt, AddBos::Always)
            .with_context(|| "failed to tokenize prompt")?;

        eprintln!("📝 Tokenized prompt: {} tokens", tokens_list.len());

        // Full-size requests (summaries) keep one batch as large as the context.
        let n_ctx = request_n_ctx(self.context_size, n_ctx, tokens_list.len(), max_tokens);
        let n_batch = if n_ctx < self.context_size {
            n_ctx.min(512)
        } else {
            n_ctx
        };

        // ponytail: a fresh context (KV cache) per request. Next step is one persistent
        // context reusing the shared prompt prefix, but LlamaContext borrows the model,
        // so ModelState would become self-referential.
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(Some(NonZeroU32::new(n_ctx).context("Invalid ctx size")?))
            .with_n_batch(n_batch)
            .with_n_threads(threads)
            .with_n_threads_batch(threads);

        let mut ctx = model
            .new_context(&self.backend, ctx_params)
            .context("unable to create the llama_context")?;

        let mut batch = LlamaBatch::new(n_batch as usize, 1);

        // Decode the prompt in chunks of at most n_batch tokens.
        let last_index: i32 = (tokens_list.len() - 1) as i32;
        for (i, token) in (0_i32..).zip(tokens_list.into_iter()) {
            let is_last = i == last_index;
            batch
                .add(token, i, &[0], is_last)
                .context("Failed to add token to batch")?;
            if is_last || batch.n_tokens() as u32 == n_batch {
                ctx.decode(&mut batch).context("llama_decode() failed")?;
                if !is_last {
                    batch.clear();
                }
            }
        }
        let prompt_time = start_time.elapsed();

        let n_prompt_tokens = last_index + 1;
        let mut n_cur = n_prompt_tokens;
        let mut output = TextStream::new(&stop_tokens);

        eprintln!("🔄 Starting generation (max_tokens: {})", max_tokens);

        use llama_cpp_2::sampling::LlamaSampler;

        let seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u32;
        let sampler = if sampling.temperature <= 0.0 {
            if sampling.uses_penalties() {
                LlamaSampler::chain_simple([
                    LlamaSampler::penalties(
                        sampling.penalty_last_n,
                        sampling.repeat_penalty,
                        sampling.frequency_penalty,
                        sampling.presence_penalty,
                    ),
                    LlamaSampler::greedy(),
                ])
            } else {
                LlamaSampler::chain_simple([LlamaSampler::greedy()])
            }
        } else if sampling.uses_penalties() {
            LlamaSampler::chain_simple([
                LlamaSampler::penalties(
                    sampling.penalty_last_n,
                    sampling.repeat_penalty,
                    sampling.frequency_penalty,
                    sampling.presence_penalty,
                ),
                LlamaSampler::top_k(sampling.top_k),
                LlamaSampler::top_p(sampling.top_p, 1),
                LlamaSampler::temp(sampling.temperature),
                LlamaSampler::dist(seed),
            ])
        } else {
            LlamaSampler::chain_simple([
                LlamaSampler::top_k(sampling.top_k),
                LlamaSampler::top_p(sampling.top_p, 1),
                LlamaSampler::temp(sampling.temperature),
                LlamaSampler::dist(seed),
            ])
        };
        let mut sampler = pin!(sampler);

        loop {
            if cancel_requested() {
                eprintln!("✋ Generation cancelled");
                anyhow::bail!("cancelled");
            }

            // Check if we've generated enough tokens
            if (n_cur - n_prompt_tokens) >= max_tokens {
                eprintln!("✓ Reached max_tokens limit");
                break;
            }

            let token = sampler.as_mut().sample(&ctx, batch.n_tokens() - 1);
            sampler.as_mut().accept(token);

            if model.is_eog_token(token) {
                eprintln!(
                    "✓ End-of-generation token reached (generated {} chars)",
                    output.text.len()
                );
                break;
            }

            let output_bytes = match model.token_to_piece_bytes(token, 32, true, None) {
                Err(llama_cpp_2::TokenToStringError::InsufficientBufferSpace(size)) => {
                    let required_size: usize = size
                        .checked_neg()
                        .context("Invalid token piece buffer size")?
                        .try_into()
                        .context("Invalid token piece buffer size")?;
                    model.token_to_piece_bytes(token, required_size, true, None)
                }
                result => result,
            }
            .context("Failed to convert token to bytes")?;

            if output.push(&output_bytes) {
                break;
            }
            if let (Some(on_delta), Some(delta)) = (on_delta.as_mut(), output.take_delta()) {
                on_delta(&delta);
            }

            batch.clear();
            batch
                .add(token, n_cur, &[0], true)
                .context("Failed to add generated token to batch")?;
            n_cur += 1;
            ctx.decode(&mut batch).context("failed to eval")?;
        }

        // Generation statistics
        let total_time = start_time.elapsed();
        let gen_time = total_time.saturating_sub(prompt_time);
        let output_tokens = (n_cur - n_prompt_tokens) as u64;
        let prompt_tokens = n_prompt_tokens as u64;

        let tokens_per_sec = if gen_time.as_secs_f64() > 0.0 {
            output_tokens as f64 / gen_time.as_secs_f64()
        } else {
            0.0
        };

        eprintln!("📊 Generation Statistics:");
        eprintln!("   • Prompt tokens: {}", prompt_tokens);
        eprintln!("   • Output tokens: {}", output_tokens);
        eprintln!("   • Prompt processing: {:.2}s", prompt_time.as_secs_f64());
        eprintln!("   • Generation time: {:.2}s", gen_time.as_secs_f64());
        eprintln!("   • Total time: {:.2}s", total_time.as_secs_f64());
        eprintln!("   • Speed: {:.2} tokens/sec", tokens_per_sec);

        self.update_activity();
        Ok(output.text)
    }
}

/// Generated text, decoded token by token. The UTF-8 decoder buffers a character split
/// across tokens, and deltas hold back a tail that may still become a stop token.
struct TextStream<'a> {
    decoder: encoding_rs::Decoder,
    text: String,
    sent: usize,
    stop_tokens: &'a [String],
}

impl<'a> TextStream<'a> {
    fn new(stop_tokens: &'a [String]) -> Self {
        Self {
            decoder: encoding_rs::UTF_8.new_decoder(),
            text: String::new(),
            sent: 0,
            stop_tokens,
        }
    }

    /// Appends one token's bytes. On a stop token, removes it (and trailing whitespace)
    /// and returns true.
    fn push(&mut self, bytes: &[u8]) -> bool {
        // decode_to_string only writes into spare capacity; long pieces were truncated.
        let needed = self
            .decoder
            .max_utf8_buffer_length(bytes.len())
            .unwrap_or(bytes.len() * 3 + 4);
        self.text.reserve(needed);
        let _ = self.decoder.decode_to_string(bytes, &mut self.text, false);

        for stop_token in self.stop_tokens {
            if self.text.contains(stop_token.as_str()) {
                eprintln!(
                    "✓ Stop token '{}' detected (generated {} chars)",
                    stop_token,
                    self.text.len()
                );
                self.text = self.text.replace(stop_token.as_str(), "").trim_end().to_string();
                return true;
            }
        }
        false
    }

    /// Text not handed out yet, minus a tail that is a proper prefix of a stop token.
    fn take_delta(&mut self) -> Option<String> {
        let unsent = &self.text[self.sent..];
        let held = self
            .stop_tokens
            .iter()
            .map(|stop| stop_prefix_len(unsent, stop))
            .max()
            .unwrap_or(0);
        let end = self.text.len() - held;
        if end <= self.sent {
            return None;
        }
        let delta = self.text[self.sent..end].to_string();
        self.sent = end;
        Some(delta)
    }
}

/// Length of the longest suffix of `text` that is a proper prefix of `stop`.
fn stop_prefix_len(text: &str, stop: &str) -> usize {
    (1..stop.len().min(text.len() + 1))
        .rev()
        .find(|&n| {
            let start = text.len() - n;
            text.is_char_boundary(start) && stop.as_bytes().starts_with(&text.as_bytes()[start..])
        })
        .unwrap_or(0)
}

/// Context size for one request: the model's full `context_size` unless the request asks
/// for less, in which case prompt + max_tokens (rounded up to 512) must still fit.
fn request_n_ctx(context_size: u32, requested: Option<u32>, prompt_tokens: usize, max_tokens: i32) -> u32 {
    let Some(requested) = requested else {
        return context_size;
    };
    let needed = (prompt_tokens as u64 + max_tokens.max(0) as u64).div_ceil(512) * 512;
    needed.max(requested as u64).min(context_size as u64) as u32
}

// ============================================================================
// Main Loop with Keep-Alive Protocol
// ============================================================================

fn send_response(response: &Response) -> Result<()> {
    let json = serde_json::to_string(response)?;
    println!("{}", json);
    io::stdout().flush()?;
    Ok(())
}

/// Reads stdin on its own thread so a running generation can see `cancel` lines.
/// The channel closes on EOF or a read error.
fn spawn_stdin_reader() -> Receiver<Incoming> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let line = match line {
                Ok(line) => line,
                Err(e) => {
                    eprintln!("❌ Error reading stdin: {}", e);
                    break;
                }
            };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let incoming = serde_json::from_str::<Request>(line).map_err(|e| {
                let id = serde_json::from_str::<serde_json::Value>(line)
                    .ok()
                    .and_then(|v| v.get("id")?.as_u64());
                (id, e.to_string())
            });
            if tx.send(incoming).is_err() {
                break;
            }
        }
    });
    rx
}

/// Queues lines that arrived mid-generation and removes a `cancel` for `id`, if any.
fn take_cancel(rx: &Receiver<Incoming>, pending: &mut VecDeque<Incoming>, id: Option<u64>) -> bool {
    pending.extend(rx.try_iter());
    let Some(id) = id else {
        return false;
    };
    match pending
        .iter()
        .position(|m| matches!(m, Ok(Request::Cancel { id: c }) if *c == id))
    {
        Some(pos) => {
            pending.remove(pos);
            true
        }
        None => false,
    }
}

fn main() -> Result<()> {
    // Get idle timeout from environment variable (default 5 minutes)
    let idle_timeout_secs = std::env::var("LLAMA_IDLE_TIMEOUT")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(300); // 5 minutes default

    eprintln!(
        "🦙 llama-helper starting (idle timeout: {}s)",
        idle_timeout_secs
    );

    let mut state = ModelState::new()?;

    let rx = spawn_stdin_reader();
    // Requests that arrived while a generation was running.
    let mut pending: VecDeque<Incoming> = VecDeque::new();

    loop {
        // Check idle timeout
        if state.seconds_since_activity() > idle_timeout_secs {
            eprintln!("💤 Idle timeout reached, shutting down");
            send_response(&Response::Goodbye)?;
            break;
        }

        let incoming = match pending.pop_front() {
            Some(incoming) => incoming,
            None => match rx.recv() {
                Ok(incoming) => incoming,
                Err(_) => {
                    // EOF reached
                    eprintln!("📪 EOF received, shutting down");
                    break;
                }
            },
        };

        match incoming {
            Ok(Request::Generate {
                id,
                prompt,
                max_tokens,
                context_size,
                n_ctx,
                model_path,
                temperature,
                top_k,
                top_p,
                presence_penalty,
                frequency_penalty,
                repeat_penalty,
                penalty_last_n,
                stop_tokens,
                stream,
            }) => {
                if take_cancel(&rx, &mut pending, id) {
                    eprintln!("✋ Generation cancelled before start");
                    send_response(&Response::Response {
                        id,
                        text: String::new(),
                        error: Some("Generation failed: cancelled".to_string()),
                    })?;
                    continue;
                }

                let max_tokens = max_tokens.unwrap_or(512);
                let context_size = context_size.unwrap_or(2048);

                let sampling = SamplingConfig::from_request(
                    temperature,
                    top_k,
                    top_p,
                    presence_penalty,
                    frequency_penalty,
                    repeat_penalty,
                    penalty_last_n,
                );
                let stop_tokens = stop_tokens.unwrap_or_else(Vec::new);

                // Load model if path provided
                if let Some(path_str) = model_path {
                    let path = PathBuf::from(path_str);
                    if let Err(e) = state.load_model_if_needed(path, context_size) {
                        send_response(&Response::Response {
                            id,
                            text: String::new(),
                            error: Some(format!("Failed to load model: {}", e)),
                        })?;
                        continue;
                    }
                }

                let mut send_delta = |text: &str| {
                    let _ = send_response(&Response::Delta {
                        id,
                        text: text.to_string(),
                    });
                };
                let on_delta: Option<&mut dyn FnMut(&str)> = if stream { Some(&mut send_delta) } else { None };

                // Generate response with sampling parameters
                match state.generate(
                    prompt,
                    max_tokens,
                    n_ctx,
                    sampling,
                    stop_tokens,
                    || take_cancel(&rx, &mut pending, id),
                    on_delta,
                ) {
                    Ok(text) => {
                        send_response(&Response::Response {
                            id,
                            text,
                            error: None,
                        })?;
                    }
                    Err(e) => {
                        send_response(&Response::Response {
                            id,
                            text: String::new(),
                            error: Some(format!("Generation failed: {}", e)),
                        })?;
                    }
                }
            }
            Ok(Request::Ping { id }) => {
                state.update_activity();
                send_response(&Response::Pong { id })?;
            }
            // Its request already finished (and was answered); nothing to do.
            Ok(Request::Cancel { .. }) => {}
            Ok(Request::Shutdown) => {
                eprintln!("🛑 Shutdown requested");
                send_response(&Response::Goodbye)?;
                break;
            }
            Err((id, e)) => {
                eprintln!("❌ Failed to parse request: {}", e);
                send_response(&Response::Error {
                    id,
                    message: format!("Invalid request: {}", e),
                })?;
            }
        }
    }

    eprintln!("👋 llama-helper exiting");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_request_defaults_penalties_when_omitted() {
        let json = r#"{"type":"generate","prompt":"summarize","temperature":0.5,"top_k":20,"top_p":0.8}"#;
        let request: Request = serde_json::from_str(json).unwrap();
        let Request::Generate {
            temperature,
            top_k,
            top_p,
            presence_penalty,
            frequency_penalty,
            repeat_penalty,
            penalty_last_n,
            ..
        } = request else {
            panic!("expected generate request");
        };

        let sampling = SamplingConfig::from_request(
            temperature,
            top_k,
            top_p,
            presence_penalty,
            frequency_penalty,
            repeat_penalty,
            penalty_last_n,
        );

        assert_eq!(sampling.presence_penalty, 0.0);
        assert_eq!(sampling.frequency_penalty, 0.0);
        assert_eq!(sampling.repeat_penalty, 1.0);
        assert_eq!(sampling.penalty_last_n, 0);
        assert!(!sampling.uses_penalties());
    }

    #[test]
    fn request_n_ctx_fits_prompt_and_output_within_model_context() {
        assert_eq!(request_n_ctx(32768, None, 120, 512), 32768, "summaries keep full context");
        assert_eq!(request_n_ctx(32768, Some(2048), 120, 512), 2048, "floor");
        assert_eq!(request_n_ctx(32768, Some(2048), 1700, 512), 2560, "grown, 512-aligned");
        assert_eq!(request_n_ctx(4096, Some(2048), 9000, 512), 4096, "capped");
    }

    /// Feeds token pieces like the generate loop; returns (deltas, final text, stopped).
    fn stream_all(pieces: &[&[u8]], stop_tokens: &[String]) -> (Vec<String>, String, bool) {
        let mut stream = TextStream::new(stop_tokens);
        let mut deltas = Vec::new();
        for piece in pieces {
            if stream.push(piece) {
                return (deltas, stream.text, true);
            }
            deltas.extend(stream.take_delta());
        }
        (deltas, stream.text, false)
    }

    #[test]
    fn deltas_carry_only_complete_utf8_characters() {
        for text in ["नमस्ते, आज की बैठक", "¿Qué tal, señor Muñoz?", "会议现在开始。よろしく"] {
            // Worst case: every byte is its own token piece.
            let pieces: Vec<&[u8]> = text.as_bytes().chunks(1).collect();
            let (deltas, final_text, stopped) = stream_all(&pieces, &[]);
            assert!(!stopped);
            assert_eq!(deltas.concat(), text);
            assert_eq!(final_text, text);
            assert!(deltas.iter().all(|d| !d.is_empty() && !d.contains('\u{FFFD}')), "{deltas:?}");
            assert_eq!(deltas.len(), text.chars().count(), "one delta per completed character");
        }
    }

    #[test]
    fn deltas_hold_back_a_possible_stop_token() {
        let stop = ["<|im_end|>".to_string()];
        let (deltas, final_text, stopped) = stream_all(&[b"Hola ", b"<", b"|im", b"_end", b"|>", b"junk"], &stop);
        assert!(stopped);
        assert_eq!(deltas, ["Hola "]);
        assert_eq!(final_text, "Hola", "final text drops the stop token and trailing space");

        let (deltas, _, stopped) = stream_all(&[b"a <", b"b"], &stop);
        assert!(!stopped);
        assert_eq!(deltas.concat(), "a <b", "a false alarm is released once it can't match");
    }

    #[test]
    fn long_token_pieces_are_not_truncated() {
        let piece = "=".repeat(200);
        let (deltas, final_text, _) = stream_all(&[piece.as_bytes()], &[]);
        assert_eq!(final_text, piece);
        assert_eq!(deltas.concat(), piece);
    }

    #[test]
    fn stream_is_opt_in_and_deltas_echo_the_id() {
        let request: Request = serde_json::from_str(r#"{"type":"generate","id":3,"prompt":"p"}"#).unwrap();
        assert!(matches!(request, Request::Generate { stream: false, .. }), "summaries don't stream");
        let request: Request =
            serde_json::from_str(r#"{"type":"generate","id":3,"prompt":"p","stream":true}"#).unwrap();
        assert!(matches!(request, Request::Generate { stream: true, .. }));
        assert_eq!(
            serde_json::to_string(&Response::Delta { id: Some(3), text: "Ho".into() }).unwrap(),
            r#"{"type":"delta","id":3,"text":"Ho"}"#
        );
    }

    #[test]
    fn replies_echo_request_id() {
        let request: Request = serde_json::from_str(r#"{"type":"ping","id":7}"#).unwrap();
        let Request::Ping { id } = request else {
            panic!("expected ping request");
        };
        assert_eq!(
            serde_json::to_string(&Response::Pong { id }).unwrap(),
            r#"{"type":"pong","id":7}"#
        );
        let request: Request = serde_json::from_str(r#"{"type":"ping"}"#).unwrap();
        assert!(matches!(request, Request::Ping { id: None }));
    }

    #[test]
    fn take_cancel_matches_only_its_id_and_keeps_other_lines() {
        let parse = |line: &str| serde_json::from_str::<Request>(line).map_err(|e| (None, e.to_string()));
        let (tx, rx) = mpsc::channel();
        let mut pending = VecDeque::new();
        tx.send(parse(r#"{"type":"cancel","id":1}"#)).unwrap();
        tx.send(parse(r#"{"type":"ping","id":3}"#)).unwrap();

        assert!(!take_cancel(&rx, &mut pending, Some(2)));
        assert_eq!(pending.len(), 2, "unrelated lines stay queued");
        assert!(!take_cancel(&rx, &mut pending, None));
        assert!(take_cancel(&rx, &mut pending, Some(1)));
        assert!(matches!(pending.front(), Some(Ok(Request::Ping { id: Some(3) }))));
        assert_eq!(pending.len(), 1);
    }

    #[test]
    fn generate_request_deserializes_qwen_penalties() {
        let json = r#"{"type":"generate","prompt":"summarize","temperature":0.5,"top_k":20,"top_p":0.8,"presence_penalty":0.3,"frequency_penalty":0.0,"repeat_penalty":1.05,"penalty_last_n":256}"#;
        let request: Request = serde_json::from_str(json).unwrap();
        let Request::Generate {
            temperature,
            top_k,
            top_p,
            presence_penalty,
            frequency_penalty,
            repeat_penalty,
            penalty_last_n,
            ..
        } = request else {
            panic!("expected generate request");
        };

        let sampling = SamplingConfig::from_request(
            temperature,
            top_k,
            top_p,
            presence_penalty,
            frequency_penalty,
            repeat_penalty,
            penalty_last_n,
        );

        assert_eq!(sampling.temperature, 0.5);
        assert_eq!(sampling.top_k, 20);
        assert_eq!(sampling.top_p, 0.8);
        assert_eq!(sampling.presence_penalty, 0.3);
        assert_eq!(sampling.frequency_penalty, 0.0);
        assert_eq!(sampling.repeat_penalty, 1.05);
        assert_eq!(sampling.penalty_last_n, 256);
        assert!(sampling.uses_penalties());
    }
}
